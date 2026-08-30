/**
 * 任务 worker。
 *
 * 队列在数据库里，不在内存里。这是验收第 10 条的实现方式：
 * 进程重启后未完成的任务还在表里，租约一过期就被下一个进程接手继续跑。
 *
 * 并发和限流按「供应商 × 能力」算，不是全局一个数——
 * 同一家的视频合成和图片创作限制完全不同，写死成一个数会把宽松的那条也拖慢。
 * 数值从 provider_limits 读，管理后台改完立刻生效，不用重启。
 */

import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { one, pool, query, tx } from '../db/index.ts'
import { ProviderError, type Capability, type PollResult, type TaskStatus } from '../providers/types.ts'
import { findRule, priceDimensions, priceOf } from '../quota/cost.ts'
import { refund, settle } from '../quota/ledger.ts'
import { loadProvider } from './context.ts'
import { archiveOutputs } from './archive.ts'
import { resolveRefs } from './resolve.ts'

/** 这个进程的标识，用于租约 */
const OWNER = `${process.pid}-${randomUUID().slice(0, 8)}`
/** 租约时长。进程崩了最多这么久任务就会被别人接手。 */
const LEASE_MS = 2 * 60 * 1000
/** 主循环间隔 */
const TICK_MS = 3000
/**
 * 轮询退避。刚提交的任务查得勤一点，跑久了就放慢，
 * 免得一个跑十分钟的视频把限流额度全耗在查询上。
 */
function pollDelayMs(attempts: number): number {
  if (attempts < 5) return 3000
  if (attempts < 15) return 6000
  return 12_000
}
/** 任务在平台侧挂太久就判失败，避免永远占着并发位 */
const STUCK_AFTER_MS = 60 * 60 * 1000
/** 结果转存失败最多再试几轮。生成已经花过钱了，值得多试几次。 */
const ARCHIVE_RETRIES = 5
/** 一般可重试错误的次数上限 */
const RETRIES = 3
/**
 * 限流的次数上限。给得很宽，因为限流只是要等一个窗口，等到了就能过。
 * 配合上面 60 秒的退避上限，最坏情况也就是排队半小时，
 * 而 STUCK_AFTER_MS 那道闸会兜住真正卡死的任务。
 */
const RATE_LIMIT_RETRIES = 40

let running = false
let timer: NodeJS.Timeout | null = null

export function startWorker(): void {
  if (timer) return
  const loop = async (): Promise<void> => {
    if (!running) return
    try {
      await tick()
    } catch (err) {
      console.error('[worker] tick 异常', err)
    }
    timer = setTimeout(() => void loop(), TICK_MS)
  }
  running = true
  void loop()
  console.log(`[worker] 已启动，owner=${OWNER}`)
}

export function stopWorker(): void {
  running = false
  if (timer) clearTimeout(timer)
  timer = null
}

// ---------------------------------------------------------------------------

interface LimitRow {
  provider_id: string
  capability: Capability
  concurrency: number
  rpm: number
}

async function tick(): Promise<void> {
  const limits = await query<LimitRow>(
    pool,
    `SELECT l.provider_id, l.capability, l.concurrency, l.rpm
       FROM provider_limits l
       JOIN providers p ON p.id = l.provider_id
      WHERE p.enabled`,
  )

  for (const limit of limits) {
    await submitBatch(limit).catch((err) => console.error('[worker] 提交批次异常', err))
    await pollBatch(limit).catch((err) => console.error('[worker] 轮询批次异常', err))
  }

  await failStuck().catch(() => {})
}

/** 平台侧正在跑的数量，这才是占着并发位的那些 */
async function inFlightCount(limit: LimitRow): Promise<number> {
  const row = await one<{ n: number }>(
    pool,
    `SELECT count(*)::int AS n FROM tasks
      WHERE provider_id = $1 AND capability = $2::capability
        AND status IN ('pending','running')`,
    [limit.provider_id, limit.capability],
  )
  return row?.n ?? 0
}

