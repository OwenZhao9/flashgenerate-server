/**
 * 计价。
 *
 * 客户看到的永远是统一点数，供应商自家的货币（蝉豆、魔力）只出现在账本和对账里。
 * 这样做的理由：平台有两种货币，不同能力扣的不一样，以后换供应商货币单位又会变一次。
 * 如果客户额度直接用供应商货币来设，换供应商那天所有客户的额度全部作废。
 *
 * 换算表在 cost_rules 里，改价改换算表即可，不动代码也不影响客户已设的额度。
 */

import { one, type Sql } from '../db/index.ts'
import type { Capability, Usage } from '../providers/types.ts'

export interface CostRule {
  currency: string
  providerCost: number
  points: number
  perUnit: boolean
}

export interface Charge {
  points: number
  currency: string
  providerAmount: number
}

/**
 * 找一条适用的换算规则。
 * 优先精确匹配 model_code，找不到就退到该能力的兜底价。
 */
export async function findRule(
  sql: Sql,
  providerId: string,
  capability: Capability,
  modelCode?: string | null,
): Promise<CostRule | null> {
  const row = await one<{
    currency: string
    provider_cost: string
    points: string
    per_unit: boolean
  }>(
    sql,
    `SELECT currency, provider_cost, points, per_unit
       FROM cost_rules
      WHERE provider_id = $1
        AND capability = $2::capability
        AND (model_code = $3 OR model_code IS NULL)
        AND effective_at <= now()
      ORDER BY (model_code IS NOT NULL) DESC, effective_at DESC
      LIMIT 1`,
    [providerId, capability, modelCode ?? null],
  )

  if (!row) return null
  return {
    currency: row.currency,
    providerCost: Number(row.provider_cost),
    points: Number(row.points),
    perUnit: row.per_unit,
  }
}

/**
 * 算这次任务该扣多少。
 *
 * usage 为空表示还不知道用量（提交时就是这样），按一份的量预扣；
 * 结束时拿到真实用量再按实际结算，多退少补由账本处理。
 */
export function priceOf(rule: CostRule, usage?: Usage): Charge {
  const units = rule.perUnit && usage ? Math.max(1, usage.amount) : 1
  return {
    points: round4(rule.points * units),
    currency: rule.currency,
    providerAmount: round4(rule.providerCost * units),
  }
}

/** 点数一律保留四位小数，避免浮点误差在账本里越滚越大 */
export function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000
}

/**
 * 提交时的预扣额。
 *
 * 按量计价的能力这时还不知道会跑多少秒，用请求参数里的时长估一个；
 * 估不出来就按一份预扣，等结算时补差。宁可预扣少了事后补，
 * 也不要预扣多了让客户觉得钱莫名其妙少了一块。
 */
export function estimateUsage(capability: Capability, params: Record<string, unknown>): Usage | undefined {
  if (capability === 'video') {
    const d = Number(params.video_duration)
    if (Number.isFinite(d) && d > 0) return { unit: 'second', amount: d }
  }
  if (capability === 'image') {
    const n = Number(params.number_of_images)
    if (Number.isFinite(n) && n > 0) return { unit: 'count', amount: n }
  }
  return undefined
}
