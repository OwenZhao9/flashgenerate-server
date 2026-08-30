/**
 * 计价的正确性测试。
 * 重点在两件事：分辨率和输入类型有没有真的参与定价，以及两段式计费算不算得对。
 */

import assert from 'node:assert/strict'
import { closePool, pool } from '../src/db/index.ts'
import { estimateUsage, findRule, priceDimensions, priceOf } from '../src/quota/cost.ts'
import type { Capability } from '../src/providers/types.ts'

let pass = 0, fail = 0
async function it(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n     ${e instanceof Error ? e.message : e}`); fail++ }
}

/** 走一遍真实路径：参数 → 维度 → 查价 → 算钱 */
async function quote(capability: Capability, modelCode: string | null, params: Record<string, unknown>, usageAmount?: number) {
  const d = priceDimensions(capability, params)
  const rule = await findRule(pool, 'chanjing', capability, modelCode, d.variant, d.resolution)
  assert.ok(rule, `找不到规则：${capability}/${modelCode}`)
  const usage = usageAmount !== undefined
    ? { unit: 'second' as const, amount: usageAmount }
    : estimateUsage(capability, params)
  return { rule: rule!, charge: priceOf(rule!, usage) }
}

console.log('计价')

await it('视频按分辨率区分单价', async () => {
  const p720 = await quote('video', 'tx_kling-v3-0-text2video', { clarity: 720, video_duration: 1 }, 1)
  const p1080 = await quote('video', 'tx_kling-v3-0-text2video', { clarity: 1080, video_duration: 1 }, 1)
  const p4k = await quote('video', 'tx_kling-v3-0-text2video', { clarity: '4K', video_duration: 1 }, 1)
  assert.equal(p720.charge.points, 30, `720P 应为 30，实际 ${p720.charge.points}`)
  assert.equal(p1080.charge.points, 35, `1080P 应为 35，实际 ${p1080.charge.points}`)
  assert.equal(p4k.charge.points, 45, `4K 应为 45，实际 ${p4k.charge.points}`)
})

await it('视频按秒累计，一条 10 秒 1080P 的 Kling3.0 是 350', async () => {
  const r = await quote('video', 'tx_kling-v3-0-text2video', { clarity: 1080, video_duration: 10 }, 10)
  assert.equal(r.charge.points, 350, `实际 ${r.charge.points}`)
  assert.equal(r.charge.providerAmount, 350)
})

await it('分辨率认不出来时退到该模型最贵的一档，不会少算', async () => {
  const r = await quote('video', 'tx_kling-v3-0-text2video', { clarity: 9999, video_duration: 1 }, 1)
  assert.equal(r.charge.points, 45, `应退到最贵的 4K 价 45，实际 ${r.charge.points}`)
})

await it('同模型的魔力价一并带出来了', async () => {
  const d = priceDimensions('video', { clarity: 720 })
  const rule = await findRule(pool, 'chanjing', 'video', 'seedance-2.0-lite-wetoken', d.variant, d.resolution)
  assert.ok(rule)
  assert.equal(rule!.points, 30, '蝉豆价')
  const row = await import('../src/db/index.ts').then(m => m.one<{magic_cost:string}>(pool,
    `SELECT magic_cost FROM cost_rules WHERE model_code=$1 AND resolution='720P'`, ['seedance-2.0-lite-wetoken']))
  assert.equal(Number(row!.magic_cost), 4, '魔力价应为 4')
})

await it('图片按张累计', async () => {
  const one = await quote('image', 'doubao-seedream5.0-pro', { number_of_images: 1 })
  const four = await quote('image', 'doubao-seedream5.0-pro', { number_of_images: 4 })
  assert.equal(one.charge.points, 8, `1 张应为 8，实际 ${one.charge.points}`)
  assert.equal(four.charge.points, 32, `4 张应为 32，实际 ${four.charge.points}`)
})

await it('对口型是基础费加按秒，不是纯按秒', async () => {
  const r = await quote('lipsync', null, {}, 10)
  // 基础费 80 + 10 秒 × 1 蝉豆
  assert.equal(r.rule.basePoints, 80, `基础费应为 80，实际 ${r.rule.basePoints}`)
  assert.equal(r.charge.points, 90, `10 秒应为 80+10=90，实际 ${r.charge.points}`)
})

await it('定制数字人按次不按量', async () => {
  const r = await quote('person', null, {}, 999)
  assert.equal(r.rule.perUnit, false)
  assert.equal(r.charge.points, 80, `应恒为 80，实际 ${r.charge.points}`)
})

await it('语音合成按秒，单价是小数', async () => {
  const r = await quote('tts', null, {}, 60)
  assert.equal(r.charge.points, 6, `60 秒 × 0.1 = 6，实际 ${r.charge.points}`)
})

await it('跟旧的占位价比，差距确实是数量级的', async () => {
  const kling = await quote('video', 'tx_kling-v3-0-text2video', { clarity: 1080, video_duration: 10 }, 10)
  const oldPrice = 5 * 10  // 旧占位：5 点/秒
  assert.ok(kling.charge.points / oldPrice >= 5,
    `真实价应是旧占位的 5 倍以上，实际 ${kling.charge.points} vs ${oldPrice}`)
})

console.log(`\n通过 ${pass}，失败 ${fail}`)
await closePool()
process.exit(fail ? 1 : 0)
