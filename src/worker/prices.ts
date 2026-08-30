/**
 * 价格同步。
 *
 * 定期拉平台的公开价格目录，写进 cost_rules。解决两件事：
 * 价格是变动的，人工维护迟早对不上；以及原来那套占位数字比真实价低 4 到 10 倍，
 * 系统以为扣了 40 点，实际烧掉 350 蝉豆。
 *
 * 几条原则：
 *
 * 只覆盖自己写过的行（source = 'catalog'）。人工调过的价不动，
 * 否则运营刚按实际情况改完，下一轮同步就给冲掉了。
 *
 * 映射不上的模型不猜价，列进 unmapped 报出来。涉及钱的地方猜错的代价是静默的。
 *
 * 客户看到的点数按「1 点 = 1 蝉豆」折算。这样额度的含义稳定、可解释，
 * 平台调价时同一次生成扣的点数跟着变（本来就该变），
 * 但客户手上已有的额度不会被重新估值。
 */

import { pool, query, tx } from '../db/index.ts'
import type { Capability } from '../providers/types.ts'
import {
  CHANJING_PRICE_ALIASES,
  LIPSYNC_BASE_MODEL,
  type PriceAlias,
} from '../providers/chanjing/priceMap.ts'
import { fetchPriceCatalog, num, type PriceItem, type PriceRow } from '../providers/chanjing/price.ts'

const PROVIDER = 'chanjing'
const INTERVAL_MS = 6 * 60 * 60 * 1000

let timer: NodeJS.Timeout | null = null

