/**
 * 平台公开价格目录。
 *
 * 这是个不需要凭证的公开接口，返回带 version 和 updated_at，
 * 所以价格可以自动同步、变了能发现，不用找商务要报价单，也不用人工维护。
 *
 *   GET https://open-api.chanjing.cc/open/v1/price/catalog
 *
 * 文档页上那个 MCP 工具 price_catalog 底下就是它，走不走 MCP 无所谓。
 */

const CATALOG_URL = 'https://open-api.chanjing.cc/open/v1/price/catalog'

/** 目录里一行价格。同一个模型会因为分辨率和输入类型出现多行。 */
export interface PriceRow {
  price_row_code?: string
  model_code?: string
  model_name?: string
  /** 输入类型，例如「文/图生视频」「视频生视频」。同模型同分辨率下差价可以到 70% */
  variant_name?: string
  variant_code?: string
  resolution?: string
  duration_seconds?: number | null
  /** unit 表示按量，base 之类表示固定费用 */
  charge_component?: string
  bean_price?: string
  magic_price?: string
  /** per_second / per_image / per_task */
  price_unit?: string
  tier_condition?: string
  remark?: string
}

export interface PriceItem {
  item_code: string
  item_name: string
  billing_rule?: string
  remark?: string
  price_rows?: PriceRow[]
}

export interface PriceCatalog {
  version: string
  updated_at?: string
  items: PriceItem[]
}

export async function fetchPriceCatalog(signal?: AbortSignal): Promise<PriceCatalog> {
  const res = await fetch(CATALOG_URL, { signal: signal ?? AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`取价格目录失败，HTTP ${res.status}`)

  const env = (await res.json()) as { code: number; msg?: string; data?: PriceCatalog }
  if (env.code !== 0 || !env.data) throw new Error(env.msg || '取价格目录失败')

  return {
    version: env.data.version,
    updated_at: env.data.updated_at,
    items: env.data.items ?? [],
  }
}

/** 把一行价格里的数字取出来。目录里是字符串，空串表示这条不收这种货币。 */
export function num(v: unknown): number | null {
  if (typeof v !== 'string' || !v.trim()) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
