/**
 * 对象存储。
 *
 * 私有桶，对外一律走限时签名地址（验收第 6 条）。任何时候都不要把桶设成公开读，
 * 也不要下发固定地址——那等于让所有客户互相能拿到对方的文件。
 *
 * 用 S3 兼容接口，Cloudflare R2、阿里云 OSS、MinIO 都能接，不锁死在某一家。
 */

import { createHash, randomUUID } from 'node:crypto'
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { env, hasStorage } from '../lib/env.ts'

let client: S3Client | null = null

function s3(): S3Client {
  if (!hasStorage()) {
    throw new Error('尚未配置对象存储，请填写 S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY')
  }
  client ??= new S3Client({
    region: env.s3.region,
    endpoint: env.s3.endpoint,
    credentials: {
      accessKeyId: env.s3.accessKeyId,
      secretAccessKey: env.s3.secretAccessKey,
    },
    // R2 和 MinIO 都要求路径风格
    forcePathStyle: true,
  })
  return client
}

/**
 * 对象键里带上租户 id。
 *
 * 这不是为了鉴权——鉴权在下发签名地址之前就做完了——而是为了出事时能一眼看出
 * 某个文件属于谁，以及删租户时能按前缀清干净。
 */
export function keyFor(tenantId: string, kind: string, filename: string): string {
  const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : ''
  const safeExt = /^\.[A-Za-z0-9]{1,8}$/.test(ext) ? ext.toLowerCase() : ''
  return `${tenantId}/${kind}/${randomUUID()}${safeExt}`
}

export async function put(
  key: string,
  body: Buffer | Uint8Array,
  mime?: string,
): Promise<{ key: string; size: number; etag?: string }> {
  const res = await s3().send(
    new PutObjectCommand({
      Bucket: env.s3.bucket,
      Key: key,
      Body: body,
      ContentType: mime || 'application/octet-stream',
    }),
  )
  return { key, size: body.byteLength, etag: res.ETag }
}

/** 下发给浏览器的读地址。到期自动失效，不存在长期有效的公开链接。 */
export async function signedGetUrl(key: string, ttlSeconds = env.s3.signedUrlTtl): Promise<string> {
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: env.s3.bucket, Key: key }), {
    expiresIn: ttlSeconds,
  })
}

export async function remove(key: string): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: env.s3.bucket, Key: key }))
}

/** 单个文件的大小上限，防止一个超大响应把内存吃光 */
const MAX_TRANSFER_BYTES = 512 * 1024 * 1024

export class TransferError extends Error {
  readonly reason: string

  constructor(reason: string, message: string) {
    super(message)
    this.name = 'TransferError'
    this.reason = reason
  }
}

/**
 * 把供应商的临时结果转存到我方存储（验收第 5 条）。
 *
 * 有一个必须防住的情况：供应商的地址失效之后，请求往往不是 404，
 * 而是 200 加一个 HTML 错误页。不检查内容类型就会把一段 HTML 当成视频存下来，
 * 用户点开是坏文件，而且查不出原因——这个坑在浏览器那版踩过一次。
 */
export async function transferFromUrl(
  url: string,
  key: string,
  expectedMime?: string,
): Promise<{ key: string; size: number; mime: string; sha256: string }> {
  // 网络抖一下就放弃是不行的：走到这一步说明生成已经成功、供应商已经扣过费，
  // 这时候失败等于我方白付钱、客户还拿不到东西。所以先在这里自己重试几次。
  let res: Response | null = null
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(180_000) })
      break
    } catch (err) {
      lastErr = err
    }
  }
  if (!res) {
    throw new TransferError('unreachable', `下载生成结果失败：${String(lastErr)}`)
  }

  if (!res.ok) {
    throw new TransferError('http_error', `下载生成结果失败，HTTP ${res.status}`)
  }

  const mime = res.headers.get('content-type')?.split(';')[0]?.trim() || expectedMime || 'application/octet-stream'

  // 供应商地址失效时经常回 200 + HTML 错误页。存下来就是个打不开的坏文件。
  if (mime.startsWith('text/html')) {
    throw new TransferError('expired', '生成结果的地址已失效，返回的是网页而不是文件')
  }

  const len = Number(res.headers.get('content-length') ?? 0)
  if (len > MAX_TRANSFER_BYTES) {
    throw new TransferError('too_large', `文件超过 ${Math.round(MAX_TRANSFER_BYTES / 1024 / 1024)}MB`)
  }

  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.byteLength === 0) throw new TransferError('empty', '下载到的文件是空的')
  if (buf.byteLength > MAX_TRANSFER_BYTES) {
    throw new TransferError('too_large', '文件超出大小上限')
  }

  await put(key, buf, mime)

  return {
    key,
    size: buf.byteLength,
    mime,
    sha256: createHash('sha256').update(buf).digest('hex'),
  }
}

export { hasStorage }
