/**
 * 资料库的增删改与分类管理。
 * 跟 assets.ts 拆开只是为了单个文件别太长，作用域校验的规矩完全一致。
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { one, pool, query, tx } from '../db/index.ts'
import { HttpError, scopeOf, sendError } from '../auth/guard.ts'

const SELECT = `id, type, name, description, category_id, tags, source, size_bytes, mime_type,
                content, meta, status, favorite, used_count, created_at, updated_at,
                (storage_key IS NOT NULL) AS has_file`

export function assetExtraRoutes(app: FastifyInstance): void {
  /** 新建资产。只有文案这类没有文件的记录会走这里，生成结果由服务端自己入库。 */
  app.post('/api/assets', async (req, reply) => {
    try {
      const scope = scopeOf(req)
      const body = z
        .object({
          type: z.enum(['text', 'image', 'video', 'audio', 'avatar', 'voice']),
          name: z.string().min(1).max(200),
          content: z.string().max(200_000).optional(),
          description: z.string().max(2000).optional(),
          categoryId: z.string().uuid().optional(),
          tags: z.array(z.string().max(60)).max(20).default([]),
          providerRef: z.record(z.unknown()).optional(),
          originUrl: z.string().max(2000).optional(),
          meta: z.record(z.unknown()).optional(),
        })
        .parse(req.body)

      const row = await one(
        pool,
        `INSERT INTO assets (tenant_id, created_by, type, name, description, category_id, tags,
                             source, content, origin_url, meta, status)
         VALUES ($1,$2,$3::asset_type,$4,$5,$6,$7,'generated',$8,$9,$10::jsonb,'ready')
         RETURNING ${SELECT}`,
        [
          scope.tenantId,
          scope.accountId,
          body.type,
          body.name,
          body.description ?? null,
          body.categoryId ?? null,
          body.tags,
          body.content ?? null,
          body.originUrl ?? null,
          JSON.stringify({ ...(body.meta ?? {}), providerRef: body.providerRef ?? {} }),
        ],
      )
      reply.send({ asset: row })
    } catch (err) {
      if (err instanceof z.ZodError) {
        return sendError(reply, new HttpError(400, 'bad_request', err.errors[0]?.message ?? '参数不正确'))
      }
      sendError(reply, err)
    }
  })

  app.patch('/api/assets/:id', async (req, reply) => {
    try {
      const scope = scopeOf(req)
      const { id } = req.params as { id: string }
      const body = z
        .object({
          name: z.string().min(1).max(200).optional(),
          description: z.string().max(2000).nullable().optional(),
          categoryId: z.string().uuid().nullable().optional(),
          tags: z.array(z.string().max(60)).max(20).optional(),
          favorite: z.boolean().optional(),
        })
        .parse(req.body)

      // COALESCE 让「没传的字段保持原样」，避免部分更新把别的字段清空
      const rows = await query(
        pool,
        `UPDATE assets
            SET name = COALESCE($3, name),
                description = CASE WHEN $4::boolean THEN $5 ELSE description END,
                category_id = CASE WHEN $6::boolean THEN $7::uuid ELSE category_id END,
                tags = COALESCE($8::text[], tags),
                favorite = COALESCE($9::boolean, favorite),
                updated_at = now()
          WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
          RETURNING id`,
        [
          id,
          scope.tenantId,
          body.name ?? null,
          body.description !== undefined,
          body.description ?? null,
          body.categoryId !== undefined,
          body.categoryId ?? null,
          body.tags ?? null,
          body.favorite ?? null,
        ],
      )
      if (!rows.length) throw new HttpError(404, 'not_found', '素材不存在')
      reply.send({ ok: true })
    } catch (err) {
      if (err instanceof z.ZodError) {
        return sendError(reply, new HttpError(400, 'bad_request', err.errors[0]?.message ?? '参数不正确'))
      }
      sendError(reply, err)
    }
  })

  /** 被下游生成功能选用时计数，用于「常用素材」排序 */
  app.post('/api/assets/:id/used', async (req, reply) => {
    try {
      const scope = scopeOf(req)
      const { id } = req.params as { id: string }
      await query(
        pool,
        `UPDATE assets SET used_count = used_count + 1 WHERE id = $1 AND tenant_id = $2`,
        [id, scope.tenantId],
      )
      reply.send({ ok: true })
    } catch (err) {
      sendError(reply, err)
    }
  })

  app.post('/api/assets/:id/restore', async (req, reply) => {
    try {
      const scope = scopeOf(req)
      const { id } = req.params as { id: string }
      await query(
        pool,
        `UPDATE assets SET deleted_at = NULL, updated_at = now()
          WHERE id = $1 AND tenant_id = $2`,
        [id, scope.tenantId],
      )
      reply.send({ ok: true })
    } catch (err) {
      sendError(reply, err)
    }
  })

  // -------------------------------------------------------------------------
  // 分类
  // -------------------------------------------------------------------------

  app.post('/api/categories', async (req, reply) => {
    try {
      const scope = scopeOf(req)
      const body = z
        .object({ name: z.string().min(1).max(60), parentId: z.string().uuid().optional() })
        .parse(req.body)

      const row = await one(
        pool,
        `INSERT INTO categories (tenant_id, name, parent_id, sort)
         VALUES ($1,$2,$3,
                 COALESCE((SELECT max(sort) + 10 FROM categories WHERE tenant_id = $1), 10))
         RETURNING id, name, parent_id, sort, is_system`,
        [scope.tenantId, body.name, body.parentId ?? null],
      )
      reply.send({ category: row })
    } catch (err) {
      if (err instanceof z.ZodError) {
        return sendError(reply, new HttpError(400, 'bad_request', '分类名不正确'))
      }
      sendError(reply, err)
    }
  })

  app.patch('/api/categories/order', async (req, reply) => {
    try {
      const scope = scopeOf(req)
      const body = z.object({ ordered: z.array(z.string().uuid()).max(200) }).parse(req.body)
      await tx(async (client) => {
        for (const [i, id] of body.ordered.entries()) {
          await query(
            client,
            `UPDATE categories SET sort = $3 WHERE id = $1 AND tenant_id = $2`,
            [id, scope.tenantId, (i + 1) * 10],
          )
        }
      })
      reply.send({ ok: true })
    } catch (err) {
      sendError(reply, err)
    }
  })

  app.patch('/api/categories/:id', async (req, reply) => {
    try {
      const scope = scopeOf(req)
      const { id } = req.params as { id: string }
      const body = z.object({ name: z.string().min(1).max(60) }).parse(req.body)

      const rows = await query(
        pool,
        `UPDATE categories SET name = $3
          WHERE id = $1 AND tenant_id = $2 AND NOT is_system
          RETURNING id`,
        [id, scope.tenantId, body.name],
      )
      if (!rows.length) throw new HttpError(400, 'not_editable', '系统分类不能重命名')
      reply.send({ ok: true })
    } catch (err) {
      if (err instanceof z.ZodError) {
        return sendError(reply, new HttpError(400, 'bad_request', '分类名不正确'))
      }
      sendError(reply, err)
    }
  })

  app.delete('/api/categories/:id', async (req, reply) => {
    try {
      const scope = scopeOf(req)
      const { id } = req.params as { id: string }

      await tx(async (client) => {
        const cat = await one<{ is_system: boolean }>(
          client,
          `SELECT is_system FROM categories WHERE id = $1 AND tenant_id = $2`,
          [id, scope.tenantId],
        )
        if (!cat) throw new HttpError(404, 'not_found', '分类不存在')
        if (cat.is_system) throw new HttpError(400, 'system_category', '系统分类不能删除')

        // 分类下的素材退回未分类，不跟着删——删分类不该丢东西
        await query(client, `UPDATE assets SET category_id = NULL WHERE category_id = $1`, [id])
        await query(client, `UPDATE categories SET parent_id = NULL WHERE parent_id = $1`, [id])
        await query(client, `DELETE FROM categories WHERE id = $1 AND tenant_id = $2`, [id, scope.tenantId])
      })

      reply.send({ ok: true })
    } catch (err) {
      sendError(reply, err)
    }
  })
}
