/**
 * 任务接口。
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { one, pool, query, tx } from '../db/index.ts'
import { HttpError, requireAuth, scopeOf, sendError } from '../auth/guard.ts'
import { CAPABILITIES, providersFor, type Capability } from '../providers/types.ts'
import { estimateUsage, findRule, priceOf } from '../quota/cost.ts'
import { balanceOf, hold, InsufficientQuota, refund } from '../quota/ledger.ts'
import '../providers/chanjing/index.ts'

const submitBody = z.object({
  capability: z.enum(CAPABILITIES as [Capability, ...Capability[]]),
  modelCode: z.string().max(120).optional(),
  name: z.string().max(200).optional(),
  params: z.record(z.unknown()).default({}),
  /**
   * 幂等键，由前端生成（验收第 9 条）。
   * 同一个键重复提交只会落一条任务、只扣一次额度，
   * 所以重复点击、刷新页面、网络层重试都是安全的。
   */
  idempotencyKey: z.string().min(8).max(120),
  providerId: z.string().max(60).optional(),
})

/** 选一家能干这活的供应商。目前只接了一家，以后要分流就改这里。 */
async function pickProvider(capability: Capability, prefer?: string): Promise<string> {
  const candidates = providersFor(capability).map((p) => p.id)
  if (!candidates.length) throw new HttpError(400, 'unsupported', '暂不支持该能力')

  const enabled = await query<{ id: string }>(
    pool,
    `SELECT id FROM providers WHERE enabled AND id = ANY($1::text[]) ORDER BY id`,
    [candidates],
  )
  if (!enabled.length) throw new HttpError(503, 'no_provider', '没有可用的供应商，请联系管理员')

  if (prefer && enabled.some((p) => p.id === prefer)) return prefer
  return enabled[0]!.id
}

