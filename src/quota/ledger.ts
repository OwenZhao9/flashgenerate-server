/**
 * 额度账本。
 *
 * 只追加，不修改。每一笔都带 (task_id, op)，数据库上有唯一约束，
 * 所以「同一个任务重复扣费」和「重复退款」在库层面就写不进去——
 * 不依赖应用代码判断先后，也不怕 worker 崩在中间重跑一遍。
 *
 * quota_accounts 上的三个数是账本的物化结果，必须和写账本在同一个事务里更新。
 */

import type pg from 'pg'
import { one, query, tx, type Sql } from '../db/index.ts'
import { round4 } from './cost.ts'

/**
 * 重复写入一律用 ON CONFLICT DO NOTHING 挡，不要靠 catch 唯一约束错误。
 *
 * 这条是踩出来的：Postgres 里只要有一条语句报错，整个事务就进入中止状态，
 * 后面的语句全部拒绝执行，在 JS 里 catch 掉那个错误并不能把事务救回来。
 * 单独一个事务里 catch 完就 return 看着是对的（COMMIT 一个已中止的事务等同回滚），
 * 可一旦后面还有别的语句——比如退款之后还要改任务状态——就会以
 * 「当前事务被终止」失败，而且失败的是后面那条无辜的语句，很难往回查。
 *
 * 唯一索引是带条件的（WHERE task_id IS NOT NULL），
 * 所以 ON CONFLICT 也要写同样的条件才推断得出该用哪个索引。
 */
const ON_CONFLICT = `ON CONFLICT (task_id, op) WHERE task_id IS NOT NULL DO NOTHING`

export interface Balance {
  granted: number
  used: number
  held: number
  /** 还能用多少 */
  available: number
}

export async function balanceOf(sql: Sql, tenantId: string): Promise<Balance> {
  const row = await one<{ granted_points: string; used_points: string; held_points: string }>(
    sql,
    `SELECT granted_points, used_points, held_points FROM quota_accounts WHERE tenant_id = $1`,
    [tenantId],
  )
  const granted = Number(row?.granted_points ?? 0)
  const used = Number(row?.used_points ?? 0)
  const held = Number(row?.held_points ?? 0)
  return { granted, used, held, available: round4(granted - used - held) }
}

export class InsufficientQuota extends Error {
  readonly available: number
  readonly required: number

  constructor(available: number, required: number) {
    super(`额度不足，还剩 ${available}，本次需要 ${required}`)
    this.name = 'InsufficientQuota'
    this.available = available
    this.required = required
  }
}

/**
 * 提交时预扣。
 *
 * 在同一个事务里锁住 quota_accounts 这一行再判断余额，
 * 否则两个请求同时读到「够用」，各自扣一次就透支了。
 * 同一个任务重复调用是安全的：唯一约束会挡住第二条，这里当成已扣处理。
 */
export async function hold(
  client: pg.PoolClient,
  args: {
    tenantId: string
    taskId: string
    points: number
    providerId?: string
    currency?: string
    providerAmount?: number
  },
): Promise<void> {
  const points = round4(args.points)
  if (points <= 0) return

  const row = await one<{ granted_points: string; used_points: string; held_points: string }>(
    client,
    `SELECT granted_points, used_points, held_points
       FROM quota_accounts WHERE tenant_id = $1 FOR UPDATE`,
    [args.tenantId],
  )
  if (!row) throw new InsufficientQuota(0, points)

  const available = round4(
    Number(row.granted_points) - Number(row.used_points) - Number(row.held_points),
  )
  if (available < points) throw new InsufficientQuota(available, points)

  const inserted = await query<{ id: number }>(
    client,
    `INSERT INTO quota_ledger
       (tenant_id, task_id, op, points, provider_id, provider_currency, provider_amount)
     VALUES ($1, $2, 'hold', $3, $4, $5, $6)
     ${ON_CONFLICT}
     RETURNING id`,
    [args.tenantId, args.taskId, points, args.providerId ?? null, args.currency ?? null, args.providerAmount ?? null],
  )

  // 没插进去说明这个任务已经扣过了，不重复扣。这是重放安全的关键一步。
  if (!inserted.length) return

  await query(
    client,
    `UPDATE quota_accounts SET held_points = held_points + $2, updated_at = now()
      WHERE tenant_id = $1`,
    [args.tenantId, points],
  )
}

/**
 * 任务成功后结算。
 *
 * 把预扣转成实际消耗。真实用量跟提交时的估算可能不一样（视频按秒计费尤其明显），
 * 所以结算金额以这里传进来的为准，预扣多退少补。
 */
export async function settle(
  client: pg.PoolClient,
  args: {
    tenantId: string
    taskId: string
    points: number
    providerId?: string
    currency?: string
    providerAmount?: number
    /** 结算依据的说明，例如按账单结算还是按估算 */
    note?: string
  },
): Promise<void> {
  const points = round4(args.points)

  const heldRow = await one<{ points: string }>(
    client,
    `SELECT points FROM quota_ledger WHERE task_id = $1 AND op = 'hold'`,
    [args.taskId],
  )
  const held = round4(Number(heldRow?.points ?? 0))

  const inserted = await query<{ id: number }>(
    client,
    `INSERT INTO quota_ledger
       (tenant_id, task_id, op, points, provider_id, provider_currency, provider_amount, note)
     VALUES ($1, $2, 'settle', $3, $4, $5, $6, $7)
     ${ON_CONFLICT}
     RETURNING id`,
    [args.tenantId, args.taskId, points, args.providerId ?? null, args.currency ?? null,
     args.providerAmount ?? null, args.note ?? null],
  )
  if (!inserted.length) return

  await query(
    client,
    `UPDATE quota_accounts
        SET held_points = GREATEST(0, held_points - $2),
            used_points = used_points + $3,
            updated_at = now()
      WHERE tenant_id = $1`,
    [args.tenantId, held, points],
  )
}

