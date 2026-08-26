/**
 * 客户点名的异常场景演练。
 * 同时提交多个任务，其中一个成功、一个失败、一个排队，
 * 然后模拟刷新页面、重新登录，核对额度变化和后台记录。
 */

import assert from 'node:assert/strict'
import { closePool, one, pool, query } from '../src/db/index.ts'

const B = 'http://localhost:8080'

async function api(path: string, token?: string, init: RequestInit = {}) {
  const res = await fetch(B + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : ({} as any) }
}

const login = async (e: string, p: string) =>
  (await api('/api/auth/login', undefined, { method: 'POST', body: JSON.stringify({ email: e, password: p }) })).body.token

const admin = await login('admin@flashgenerate.local', 'newpass12345')
let jia = await login('jia@example.com', 'jiaNewPass2026')

const q0 = (await api('/api/quota', jia)).body.quota
console.log(`开始前额度：可用 ${q0.available} · 已用 ${q0.used} · 占用 ${q0.held}\n`)

const stamp = Math.random().toString(36).slice(2, 8)
const submit = (name: string, params: Record<string, unknown>) =>
  api('/api/tasks', jia, {
    method: 'POST',
    body: JSON.stringify({
      capability: 'image',
      modelCode: 'doubao-seedream5.0-pro',
      name,
      idempotencyKey: `scn-${stamp}-${name}`,
      params,
    }),
  })

// 三条一起发：一条正常、一条参数必然被拒、一条正常（会排在第一条后面）
console.log('同时提交三条任务…')
const [ok1, bad, ok2] = await Promise.all([
  submit('会成功的', { ref_prompt: '一朵白色山茶花特写', aspect_ratio: '1:1', number_of_images: 1 }),
  submit('会失败的', { ref_prompt: '测试', aspect_ratio: '7:3', number_of_images: 1 }),
  submit('会排队的', { ref_prompt: '雨后的城市街道', aspect_ratio: '16:9', number_of_images: 1 }),
])
const ids = [ok1, bad, ok2].map((r) => r.body.task.id)

const q1 = (await api('/api/quota', jia)).body.quota
console.log(`提交后额度：可用 ${q1.available} · 占用 ${q1.held}（三条各预扣 2 点）`)
assert.equal(q1.held - q0.held, 6, '预扣数不对')

// 立刻看一眼排队状态，这是客户要求界面上必须显示的四态
const early = (await api('/api/tasks', jia)).body.tasks.filter((t: any) => ids.includes(t.id))
console.log('\n提交瞬间的状态：')
for (const t of early) console.log(`  ${t.name}：${t.status}${t.queueAhead !== null ? ` · 前面还有 ${t.queueAhead} 个` : ''}`)

// 模拟刷新页面 + 重新登录
console.log('\n模拟刷新页面并重新登录…')
jia = await login('jia@example.com', 'jiaNewPass2026')

// 等三条都跑完
const deadline = Date.now() + 180_000
let rows: any[] = []
while (Date.now() < deadline) {
  rows = (await api('/api/tasks', jia)).body.tasks.filter((t: any) => ids.includes(t.id))
  if (rows.every((t: any) => ['success', 'failed', 'fatal', 'cancelled'].includes(t.status))) break
  await new Promise((r) => setTimeout(r, 5000))
}

console.log('\n最终状态：')
for (const t of rows) {
  console.log(`  ${t.name}：${t.status}${t.errorMessage ? ` · ${t.errorMessage}` : ''}`)
}

const q2 = (await api('/api/quota', jia)).body.quota
console.log(`\n结束后额度：可用 ${q2.available} · 已用 ${q2.used} · 占用 ${q2.held}`)

const succeeded = rows.filter((t: any) => t.status === 'success')
const failed = rows.filter((t: any) => t.status !== 'success')

// 只核对这三条自己的账。
// 不拿全局余额做差是因为同一租户可能还有别的任务在跑，
// 那些任务的结算会混进差值里，让断言时灵时不灵。
const mine = await query<{ op: string; points: string; task_id: string }>(
  pool,
  `SELECT op::text, points, task_id::text FROM quota_ledger WHERE task_id = ANY($1::uuid[])`,
  [ids],
)
const sumOf = (op: string) =>
  mine.filter((r) => r.op === op).reduce((n, r) => n + Number(r.points), 0)

assert.equal(sumOf('hold'), 6, '三条应该各预扣 2 点')
assert.equal(sumOf('settle'), succeeded.length * 2, '成功的没按数结算')
assert.equal(sumOf('refund'), -failed.length * 2, '失败的没全额退回')
assert.equal(q2.held, 0, '还有没结清的预扣')
console.log(`  成功 ${succeeded.length} 条共扣 ${succeeded.length * 2} 点，失败 ${failed.length} 条全额退回 ✓`)

// 后台记录
console.log('\n后台记录：')
for (const id of ids) {
  const d = (await api(`/api/admin/tasks/${id}`, admin)).body
  const ops = d.ledger.map((l: any) => `${l.op} ${l.points}`).join(' → ')
  console.log(`  ${d.task.name}：${ops}｜调用 ${d.logs.length} 次｜${d.task.error_code ?? '无错误'}`)
}

// 成功的那条要有文件落到我方存储
for (const t of succeeded) {
  const a = await one<{ storage_key: string }>(pool, `SELECT storage_key FROM assets WHERE task_id = $1`, [t.id])
  assert.ok(a?.storage_key, `${t.name} 没有把结果转存下来`)
}
console.log(`\n成功任务的结果都已转存到对象存储 ✓`)

await closePool()
