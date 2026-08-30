/**
 * 蝉镜适配器。
 *
 * 职责边界：把这一家的接口翻译成 Provider 接口，状态和错误在这里归一，
 * 往上一律不透供应商特有的概念。调度层看不到 status 30 或 progress_desc 这种东西。
 */

import {
  ProviderError,
  registerProvider,
  type BalanceEntry,
  type Capability,
  type Output,
  type PollResult,
  type Provider,
  type ProviderContext,
  type ActualCost,
  type ProviderModel,
  type SubmitInput,
  type SubmitResult,
  type TaskStatus,
  type UploadResult,
  type Usage,
} from '../types.ts'
import { get, post, readCredentials } from './client.ts'
import { CHANJING_MODELS } from './models.ts'

const ID = 'chanjing'

// ---------------------------------------------------------------------------
// 状态归一
// ---------------------------------------------------------------------------

/**
 * 视频合成与口型驱动共用这套码：10 处理中，30 成功，4x 参数错，5x 服务错。
 *
 * 判断顺序只有一种排法说得通：先看错误码，再看队列状态。
 * 一条判了参数错的任务照样会被出队标成 completed，
 * 要是让 completed 先短路，这种任务会被当成成功归档，失败原因也一并丢掉。
 */
function fromVideoStatus(status: number | undefined, queue?: string): TaskStatus {
  if (status != null && status >= 50) return 'failed'
  if (status != null && status >= 40) return 'fatal'
  if (queue === 'failed') return 'failed'
  if (status === 30 || queue === 'completed') return 'success'
  if (queue === 'queued') return 'pending'
  if (queue === 'processing') return 'running'
  if (status === 10) return 'running'
  return 'pending'
}

/** AI 创作的七态。官方明确 Error 可重试、Fail 不可重试，这是两者唯一的区别。 */
const AIGC_STATUS: Record<string, TaskStatus> = {
  Queued: 'pending',
  Ready: 'pending',
  Generating: 'running',
  Success: 'success',
  Error: 'failed',
  Fail: 'fatal',
  Cancelled: 'cancelled',
}

const AIGC_PROGRESS: Record<string, number> = {
  Queued: 0,
  Ready: 8,
  Generating: 55,
  Success: 100,
  Error: 0,
  Fail: 0,
  Cancelled: 0,
}

/** 定制数字人与声音克隆共用：1 处理中，2 成功，4 失败，5 系统错误。 */
function fromTrainStatus(status?: number): TaskStatus {
  switch (status) {
    case 2:
      return 'success'
    // 4 基本是训练素材不合格，同一份素材再来一次仍然过不了
    case 4:
      return 'fatal'
    case 5:
      return 'failed'
    default:
      return 'running'
  }
}

function clampProgress(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n)))
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

