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
  /** 两段式计费的固定部分，例如对口型的基础费 */
  basePoints: number
  baseCost: number
}

export interface Charge {
  points: number
  currency: string
  providerAmount: number
}

/**
 * 找一条适用的换算规则。
 *
 * 匹配三个维度：模型、输入类型、分辨率。后两个是必须的——
 * 同一个 doubao-seedance-2.0 1080P，文生视频 35 蝉豆每秒，视频生视频 60，差 71%；
 * 只按模型定价一定是错的。
 *
 * 排序上让匹配得越具体的越优先，都匹配不上时退到该能力的兜底价。
 * 同样具体程度下取最贵的一条：报低了差额由承担生成费用的一方悄悄吃掉，
 * 要到月底对账才发现；报高了客户当场会问，能立刻改。
 */
export async function findRule(
  sql: Sql,
  providerId: string,
  capability: Capability,
  modelCode?: string | null,
  variant?: string | null,
  resolution?: string | null,
): Promise<CostRule | null> {
  const row = await one<{
    currency: string
    provider_cost: string
    points: string
    per_unit: boolean
    base_cost: string
    base_points: string
  }>(
    sql,
    // 分辨率不进 WHERE，只参与排序。
    //
    // 放进 WHERE 会出事：请求里的清晰度是个目录里没有的值时（参数写错、
    // 平台加了新档、或者图片那套 1024/2048 跟目录的 2K/4K 对不齐），
    // 一条规则都匹配不到，任务就变成不扣费——白跑一条 350 蝉豆的视频。
    // 放进排序则是精确匹配优先，匹配不上自动退到该模型最贵的一行。
    `SELECT currency, provider_cost, points, per_unit, base_cost, base_points
       FROM cost_rules
      WHERE provider_id = $1
        AND capability = $2::capability
        AND (model_code = $3 OR model_code IS NULL)
        AND (variant   = $4 OR variant    IS NULL)
        AND effective_at <= now()
      ORDER BY (model_code IS NOT NULL) DESC,
               (resolution IS NOT DISTINCT FROM $5) DESC,
               (variant IS NOT NULL) DESC,
               -- 时间要排在价格前面。反过来的话，平台降价后旧的高价行会一直赢，
               -- 价格变成只涨不跌。
               effective_at DESC,
               -- 同一批次里分辨率没匹配上时，才轮到「取最贵的那一档」这条兜底
               points DESC
      LIMIT 1`,
    [providerId, capability, modelCode ?? null, variant ?? null, resolution ?? null],
  )

  if (!row) return null
  return {
    currency: row.currency,
    providerCost: Number(row.provider_cost),
    points: Number(row.points),
    perUnit: row.per_unit,
    baseCost: Number(row.base_cost),
    basePoints: Number(row.base_points),
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
  // 对口型这类是「基础费 + 按秒」两段式，固定部分不随用量走
  return {
    points: round4(rule.basePoints + rule.points * units),
    currency: rule.currency,
    providerAmount: round4(rule.baseCost + rule.providerCost * units),
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
/**
 * 从提交参数里读出定价用得上的两个维度。
 *
 * 分辨率：我们视频传 720/1080/'2K'/'4K'，跟目录对得上；
 * 图片传 1024/2048，目录里是 2K/4K 两档，对不齐，所以图片不按分辨率查，
 * 让它退到该模型最贵的一行。
 *
 * 输入类型：目录按「文/图生视频」和「视频生视频」分开标价。
 * 我们这几个模型收的都是图片参考（首帧、参考图），属于前者。
 */
export function priceDimensions(
  capability: Capability,
  params: Record<string, unknown>,
): { variant: string | null; resolution: string | null } {
  if (capability !== 'video') return { variant: null, resolution: null }

  const c = params.clarity
  let resolution: string | null = null
  if (typeof c === 'number' && (c === 480 || c === 720 || c === 1080)) resolution = `${c}P`
  else if (typeof c === 'string' && /^[24]K$/i.test(c)) resolution = c.toUpperCase()

  return { variant: '文/图生视频', resolution }
}

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
