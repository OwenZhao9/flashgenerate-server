/**
 * 生成结果归档。
 *
 * 验收第 5 条：结果必须转存到我方对象存储，供应商的临时链接失效后客户仍能预览下载。
 * 所以 origin_url 只留档排查，任何读取路径都不许用它。
 */

import { one, pool, query } from '../db/index.ts'
import type { Capability, PollResult } from '../providers/types.ts'
import { hasStorage, keyFor, transferFromUrl } from '../storage/index.ts'

/** 能力产出什么类型的资产 */
const ASSET_TYPE: Record<Capability, string> = {
  image: 'image',
  video: 'video',
  avatar: 'video',
  tts: 'audio',
  voice_clone: 'voice',
  lipsync: 'video',
  person: 'avatar',
}

async function defaultCategory(tenantId: string, name: string): Promise<string | null> {
  const row = await one<{ id: string }>(
    pool,
    `SELECT id FROM categories WHERE tenant_id = $1 AND name = $2 AND is_system LIMIT 1`,
    [tenantId, name],
  )
  return row?.id ?? null
}

const CATEGORY_NAME: Record<string, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
  avatar: '数字人',
  voice: '音色',
  text: '文案',
}

export async function archiveOutputs(
  task: Record<string, unknown>,
  result: PollResult,
): Promise<string[]> {
  const tenantId = String(task.tenant_id)
  const createdBy = String(task.created_by)
  const capability = task.capability as Capability
  const baseName = String(task.name || '生成结果')
  const type = ASSET_TYPE[capability] ?? 'video'
  const categoryId = await defaultCategory(tenantId, CATEGORY_NAME[type] ?? '视频')

  const ids: string[] = []

  // 声音克隆和定制数字人产出的是可引用的 id，没有文件可下载
  if (result.resourceId && !result.outputs.length) {
    const row = await one<{ id: string }>(
      pool,
      `INSERT INTO assets (tenant_id, created_by, type, name, category_id, source, meta, status)
       VALUES ($1,$2,$3::asset_type,$4,$5,'generated',$6::jsonb,'ready') RETURNING id`,
      [
        tenantId,
        createdBy,
        type,
        baseName,
        categoryId,
        JSON.stringify({ providerRef: { id: result.resourceId }, capability }),
      ],
    )
    if (row) ids.push(row.id)
    return ids
  }

  if (!hasStorage()) {
    throw new Error('尚未配置对象存储，无法保存生成结果')
  }

  const multiple = result.outputs.length > 1
  for (const [i, out] of result.outputs.entries()) {
    const name = multiple ? `${baseName} ${i + 1}` : baseName
    // 后缀优先看地址本身。供应商大多不在响应头里给准确的 mime，
    // 光按 kind 猜会出现「叫 .png 的 JPEG」，下载下来打不开或者看着别扭。
    const key = keyFor(tenantId, type, `${name}.${extOf(out.url, out.mime, out.kind)}`)
    const stored = await transferFromUrl(out.url, key, out.mime)

    const row = await one<{ id: string }>(
      pool,
      `INSERT INTO assets
         (tenant_id, created_by, type, name, category_id, source,
          storage_key, size_bytes, mime_type, origin_url, meta, status)
       VALUES ($1,$2,$3::asset_type,$4,$5,'generated',$6,$7,$8,$9,$10::jsonb,'ready')
       RETURNING id`,
      [
        tenantId,
        createdBy,
        type,
        name,
        categoryId,
        stored.key,
        stored.size,
        stored.mime,
        // 只留档，读取一律走我方存储
        out.url,
        JSON.stringify({
          capability,
          modelCode: task.model_code ?? null,
          sha256: stored.sha256,
          duration: result.usage?.unit === 'second' ? result.usage.amount : undefined,
          ...out.meta,
        }),
      ],
    )
    if (row) ids.push(row.id)
  }

  return ids
}

function extOf(url: string, mime: string | undefined, kind: string): string {
  const fromUrl = /\.([A-Za-z0-9]{2,5})(?:[?#]|$)/.exec(url)?.[1]?.toLowerCase()
  if (fromUrl && ['mp4', 'webm', 'mov', 'png', 'jpg', 'jpeg', 'webp', 'mp3', 'wav', 'm4a'].includes(fromUrl)) {
    return fromUrl === 'jpeg' ? 'jpg' : fromUrl
  }
  if (mime?.includes('mp4')) return 'mp4'
  if (mime?.includes('webm')) return 'webm'
  if (mime?.includes('png')) return 'png'
  if (mime?.includes('jpeg') || mime?.includes('jpg')) return 'jpg'
  if (mime?.includes('webp')) return 'webp'
  if (mime?.includes('mpeg') || mime?.includes('mp3')) return 'mp3'
  if (mime?.includes('wav')) return 'wav'
  return kind === 'video' ? 'mp4' : kind === 'audio' ? 'mp3' : 'png'
}
