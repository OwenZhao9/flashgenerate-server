/**
 * 素材引用解析。
 *
 * 前端交上来的生成参数里，素材是一个引用而不是地址：
 *   { "url": { "$asset": "<素材 id>" } }
 *
 * 提交给供应商之前在这里换成对方能用的地址。这一步之所以必须在服务端：
 * 供应商的上传素材 30 天就清理，过期后要拿原件重传一次，
 * 而原件在我方对象存储里，凭据也在我方手上——浏览器两样都没有。
 *
 * 顺带解决了换供应商的问题：引用形式不变，各家要 url 还是 file_id
 * 由它自己的适配器决定。
 */

import { one, pool, query } from '../db/index.ts'
import { ProviderError, type Provider, type ProviderContext } from '../providers/types.ts'
import { signedGetUrl } from '../storage/index.ts'

interface AssetRow {
  id: string
  name: string
  mime_type: string | null
  storage_key: string | null
  meta: Record<string, unknown>
}

function isRef(v: unknown): v is { $asset: string } {
  return typeof v === 'object' && v !== null && typeof (v as { $asset?: unknown }).$asset === 'string'
}

/** 供应商那份引用是不是还能用 */
function refIsFresh(meta: Record<string, unknown>): boolean {
  const ref = (meta.providerRef ?? {}) as Record<string, unknown>
  if (!ref.url && !ref.fileId) return false
  const expires = typeof ref.expiresAt === 'string' ? Date.parse(ref.expiresAt) : NaN
  // 到期前一天就当它过期，别卡在边界上
  return Number.isFinite(expires) ? expires - Date.now() > 24 * 60 * 60 * 1000 : false
}

/**
 * 把一个素材变成供应商能用的地址。
 * 过期或从来没传过就拿我方存的原件重传一次，并把新引用写回资产。
 */
async function resolveOne(
  provider: Provider,
  ctx: ProviderContext,
  tenantId: string,
  assetId: string,
): Promise<string> {
  const asset = await one<AssetRow>(
    pool,
    `SELECT id, name, mime_type, storage_key, meta FROM assets
      WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [assetId, tenantId],
  )
  if (!asset) throw new ProviderError('missing_resource', '引用的素材不存在或已被删除')

  const meta = asset.meta ?? {}
  const ref = (meta.providerRef ?? {}) as Record<string, unknown>

  if (refIsFresh(meta) && typeof ref.url === 'string') return ref.url

  if (!asset.storage_key) {
    // 没有原件又没有可用引用，只能让用户重新上传
    throw new ProviderError(
      'missing_resource',
      `素材「${asset.name}」在平台上已失效，且本地没有留存原件，请重新上传`,
    )
  }

  // 从我方存储把原件取回来，重传一份给供应商
  const url = await signedGetUrl(asset.storage_key, 600)
  const res = await fetch(url)
  if (!res.ok) throw new ProviderError('provider_error', `取回素材「${asset.name}」失败`)
  const body = Buffer.from(await res.arrayBuffer())

  const up = await provider.upload(ctx, {
    name: asset.name,
    mime: asset.mime_type ?? 'application/octet-stream',
    size: body.byteLength,
    body,
  })

  const nextRef = { ...ref, fileId: up.fileId, url: up.url, expiresAt: up.expiresAt?.toISOString() }
  await query(
    pool,
    `UPDATE assets SET meta = jsonb_set(meta, '{providerRef}', $2::jsonb), updated_at = now()
      WHERE id = $1`,
    [assetId, JSON.stringify(nextRef)],
  )

  if (!up.url) throw new ProviderError('provider_error', `素材「${asset.name}」重传后没有拿到可用地址`)
  return up.url
}

/**
 * 递归展开参数里的所有素材引用。
 * 同一个素材在一次提交里被引用多次时只解析一次，免得重传好几遍。
 */
export async function resolveRefs(
  provider: Provider,
  ctx: ProviderContext,
  tenantId: string,
  params: unknown,
  cache = new Map<string, Promise<string>>(),
): Promise<unknown> {
  if (isRef(params)) {
    const id = params.$asset
    if (!cache.has(id)) cache.set(id, resolveOne(provider, ctx, tenantId, id))
    return cache.get(id)!
  }

  if (Array.isArray(params)) {
    return Promise.all(params.map((v) => resolveRefs(provider, ctx, tenantId, v, cache)))
  }

  if (params && typeof params === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
      out[k] = await resolveRefs(provider, ctx, tenantId, v, cache)
    }
    return out
  }

  return params
}