async function recentSubmits(limit: LimitRow): Promise<number> {
  const row = await one<{ n: number }>(
    pool,
    `SELECT count(*)::int AS n FROM tasks
      WHERE provider_id = $1 AND capability = $2::capability
        AND submitted_at > now() - interval '60 seconds'`,
    [limit.provider_id, limit.capability],
  )
  return row?.n ?? 0
}

/**
 * 抢一批任务。
 *
 * SKIP LOCKED 是关键：多个实例同时抢时各自拿到不同的行，
 * 不会互相阻塞，也不会有两个进程跑同一个任务。
 */
async function claim(
  limit: LimitRow,
  statuses: TaskStatus[],
  max: number,
): Promise<Array<Record<string, unknown>>> {
  if (max <= 0) return []
  return query(
    pool,
    `UPDATE tasks SET lease_owner = $1, lease_until = now() + ($2 || ' milliseconds')::interval,
                      updated_at = now()
      WHERE id IN (
        SELECT id FROM tasks
         WHERE provider_id = $3 AND capability = $4::capability
           AND status = ANY($5::task_status[])
           AND next_run_at <= now()
           AND (lease_until IS NULL OR lease_until < now())
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $6
      )
      RETURNING *`,
    [OWNER, String(LEASE_MS), limit.provider_id, limit.capability, statuses, max],
  )
}

async function submitBatch(limit: LimitRow): Promise<void> {
  const slots = limit.concurrency - (await inFlightCount(limit))
  if (slots <= 0) return

  const rpmLeft = limit.rpm - (await recentSubmits(limit))
  const take = Math.min(slots, rpmLeft)
  if (take <= 0) return

  const tasks = await claim(limit, ['queued'], take)
  for (const task of tasks) {
    await submitOne(task).catch((err) => console.error('[worker] 提交失败', err))
  }
}

async function submitOne(task: Record<string, unknown>): Promise<void> {
  const id = String(task.id)
  const tenantId = String(task.tenant_id)
  const providerId = String(task.provider_id)
  const capability = task.capability as Capability
  const params = (task.params ?? {}) as Record<string, unknown>

  try {
    const { provider, ctx } = await loadProvider(providerId, { tenantId, taskId: id })

    // 参数里的素材引用在这里才展开成供应商能用的地址。
    // 放在提交这一步而不是入库时，是因为引用可能在排队期间过期，
    // 真正要用的那一刻再解析才不会拿到一个刚好失效的地址。
    const resolved = (await resolveRefs(provider, ctx, tenantId, params)) as Record<string, unknown>

    const res = await provider.submit(ctx, {
      capability,
      modelCode: task.model_code ? String(task.model_code) : null,
      params: resolved,
    })

    await query(
      pool,
      `UPDATE tasks
          SET status = 'pending', provider_task_id = $2, trace_id = $3,
              submitted_at = now(), next_run_at = now() + interval '3 seconds',
              attempts = 0, lease_owner = NULL, lease_until = NULL, updated_at = now()
        WHERE id = $1`,
      [id, res.providerTaskId, res.traceId ?? null],
    )
  } catch (err) {
    await failTask(id, tenantId, err, { allowRetry: true })
  }
}

async function pollBatch(limit: LimitRow): Promise<void> {
  // 轮询是读操作，不占平台的并发位，但一次别拉太多，免得一轮 tick 拖很久
  const tasks = await claim(limit, ['pending', 'running'], 20)
  for (const task of tasks) {
    await pollOne(task).catch((err) => console.error('[worker] 轮询失败', err))
  }
}

