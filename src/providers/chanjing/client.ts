/**
 * 平台 HTTP 客户端。
 *
 * 三条从前端那版继承下来的经验，改这里之前先看一眼：
 *
 * 1. HTTP 状态码恒为 200，成功与否看响应体里的 code。不要用 res.ok 判断。
 * 2. access_token 响应里的 expire_in 是「过期时间戳」（10 位秒），不是剩余秒数。
 * 3. 认证头叫 access_token，不是 Authorization。
 */

import { one, pool, query, tx } from '../../db/index.ts'
import { ProviderError, type ErrorCode, type ProviderContext } from '../types.ts'

const BASE = 'https://open-api.chanjing.cc/open/v1'
/** 过期前多久就该换新的 */
const REFRESH_AHEAD_MS = 30 * 60 * 1000

export interface Envelope<T> {
  trace_id?: string
  code: number
  msg?: string
  data: T
}

export interface Credentials {
  appId: string
  secretKey: string
}

export function readCredentials(raw: Record<string, unknown>): Credentials {
  const appId = String(raw.app_id ?? raw.appId ?? '').trim()
  const secretKey = String(raw.secret_key ?? raw.secretKey ?? '').trim()
  if (!appId || !secretKey) {
    throw new ProviderError('auth_failed', '尚未配置该供应商的接口凭据，请在管理后台填写')
  }
  return { appId, secretKey }
}

// ---------------------------------------------------------------------------
// 凭证
// ---------------------------------------------------------------------------

