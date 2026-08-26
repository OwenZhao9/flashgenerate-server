/**
 * 额度账本的不变量测试。
 * 针对验收第 3 条：不能重复扣费、不能重复退款、并发提交不能透支。
 */

import assert from 'node:assert/strict'
import { closePool, one, pool, query, tx } from '../src/db/index.ts'
import { adjust, balanceOf, hold, InsufficientQuota, refund, settle } from '../src/quota/ledger.ts'

let pass = 0
let fail = 0

async function it(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    pass++
  } catch (err) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${err instanceof Error ? err.message : String(err)}`)
    fail++
  }
}

async function freshTenant(): Promise<string> {
  const t = await one<{ id: string }>(
    pool,
    `INSERT INTO tenants (kind, name) VALUES ('client', $1) RETURNING id`,
    [`测试租户-${Math.random().toString(36).slice(2, 8)}`],
  )
  await query(pool, `INSERT INTO quota_accounts (tenant_id) VALUES ($1)`, [t!.id])
  return t!.id
}

/** 任务表有外键，账本要挂在真任务上 */
async function freshTask(tenantId: string): Promise<string> {
  const admin = await one<{ id: string }>(pool, `SELECT id FROM accounts WHERE role='admin' LIMIT 1`)
  const t = await one<{ id: string }>(
    pool,
    `INSERT INTO tasks (tenant_id, created_by, capability, provider_id, idempotency_key)
     VALUES ($1, $2, 'image', 'chanjing', $3) RETURNING id`,
    [tenantId, admin!.id, `k-${Math.random().toString(36).slice(2, 12)}`],
  )
  return t!.id
}

console.log('额度账本')

await it('发放额度后可用额度等于发放额', async () => {
  const tenant = await freshTenant()
  await adjust({ tenantId: tenant, points: 100, actorAccountId: (await one<{id:string}>(pool, `SELECT id FROM accounts WHERE role='admin' LIMIT 1`))!.id })
  const b = await balanceOf(pool, tenant)
  assert.equal(b.available, 100)
})

await it('预扣占住额度，可用额度相应减少', async () => {
  const tenant = await freshTenant()
  const admin = (await one<{id:string}>(pool, `SELECT id FROM accounts WHERE role='admin' LIMIT 1`))!.id
  await adjust({ tenantId: tenant, points: 100, actorAccountId: admin })
  const task = await freshTask(tenant)
  await tx((c) => hold(c, { tenantId: tenant, taskId: task, points: 30 }))
  const b = await balanceOf(pool, tenant)
  assert.equal(b.held, 30)
  assert.equal(b.available, 70)
})

await it('同一个任务重复预扣只扣一次', async () => {
  const tenant = await freshTenant()
  const admin = (await one<{id:string}>(pool, `SELECT id FROM accounts WHERE role='admin' LIMIT 1`))!.id
  await adjust({ tenantId: tenant, points: 100, actorAccountId: admin })
  const task = await freshTask(tenant)
  for (let i = 0; i < 5; i++) {
    await tx((c) => hold(c, { tenantId: tenant, taskId: task, points: 30 }))
  }
  const b = await balanceOf(pool, tenant)
  assert.equal(b.held, 30, `重复预扣了，held=${b.held}`)
  assert.equal(b.available, 70)
})

await it('额度不足时预扣被拒绝', async () => {
  const tenant = await freshTenant()
  const admin = (await one<{id:string}>(pool, `SELECT id FROM accounts WHERE role='admin' LIMIT 1`))!.id
  await adjust({ tenantId: tenant, points: 10, actorAccountId: admin })
  const task = await freshTask(tenant)
  await assert.rejects(
    () => tx((c) => hold(c, { tenantId: tenant, taskId: task, points: 30 })),
    (e) => e instanceof InsufficientQuota,
  )
  const b = await balanceOf(pool, tenant)
  assert.equal(b.held, 0)
})

await it('并发提交不会透支', async () => {
  const tenant = await freshTenant()
  const admin = (await one<{id:string}>(pool, `SELECT id FROM accounts WHERE role='admin' LIMIT 1`))!.id
  await adjust({ tenantId: tenant, points: 100, actorAccountId: admin })
  // 10 个任务同时各扣 30，额度只够 3 个
  const tasks = await Promise.all(Array.from({ length: 10 }, () => freshTask(tenant)))
  const results = await Promise.allSettled(
    tasks.map((task) => tx((c) => hold(c, { tenantId: tenant, taskId: task, points: 30 }))),
  )
  const ok = results.filter((r) => r.status === 'fulfilled').length
  const b = await balanceOf(pool, tenant)
  assert.equal(ok, 3, `应该只有 3 个成功，实际 ${ok}`)
  assert.equal(b.held, 90)
  assert.ok(b.available >= 0, `可用额度不能为负，实际 ${b.available}`)
})

await it('结算把预扣转成消耗，按真实用量', async () => {
  const tenant = await freshTenant()
  const admin = (await one<{id:string}>(pool, `SELECT id FROM accounts WHERE role='admin' LIMIT 1`))!.id
  await adjust({ tenantId: tenant, points: 100, actorAccountId: admin })
  const task = await freshTask(tenant)
  await tx((c) => hold(c, { tenantId: tenant, taskId: task, points: 30 }))
  // 实际只用了 22
  await tx((c) => settle(c, { tenantId: tenant, taskId: task, points: 22, currency: 'bean', providerAmount: 44 }))
  const b = await balanceOf(pool, tenant)
  assert.equal(b.held, 0, '预扣要清掉')
  assert.equal(b.used, 22)
  assert.equal(b.available, 78)
})

await it('重复结算只算一次', async () => {
  const tenant = await freshTenant()
  const admin = (await one<{id:string}>(pool, `SELECT id FROM accounts WHERE role='admin' LIMIT 1`))!.id
  await adjust({ tenantId: tenant, points: 100, actorAccountId: admin })
  const task = await freshTask(tenant)
  await tx((c) => hold(c, { tenantId: tenant, taskId: task, points: 30 }))
  for (let i = 0; i < 5; i++) {
    await tx((c) => settle(c, { tenantId: tenant, taskId: task, points: 22 }))
  }
  const b = await balanceOf(pool, tenant)
  assert.equal(b.used, 22, `重复结算了，used=${b.used}`)
})

await it('失败退还预扣，额度回到原样', async () => {
  const tenant = await freshTenant()
  const admin = (await one<{id:string}>(pool, `SELECT id FROM accounts WHERE role='admin' LIMIT 1`))!.id
  await adjust({ tenantId: tenant, points: 100, actorAccountId: admin })
  const task = await freshTask(tenant)
  await tx((c) => hold(c, { tenantId: tenant, taskId: task, points: 30 }))
  await tx((c) => refund(c, { tenantId: tenant, taskId: task }))
  const b = await balanceOf(pool, tenant)
  assert.equal(b.held, 0)
  assert.equal(b.used, 0)
  assert.equal(b.available, 100)
})

await it('重复退款只退一次', async () => {
  const tenant = await freshTenant()
  const admin = (await one<{id:string}>(pool, `SELECT id FROM accounts WHERE role='admin' LIMIT 1`))!.id
  await adjust({ tenantId: tenant, points: 100, actorAccountId: admin })
  const task = await freshTask(tenant)
  await tx((c) => hold(c, { tenantId: tenant, taskId: task, points: 30 }))
  for (let i = 0; i < 5; i++) {
    await tx((c) => refund(c, { tenantId: tenant, taskId: task }))
  }
  const b = await balanceOf(pool, tenant)
  assert.equal(b.available, 100, `重复退款了，available=${b.available}`)
})

await it('已结算的任务不能再退款', async () => {
  const tenant = await freshTenant()
  const admin = (await one<{id:string}>(pool, `SELECT id FROM accounts WHERE role='admin' LIMIT 1`))!.id
  await adjust({ tenantId: tenant, points: 100, actorAccountId: admin })
  const task = await freshTask(tenant)
  await tx((c) => hold(c, { tenantId: tenant, taskId: task, points: 30 }))
  await tx((c) => settle(c, { tenantId: tenant, taskId: task, points: 30 }))
  await tx((c) => refund(c, { tenantId: tenant, taskId: task }))
  const b = await balanceOf(pool, tenant)
  assert.equal(b.used, 30, '已经发生的消耗不能退')
  assert.equal(b.available, 70)
})

await it('账本流水与物化余额始终一致', async () => {
  const tenant = await freshTenant()
  const admin = (await one<{id:string}>(pool, `SELECT id FROM accounts WHERE role='admin' LIMIT 1`))!.id
  await adjust({ tenantId: tenant, points: 500, actorAccountId: admin })
  for (let i = 0; i < 6; i++) {
    const task = await freshTask(tenant)
    await tx((c) => hold(c, { tenantId: tenant, taskId: task, points: 20 }))
    if (i % 2 === 0) await tx((c) => settle(c, { tenantId: tenant, taskId: task, points: 17 }))
    else await tx((c) => refund(c, { tenantId: tenant, taskId: task }))
  }
  const b = await balanceOf(pool, tenant)
  const sums = await one<{ granted: string; used: string }>(
    pool,
    `SELECT COALESCE(SUM(points) FILTER (WHERE op='adjust'),0) AS granted,
            COALESCE(SUM(points) FILTER (WHERE op='settle'),0) AS used
       FROM quota_ledger WHERE tenant_id = $1`,
    [tenant],
  )
  assert.equal(b.granted, Number(sums!.granted), '发放额对不上账本')
  assert.equal(b.used, Number(sums!.used), '消耗对不上账本')
  assert.equal(b.held, 0, '全部结束后不该还有预扣')
})

await it('重复写账本之后，同一个事务里还能继续写别的表', async () => {
  // 回归用例。原来靠 catch 唯一约束错误来做幂等，
  // 但 Postgres 里语句一报错整个事务就中止了，catch 掉也救不回来——
  // 后面那条 UPDATE tasks 会以「当前事务被终止」失败，
  // 而且报错的是无辜的那条语句，很难往回查到真正的原因。
  const tenant = await freshTenant()
  const admin = (await one<{id:string}>(pool, `SELECT id FROM accounts WHERE role='admin' LIMIT 1`))!.id
  await adjust({ tenantId: tenant, points: 100, actorAccountId: admin })
  const task = await freshTask(tenant)

  await tx((c) => hold(c, { tenantId: tenant, taskId: task, points: 10 }))
  await tx((c) => refund(c, { tenantId: tenant, taskId: task }))

  // 第二次退款会撞唯一约束，之后同一个事务里还要能改任务状态
  await tx(async (c) => {
    await refund(c, { tenantId: tenant, taskId: task, note: '重复退款' })
    await query(c, `UPDATE tasks SET status = 'fatal', error_code = $2 WHERE id = $1`, [task, 'test'])
  })

  const row = await one<{ status: string; error_code: string }>(
    pool,
    `SELECT status::text, error_code FROM tasks WHERE id = $1`,
    [task],
  )
  assert.equal(row!.status, 'fatal', '事务被中止会让这条 UPDATE 静默失败')
  assert.equal(row!.error_code, 'test')

  const b = await balanceOf(pool, tenant)
  assert.equal(b.available, 100, '只该退一次')
})

console.log(`\n通过 ${pass}，失败 ${fail}`)
await closePool()
process.exit(fail ? 1 : 0)