async function pollOne(task: Record<string, unknown>): Promise<void> {
  const id = String(task.id)
  const tenantId = String(task.tenant_id)
  const providerId = String(task.provider_id)
  const capability = task.capability as Capability
  const providerTaskId = String(task.provider_task_id ?? '')
  const attempts = Number(task.attempts ?? 0) + 1

  if (!providerTaskId) {
    await failTask(id, tenantId, new ProviderError('provider_error', '任务缺少平台任务号'), {
      allowRetry: false,
    })
    return
  }

  let result: PollResult
  try {
    const { provider, ctx } = await loadProvider(providerId, { tenantId, taskId: id })
    result = await provider.poll(ctx, capability, providerTaskId)
  } catch (err) {
    // 查询本身出错不代表任务失败，可重试的就放回队列继续查
    if (err instanceof ProviderError && err.retryable) {
      await query(
        pool,
        `UPDATE tasks SET attempts = $2, next_run_at = now() + ($3 || ' milliseconds')::interval,
                          lease_owner = NULL, lease_until = NULL, updated_at = now()
          WHERE id = $1`,
        [id, attempts, String(pollDelayMs(attempts))],
      )
      return
    }
    await failTask(id, tenantId, err, { allowRetry: false })
    return
  }

  if (result.status === 'success') {
    await finishSuccess(task, result)
    return
  }

  if (result.status === 'failed' || result.status === 'fatal' || result.status === 'cancelled') {
    await failTask(
      id,
      tenantId,
      new ProviderError(result.error?.code ?? 'provider_error', result.error?.message ?? '生成失败', {
        raw: result.raw,
      }),
      { allowRetry: false, forceStatus: result.status },
    )
    return
  }

  await query(
    pool,
    `UPDATE tasks
        SET status = $2::task_status, progress = $3, attempts = $4,
            provider_raw = $5::jsonb,
            next_run_at = now() + ($6 || ' milliseconds')::interval,
            lease_owner = NULL, lease_until = NULL, updated_at = now()
      WHERE id = $1`,
    [id, result.status, result.progress, attempts, JSON.stringify(result.raw ?? null), String(pollDelayMs(attempts))],
  )
}

/**
 * 成功收尾。
 *
 * 顺序很讲究：先把结果转存到我方存储，成功了才结算额度、标成功。
 * 反过来先标成功再转存的话，转存失败就会留下一个「成功但没有文件」的任务，
 * 客户点开是空的，而额度已经扣了。
 */
async function finishSuccess(task: Record<string, unknown>, result: PollResult): Promise<void> {
  const id = String(task.id)
  const tenantId = String(task.tenant_id)
  const providerId = String(task.provider_id)
  const capability = task.capability as Capability
  const modelCode = task.model_code ? String(task.model_code) : null

  try {
    const assetIds = await archiveOutputs(task, result)

    const dims = priceDimensions(capability, (task.params ?? {}) as Record<string, unknown>)
    const rule = await findRule(pool, providerId, capability, modelCode, dims.variant, dims.resolution)
    const charge = rule ? priceOf(rule, result.usage) : null

    await tx(async (client) => {
      if (charge) {
        await settle(client, {
          tenantId,
          taskId: id,
          points: charge.points,
          providerId,
          currency: charge.currency,
          providerAmount: charge.providerAmount,
        })
      } else {
        // 没配换算规则，退掉预扣而不是硬扣一个猜的数
        await refund(client, { tenantId, taskId: id, note: '未配置计价规则，未扣费' })
      }

      await query(
        client,
        `UPDATE tasks
            SET status = 'success', progress = 100, provider_raw = $2::jsonb,
                finished_at = now(), lease_owner = NULL, lease_until = NULL, updated_at = now()
          WHERE id = $1`,
        [id, JSON.stringify(result.raw ?? null)],
      )

      if (assetIds.length) {
        await query(client, `UPDATE assets SET task_id = $1 WHERE id = ANY($2::uuid[])`, [id, assetIds])
      }
    })
  } catch (err) {
    // 走到这里说明供应商那边已经生成成功、也已经扣过费了，只是我方收尾出了问题。
    // 这时候直接判失败并退款是最坏的处理：钱照付，客户还什么都没拿到。
    // 所以先当成可恢复的情况重试若干轮，实在不行才落败，并且在错误里说明白。
    const attempts = Number(task.attempts ?? 0) + 1
    if (attempts <= ARCHIVE_RETRIES) {
      await query(
        pool,
        `UPDATE tasks
            SET attempts = $2, error_code = 'archive_retry', error_message = $3,
                next_run_at = now() + ($4 || ' seconds')::interval,
                lease_owner = NULL, lease_until = NULL, updated_at = now()
          WHERE id = $1`,
        [id, attempts, (err instanceof Error ? err.message : String(err)).slice(0, 500), String(2 ** attempts * 3)],
      )
      return
    }

    await failTask(
      id,
      tenantId,
      new ProviderError('provider_error', `生成已完成，但保存结果失败：${err instanceof Error ? err.message : String(err)}`),
      { allowRetry: false, keepCharge: true },
    )
  }
}

