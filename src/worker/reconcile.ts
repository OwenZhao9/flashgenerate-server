/**
 * 平台余额对账。
 *
 * 系统里的额度和平台余额不可能实时一致：任务是异步的，失败要退还，
 * 平台扣费的时点也不完全可控。所以这两个数分开看——
 * 系统里的是预算控制，平台余额是事实。这里定期把事实拉回来存一份，
 * 差得太多或者余额见底就告警。
 *
 * 别指望两边分毫不差，那是做不到的，也不该按那个标准去对。
 */

import { pool, query } from '../db/index.ts'
import { listProviders } from '../providers/types.ts'
import { loadProvider } from './context.ts'

const INTERVAL_MS = 10 * 60 * 1000
/** 余额低于这个数就该提醒充值了 */
const LOW_BALANCE = 200

let timer: NodeJS.Timeout | null = null

export function startReconcile(): void {
  if (timer) return
  const run = async (): Promise<void> => {
    try {
      await reconcileOnce()
    } catch (err) {
      console.error('[reconcile] 异常', err)
    }
  }
  void run()
  timer = setInterval(() => void run(), INTERVAL_MS)
  console.log('[reconcile] 余额对账已启动')
}

export function stopReconcile(): void {
  if (timer) clearInterval(timer)
  timer = null
}

export async function reconcileOnce(): Promise<void> {
  const enabled = await query<{ id: string }>(pool, `SELECT id FROM providers WHERE enabled`)
  const known = new Set(listProviders().map((p) => p.id))

  for (const row of enabled) {
    if (!known.has(row.id)) continue
    try {
      const { provider, ctx } = await loadProvider(row.id)
      const entries = await provider.balance(ctx)
      for (const e of entries) {
        await query(
          pool,
          `INSERT INTO provider_balances (provider_id, currency, amount, raw)
           VALUES ($1,$2,$3,$4::jsonb)`,
          [row.id, e.currency, e.amount, JSON.stringify(e.raw ?? null)],
        )
        if (e.amount < LOW_BALANCE) {
          console.warn(`[reconcile] ${row.id} 的 ${e.currency} 余额只剩 ${e.amount}，该充值了`)
        }
      }
    } catch (err) {
      // 凭据没填或者对方挂了都不该让整个对账循环停掉
      console.warn(`[reconcile] ${row.id} 拉余额失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 只留最近 30 天的快照
  await query(pool, `DELETE FROM provider_balances WHERE fetched_at < now() - interval '30 days'`).catch(
    () => {},
  )
}