export function taskRoutes(app: FastifyInstance): void {
  app.post('/api/tasks', async (req, reply) => {
    try {
      const scope = scopeOf(req)
      const body = submitBody.parse(req.body)

      // 幂等键先查一遍。重复提交直接把原来那条还回去，
      // 而不是报错——用户按了两次不是错误，只是不该产生第二条任务。
      const existing = await one(
        pool,
        `SELECT * FROM tasks WHERE tenant_id = $1 AND idempotency_key = $2`,
        [scope.tenantId, body.idempotencyKey],
      )
      if (existing) {
        reply.send({ task: shape(existing), deduped: true })
        return
      }

      const providerId = await pickProvider(body.capability, body.providerId)

      const rule = await findRule(pool, providerId, body.capability, body.modelCode)
      const estimate = rule
        ? priceOf(rule, estimateUsage(body.capability, body.params))
        : { points: 0, currency: '', providerAmount: 0 }

      const task = await tx(async (client) => {
        const row = await one(
          client,
          `INSERT INTO tasks (tenant_id, created_by, capability, provider_id, model_code, name, params, idempotency_key)
           VALUES ($1,$2,$3::capability,$4,$5,$6,$7::jsonb,$8)
           ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
           RETURNING *`,
          [
            scope.tenantId,
            scope.accountId,
            body.capability,
            providerId,
            body.modelCode ?? null,
            body.name ?? '',
            JSON.stringify(body.params),
            body.idempotencyKey,
          ],
        )

        // 并发的第二次请求走到这里，说明第一次刚插进去，读出来还给它
        if (!row) {
          return one(pool, `SELECT * FROM tasks WHERE tenant_id = $1 AND idempotency_key = $2`, [
            scope.tenantId,
            body.idempotencyKey,
          ])
        }

        if (estimate.points > 0) {
          await hold(client, {
            tenantId: scope.tenantId,
            taskId: String(row.id),
            points: estimate.points,
            providerId,
            currency: estimate.currency,
            providerAmount: estimate.providerAmount,
          })
        }

        return row
      })

      reply.send({ task: shape(task!) })
    } catch (err) {
      if (err instanceof InsufficientQuota) {
        return sendError(
          reply,
          new HttpError(402, 'insufficient_quota', `额度不足。剩余 ${err.available}，本次需要 ${err.required}`),
        )
      }
      if (err instanceof z.ZodError) {
        return sendError(reply, new HttpError(400, 'bad_request', err.errors[0]?.message ?? '参数不正确'))
      }
      sendError(reply, err)
    }
  })

  app.get('/api/tasks', async (req, reply) => {
    try {
      const scope = scopeOf(req)
      const q = req.query as Record<string, string | undefined>
      const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50)))
      const offset = Math.max(0, Number(q.offset ?? 0))

      const rows = await query(
        pool,
        `SELECT t.*, a.email AS created_by_email,
                COALESCE(
                  (SELECT array_agg(s.id ORDER BY s.created_at) FROM assets s
                    WHERE s.task_id = t.id AND s.deleted_at IS NULL),
                  '{}'
                ) AS asset_ids,
                -- 位次只对还在排队的任务有意义。跑完的任务算这个数没有意义，
                -- 显示出来还会让人以为它还在队列里。
                CASE WHEN t.status IN ('queued','pending') THEN
                  (SELECT count(*)::int FROM tasks q
                    WHERE q.provider_id = t.provider_id AND q.capability = t.capability
                      AND q.status IN ('queued','pending')
                      AND q.created_at < t.created_at)
                END AS queue_ahead
           FROM tasks t
           LEFT JOIN accounts a ON a.id = t.created_by
          WHERE t.tenant_id = $1
            AND ($2::task_status IS NULL OR t.status = $2::task_status)
          ORDER BY t.created_at DESC
          LIMIT $3 OFFSET $4`,
        [scope.tenantId, q.status || null, limit, offset],
      )

      reply.send({ tasks: rows.map(shape) })
    } catch (err) {
      sendError(reply, err)
    }
  })

  app.get('/api/tasks/:id', async (req, reply) => {
    try {
      const scope = scopeOf(req)
      const { id } = req.params as { id: string }
      // 作用域带在 WHERE 里，改 URL 上的 id 拿不到别人的任务（验收第 1 条）
      const row = await one(
        pool,
        `SELECT t.*,
                COALESCE(
                  (SELECT array_agg(s.id ORDER BY s.created_at) FROM assets s
                    WHERE s.task_id = t.id AND s.deleted_at IS NULL),
                  '{}'
                ) AS asset_ids
           FROM tasks t WHERE t.id = $1 AND t.tenant_id = $2`,
        [id, scope.tenantId],
      )
      if (!row) throw new HttpError(404, 'not_found', '任务不存在')
      reply.send({ task: shape(row) })
    } catch (err) {
      sendError(reply, err)
    }
  })

  app.post('/api/tasks/:id/cancel', async (req, reply) => {
    try {
      const scope = scopeOf(req)
      const { id } = req.params as { id: string }

      const row = await one<{ id: string; status: string }>(
        pool,
        `SELECT id, status FROM tasks WHERE id = $1 AND tenant_id = $2`,
        [id, scope.tenantId],
      )
      if (!row) throw new HttpError(404, 'not_found', '任务不存在')
      if (row.status !== 'queued') {
        throw new HttpError(409, 'not_cancellable', '任务已经提交到平台，无法取消')
      }

      await tx(async (client) => {
        await refund(client, { tenantId: scope.tenantId, taskId: id, note: '用户取消' })
        await query(
          client,
          `UPDATE tasks SET status = 'cancelled', finished_at = now(), updated_at = now() WHERE id = $1`,
          [id],
        )
      })

      reply.send({ ok: true })
    } catch (err) {
      sendError(reply, err)
    }
  })

  app.get('/api/quota', async (req, reply) => {
    try {
      const scope = scopeOf(req)
      reply.send({ quota: await balanceOf(pool, scope.tenantId) })
    } catch (err) {
      sendError(reply, err)
    }
  })
}

/**
 * 出参整形。
 *
 * provider_raw 和 params 不往客户端送：前者是供应商的原始响应，可能带内部字段；
 * 后者体积大且客户端本来就有。管理员要看原始响应走管理端专用接口。
 */
function shape(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    capability: row.capability,
    modelCode: row.model_code,
    name: row.name,
    status: row.status,
    progress: row.progress,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    traceId: row.trace_id,
    queueAhead: row.queue_ahead ?? null,
    // 这次任务产出的资产 id，结果面板按它去资料库里取
    assetIds: row.asset_ids ?? [],
    createdBy: row.created_by_email ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  }
}
