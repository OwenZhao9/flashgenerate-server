/**
 * 供应商执行上下文。凭据从库里读，任何时候都不外流。
 */

import { one, pool, query } from '../db/index.ts'
import { getProvider, ProviderError, type Provider, type ProviderContext } from '../providers/types.ts'

export interface Loaded {
  provider: Provider
  ctx: ProviderContext
}

/**
 * 装配一个供应商。
 * 日志异步落库，不阻塞主流程——记日志失败不应该让任务跟着失败。
 */
export async function loadProvider(
  providerId: string,
  scope: { tenantId?: string; taskId?: string } = {},
): Promise<Loaded> {
  const row = await one<{ credentials: Record<string, unknown>; enabled: boolean }>(
    pool,
    `SELECT credentials, enabled FROM providers WHERE id = $1`,
    [providerId],
  )
  if (!row) throw new ProviderError('bad_param', `未知的供应商 ${providerId}`)
  if (!row.enabled) throw new ProviderError('provider_error', '该供应商已被管理员停用')

  const provider = getProvider(providerId)

  const ctx: ProviderContext = {
    credentials: row.credentials ?? {},
    log: (entry) => {
      void query(
        pool,
        `INSERT INTO api_logs (tenant_id, task_id, provider_id, method, path, duration_ms, ok, code, msg, trace_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          scope.tenantId ?? null,
          scope.taskId ?? null,
          providerId,
          entry.method,
          entry.path,
          entry.durationMs,
          entry.ok,
          entry.code ?? null,
          entry.msg?.slice(0, 1000) ?? null,
          entry.traceId ?? null,
        ],
      ).catch(() => {})
    },
  }

  return { provider, ctx }
}
