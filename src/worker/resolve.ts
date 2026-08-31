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
import {
  ProviderError,
  type AssetPurpose,
  type Capability,
  type Provider,
  type ProviderContext,
} from '../providers/types.ts'
import { signedGetUrl } from '../storage/index.ts'

interface AssetRow {
  id: string
  name: string
  mime_type: string | null
  storage_key: string | null
  meta: Record<string, unknown>
}

type RefForm = 'url' | 'fileId'

function isRef(v: unknown): v is { $asset: string; as?: RefForm } {
  return typeof v === 'object' && v !== null && typeof (v as { $asset?: unknown }).$asset === 'string'
}

/**
 * 各能力要的素材用途。
 *
 * 平台按用途分桶，桶不对下游就当文件不存在——一段视频当合成背景传过，
 * 拿去做口型驱动会被拒，报的还是「视频文件还未完成上传」，很难往回查。
 * 所以引用解析时要看这次的用途跟当初传的是不是一回事，不是就重传一遍。
 */
const PURPOSE_BY_CAPABILITY: Partial<Record<Capability, AssetPurpose>> = {
  image: 'reference',
  video: 'reference',
  avatar: 'background',
  person: 'avatar_training',
  lipsync: 'lipsync_source',
  voice_clone: 'audio',
  tts: 'audio',
}

/** 供应商那份引用是不是还能用：没过期，而且用途对得上 */
function refIsFresh(meta: Record<string, unknown>, want?: AssetPurpose): boolean {
  const ref = (meta.providerRef ?? {}) as Record<string, unknown>
  if (!ref.url && !ref.fileId) return false

  // 用途不同就得重传，哪怕还没过期
  if (want && ref.purpose && ref.purpose !== want) return false
  // 老记录没存用途，无从判断，保险起见重传一次把它补上
  if (want && !ref.purpose) return false

  const expires = typeof ref.expiresAt === 'string' ? Date.parse(ref.expiresAt) : NaN
  // 到期前一天就当它过期，别卡在边界上
  return Number.isFinite(expires) ? expires - Date.now() > 24 * 60 * 60 * 1000 : false
}

/**
 * 把一个素材变成供应商能用的地址。
 * 过期或从来没传过就拿我方存的原件重传一次，并把新引用写回资产。
 */
/**
 * 把一个素材换成供应商能用的形式。
 *
 * form 决定给地址还是给文件 id。平台的参数两种都有：
 * ref_img_url 之类要地址，video_file_id / audio_file_id / bg.file_id 要文件 id。
 * 给错了平台会拿 URL 当文件 id 去查，找不到，回一句
 * 「视频文件还未完成上传」——文件好好的，纯粹是形式给错了。
 */
async function resolveOne(
  provider: Provider,
  ctx: ProviderContext,
  tenantId: string,
  assetId: string,
  purpose?: AssetPurpose,
  form: RefForm = 'url',
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

  if (refIsFresh(meta, purpose)) {
    const cached = form === 'fileId' ? ref.fileId : ref.url
    if (typeof cached === 'string' && cached) return cached
  }

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
    purpose,
  })

  const nextRef = {
    ...ref,
    fileId: up.fileId,
    url: up.url,
    purpose: up.purpose ?? purpose,
    expiresAt: up.expiresAt?.toISOString(),
  }
  await query(
    pool,
    `UPDATE assets SET meta = jsonb_set(meta, '{providerRef}', $2::jsonb), updated_at = now()
      WHERE id = $1`,
    [assetId, JSON.stringify(nextRef)],
  )

  const out = form === 'fileId' ? up.fileId : up.url
  if (!out) {
    throw new ProviderError(
      'provider_error',
      `素材「${asset.name}」重传后没有拿到${form === 'fileId' ? '文件 id' : '可用地址'}`,
    )
  }
  return out
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
  capability?: Capability,
  cache = new Map<string, Promise<string>>(),
): Promise<unknown> {
  const purpose = capability ? PURPOSE_BY_CAPABILITY[capability] : undefined

  if (isRef(params)) {
    const form: RefForm = params.as === 'fileId' ? 'fileId' : 'url'
    // 同一个素材可能既被要地址又被要文件 id，缓存键要带上形式
    const key = `${params.$asset}:${form}`
    if (!cache.has(key)) {
      cache.set(key, resolveOne(provider, ctx, tenantId, params.$asset, purpose, form))
    }
    return cache.get(key)!
  }

  if (Array.isArray(params)) {
    return Promise.all(params.map((v) => resolveRefs(provider, ctx, tenantId, v, capability, cache)))
  }

  if (params && typeof params === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
      out[k] = await resolveRefs(provider, ctx, tenantId, v, capability, cache)
    }
    return out
  }

  return params
}
