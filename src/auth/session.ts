/**
 * 会话。
 *
 * 用不透明随机串，不用 JWT。验收第 8 条要求「管理员停用账号或重置密码后立即生效」，
 * JWT 在自然过期前收不回来，想立刻失效就得每次再查一次库看有没有被撤销——
 * 既然每次都要查库，用 JWT 就只剩坏处了。
 *
 * 库里存的是 HMAC 而不是原串：数据库被读走也不能拿去冒充登录，
 * 因为还缺服务端的 SESSION_SECRET。
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { env } from '../lib/env.ts'
import { one, pool, query, type Sql } from '../db/index.ts'

/** 会话有效期。设短一点，配合下面的滑动续期。 */
const TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 距上次活动超过这个时间就顺手续一次，避免每个请求都写库 */
const TOUCH_AFTER_MS = 30 * 60 * 1000

export type Role = 'admin' | 'staff' | 'client'

export interface Principal {
  accountId: string
  tenantId: string
  role: Role
  email: string
  name: string
  sessionId: string
  mustChangePassword: boolean
}

function hashToken(token: string): string {
  return createHmac('sha256', env.sessionSecret).update(token).digest('base64')
}

export async function createSession(
  sql: Sql,
  accountId: string,
  userAgent?: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + TTL_MS)

  await query(
    sql,
    `INSERT INTO sessions (account_id, token_hash, expires_at, user_agent)
     VALUES ($1, $2, $3, $4)`,
    [accountId, hashToken(token), expiresAt, userAgent ?? null],
  )

  return { token, expiresAt }
}

/**
 * 解析一个 token。
 *
 * 停用的账号当场判失效——不是等下次登录才拦，而是它手上这个还没过期的 token
 * 立刻就不好使了，这正是验收第 8 条要的效果。
 */
export async function resolveSession(token: string): Promise<Principal | null> {
  if (!token) return null

  const row = await one<{
    session_id: string
    account_id: string
    tenant_id: string
    role: Role
    email: string
    name: string
    must_change_password: boolean
    disabled_at: Date | null
    last_seen_at: Date
  }>(
    pool,
    `SELECT s.id AS session_id, a.id AS account_id, a.tenant_id, a.role, a.email, a.name,
            a.must_change_password, a.disabled_at, s.last_seen_at
       FROM sessions s
       JOIN accounts a ON a.id = s.account_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()`,
    [hashToken(token)],
  )

  if (!row) return null
  if (row.disabled_at) return null

  // 滑动续期，但不是每个请求都写库
  if (Date.now() - new Date(row.last_seen_at).getTime() > TOUCH_AFTER_MS) {
    void query(
      pool,
      `UPDATE sessions SET last_seen_at = now(), expires_at = now() + $2::interval WHERE id = $1`,
      [row.session_id, `${Math.floor(TTL_MS / 1000)} seconds`],
    ).catch(() => {})
  }

  return {
    accountId: row.account_id,
    tenantId: row.tenant_id,
    role: row.role,
    email: row.email,
    name: row.name,
    sessionId: row.session_id,
    mustChangePassword: row.must_change_password,
  }
}

export async function revokeSession(sql: Sql, sessionId: string): Promise<void> {
  await query(sql, `UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [
    sessionId,
  ])
}

/**
 * 撤销某个账号的全部会话。
 * 停用账号、重置密码、用户自己改密码之后都要调，它是「立即生效」的实现。
 */
export async function revokeAllSessions(sql: Sql, accountId: string): Promise<number> {
  const rows = await query<{ id: string }>(
    sql,
    `UPDATE sessions SET revoked_at = now()
      WHERE account_id = $1 AND revoked_at IS NULL
      RETURNING id`,
    [accountId],
  )
  return rows.length
}

/** 定期清理，别让表无限涨 */
export async function purgeExpiredSessions(): Promise<number> {
  const rows = await query<{ id: string }>(
    pool,
    `DELETE FROM sessions
      WHERE expires_at < now() - interval '30 days'
         OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days')
      RETURNING id`,
  )
  return rows.length
}

/** 用于常数时间比较，避免用 === 比 token 泄漏长度信息 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}
