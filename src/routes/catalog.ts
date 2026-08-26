/**
 * 模型与素材库目录。
 *
 * 模型列表从服务端下发（验收第 13 条），前端不再内置注册表，
 * 新增或停用模型改数据即可，不用重新发布前端。
 */

import type { FastifyInstance } from 'fastify'
import { pool, query } from '../db/index.ts'
import { requireAuth, scopeOf, sendError } from '../auth/guard.ts'
import { CHANJING_MODEL_SPECS } from '../providers/chanjing/models.ts'
import { loadProvider } from '../worker/context.ts'
import { balanceOf } from '../quota/ledger.ts'

export function catalogRoutes(app: FastifyInstance): void {
  /**
   * 可用模型。
   *
   * 只回可用供应商的模型：某家被管理员停用后，它的模型立刻从选择器里消失，
   * 用户不会选了才发现提交不了。
   */
  app.get('/api/models', async (req, reply) => {
    try {
      requireAuth(req)
      const enabled = await query<{ id: string }>(pool, `SELECT id FROM providers WHERE enabled`)
      const ids = new Set(enabled.map((p) => p.id))

      const models = ids.has('chanjing')
        ? CHANJING_MODEL_SPECS.map((m) => ({
            code: m.code,
            capability: m.capability,
            providerId: 'chanjing',
            label: m.label,
            vendor: m.vendor,
            tags: m.tags ?? [],
            fields: m.fields,
          }))
        : []

      reply.send({ models })
    } catch (err) {
      sendError(reply, err)
    }
  })

  /** 公共音色库。透传供应商的目录，凭据不出服务端。 */
  app.get('/api/catalog/voices', async (req, reply) => {
    try {
      const scope = scopeOf(req)
      const q = req.query as Record<string, string | undefined>
      const { ctx } = await loadProvider('chanjing', { tenantId: scope.tenantId })
      const { get } = await import('../providers/chanjing/client.ts')
      const data = await get<unknown>(ctx, 'chanjing', '/list_common_audio', {
        page: Number(q.page ?? 1),
        page_size: Number(q.pageSize ?? 30),
      })
      reply.send({ data })
    } catch (err) {
      sendError(reply, err)
    }
  })

  /** 我的音色。这一份属于平台账号，所有租户共用同一个账号，所以只有内部角色能看全。 */
  app.get('/api/catalog/my-voices', async (req, reply) => {
    try {
      const scope = scopeOf(req)
      const { ctx } = await loadProvider('chanjing', { tenantId: scope.tenantId })
      const { post } = await import('../providers/chanjing/client.ts')
      const data = await post<unknown>(ctx, 'chanjing', '/list_customised_audio', {
        page: 1,
        page_size: 100,
      })
      reply.send({ data })
    } catch (err) {
      sendError(reply, err)
    }
  })

  /** 公共数字人 */
  app.get('/api/catalog/avatars', async (req, reply) => {
    try {
      const scope = scopeOf(req)
      const q = req.query as Record<string, string | undefined>
      const { ctx } = await loadProvider('chanjing', { tenantId: scope.tenantId })
      const { get } = await import('../providers/chanjing/client.ts')
      // tag_ids 必须拼成逗号串，同名参数传多次只认第一个——这条跟 tag_list 正好相反
      const data = await get<unknown>(ctx, 'chanjing', '/list_common_dp', {
        page: Number(q.page ?? 1),
        size: Number(q.size ?? 30),
        tag_ids: q.tagIds || undefined,
      })
      reply.send({ data })
    } catch (err) {
      sendError(reply, err)
    }
  })

  /** 我的定制数字人 */
  app.get('/api/catalog/my-avatars', async (req, reply) => {
    try {
      const scope = scopeOf(req)
      const { ctx } = await loadProvider('chanjing', { tenantId: scope.tenantId })
      const { post } = await import('../providers/chanjing/client.ts')
      const data = await post<unknown>(ctx, 'chanjing', '/list_customised_person', {
        page: 1,
        page_size: 100,
      })
      reply.send({ data })
    } catch (err) {
      sendError(reply, err)
    }
  })

  /**
   * 工作台概览。
   * 客户看到的是自己的统一点数，不是平台余额——平台余额只有管理员看得到。
   */
  app.get('/api/overview', async (req, reply) => {
    try {
      const scope = scopeOf(req)
      const quota = await balanceOf(pool, scope.tenantId)
      const counts = await query<{ status: string; n: number }>(
        pool,
        `SELECT status::text, count(*)::int AS n FROM tasks WHERE tenant_id = $1 GROUP BY status`,
        [scope.tenantId],
      )
      const assets = await query<{ type: string; n: number }>(
        pool,
        `SELECT type::text, count(*)::int AS n FROM assets
          WHERE tenant_id = $1 AND deleted_at IS NULL GROUP BY type`,
        [scope.tenantId],
      )
      reply.send({ quota, taskCounts: counts, assetCounts: assets })
    } catch (err) {
      sendError(reply, err)
    }
  })
}
