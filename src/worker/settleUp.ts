/**
 * 账单补差。
 *
 * 平台出账有延迟：任务刚成功时去查消耗明细还没有这一笔，结算只能先按估算记。
 * 这个循环隔一阵回头看一次，账单出来了就把差额补上。
 *
 * 差距不小，不补不行——实测同一张图估算 8、账单 20；一条 4 秒视频估算 120、账单 180。
 * 挂着不管的话月底跟平台怎么都对不齐，而且差额是我方在吃。
 */

import { one, pool, query, tx } from '../db/index.ts'
import { reconcileCost } from '../quota/ledger.ts'
import { loadProvider } from './context.ts'

/** 多久扫一次 */
const INTERVAL_MS = 10 * 60 * 1000
/** 任务结束多久之后才去查账单，给平台出账留时间 */
const GRACE_MS = 5 * 60 * 1000
/** 超过这个时间还没出账就不等了，按估算认账 */
const GIVE_UP_MS = 48 * 60 * 60 * 1000

let timer: NodeJS.Timeout | null = null

export function startSettleUp(): void {
  if (timer) return
  const run = async (): Promise<void> => {
    try {
      const r = await settleUpOnce()
      if (r.checked) {
        console.log(`[settleup] 核对 ${r.checked} 笔 · 补差 ${r.adjusted} 笔 · 合计 ${r.total} 点`)
      }
    } catch (err) {
      console.warn(`[settleup] 异常：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  timer = setInterval(() => void run(), INTERVAL_MS)
  // 启动后等一会儿再跑第一轮，别跟迁移和初始化抢
  setTimeout(() => void run(), 60_000)
  console.log('[settleup] 账单补差已启动')
}

export function stopSettleUp(): void {
  if (timer) clearInterval(timer)
  timer = null
}

export interface SettleUpResult {
  checked: number
  adjusted: number
  total: number
}

export async function settleUpOnce(): Promise<SettleUpResult> {
  const pending = await query<{
    id: string
    tenant_id: string
    provider_id: string
    provider_task_id: string
    finished_at: Date
  }>(
    pool,
    `SELECT id, tenant_id, provider_id, provider_task_id, finished_at
       FROM tasks
      WHERE status = 'success'
        AND cost_reconciled_at IS NULL
        AND provider_task_id IS NOT NULL
        AND finished_at < now() - ($1 || ' milliseconds')::interval
        AND finished_at > now() - ($2 || ' milliseconds')::interval
      ORDER BY finished_at
      LIMIT 100`,
    [String(GRACE_MS), String(GIVE_UP_MS)],
  )

  if (!pending.length) {
    // 顺手把超时还没出账的标掉，别一直扫
    await query(
      pool,
      `UPDATE tasks SET cost_reconciled_at = now()
        WHERE status = 'success' AND cost_reconciled_at IS NULL
          AND finished_at < now() - ($1 || ' milliseconds')::interval`,
      [String(GIVE_UP_MS)],
    )
    return { checked: 0, adjusted: 0, total: 0 }
  }

  // 按供应商分组，一次查询覆盖一批，别一个任务查一次
  const byProvider = new Map<string, typeof pending>()
  for (const t of pending) {
    const list = byProvider.get(t.provider_id) ?? []
    list.push(t)
    byProvider.set(t.provider_id, list)
  }

  let adjusted = 0
  let total = 0

  for (const [providerId, tasks] of byProvider) {
    const { provider, ctx } = await loadProvider(providerId)
    if (!provider.actualCost) {
      // 这家不支持查账单，直接认账，不再反复扫
      await query(pool, `UPDATE tasks SET cost_reconciled_at = now() WHERE id = ANY($1::uuid[])`, [
        tasks.map((t) => t.id),
      ])
      continue
    }

    for (const t of tasks) {
      try {
        const actual = await provider.actualCost(ctx, t.provider_task_id, new Date(t.finished_at))
        if (!actual) continue // 还没出账，下一轮再看

        const diff = await tx(async (client) => {
          const d = await reconcileCost(client, {
            tenantId: t.tenant_id,
            taskId: t.id,
            actualAmount: actual.amount,
            providerId,
            currency: actual.currency,
          })
          await query(client, `UPDATE tasks SET cost_reconciled_at = now() WHERE id = $1`, [t.id])
          return d
        })

        if (diff !== 0) {
          adjusted++
          total += diff
        }
      } catch (err) {
        console.warn(`[settleup] 任务 ${t.id} 核对失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  return { checked: pending.length, adjusted, total: Math.round(total * 10000) / 10000 }
}