async function fetchFreshToken(cred: Credentials): Promise<{ token: string; expiresAt: Date }> {
  const res = await fetch(`${BASE}/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: cred.appId, secret_key: cred.secretKey }),
  })

  if (!res.ok) {
    throw new ProviderError('provider_error', `取凭证失败，HTTP ${res.status}`)
  }

  const env = (await res.json()) as Envelope<{ access_token: string; expire_in: number }>
  if (env.code !== 0 || !env.data?.access_token) {
    throw new ProviderError('auth_failed', env.msg || '取凭证失败', { traceId: env.trace_id, raw: env })
  }

  // expire_in 是绝对时间戳（秒），不是剩余秒数。看成剩余秒数会得到 1970 年，
  // 于是每次调用都判定过期、每次都重新取，而每次重新取又会把上一个踢掉。
  return { token: env.data.access_token, expiresAt: new Date(env.data.expire_in * 1000) }
}

/**
 * 拿一个可用凭证。
 *
 * 行锁保证同一时刻全局只有一次刷新。拿不到锁的实例会阻塞在 FOR UPDATE 上，
 * 等前面那个提交后读到新值，不会各刷各的把对方顶掉。
 */
export async function getToken(providerId: string, cred: Credentials): Promise<string> {
  const cached = await one<{ token: string; expires_at: Date }>(
    pool,
    `SELECT token, expires_at FROM provider_tokens WHERE provider_id = $1`,
    [providerId],
  )

  if (cached && new Date(cached.expires_at).getTime() - Date.now() > REFRESH_AHEAD_MS) {
    return cached.token
  }

  return tx(async (client) => {
    // 占住这一行。别的实例走到这里会等，等到之后读到的就是刷新后的值。
    const locked = await one<{ token: string; expires_at: Date }>(
      client,
      `SELECT token, expires_at FROM provider_tokens WHERE provider_id = $1 FOR UPDATE`,
      [providerId],
    )

    if (locked && new Date(locked.expires_at).getTime() - Date.now() > REFRESH_AHEAD_MS) {
      return locked.token
    }

    const fresh = await fetchFreshToken(cred)
    await query(
      client,
      `INSERT INTO provider_tokens (provider_id, token, expires_at, refreshed_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (provider_id) DO UPDATE
         SET token = EXCLUDED.token, expires_at = EXCLUDED.expires_at, refreshed_at = now()`,
      [providerId, fresh.token, fresh.expiresAt],
    )
    return fresh.token
  })
}

/** 凭证被判失效时清掉，下一次调用会重新取 */
export async function invalidateToken(providerId: string): Promise<void> {
  await query(pool, `DELETE FROM provider_tokens WHERE provider_id = $1`, [providerId])
}

// ---------------------------------------------------------------------------
// 错误归一
// ---------------------------------------------------------------------------

/**
 * 平台错误码到统一错误类型的映射。
 *
 * 400 和 50000 这两个码平台都拿来当兜底用，光看码判断不出真实原因，
 * 必须再读 msg。这一条是踩过两次坑换来的：
 *   声音克隆返回 400「声音预览文本内容不得超过50个字符」，
 *     按码猜成「音频读不了」，用户反复换音频怎么都不对；
 *   数字人合成返回 50000「文件不存在/您无权使用该文件」，
 *     按码猜成「平台服务异常，请稍后重试」，用户点了四次重试全是白等。
 * 所以：平台把话说清楚了就以平台为准，别用我们的猜测盖掉它。
 */
const MISSING_RESOURCE = /不存在|无权使用|没有找到|not found/i
const BALANCE = /余额不足|额度不足|insufficient/i
const AUDIT = /审核|违规|敏感|违禁/i

export function classify(code: number, msg?: string): ErrorCode {
  const m = msg ?? ''

  switch (code) {
    case 10400:
      return 'auth_failed'
    case 40001:
      return 'rate_limited'
    case 50011:
      return 'content_rejected'
    case 40000:
    case 40002:
      return 'bad_param'
    case 400:
      // 官方释义是「传入参数格式错误」，实际大多是引用的素材取不到
      if (MISSING_RESOURCE.test(m)) return 'missing_resource'
      return 'bad_param'
    case 50000:
      // 官方释义是「系统内部错误」，实际是个兜底码
      if (MISSING_RESOURCE.test(m)) return 'missing_resource'
      if (BALANCE.test(m)) return 'insufficient_balance'
      if (AUDIT.test(m)) return 'content_rejected'
      return 'provider_error'
    default:
      if (MISSING_RESOURCE.test(m)) return 'missing_resource'
      if (BALANCE.test(m)) return 'insufficient_balance'
      return 'unknown'
  }
}

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

interface RequestOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  query?: Record<string, unknown>
  /** 凭证失效时是否已经重试过，内部用 */
  tokenRetried?: boolean
}

function buildUrl(path: string, q?: Record<string, unknown>): string {
  const url = `${BASE}${path.startsWith('/') ? path : `/${path}`}`
  if (!q) return url
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue
    // 数组参数各接口的绑定方式并不统一：/tag_list 的 business_type 可以传多次，
    // 但 /list_common_dp 的 tag_ids 传多次只认第一个、必须拼逗号串。
    // 所以这里不擅自展开，交给调用方决定形状。
    sp.set(k, String(v))
  }
  const qs = sp.toString()
  return qs ? `${url}?${qs}` : url
}

export async function request<T>(
  ctx: ProviderContext,
  providerId: string,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const cred = readCredentials(ctx.credentials)
  const token = await getToken(providerId, cred)
  const method = opts.method ?? 'POST'
  const startedAt = Date.now()

  let res: Response
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method,
      headers: { 'Content-Type': 'application/json; charset=utf-8', access_token: token },
      body: method === 'POST' ? JSON.stringify(opts.body ?? {}) : undefined,
      signal: ctx.signal ?? AbortSignal.timeout(60_000),
    })
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    ctx.log({ method, path, durationMs: Date.now() - startedAt, ok: false, msg: String(err) })
    throw new ProviderError(timedOut ? 'timeout' : 'provider_error', timedOut ? '请求超时' : '网络异常', {
      raw: String(err),
    })
  }

  // 路径写错时会拿到真正的 404 纯文本，「状态码恒为 200」那条在这种情况下不成立
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    ctx.log({ method, path, durationMs: Date.now() - startedAt, ok: false, code: res.status, msg: text.slice(0, 200) })
    throw new ProviderError('provider_error', `接口返回 HTTP ${res.status}`, { raw: text.slice(0, 500) })
  }

  const env = (await res.json()) as Envelope<T>
  ctx.log({
    method,
    path,
    durationMs: Date.now() - startedAt,
    ok: env.code === 0,
    code: env.code,
    msg: env.msg,
    traceId: env.trace_id,
  })

  if (env.code === 0) return env.data

  // 凭证失效换一个重放，只试一次
  if (env.code === 10400 && !opts.tokenRetried) {
    await invalidateToken(providerId)
    return request<T>(ctx, providerId, path, { ...opts, tokenRetried: true })
  }

  throw new ProviderError(classify(env.code, env.msg), env.msg || `平台返回错误码 ${env.code}`, {
    traceId: env.trace_id,
    raw: env,
  })
}

export const get = <T>(ctx: ProviderContext, id: string, path: string, q?: Record<string, unknown>) =>
  request<T>(ctx, id, path, { method: 'GET', query: q })

export const post = <T>(ctx: ProviderContext, id: string, path: string, body?: unknown) =>
  request<T>(ctx, id, path, { method: 'POST', body })