/**
 * 任务失败或确定没执行时退还。
 * 只退预扣的那部分，已结算的不动——已经产生的消耗不能退。
 */
export async function refund(
  client: pg.PoolClient,
  args: { tenantId: string; taskId: string; note?: string },
): Promise<void> {
  const heldRow = await one<{ points: string }>(
    client,
    `SELECT points FROM quota_ledger WHERE task_id = $1 AND op = 'hold'`,
    [args.taskId],
  )
  if (!heldRow) return

  // 已经结算过就不该再退，否则同一笔钱既算了消耗又退了回去
  const settled = await one<{ id: number }>(
    client,
    `SELECT id FROM quota_ledger WHERE task_id = $1 AND op = 'settle'`,
    [args.taskId],
  )
  if (settled) return

  const held = round4(Number(heldRow.points))

  const inserted = await query<{ id: number }>(
    client,
    `INSERT INTO quota_ledger (tenant_id, task_id, op, points, note)
     VALUES ($1, $2, 'refund', $3, $4)
     ${ON_CONFLICT}
     RETURNING id`,
    [args.tenantId, args.taskId, -held, args.note ?? null],
  )
  if (!inserted.length) return

  await query(
    client,
    `UPDATE quota_accounts SET held_points = GREATEST(0, held_points - $2), updated_at = now()
      WHERE tenant_id = $1`,
    [args.tenantId, held],
  )
}

/**
 * 账单补差。
 *
 * 平台出账有延迟，结算时拿不到真实扣费，只能先按估算记。
 * 这里在账单出来之后把差额补上，让账本跟平台账单对得齐。
 *
 * 差额记成单独一笔而不是改写原来那条结算，理由跟账本只追加不修改一样：
 * 改写会让「当时按什么结的」这个信息消失，出了争议查不回去。
 *
 * (task_id, op) 上有唯一约束，所以同一个任务只会补一次。
 */
export async function reconcileCost(
  client: pg.PoolClient,
  args: {
    tenantId: string
    taskId: string
    /** 平台账单上的实际扣费 */
    actualAmount: number
    providerId?: string
    currency?: string
    note?: string
  },
): Promise<number> {
  const settled = await one<{ points: string }>(
    client,
    `SELECT points FROM quota_ledger WHERE task_id = $1 AND op = 'settle'`,
    [args.taskId],
  )
  // 没结算过的不补差——失败退还过的任务不该再扣钱
  if (!settled) return 0

  const diff = round4(args.actualAmount - Number(settled.points))
  if (Math.abs(diff) < 0.0001) return 0

  const inserted = await query<{ id: number }>(
    client,
    `INSERT INTO quota_ledger
       (tenant_id, task_id, op, points, provider_id, provider_currency, provider_amount, note)
     VALUES ($1, $2, 'reconcile', $3, $4, $5, $6, $7)
     ${ON_CONFLICT}
     RETURNING id`,
    [
      args.tenantId,
      args.taskId,
      diff,
      args.providerId ?? null,
      args.currency ?? null,
      args.actualAmount,
      args.note ?? `按平台账单补差：结算 ${Number(settled.points)}，账单 ${args.actualAmount}`,
    ],
  )
  if (!inserted.length) return 0

  await query(
    client,
    `UPDATE quota_accounts
        SET used_points = GREATEST(0, used_points + $2), updated_at = now()
      WHERE tenant_id = $1`,
    [args.tenantId, diff],
  )

  return diff
}

/**
 * 管理员调整额度。
 * 验收第 12 条要求「立即生效并保留调整记录」，所以走账本而不是直接改数。
 */
export async function adjust(args: {
  tenantId: string
  points: number
  actorAccountId: string
  note?: string
}): Promise<Balance> {
  return tx(async (client) => {
    await query(
      client,
      `INSERT INTO quota_accounts (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`,
      [args.tenantId],
    )
    await query(
      client,
      `INSERT INTO quota_ledger (tenant_id, op, points, actor_account_id, note)
       VALUES ($1, 'adjust', $2, $3, $4)`,
      [args.tenantId, round4(args.points), args.actorAccountId, args.note ?? null],
    )
    await query(
      client,
      `UPDATE quota_accounts
          SET granted_points = GREATEST(0, granted_points + $2), updated_at = now()
        WHERE tenant_id = $1`,
      [args.tenantId, round4(args.points)],
    )
    return balanceOf(client, args.tenantId)
  })
}

/** 用量明细，管理后台查看用 */
export async function ledgerOf(
  sql: Sql,
  tenantId: string,
  limit = 100,
  offset = 0,
): Promise<Array<Record<string, unknown>>> {
  return query(
    sql,
    `SELECT l.id, l.task_id, l.op, l.points, l.provider_id, l.provider_currency,
            l.provider_amount, l.note, l.created_at,
            t.capability, t.model_code, t.name AS task_name,
            a.email AS actor_email
       FROM quota_ledger l
       LEFT JOIN tasks t ON t.id = l.task_id
       LEFT JOIN accounts a ON a.id = l.actor_account_id
      WHERE l.tenant_id = $1
      ORDER BY l.id DESC
      LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset],
  )
}