export function startPriceSync(): void {
  if (timer) return
  const run = async (): Promise<void> => {
    try {
      const r = await syncPrices()
      console.log(`[prices] 目录 ${r.version.slice(0, 8)} · 写入 ${r.applied} 条 · 未映射 ${r.unmapped.length} 项${r.changed ? ' · 价格有变动' : ''}`)
      for (const u of r.unmapped) console.warn(`[prices] 未映射：${u}`)
    } catch (err) {
      console.warn(`[prices] 同步失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  void run()
  timer = setInterval(() => void run(), INTERVAL_MS)
}

export function stopPriceSync(): void {
  if (timer) clearInterval(timer)
  timer = null
}

// ---------------------------------------------------------------------------
// 分辨率
// ---------------------------------------------------------------------------

/**
 * 把我们提交时用的清晰度参数折成目录里的写法。
 *
 * 视频那边我们传 720 / 1080 / '2K' / '4K'，目录写 720P / 1080P / 2K / 4K，对得上。
 * 图片那边我们传 1024 / 2048，目录写 2K / 4K —— 这两套对不齐，
 * 2048 就是 2K，1024 目录里根本没有对应档。所以图片不按分辨率匹配，
 * 统一落到该模型最贵的那一行（见下面的兜底策略）。
 */
export function normalizeResolution(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  const s = String(v).trim().toUpperCase()
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    if (n === 720 || n === 1080 || n === 480) return `${n}P`
    if (n === 2048) return '2K'
    if (n === 4096) return '4K'
    return null
  }
  if (s === '2K' || s === '4K' || s === '1K') return s
  if (/^\d+P$/.test(s)) return s
  return null
}

/**
 * 在一个条目里挑出该模型的价格行。
 *
 * 挑不准的时候取最贵的那一行，而不是最便宜的或者第一行。
 * 理由是两种错法的代价不对称：报低了我方按低价扣、平台按高价扣，
 * 差额悄悄由承担生成费用的一方吃掉，要到月底对账才发现；
 * 报高了客户马上会问，当场就能改。所以宁可偏保守。
 */
function pickRows(item: PriceItem, alias: PriceAlias): PriceRow[] {
  const rows = item.price_rows ?? []
  let hit = rows

  if (alias.catalogModel) {
    hit = hit.filter((r) => (r.model_code ?? '') === alias.catalogModel)
  }
  if (alias.variant) {
    const byVariant = hit.filter((r) => (r.variant_name ?? '') === alias.variant)
    if (byVariant.length) hit = byVariant
  }
  return hit
}

function priceOfRow(r: PriceRow): number | null {
  return num(r.bean_price)
}

// ---------------------------------------------------------------------------

export interface SyncResult {
  version: string
  applied: number
  unmapped: string[]
  changed: boolean
}

export async function syncPrices(): Promise<SyncResult> {
  const catalog = await fetchPriceCatalog()
  const byItem = new Map(catalog.items.map((i) => [i.item_code, i]))

  const unmapped: string[] = []
  interface Upsert {
    capability: Capability
    modelCode: string | null
    variant: string | null
    resolution: string | null
    beanCost: number
    magicCost: number | null
    perUnit: boolean
    baseCost: number
  }
  const rows: Upsert[] = []

  for (const alias of CHANJING_PRICE_ALIASES) {
    const item = byItem.get(alias.item)
    if (!item) {
      unmapped.push(`${alias.capability}/${alias.modelCode || '(默认)'}：目录里没有条目 ${alias.item}`)
      continue
    }

    const hits = pickRows(item, alias)
    if (!hits.length) {
      unmapped.push(
        `${alias.capability}/${alias.modelCode || '(默认)'}：条目 ${alias.item} 里找不到模型 ${alias.catalogModel ?? '(默认)'}`,
      )
      continue
    }

    // 对口型的基础费单独取一行
    let baseCost = 0
    if (alias.capability === 'lipsync') {
      const base = (item.price_rows ?? []).find((r) => r.model_code === LIPSYNC_BASE_MODEL)
      baseCost = priceOfRow(base ?? {}) ?? 0
    }

    // 按分辨率拆成多行。没有分辨率维度的条目只会产出一行。
    const byRes = new Map<string, PriceRow>()
    for (const r of hits) {
      const key = (r.resolution ?? '').trim()
      const prev = byRes.get(key)
      // 同一分辨率出现多行（例如不同 tier）时留最贵的，理由同 pickRows
      if (!prev || (priceOfRow(r) ?? 0) > (priceOfRow(prev) ?? 0)) byRes.set(key, r)
    }

    for (const [res, r] of byRes) {
      const bean = priceOfRow(r)
      if (bean === null) {
        unmapped.push(`${alias.capability}/${alias.modelCode || '(默认)'}${res ? ` ${res}` : ''}：这一行没有蝉豆价`)
        continue
      }
      rows.push({
        capability: alias.capability,
        modelCode: alias.modelCode || null,
        variant: alias.variant ?? null,
        // '-' 是目录里表示「不分分辨率」的写法，折成空
        resolution: res && res !== '-' ? res : null,
        beanCost: bean,
        magicCost: num(r.magic_price),
        perUnit: (r.price_unit ?? '') !== 'per_task',
        baseCost,
      })
    }
  }

  const applied = await tx(async (client) => {
    let n = 0
    for (const r of rows) {
      // 只动自己写过的行。人工调过的价（source='manual'）跳过，
      // 否则运营刚按实情改完就被下一轮同步冲掉。
      await query(
        client,
        `INSERT INTO cost_rules
           (provider_id, capability, model_code, variant, resolution,
            currency, provider_cost, magic_cost, points, per_unit,
            base_cost, base_points, source, catalog_version, effective_at)
         VALUES ($1,$2::capability,$3,$4,$5,'bean',$6,$7,$6,$8,$9,$9,'catalog',$10, date_trunc('second', now()))
         ON CONFLICT (provider_id, capability, COALESCE(model_code,''),
                      COALESCE(variant,''), COALESCE(resolution,''), effective_at)
         DO UPDATE SET
           provider_cost = EXCLUDED.provider_cost,
           magic_cost    = EXCLUDED.magic_cost,
           points        = EXCLUDED.points,
           per_unit      = EXCLUDED.per_unit,
           base_cost     = EXCLUDED.base_cost,
           base_points   = EXCLUDED.base_points,
           catalog_version = EXCLUDED.catalog_version
         WHERE cost_rules.source = 'catalog'`,
        [
          PROVIDER,
          r.capability,
          r.modelCode,
          r.variant,
          r.resolution,
          r.beanCost,
          r.magicCost,
          r.perUnit,
          r.baseCost,
          catalog.version,
        ],
      )
      n++
    }
    return n
  })

  // 目录版本变了说明平台调价了，留一份快照，方便对出改了哪几项
  const known = await query<{ version: string }>(
    pool,
    `SELECT version FROM price_catalogs WHERE provider_id = $1 ORDER BY fetched_at DESC LIMIT 1`,
    [PROVIDER],
  )
  const changed = !!known.length && known[0]!.version !== catalog.version

  await query(
    pool,
    `INSERT INTO price_catalogs (provider_id, version, updated_at, payload, applied, unmapped)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb)
     ON CONFLICT (provider_id, version) DO UPDATE
       SET fetched_at = now(), applied = EXCLUDED.applied, unmapped = EXCLUDED.unmapped`,
    [
      PROVIDER,
      catalog.version,
      catalog.updated_at ?? null,
      JSON.stringify(catalog),
      applied,
      JSON.stringify(unmapped),
    ],
  )

  if (changed) {
    console.warn(`[prices] 平台价格目录版本变了（${known[0]!.version.slice(0, 8)} → ${catalog.version.slice(0, 8)}），请核对受影响的模型`)
  }

  return { version: catalog.version, applied, unmapped, changed }
}
