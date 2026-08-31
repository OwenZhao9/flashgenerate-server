/**
 * 资料库接口。
 *
 * 读文件一律走这里换一个限时签名地址，不下发固定地址（验收第 6 条）。
 * 换签名之前先按租户校验归属，所以拿到别人的 asset id 也换不出地址来。
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { one, pool, query } from '../db/index.ts'
import { HttpError, scopeOf, sendError } from '../auth/guard.ts'
import { hasStorage, keyFor, put, signedGetUrl } from '../storage/index.ts'
import { loadProvider } from '../worker/context.ts'

/** 上传大小上限，跟平台的素材限制对齐 */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

export function assetRoutes(app: FastifyInstance): void {
  app.get('/api/categories', async (req, reply) => {
    try {
      const scope = scopeOf(req)
      const rows = await query(
        pool,
        `SELECT id, name, parent_id, sort, is_system FROM categories
          WHERE tenant_id = $1 ORDER BY sort, name`,
        [scope.tenantId],
      )
      reply.send({ categories: rows })
    } catch (err) {
      sendError(reply, err)
    }
  })

  app.get('/api/assets', async (req, reply) => {
    try {
      const scope = scopeOf(req)
      const q = req.query as Record<string, string | undefined>
      const limit = Math.min(200, Math.max(1, Number(q.limit ?? 60)))
      const offset = Math.max(0, Number(q.offset ?? 0))

      const rows = await query(
        pool,
        `SELECT id, type, name, description, category_id, tags, source, size_bytes, mime_type,
                content, meta, status, favorite, used_count, created_at, updated_at,
                (storage_key IS NOT NULL) AS has_file
           FROM assets
          WHERE tenant_id = $1
            AND deleted_at IS NULL
            AND ($2::asset_type IS NULL OR type = $2::asset_type)
            AND ($3::uuid IS NULL OR category_id = $3::uuid)
            AND ($4::text IS NULL OR name ILIKE '%' || $4 || '%')
          ORDER BY created_at DESC
          LIMIT $5 OFFSET $6`,
        [scope.tenantId, q.type || null, q.categoryId || null, q.keyword || null, limit, offset],
      )
      reply.send({ assets: rows })
    } catch (err) {
      sendError(reply, err)
    }
  })

  /**
   * 换一个限时读地址。
   * 校验归属在换地址之前，所以别的租户拿着 id 过来只会得到 404。
   */
  app.get('/api/assets/:id/url', async (req, reply) => {
    try {
      const scope = scopeOf(req)
      const { id } = req.params as { id: string }

      const row = await one<{ storage_key: string | null; mime_type: string | null }>(
        pool,
        `SELECT storage_key, mime_type FROM assets
          WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [id, scope.tenantId],
      )
      if (!row) throw new HttpError(404, 'not_found', '素材不存在')
      if (!row.storage_key) throw new HttpError(409, 'no_file', '这条记录没有可下载的文件')

      const url = await signedGetUrl(row.storage_key)
      reply.send({ url, mimeType: row.mime_type, expiresIn: 900 })
    } catch (err) {
      sendError(reply, err)
    }
  })

  /**
   * 上传素材。
   *
   * 走两步：先存我方对象存储留底，再传一份到供应商供生成时引用。
   * 供应商那份 30 天会被清理，到时候拿我方这份重传即可，用户不用重新上传。
   */
  app.post('/api/assets/upload', async (req, reply) => {
    try {
      const scope = scopeOf(req)
      if (!hasStorage()) throw new HttpError(503, 'no_storage', '尚未配置对象存储')

      const q = req.query as Record<string, string | undefined>
      const name = (q.name ?? 'upload').slice(0, 200)
      const type = z.enum(['image', 'video', 'audio']).parse(q.type ?? 'image')
      // 用途决定平台把文件放进哪个桶。调用方知道就传，不传按类型给个兜底，
      // 真正用到的时候引用解析会按当次能力再校一遍，不对就重传。
      const purpose = q.purpose
        ? z.enum(['reference', 'background', 'avatar_training', 'lipsync_source', 'audio']).parse(q.purpose)
        : undefined
      const mime = req.headers['content-type']?.split(';')[0]?.trim() || 'application/octet-stream'

      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req.raw) {
        const b = Buffer.from(chunk as Uint8Array)
        size += b.length
        if (size > MAX_UPLOAD_BYTES) throw new HttpError(413, 'too_large', '文件超过 100MB')
        chunks.push(b)
      }
      if (!size) throw new HttpError(400, 'empty', '没有收到文件内容')
      const body = Buffer.concat(chunks)

      const key = keyFor(scope.tenantId, type, name)
      await put(key, body, mime)

      // 传一份到供应商。这一步失败不影响素材入库，
      // 只是生成时要再传一次，所以单独 catch 掉。
      let providerRef: Record<string, unknown> = {}
      try {
        const { provider, ctx } = await loadProvider('chanjing', { tenantId: scope.tenantId })
        const up = await provider.upload(ctx, { name, mime, size, body, purpose })
        providerRef = {
          fileId: up.fileId,
          url: up.url,
          purpose: up.purpose,
          expiresAt: up.expiresAt,
        }
      } catch (err) {
        req.log.warn({ err }, '素材传到供应商失败，仅存本地')
      }

      const row = await one(
        pool,
        `INSERT INTO assets
           (tenant_id, created_by, type, name, source, storage_key, size_bytes, mime_type, meta, status)
         VALUES ($1,$2,$3::asset_type,$4,'uploaded',$5,$6,$7,$8::jsonb,'ready')
         RETURNING id, type, name, size_bytes, mime_type, created_at`,
        [scope.tenantId, scope.accountId, type, name, key, size, mime, JSON.stringify({ providerRef })],
      )

      reply.send({ asset: row })
    } catch (err) {
      if (err instanceof z.ZodError) {
        return sendError(reply, new HttpError(400, 'bad_request', '素材类型不正确'))
      }
      sendError(reply, err)
    }
  })

  app.delete('/api/assets/:id', async (req, reply) => {
    try {
      const scope = scopeOf(req)
      const { id } = req.params as { id: string }
      const rows = await query(
        pool,
        `UPDATE assets SET deleted_at = now(), updated_at = now()
          WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL RETURNING id`,
        [id, scope.tenantId],
      )
      if (!rows.length) throw new HttpError(404, 'not_found', '素材不存在')
      reply.send({ ok: true })
    } catch (err) {
      sendError(reply, err)
    }
  })
}