function num(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

// ---------------------------------------------------------------------------
// 各能力的提交与查询
// ---------------------------------------------------------------------------

/** 能力到 creation_type 的映射，AI 创作用 */
const CREATION_TYPE: Partial<Record<Capability, 3 | 4>> = { image: 3, video: 4 }

async function submitFor(ctx: ProviderContext, input: SubmitInput): Promise<SubmitResult> {
  const { capability, params } = input

  switch (capability) {
    case 'avatar': {
      const id = await post<string>(ctx, ID, '/create_video', params)
      return { providerTaskId: String(id) }
    }

    case 'image':
    case 'video': {
      // 图片和视频共用一组接口，靠 model_code 与 creation_type 区分，两个都必填。
      // video_duration 是视频模型的必填项，缺了会被拒，由模型配置负责带上。
      if (!input.modelCode) {
        throw new ProviderError('bad_param', '这项能力必须指定模型')
      }
      const body = {
        ...params,
        model_code: input.modelCode,
        creation_type: CREATION_TYPE[capability],
      }
      const id = await post<string>(ctx, ID, '/ai_creation/task/submit', body)
      return { providerTaskId: String(id) }
    }

    case 'tts': {
      const res = await post<{ task_id?: string }>(ctx, ID, '/create_audio_task_v2', params)
      const id = str(res?.task_id)
      if (!id) throw new ProviderError('provider_error', '平台没有返回任务号', { raw: res })
      return { providerTaskId: id }
    }

    case 'voice_clone': {
      const id = await post<string>(ctx, ID, '/create_customised_audio', params)
      return { providerTaskId: String(id) }
    }

    case 'person': {
      const id = await post<string>(ctx, ID, '/create_customised_person', params)
      return { providerTaskId: String(id) }
    }

    case 'lipsync': {
      const id = await post<string>(ctx, ID, '/video_lip_sync/create', params)
      return { providerTaskId: String(id) }
    }

    default:
      throw new ProviderError('bad_param', `该供应商不支持能力 ${capability}`)
  }
}

function videoOutputs(d: Record<string, unknown>): Output[] {
  const url = str(d.video_url) ?? str(d.preview_url)
  return url ? [{ kind: 'video', url, mime: 'video/mp4' }] : []
}

async function pollFor(
  ctx: ProviderContext,
  capability: Capability,
  providerTaskId: string,
): Promise<PollResult> {
  switch (capability) {
    case 'avatar': {
      const d = await get<Record<string, unknown>>(ctx, ID, '/video', { id: providerTaskId })
      const status = fromVideoStatus(num(d?.status), str(d?.queue_status))
      const failed = status === 'failed' || status === 'fatal'
      return {
        status,
        progress: status === 'success' ? 100 : clampProgress(d?.progress),
        outputs: status === 'success' ? videoOutputs(d ?? {}) : [],
        // 视频按秒计费，用量交给上层换算成点数
        usage: num(d?.duration) ? ({ unit: 'second', amount: num(d.duration)! } as Usage) : undefined,
        error: failed
          ? { code: status === 'fatal' ? 'bad_param' : 'provider_error', message: str(d?.msg) ?? '合成失败' }
          : undefined,
        raw: d,
      }
    }

    case 'image':
    case 'video': {
      const d = await get<Record<string, unknown>>(ctx, ID, '/ai_creation/task', {
        unique_id: providerTaskId,
      })
      const desc = str(d?.progress_desc) ?? 'Generating'
      const status = AIGC_STATUS[desc] ?? 'running'
      const urls = Array.isArray(d?.output_url) ? (d.output_url as unknown[]).filter((u): u is string => typeof u === 'string' && !!u) : []
      const isVideo = capability === 'video'
      const motion = (d?.motion_info ?? {}) as Record<string, unknown>

      return {
        status,
        progress: status === 'success' ? 100 : (AIGC_PROGRESS[desc] ?? 30),
        outputs: urls.map((url) => ({
          kind: isVideo ? 'video' : 'image',
          url,
          mime: isVideo ? 'video/mp4' : undefined,
        })),
        usage: isVideo && num(motion.video_duration)
          ? ({ unit: 'second', amount: num(motion.video_duration)! } as Usage)
          : ({ unit: 'count', amount: Math.max(1, urls.length) } as Usage),
        error:
          status === 'failed' || status === 'fatal'
            ? {
                code: status === 'fatal' ? 'content_rejected' : 'provider_error',
                message: str(d?.err_msg) ?? '生成失败',
              }
            : undefined,
        raw: d,
      }
    }

    case 'tts': {
      const d = await post<Record<string, unknown>>(ctx, ID, '/audio_task_state', {
        task_id: providerTaskId,
      })
      const st = num(d?.status)
      const done = st === 9
      const url = str(d?.audio_url) ?? str(d?.url)
      return {
        status: done ? (url ? 'success' : 'failed') : 'running',
        progress: done ? 100 : 50,
        outputs: done && url ? [{ kind: 'audio', url, mime: 'audio/mpeg' }] : [],
        usage: num(d?.duration) ? ({ unit: 'second', amount: num(d.duration)! } as Usage) : undefined,
        error: done && !url ? { code: 'provider_error', message: str(d?.msg) ?? '合成失败' } : undefined,
        raw: d,
      }
    }

    case 'voice_clone': {
      const d = await get<Record<string, unknown>>(ctx, ID, '/customised_audio', { id: providerTaskId })
      const status = fromTrainStatus(num(d?.status))
      return {
        status,
        progress: status === 'success' ? 100 : clampProgress(d?.progress),
        outputs: [],
        // 声音克隆产出的是一个音色 id，不是文件
        resourceId: status === 'success' ? providerTaskId : undefined,
        usage: { unit: 'count', amount: 1 },
        error:
          status === 'failed' || status === 'fatal'
            ? {
                code: status === 'fatal' ? 'bad_param' : 'provider_error',
                message: str(d?.err_reason) ?? str(d?.reason) ?? '训练失败',
              }
            : undefined,
        raw: d,
      }
    }

    case 'person': {
      const d = await get<Record<string, unknown>>(ctx, ID, '/customised_person', { id: providerTaskId })
      const status = fromTrainStatus(num(d?.status))
      return {
        status,
        progress: status === 'success' ? 100 : clampProgress(d?.progress),
        outputs: [],
        resourceId: status === 'success' ? providerTaskId : undefined,
        usage: { unit: 'count', amount: 1 },
        error:
          status === 'failed' || status === 'fatal'
            ? {
                code: status === 'fatal' ? 'bad_param' : 'provider_error',
                message: str(d?.err_reason) ?? str(d?.reason) ?? '训练失败',
              }
            : undefined,
        raw: d,
      }
    }

    case 'lipsync': {
      const d = await get<Record<string, unknown>>(ctx, ID, '/video_lip_sync/detail', {
        id: providerTaskId,
      })
      // 口型驱动没有 queue_status，状态码与视频合成同一套
      const status = fromVideoStatus(num(d?.status))
      const failed = status === 'failed' || status === 'fatal'
      return {
        status,
        progress: status === 'success' ? 100 : clampProgress(d?.progress),
        outputs: status === 'success' ? videoOutputs(d ?? {}) : [],
        usage: num(d?.duration) ? ({ unit: 'second', amount: num(d.duration)! } as Usage) : undefined,
        error: failed
          ? { code: status === 'fatal' ? 'bad_param' : 'provider_error', message: str(d?.msg) ?? '驱动失败' }
          : undefined,
        raw: d,
      }
    }

    default:
      throw new ProviderError('bad_param', `该供应商不支持能力 ${capability}`)
  }
}

// ---------------------------------------------------------------------------
// 上传
// ---------------------------------------------------------------------------

interface UploadUrlRsp {
  sign_url: string
  file_id: string
  full_path: string
  mime_type: string
  headers?: Record<string, string>
}

/** 按素材类型选平台的上传用途，它决定对方的格式校验和存储桶 */
function serviceFor(mime: string): string {
  if (mime.startsWith('audio/')) return 'lip_sync_audio'
  if (mime.startsWith('video/')) return 'make_video_background'
  return 'ai_creation'
}

async function upload(
  ctx: ProviderContext,
  file: { name: string; mime: string; size: number; body: AsyncIterable<Uint8Array> | Buffer },
): Promise<UploadResult> {
  const signed = await get<UploadUrlRsp>(ctx, ID, '/common/create_upload_url', {
    service: serviceFor(file.mime),
    name: file.name,
  })

  const buf = Buffer.isBuffer(file.body) ? file.body : Buffer.from(await collect(file.body))

  // Content-Type 必须用平台返回的 mime_type，不能用我们自己判断的那个。
  // OSS V1 签名把 Content-Type 算进 string-to-sign，值不一致直接 403 SignatureDoesNotMatch。
  // 实测：传 image/png 得 200，改成 application/octet-stream 立刻 403。
  const headers: Record<string, string> = { 'Content-Type': signed.mime_type || file.mime }
  for (const [k, v] of Object.entries(signed.headers ?? {})) headers[k] = v

  const startedAt = Date.now()
  const put = await fetch(signed.sign_url, { method: 'PUT', headers, body: new Uint8Array(buf) })
  ctx.log({
    method: 'PUT',
    path: '(oss)',
    durationMs: Date.now() - startedAt,
    ok: put.ok,
    code: put.status,
  })

  if (!put.ok) {
    const text = await put.text().catch(() => '')
    throw new ProviderError('provider_error', `素材上传失败，HTTP ${put.status}`, {
      raw: text.slice(0, 500),
    })
  }

  // 上传成功后平台有最长约 1 分钟的同步延迟，要等到 status === 1 才能拿去提交下游任务。
  await waitFileReady(ctx, signed.file_id)

  return {
    fileId: signed.file_id,
    url: signed.full_path,
    // 平台的上传素材保留 30 天，到点要标记失效并重传
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  }
}

async function collect(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const c of body) {
    chunks.push(c)
    total += c.length
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

async function waitFileReady(ctx: ProviderContext, fileId: string): Promise<void> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const d = await get<Record<string, unknown>>(ctx, ID, '/common/file_detail', { id: fileId })
    const status = num(d?.status)
    if (status === 1) return
    if (status === 98) throw new ProviderError('content_rejected', '素材未通过平台审核')
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new ProviderError('timeout', '素材上传后同步超时，请稍后重试')
}

// ---------------------------------------------------------------------------

async function balance(ctx: ProviderContext): Promise<BalanceEntry[]> {
  const d = await get<Record<string, unknown>>(ctx, ID, '/user_duration')
  const out: BalanceEntry[] = []
  // resi_total_bean 是剩余总量。
  // bean_day30 是其中 30 天内会过期的部分——平台充值的蝉豆有效期 31 天，
  // 到期未用清零，所以这个数要单独盯着，它是「该用掉还是该少充」的信号。
  if (num(d?.resi_total_bean) != null) {
    out.push({ currency: 'bean', amount: num(d.resi_total_bean)!, raw: d })
  }
  if (num(d?.bean_day30) != null) {
    out.push({ currency: 'bean_expiring_30d', amount: num(d.bean_day30)!, raw: d })
  }
  return out
}

/**
 * 查一笔任务的实际扣费。
 *
 * 平台的消耗明细按任务号记账，这是唯一权威的数字。
 * 时间参数用北京时间，传 UTC 查不到（实测空列表）。
 * 出账有延迟，查不到时返回 null，由调用方决定是等还是先按估算记。
 */
async function actualCost(
  ctx: ProviderContext,
  providerTaskId: string,
  at: Date,
): Promise<ActualCost | null> {
  const fmt = (d: Date): string => {
    // 平台按北京时间过滤，这里把 UTC 时刻换算成北京时间的字面量
    const bj = new Date(d.getTime() + 8 * 3600_000)
    return bj.toISOString().replace('T', ' ').slice(0, 19)
  }

  // 往前后各放宽一小时，避免边界和时钟偏差把这一笔漏掉
  const res = await post<{ list?: Array<Record<string, unknown>> }>(ctx, ID, '/consume_detail', {
    start_time: fmt(new Date(at.getTime() - 3600_000)),
    end_time: fmt(new Date(at.getTime() + 3600_000)),
    page: 1,
    page_size: 200,
  })

  const hit = (res?.list ?? []).find((x) => String(x.task_id ?? '') === providerTaskId)
  if (!hit) return null

  const amount = num(hit.bean_amount)
  if (amount === undefined) return null

  return { currency: 'bean', amount, note: str(hit.consume_type) }
}

async function models(): Promise<ProviderModel[]> {
  return CHANJING_MODELS
}

export const chanjing: Provider = {
  id: ID,
  label: 'AI 开放平台',
  capabilities: ['image', 'video', 'avatar', 'tts', 'voice_clone', 'lipsync', 'person'],
  // 平台有蝉豆和魔力两种货币，不同能力扣的不一样。
  // 客户看到的永远是统一点数，这两个名字只出现在账本和对账里。
  currencies: ['bean', 'magic'],

  submit: (ctx, input) => submitFor(ctx, input),
  poll: (ctx, capability, id) => pollFor(ctx, capability, id),
  upload,
  balance,
  actualCost,
  models,
}

/** 校验凭据能不能用，管理后台填完点测试时调 */
export async function testCredentials(ctx: ProviderContext): Promise<void> {
  readCredentials(ctx.credentials)
  await get<unknown>(ctx, ID, '/user_info')
}

registerProvider(chanjing)
