/**
 * 管理后台接口。
 *
 * 客户要的四件事：建号停用、设额度、看用量、看某个客户的任务。
 * 全部只对 admin 开放，内部员工也看不到别的租户。
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { one, pool, query, tx } from '../db/index.ts'
import { HttpError, requireAdmin, sendError } from '../auth/guard.ts'
import { hashPassword } from '../auth/password.ts'
import { revokeAllSessions } from '../auth/session.ts'
import { adjust, balanceOf, ledgerOf } from '../quota/ledger.ts'
import { seedSystemCategories } from '../db/seed.ts'
import { loadProvider } from '../worker/context.ts'
import { testCredentials } from '../providers/chanjing/index.ts'
import { CAPABILITIES, type Capability } from '../providers/types.ts'

const createClientBody = z.object({
  tenantName: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().max(120).optional(),
  initialPoints: z.number().min(0).max(10_000_000).default(0),
})

const createStaffBody = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().max(120).optional(),
  role: z.enum(['admin', 'staff']).default('staff'),
})

export function adminRoutes(app: FastifyInstance): void {
  // -------------------------------------------------------------------------
  // 账号与客户
  // -------------------------------------------------------------------------

  app.get('/api/admin/tenants', async (req, reply) => {
    try {
      requireAdmin(req)
      const rows = await query(
        pool,
        `SELECT t.id, t.kind, t.name, t.created_at,
                q.granted_points, q.used_points, q.held_points,
                (SELECT count(*)::int FROM accounts a WHERE a.tenant_id = t.id) AS account_count,
                (SELECT count(*)::int FROM tasks k WHERE k.tenant_id = t.id) AS task_count,
                (SELECT count(*)::int FROM accounts a WHERE a.tenant_id = t.id AND a.disabled_at IS NULL) AS active_accounts
           FROM tenants t
           LEFT JOIN quota_accounts q ON q.tenant_id = t.id
          ORDER BY t.kind, t.created_at DESC`,
      )
      reply.send({
        tenants: rows.map((r) => ({
          ...r,
          granted_points: Number(r.granted_points ?? 0),
          used_points: Number(r.used_points ?? 0),
          held_points: Number(r.held_points ?? 0),
          available_points:
            Number(r.granted_points ?? 0) - Number(r.used_points ?? 0) - Number(r.held_points ?? 0),
        })),
      })
    } catch (err) {
      sendError(reply, err)
    }
  })

  /** 建一个外部客户：一个租户 + 一个登录账号 + 额度账户 + 系统分类 */
  app.post('/api/admin/tenants', async (req, reply) => {
    try {
      const admin = requireAdmin(req)
      const body = createClientBody.parse(req.body)

      const dup = await one(pool, `SELECT id FROM accounts WHERE email = $1`, [body.email])
      if (dup) throw new HttpError(409, 'email_taken', '这个邮箱已经被占用')

      const hash = await hashPassword(body.password)

      const result = await tx(async (client) => {
        const tenant = await one<{ id: string }>(
          client,
          `INSERT INTO tenants (kind, name) VALUES ('client', $1) RETURNING id`,
          [body.tenantName],
        )
        await query(client, `INSERT INTO quota_accounts (tenant_id) VALUES ($1)`, [tenant!.id])
        await seedSystemCategories(client, tenant!.id)
        const account = await one<{ id: string }>(
          client,
          `INSERT INTO accounts (tenant_id, email, password_hash, role, name, must_change_password)
           VALUES ($1,$2,$3,'client',$4,true) RETURNING id`,
          [tenant!.id, body.email, hash, body.name ?? body.tenantName],
        )
        return { tenantId: tenant!.id, accountId: account!.id }
      })

      if (body.initialPoints > 0) {
        await adjust({
          tenantId: result.tenantId,
          points: body.initialPoints,
          actorAccountId: admin.accountId,
          note: '开户初始额度',
        })
      }

      reply.send({ ...result, quota: await balanceOf(pool, result.tenantId) })
    } catch (err) {
      if (err instanceof z.ZodError) {
        return sendError(reply, new HttpError(400, 'bad_request', err.errors[0]?.message ?? '参数不正确'))
      }
      sendError(reply, err)
    }
  })

  app.post('/api/admin/staff', async (req, reply) => {
    try {
      requireAdmin(req)
      const body = createStaffBody.parse(req.body)

      const internal = await one<{ id: string }>(pool, `SELECT id FROM tenants WHERE kind='internal'`)
      if (!internal) throw new HttpError(500, 'no_internal', '内部租户缺失')

      const dup = await one(pool, `SELECT id FROM accounts WHERE email = $1`, [body.email])
      if (dup) throw new HttpError(409, 'email_taken', '这个邮箱已经被占用')

      const hash = await hashPassword(body.password)
      const row = await one(
        pool,
        `INSERT INTO accounts (tenant_id, email, password_hash, role, name, must_change_password)
         VALUES ($1,$2,$3,$4::account_role,$5,true) RETURNING id, email, role`,
        [internal.id, body.email, hash, body.role, body.name ?? ''],
      )
      reply.send({ account: row })
    } catch (err) {
      if (err instanceof z.ZodError) {
        return sendError(reply, new HttpError(400, 'bad_request', err.errors[0]?.message ?? '参数不正确'))
      }
      sendError(reply, err)
    }
  })

  app.get('/api/admin/accounts', async (req, reply) => {
    try {
      requireAdmin(req)
      const q = req.query as Record<string, string | undefined>
      const rows = await query(
        pool,
        `SELECT a.id, a.email, a.name, a.role, a.disabled_at, a.must_change_password, a.created_at,
                t.id AS tenant_id, t.name AS tenant_name, t.kind AS tenant_kind
           FROM accounts a JOIN tenants t ON t.id = a.tenant_id
          WHERE ($1::uuid IS NULL OR a.tenant_id = $1::uuid)
          ORDER BY t.kind, a.created_at DESC`,
        [q.tenantId || null],
      )
      reply.send({ accounts: rows })
    } catch (err) {
      sendError(reply, err)
    }
  })

  /**
   * 停用、启用、改名、重置密码。
   * 停用和重置密码都会立刻踢掉该账号所有会话（验收第 8 条）。
   */
  app.patch('/api/admin/accounts/:id', async (req, reply) => {
    try {
      const admin = requireAdmin(req)
      const { id } = req.params as { id: string }
      const body = z
        .object({
          disabled: z.boolean().optional(),
          name: z.string().max(120).optional(),
          // 换登录邮箱。先建占位账号、等客户给了真实邮箱再换过来，
          // 靠的就是这一条——租户带着历史数据删不掉，只能原地改。
          email: z.string().email().optional(),
          newPassword: z.string().min(8).optional(),
        })
        .parse(req.body)

      const target = await one<{ id: string; role: string }>(
        pool,
        `SELECT id, role FROM accounts WHERE id = $1`,
        [id],
      )
      if (!target) throw new HttpError(404, 'not_found', '账号不存在')

      // 不许把自己停掉，否则可能没人能进后台了
      if (body.disabled === true && target.id === admin.accountId) {
        throw new HttpError(400, 'self_disable', '不能停用自己的账号')
      }
      // 也不许停掉最后一个可用的管理员
      if (body.disabled === true && target.role === 'admin') {
        const left = await one<{ n: number }>(
          pool,
          `SELECT count(*)::int AS n FROM accounts WHERE role='admin' AND disabled_at IS NULL AND id <> $1`,
          [id],
        )
        if ((left?.n ?? 0) === 0) throw new HttpError(400, 'last_admin', '这是最后一个可用的管理员，不能停用')
      }

      await tx(async (client) => {
        if (body.disabled !== undefined) {
          await query(
            client,
            `UPDATE accounts SET disabled_at = $2, updated_at = now() WHERE id = $1`,
            [id, body.disabled ? new Date() : null],
          )
          if (body.disabled) await revokeAllSessions(client, id)
        }
        if (body.name !== undefined) {
          await query(client, `UPDATE accounts SET name = $2, updated_at = now() WHERE id = $1`, [id, body.name])
        }
        if (body.email !== undefined) {
          const dup = await one(client, `SELECT id FROM accounts WHERE email = $1 AND id <> $2`, [body.email, id])
          if (dup) throw new HttpError(409, 'email_taken', '这个邮箱已经被占用')
          await query(client, `UPDATE accounts SET email = $2, updated_at = now() WHERE id = $1`, [id, body.email])
          // 换了登录邮箱等于换了身份，手上的会话一律作废，重新登录
          await revokeAllSessions(client, id)
        }
        if (body.newPassword) {
          const hash = await hashPassword(body.newPassword)
          await query(
            client,
            `UPDATE accounts SET password_hash = $2, must_change_password = true, updated_at = now()
              WHERE id = $1`,
            [id, hash],
          )
          // 重置密码后旧会话立刻失效
          await revokeAllSessions(client, id)
        }
      })

      reply.send({ ok: true })
    } catch (err) {
      if (err instanceof z.ZodError) {
        return sendError(reply, new HttpError(400, 'bad_request', err.errors[0]?.message ?? '参数不正确'))
      }
      sendError(reply, err)
    }
  })

  // -------------------------------------------------------------------------
  // 额度
  // -------------------------------------------------------------------------

  app.post('/api/admin/tenants/:id/quota', async (req, reply) => {
    try {
      const admin = requireAdmin(req)
      const { id } = req.params as { id: string }
      const body = z
        .object({
          /** 正数是增发，负数是收回 */
          points: z.number(),
          note: z.string().max(500).optional(),
        })
        .parse(req.body)

      const tenant = await one(pool, `SELECT id FROM tenants WHERE id = $1`, [id])
      if (!tenant) throw new HttpError(404, 'not_found', '客户不存在')

      const quota = await adjust({
        tenantId: id,
        points: body.points,
        actorAccountId: admin.accountId,
        note: body.note,
      })
      reply.send({ quota })
    } catch (err) {
      if (err instanceof z.ZodError) {
        return sendError(reply, new HttpError(400, 'bad_request', err.errors[0]?.message ?? '参数不正确'))
      }
      sendError(reply, err)
    }
  })

  /** 给客户改名。开户时可能只有个代称，等确认了正式名称再改过来。 */
  app.patch('/api/admin/tenants/:id', async (req, reply) => {
    try {
      requireAdmin(req)
      const { id } = req.params as { id: string }
      const body = z.object({ name: z.string().min(1).max(120) }).parse(req.body)

      const rows = await query(
        pool,
        `UPDATE tenants SET name = $2, updated_at = now() WHERE id = $1 RETURNING id, name, kind`,
        [id, body.name],
      )
      if (!rows.length) throw new HttpError(404, 'not_found', '客户不存在')
      reply.send({ tenant: rows[0] })
    } catch (err) {
      if (err instanceof z.ZodError) {
        return sendError(reply, new HttpError(400, 'bad_request', '名称不正确'))
      }
      sendError(reply, err)
    }
  })

  app.get('/api/admin/tenants/:id/ledger', async (req, reply) => {
    try {
      requireAdmin(req)
      const { id } = req.params as { id: string }
      const q = req.query as Record<string, string | undefined>
      const rows = await ledgerOf(pool, id, Math.min(500, Number(q.limit ?? 100)), Number(q.offset ?? 0))
      reply.send({ ledger: rows, quota: await balanceOf(pool, id) })
    } catch (err) {
      sendError(reply, err)
    }
  })

  // -------------------------------------------------------------------------
  // 任务
  // -------------------------------------------------------------------------

  app.get('/api/admin/tasks', async (req, reply) => {
    try {
      requireAdmin(req)
      const q = req.query as Record<string, string | undefined>
      // 验收第 4 条要的字段：创建人、时间、能力、模型、供应商、状态、点数变化、原始货币消耗
      const rows = await query(
        pool,
        `SELECT t.id, t.tenant_id, ten.name AS tenant_name,
                t.capability, t.model_code, t.provider_id, t.status, t.progress,
                t.error_code, t.error_message, t.trace_id,
                t.created_at, t.submitted_at, t.finished_at,
                a.email AS created_by_email,
                COALESCE((SELECT sum(points) FROM quota_ledger l
                           WHERE l.task_id = t.id AND l.op IN ('settle','refund')), 0) AS points_charged,
                (SELECT l.provider_currency FROM quota_ledger l
                  WHERE l.task_id = t.id AND l.op = 'settle' LIMIT 1) AS provider_currency,
                (SELECT l.provider_amount FROM quota_ledger l
                  WHERE l.task_id = t.id AND l.op = 'settle' LIMIT 1) AS provider_amount
           FROM tasks t
           JOIN tenants ten ON ten.id = t.tenant_id
           LEFT JOIN accounts a ON a.id = t.created_by
          WHERE ($1::uuid IS NULL OR t.tenant_id = $1::uuid)
            AND ($2::task_status IS NULL OR t.status = $2::task_status)
          ORDER BY t.created_at DESC
          LIMIT $3 OFFSET $4`,
        [q.tenantId || null, q.status || null, Math.min(500, Number(q.limit ?? 100)), Number(q.offset ?? 0)],
      )
      reply.send({ tasks: rows })
    } catch (err) {
      sendError(reply, err)
    }
  })

  /** 单个任务的全貌，含供应商原始响应和调用日志（验收第 11 条） */
  app.get('/api/admin/tasks/:id', async (req, reply) => {
    try {
      requireAdmin(req)
      const { id } = req.params as { id: string }
      const task = await one(pool, `SELECT * FROM tasks WHERE id = $1`, [id])
      if (!task) throw new HttpError(404, 'not_found', '任务不存在')
      const logs = await query(
        pool,
        `SELECT method, path, duration_ms, ok, code, msg, trace_id, created_at
           FROM api_logs WHERE task_id = $1 ORDER BY id`,
        [id],
      )
      const ledger = await query(
        pool,
        `SELECT op, points, provider_currency, provider_amount, created_at
           FROM quota_ledger WHERE task_id = $1 ORDER BY id`,
        [id],
      )
      reply.send({ task, logs, ledger })
    } catch (err) {
      sendError(reply, err)
    }
  })

  // -------------------------------------------------------------------------
  // 供应商
  // -------------------------------------------------------------------------

  app.get('/api/admin/providers', async (req, reply) => {
    try {
      requireAdmin(req)
      const rows = await query(
        pool,
        `SELECT id, label, enabled,
                -- 凭据绝不回传，只告诉界面填没填（验收第 7 条）
                (credentials ? 'app_id') AS configured,
                updated_at
           FROM providers ORDER BY id`,
      )
      const limits = await query(
        pool,
        `SELECT provider_id, capability, concurrency, rpm FROM provider_limits ORDER BY provider_id, capability`,
      )
      const balances = await query(
        pool,
        `SELECT DISTINCT ON (provider_id, currency) provider_id, currency, amount, fetched_at
           FROM provider_balances ORDER BY provider_id, currency, fetched_at DESC`,
      )
      reply.send({ providers: rows, limits, balances })
    } catch (err) {
      sendError(reply, err)
    }
  })

  app.patch('/api/admin/providers/:id', async (req, reply) => {
    try {
      requireAdmin(req)
      const { id } = req.params as { id: string }
      const body = z
        .object({
          enabled: z.boolean().optional(),
          appId: z.string().max(200).optional(),
          secretKey: z.string().max(400).optional(),
        })
        .parse(req.body)

      if (body.enabled !== undefined) {
        await query(pool, `UPDATE providers SET enabled = $2, updated_at = now() WHERE id = $1`, [id, body.enabled])
      }
      if (body.appId && body.secretKey) {
        await query(
          pool,
          `UPDATE providers SET credentials = $2::jsonb, updated_at = now() WHERE id = $1`,
          [id, JSON.stringify({ app_id: body.appId, secret_key: body.secretKey })],
        )
        // 换了凭据，旧的访问令牌作废
        await query(pool, `DELETE FROM provider_tokens WHERE provider_id = $1`, [id])
      }

      reply.send({ ok: true })
    } catch (err) {
      if (err instanceof z.ZodError) {
        return sendError(reply, new HttpError(400, 'bad_request', err.errors[0]?.message ?? '参数不正确'))
      }
      sendError(reply, err)
    }
  })

  app.post('/api/admin/providers/:id/test', async (req, reply) => {
    try {
      requireAdmin(req)
      const { id } = req.params as { id: string }
      const { ctx } = await loadProvider(id)
      await testCredentials(ctx)
      reply.send({ ok: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : '连接失败'
      reply.code(200).send({ ok: false, message })
    }
  })

  /** 并发与限流按供应商 × 能力配置，改完立刻生效，不用重启 */
  app.patch('/api/admin/providers/:id/limits', async (req, reply) => {
    try {
      requireAdmin(req)
      const { id } = req.params as { id: string }
      const body = z
        .object({
          limits: z.array(
            z.object({
              capability: z.enum(CAPABILITIES as [Capability, ...Capability[]]),
              concurrency: z.number().int().min(0).max(100),
              rpm: z.number().int().min(0).max(10_000),
            }),
          ),
        })
        .parse(req.body)

      await tx(async (client) => {
        for (const l of body.limits) {
          await query(
            client,
            `INSERT INTO provider_limits (provider_id, capability, concurrency, rpm)
             VALUES ($1,$2::capability,$3,$4)
             ON CONFLICT (provider_id, capability)
             DO UPDATE SET concurrency = EXCLUDED.concurrency, rpm = EXCLUDED.rpm, updated_at = now()`,
            [id, l.capability, l.concurrency, l.rpm],
          )
        }
      })

      reply.send({ ok: true })
    } catch (err) {
      if (err instanceof z.ZodError) {
        return sendError(reply, new HttpError(400, 'bad_request', err.errors[0]?.message ?? '参数不正确'))
      }
      sendError(reply, err)
    }
  })

  // -------------------------------------------------------------------------
  // 计价规则
  // -------------------------------------------------------------------------

  /**
   * 价格目录的同步状态。
   * unmapped 是同步时没能对上号的模型——这些没有价，任务会不扣费，
   * 所以它不该只写在日志里，要摆在管理后台让人看见。
   */
  app.get('/api/admin/price-catalog', async (req, reply) => {
    try {
      requireAdmin(req)
      const latest = await one<Record<string, unknown>>(
        pool,
        `SELECT version, updated_at, fetched_at, applied, unmapped
           FROM price_catalogs WHERE provider_id = 'chanjing'
          ORDER BY fetched_at DESC LIMIT 1`,
      )
      const history = await query(
        pool,
        `SELECT version, updated_at, fetched_at, applied
           FROM price_catalogs WHERE provider_id = 'chanjing'
          ORDER BY fetched_at DESC LIMIT 10`,
      )
      reply.send({ latest, history })
    } catch (err) {
      sendError(reply, err)
    }
  })

  /** 手动触发一次价格同步 */
  app.post('/api/admin/price-catalog/sync', async (req, reply) => {
    try {
      requireAdmin(req)
      const { syncPrices } = await import('../worker/prices.ts')
      reply.send(await syncPrices())
    } catch (err) {
      sendError(reply, err)
    }
  })

  app.get('/api/admin/cost-rules', async (req, reply) => {
    try {
      requireAdmin(req)
      const rows = await query(
        pool,
        `SELECT id, provider_id, capability, model_code, currency, provider_cost, points, per_unit, effective_at
           FROM cost_rules ORDER BY provider_id, capability, model_code NULLS FIRST`,
      )
      reply.send({ rules: rows })
    } catch (err) {
      sendError(reply, err)
    }
  })

  app.post('/api/admin/cost-rules', async (req, reply) => {
    try {
      requireAdmin(req)
      const body = z
        .object({
          providerId: z.string(),
          capability: z.enum(CAPABILITIES as [Capability, ...Capability[]]),
          modelCode: z.string().max(120).nullable().optional(),
          currency: z.string().max(40),
          providerCost: z.number().min(0),
          points: z.number().min(0),
          perUnit: z.boolean().default(false),
        })
        .parse(req.body)

      const row = await one(
        pool,
        `INSERT INTO cost_rules (provider_id, capability, model_code, currency, provider_cost, points, per_unit)
         VALUES ($1,$2::capability,$3,$4,$5,$6,$7) RETURNING id`,
        [
          body.providerId,
          body.capability,
          body.modelCode ?? null,
          body.currency,
          body.providerCost,
          body.points,
          body.perUnit,
        ],
      )
      reply.send({ rule: row })
    } catch (err) {
      if (err instanceof z.ZodError) {
        return sendError(reply, new HttpError(400, 'bad_request', err.errors[0]?.message ?? '参数不正确'))
      }
      sendError(reply, err)
    }
  })
}
