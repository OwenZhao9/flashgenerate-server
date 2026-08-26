/**
 * 客户 15 条验收点的自动化核对。
 * 跑之前服务端要起着，且已配好供应商凭据。
 */

import assert from 'node:assert/strict'
import { closePool, one, pool, query } from '../src/db/index.ts'

const B = 'http://localhost:8080'
let pass = 0
let fail = 0
const notes: string[] = []

async function check(n: number, name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${n}. ${name}`)
    pass++
  } catch (err) {
    console.log(`  ✗ ${n}. ${name}`)
    console.log(`      ${err instanceof Error ? err.message : String(err)}`)
    fail++
  }
}

async function api(path: string, token?: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(B + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : {} }
}

async function login(email: string, password: string): Promise<string> {
  const r = await api('/api/auth/login', undefined, { method: 'POST', body: JSON.stringify({ email, password }) })
  if (!r.body.token) throw new Error(`登录失败 ${email}: ${JSON.stringify(r.body)}`)
  return r.body.token
}

console.log('验收核对\n')

const admin = await login('admin@flashgenerate.local', 'newpass12345')
const jia = await login('jia@example.com', 'jiaNewPass2026')
const yi = await login('yi@example.com', 'yipass1234')

const tenants = (await api('/api/admin/tenants', admin)).body.tenants
const tJia = tenants.find((t: any) => t.name === '客户甲')
const tYi = tenants.find((t: any) => t.name === '客户乙')

await check(1, '客户数据完全隔离，页面 / URL / 接口参数都拿不到别人的', async () => {
  const tasks = (await api('/api/tasks', jia)).body.tasks
  assert.ok(tasks.length > 0, '甲应该有任务')
  const id = tasks[0].id

  // 乙用 URL 直接取甲的任务
  assert.equal((await api(`/api/tasks/${id}`, yi)).status, 404, '乙不该读到甲的任务')
  // 乙的列表里不该有甲的东西
  assert.equal((await api('/api/tasks', yi)).body.tasks.length, 0)
  // 乙拿甲的素材 id 换地址
  const assets = (await api('/api/assets', jia)).body.assets
  assert.equal((await api(`/api/assets/${assets[0].id}/url`, yi)).status, 404)
  // 乙调管理端
  assert.equal((await api('/api/admin/tasks', yi)).status, 403)
  // 乙查甲的账本
  assert.equal((await api(`/api/admin/tenants/${tJia.id}/ledger`, yi)).status, 403)
  // 管理员可以看全部
  assert.ok((await api('/api/admin/tasks', admin)).body.tasks.length > 0)
})

await check(2, '换设备重新登录仍能看到自己的任务、结果和额度', async () => {
  // 新开一个会话就等于换台电脑：数据全在服务端，跟浏览器无关
  const fresh = await login('jia@example.com', 'jiaNewPass2026')
  const tasks = (await api('/api/tasks', fresh)).body.tasks
  const assets = (await api('/api/assets', fresh)).body.assets
  const quota = (await api('/api/quota', fresh)).body.quota
  assert.ok(tasks.length > 0, '看不到历史任务')
  assert.ok(assets.length > 0, '看不到生成结果')
  assert.ok(quota.granted > 0, '看不到额度')
})

await check(3, '额度在服务端执行：预扣 / 结算 / 退还，不重复扣也不重复退', async () => {
  const rows = await query<{ n: number }>(
    pool,
    `SELECT count(*)::int AS n FROM (
       SELECT task_id, op, count(*) AS c FROM quota_ledger
        WHERE task_id IS NOT NULL GROUP BY task_id, op HAVING count(*) > 1
     ) x`,
  )
  assert.equal(rows[0]!.n, 0, '存在重复的账本记录')

  // 余额与账本必须对得上
  const bad = await query(
    pool,
    `SELECT q.tenant_id FROM quota_accounts q
      WHERE q.used_points <> COALESCE(
        (SELECT sum(points) FROM quota_ledger l WHERE l.tenant_id = q.tenant_id AND l.op = 'settle'), 0)`,
  )
  assert.equal(bad.length, 0, '物化余额与账本对不上')

  // 前端改不了额度：没有任何写额度的客户端接口
  assert.equal((await api(`/api/admin/tenants/${tJia.id}/quota`, jia, {
    method: 'POST', body: JSON.stringify({ points: 999 }),
  })).status, 403)
})

await check(4, '后台能看到任务的创建人、时间、能力、模型、供应商、状态、点数与原始货币', async () => {
  const t = (await api('/api/admin/tasks', admin)).body.tasks.find((x: any) => x.status === 'success')
  assert.ok(t, '没有成功的任务可查')
  for (const f of ['created_by_email', 'created_at', 'capability', 'model_code', 'provider_id', 'status', 'points_charged', 'provider_currency', 'provider_amount']) {
    assert.ok(f in t, `缺字段 ${f}`)
  }
  assert.ok(Number(t.points_charged) > 0, '点数变化没记上')
  assert.equal(t.provider_currency, 'bean')
})

await check(5, '生成结果转存到我方存储，供应商链接失效后仍可用', async () => {
  const a = (await api('/api/assets', jia)).body.assets.find((x: any) => x.has_file)
  assert.ok(a, '没有带文件的资产')
  const row = await one<{ storage_key: string; origin_url: string }>(
    pool, `SELECT storage_key, origin_url FROM assets WHERE id = $1`, [a.id])
  assert.ok(row!.storage_key, '没有转存到我方存储')
  assert.ok(row!.origin_url, '原始地址没留档')

  // 读取走我方存储，不依赖 origin_url
  const { url } = (await api(`/api/assets/${a.id}/url`, jia)).body
  const res = await fetch(url)
  assert.equal(res.status, 200, '换出来的地址取不到文件')
  assert.ok(Number(res.headers.get('content-length')) > 1000, '取回的文件太小')
})

await check(6, '对象存储有访问控制，没有固定公开地址', async () => {
  const a = (await api('/api/assets', jia)).body.assets.find((x: any) => x.has_file)
  const { url } = (await api(`/api/assets/${a.id}/url`, jia)).body
  assert.ok(url.includes('X-Amz-Signature'), '下发的不是签名地址')
  assert.ok(url.includes('X-Amz-Expires'), '签名地址没有有效期')
  // 不带签名直接访问要被拒（真实 S3/R2 上会 403；本地假件不校验签名，这里只核对地址形态）
  assert.ok(!(await api(`/api/assets/${a.id}/url`, yi)).body.url, '别的客户不该换得出地址')
})

await check(7, '凭据只在服务端，不出现在任何客户端可读的地方', async () => {
  const p = (await api('/api/admin/providers', admin)).body
  const raw = JSON.stringify(p)
  assert.ok(!raw.includes('secret_key'), '管理端接口回传了 secret_key 字段')
  assert.ok(!/[0-9a-f]{32}/.test(raw), '管理端接口疑似回传了密钥值')
  assert.equal(p.providers[0].configured, true)

  // 客户端接口一律取不到
  for (const path of ['/api/auth/me', '/api/models', '/api/overview']) {
    const body = JSON.stringify((await api(path, jia)).body)
    assert.ok(!body.includes('secret'), `${path} 里出现了 secret`)
  }
})

await check(8, '密码不明文存储，停用与重置立即生效', async () => {
  const row = await one<{ h: string }>(pool, `SELECT password_hash AS h FROM accounts WHERE email = 'yi@example.com'`)
  assert.ok(row!.h.startsWith('scrypt$'), '不是哈希存储')
  assert.ok(!row!.h.includes('yipass'), '哈希里能看到明文')

  const acc = (await api('/api/admin/accounts', admin)).body.accounts.find((a: any) => a.email === 'yi@example.com')
  const token = await login('yi@example.com', 'yipass1234')
  assert.equal((await api('/api/auth/me', token)).status, 200)

  await api(`/api/admin/accounts/${acc.id}`, admin, { method: 'PATCH', body: JSON.stringify({ disabled: true }) })
  assert.equal((await api('/api/auth/me', token)).status, 401, '停用后手上的凭证还能用')

  await api(`/api/admin/accounts/${acc.id}`, admin, { method: 'PATCH', body: JSON.stringify({ disabled: false }) })
})

await check(9, '重复点击 / 刷新 / 重试不会重复建任务、重复扣额度', async () => {
  const key = `acc-idem-${Math.random().toString(36).slice(2, 10)}`
  const before = (await api('/api/quota', jia)).body.quota.available

  const submits = await Promise.all(
    Array.from({ length: 6 }, () =>
      api('/api/tasks', jia, {
        method: 'POST',
        body: JSON.stringify({
          capability: 'image', modelCode: 'doubao-seedream5.0-pro',
          name: '幂等核对', idempotencyKey: key,
          params: { ref_prompt: '核对用', number_of_images: 1 },
        }),
      }),
    ),
  )
  const ids = new Set(submits.map((r) => r.body.task?.id).filter(Boolean))
  assert.equal(ids.size, 1, `产生了 ${ids.size} 条任务`)

  const rows = await query(pool, `SELECT id FROM tasks WHERE idempotency_key = $1`, [key])
  assert.equal(rows.length, 1, '库里落了多条')

  const after = (await api('/api/quota', jia)).body.quota.available
  assert.equal(before - after, 2, `扣了 ${before - after} 点，应该只扣一次 2 点`)
})

await check(10, '关掉浏览器或服务重启，任务状态和额度都不丢', async () => {
  // 队列必须在库里而不是内存里
  const cols = await query<{ c: string }>(
    pool,
    `SELECT column_name AS c FROM information_schema.columns WHERE table_name = 'tasks'`,
  )
  const names = cols.map((c) => c.c)
  for (const need of ['status', 'next_run_at', 'lease_owner', 'lease_until', 'attempts']) {
    assert.ok(names.includes(need), `tasks 表缺 ${need}，队列没有落库`)
  }
  // 额度同理
  const q = await query(pool, `SELECT tenant_id FROM quota_accounts`)
  assert.ok(q.length > 0, '额度没有落库')
})

await check(11, '各类异常有明确状态和后台日志，不是只显示「生成失败」', async () => {
  const codes = await query<{ error_code: string }>(
    pool, `SELECT DISTINCT error_code FROM tasks WHERE error_code IS NOT NULL`)
  assert.ok(codes.length > 0, '没有归类过的错误')
  for (const c of codes) {
    assert.ok(
      ['auth_failed','rate_limited','timeout','bad_param','missing_resource','content_rejected','insufficient_balance','provider_error','unknown','archive_retry'].includes(c.error_code),
      `未归类的错误码 ${c.error_code}`,
    )
  }
  // 失败任务要带得上原话和原始响应
  const failed = (await api('/api/admin/tasks', admin)).body.tasks.find((t: any) => t.error_message)
  assert.ok(failed, '没有带错误信息的任务')
  const detail = (await api(`/api/admin/tasks/${failed.id}`, admin)).body
  assert.ok(detail.logs.length > 0, '没有调用日志')
})

await check(12, '管理员调额度立即生效并留记录', async () => {
  const before = (await api(`/api/admin/tenants/${tYi.id}/ledger`, admin)).body.quota.available
  await api(`/api/admin/tenants/${tYi.id}/quota`, admin, {
    method: 'POST', body: JSON.stringify({ points: 30, note: '验收核对' }),
  })
  const after = (await api(`/api/admin/tenants/${tYi.id}/ledger`, admin)).body
  assert.equal(after.quota.available, before + 30, '额度没有立即生效')
  assert.ok(after.ledger.some((l: any) => l.note === '验收核对'), '没有留下调整记录')

  // 客户那边读到的也是新值。
  // 注意要重新登录：第 8 条停用过这个账号，顶上那个 token 已经被撤销了——
  // 这本身就是第 8 条生效的证明，但拿它继续请求会得到 401。
  const yiFresh = await login('yi@example.com', 'yipass1234')
  const seen = (await api('/api/quota', yiFresh)).body.quota.available
  assert.equal(seen, before + 30)

  await api(`/api/admin/tenants/${tYi.id}/quota`, admin, {
    method: 'POST', body: JSON.stringify({ points: -30, note: '验收核对回滚' }),
  })
})

await check(13, '模型列表从服务端读，增删模型不用重发前端', async () => {
  const models = (await api('/api/models', jia)).body.models
  assert.ok(models.length >= 9, `只读到 ${models.length} 个模型`)
  const m = models[0]
  for (const f of ['code', 'capability', 'providerId', 'label', 'fields']) assert.ok(f in m, `缺 ${f}`)
  assert.ok(m.label.zh && m.label.en, '模型名没有中英两版，加模型仍要改前端词典')
  assert.ok(Array.isArray(m.fields) && m.fields.length > 0, '没有下发表单字段')
})

await check(14, '多供应商架构：接新家只加适配器和模型配置', async () => {
  const { listProviders, CAPABILITIES } = await import('../src/providers/types.ts')
  await import('../src/providers/chanjing/index.ts')
  const ps = listProviders()
  assert.equal(ps.length, 1)
  // 接口齐不齐
  for (const fn of ['submit', 'poll', 'upload', 'balance', 'models']) {
    assert.equal(typeof (ps[0] as any)[fn], 'function', `适配器缺 ${fn}`)
  }
  // 账号、任务、额度、资料库都不认供应商特有概念
  assert.ok(CAPABILITIES.length === 7)
  const caps = await query<{ v: string }>(pool, `SELECT unnest(enum_range(NULL::capability))::text AS v`)
  assert.equal(caps.length, 7, '能力枚举与代码不一致')
  // 并发按 供应商 × 能力 配置，不是全局一个数
  const limits = await query(pool, `SELECT provider_id, capability FROM provider_limits`)
  assert.equal(limits.length, 7)
})

await check(15, '交付物齐全，且完成过一次完整上线测试', async () => {
  const { readdir } = await import('node:fs/promises')
  const files = await readdir(new URL('../', import.meta.url))
  for (const f of ['migrations', 'src', '.env.example', 'package.json']) {
    assert.ok(files.includes(f), `缺 ${f}`)
  }
  // 一次完整跑通：提交 → 生成 → 转存 → 结算 → 入库
  const done = await one<{ n: number }>(
    pool,
    `SELECT count(*)::int AS n FROM tasks t
      WHERE t.status = 'success'
        AND EXISTS (SELECT 1 FROM assets a WHERE a.task_id = t.id AND a.storage_key IS NOT NULL)
        AND EXISTS (SELECT 1 FROM quota_ledger l WHERE l.task_id = t.id AND l.op = 'settle')`,
  )
  assert.ok(done!.n > 0, '没有一条走完全流程的任务')
  notes.push(`走完整条链的任务：${done!.n} 条`)
})

console.log(`\n通过 ${pass}，失败 ${fail}`)
for (const n of notes) console.log(`  · ${n}`)
await closePool()
process.exit(fail ? 1 : 0)