async function failTask(
  taskId: string,
  tenantId: string,
  err: unknown,
  opts: { allowRetry: boolean; forceStatus?: TaskStatus; keepCharge?: boolean },
): Promise<void> {
  const pe = err instanceof ProviderError ? err : null
  const code = pe?.code ?? 'unknown'
  const message = err instanceof Error ? err.message : String(err)

  // 可重试的错误放回队列退避重试，重试够了才真判失败。
  //
  // 限流单独放宽：「请求太频繁」不是任务本身有问题，是我们发得太快，
  // 等一会儿一定能发出去。按三次就判死的话，只要并发配得比平台实际允许的高，
  // 排在后面的任务就会被一路退避到死——而并发数是管理后台里能随手改的，
  // 配高一点的代价不该是任务莫名其妙失败。
  if (opts.allowRetry && pe?.retryable) {
    const row = await one<{ attempts: number }>(pool, `SELECT attempts FROM tasks WHERE id = $1`, [taskId])
    const attempts = Number(row?.attempts ?? 0) + 1
    const ceiling = code === 'rate_limited' ? RATE_LIMIT_RETRIES : RETRIES

    if (attempts <= ceiling) {
      // 退避上限 60 秒。限流要等的是一个窗口，不是指数级的时间。
      const backoff = Math.min(60, 2 ** Math.min(attempts, 6) * 2)
      await query(
        pool,
        `UPDATE tasks SET attempts = $2, error_code = $3, error_message = $4,
                          next_run_at = now() + ($5 || ' seconds')::interval,
                          lease_owner = NULL, lease_until = NULL, updated_at = now()
          WHERE id = $1`,
        [taskId, attempts, code, message.slice(0, 500), String(backoff)],
      )
      return
    }
  }

  const status: TaskStatus = opts.forceStatus ?? (pe?.retryable ? 'failed' : 'fatal')

  await tx(async (client) => {
    // 失败就退还预扣，没跑成的不该扣钱。
    // 但供应商那边已经出了结果、已经扣过费的情况除外——那笔消耗是真实发生的，
    // 退了就等于账本跟平台账单对不上，对账时会平白多出一笔差额。
    if (!opts.keepCharge) {
      await refund(client, { tenantId, taskId, note: `失败退还：${code}` })
    }
    await query(
      client,
      `UPDATE tasks
          SET status = $2::task_status, error_code = $3, error_message = $4,
              provider_raw = COALESCE($5::jsonb, provider_raw),
              trace_id = COALESCE($6, trace_id),
              finished_at = now(), lease_owner = NULL, lease_until = NULL, updated_at = now()
        WHERE id = $1`,
      [
        taskId,
        status,
        code,
        message.slice(0, 500),
        pe?.raw ? JSON.stringify(pe.raw) : null,
        pe?.traceId ?? null,
      ],
    )
  })
}

/** 在平台侧挂太久的任务判失败，别让它一直占着并发位 */
async function failStuck(): Promise<void> {
  const stuck = await query<{ id: string; tenant_id: string }>(
    pool,
    `SELECT id, tenant_id FROM tasks
      WHERE status IN ('pending','running')
        AND submitted_at < now() - ($1 || ' milliseconds')::interval`,
    [String(STUCK_AFTER_MS)],
  )
  for (const t of stuck) {
    await failTask(t.id, t.tenant_id, new ProviderError('timeout', '任务在平台侧长时间没有结果'), {
      allowRetry: false,
    })
  }
}
