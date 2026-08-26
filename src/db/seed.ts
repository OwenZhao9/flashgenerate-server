/**
 * 首次启动的初始化。
 *
 * 全部写成幂等的：每次启动都会跑一遍，已经存在的就跳过。
 * 这样客户自己部署时不需要记住「第一次要先执行某个命令」。
 */

import { pathToFileURL } from 'node:url'
import { closePool, one, pool, query, tx } from './index.ts'
import { hashPassword } from '../auth/password.ts'
import { env } from '../lib/env.ts'

/** 平台各能力的并发与限流。管理后台可改，这里只给一份保守的初值。 */
const CHANJING_LIMITS: Array<{ capability: string; concurrency: number; rpm: number }> = [
  // 视频合成按套餐 1 / 5 / 10 路，不知道客户买的哪档，先按最保守的来，
  // 管理员在后台按实际套餐调大即可。
  { capability: 'avatar', concurrency: 1, rpm: 10 },
  // 图片和视频创作共用 ai_creation 接口，官方明确并发只有 1。
  { capability: 'image', concurrency: 1, rpm: 10 },
  { capability: 'video', concurrency: 1, rpm: 10 },
  { capability: 'tts', concurrency: 5, rpm: 200 },
  { capability: 'voice_clone', concurrency: 1, rpm: 10 },
  { capability: 'lipsync', concurrency: 1, rpm: 10 },
  { capability: 'person', concurrency: 10, rpm: 10 },
]

/** 系统分类。跟前端原有的那套对齐，换了服务端之后名字不变。 */
const SYSTEM_CATEGORIES = [
  { name: '文案', sort: 10 },
  { name: '图片', sort: 20 },
  { name: '视频', sort: 30 },
  { name: '音频', sort: 40 },
  { name: '数字人', sort: 50 },
  { name: '音色', sort: 60 },
]

export async function seedSystemCategories(sql: Parameters<typeof query>[0], tenantId: string): Promise<void> {
  for (const c of SYSTEM_CATEGORIES) {
    await query(
      sql,
      `INSERT INTO categories (tenant_id, name, sort, is_system)
       SELECT $1, $2, $3, true
        WHERE NOT EXISTS (
          SELECT 1 FROM categories WHERE tenant_id = $1 AND name = $2 AND is_system
        )`,
      [tenantId, c.name, c.sort],
    )
  }
}

export async function seed(): Promise<void> {
  // 内部租户
  let internal = await one<{ id: string }>(pool, `SELECT id FROM tenants WHERE kind = 'internal'`)
  if (!internal) {
    internal = await one<{ id: string }>(
      pool,
      `INSERT INTO tenants (kind, name) VALUES ('internal', $1) RETURNING id`,
      ['内部团队'],
    )
    console.log('[seed] 已创建内部租户')
  }
  const internalId = internal!.id

  await query(
    pool,
    `INSERT INTO quota_accounts (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`,
    [internalId],
  )
  await seedSystemCategories(pool, internalId)

  // 管理员。只在一个管理员都没有的时候创建，避免改了环境变量就多出一个号。
  const admin = await one<{ id: string }>(pool, `SELECT id FROM accounts WHERE role = 'admin' LIMIT 1`)
  if (!admin) {
    if (!env.bootstrap.email || !env.bootstrap.password) {
      console.warn('[seed] 还没有管理员，且未配置 BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD，跳过')
    } else {
      const hash = await hashPassword(env.bootstrap.password)
      await query(
        pool,
        `INSERT INTO accounts (tenant_id, email, password_hash, role, name, must_change_password)
         VALUES ($1, $2, $3, 'admin', $4, true)`,
        [internalId, env.bootstrap.email, hash, '管理员'],
      )
      console.log(`[seed] 已创建管理员 ${env.bootstrap.email}，首次登录必须改密码`)
    }
  }

  // 供应商。凭据留空，由管理员在后台填，不从环境变量读——
  // 环境变量会出现在部署平台的界面和日志里，凭据只应该在数据库一个地方。
  await tx(async (client) => {
    await query(
      client,
      `INSERT INTO providers (id, label) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      ['chanjing', 'AI 开放平台'],
    )
    for (const l of CHANJING_LIMITS) {
      await query(
        client,
        `INSERT INTO provider_limits (provider_id, capability, concurrency, rpm)
         VALUES ($1, $2::capability, $3, $4)
         ON CONFLICT (provider_id, capability) DO NOTHING`,
        ['chanjing', l.capability, l.concurrency, l.rpm],
      )
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seed()
    .then(() => closePool())
    .catch((err) => {
      console.error('[seed] 失败', err)
      process.exit(1)
    })
}
