/**
 * 登录相关。
 *
 * 没有自助注册：账号一律由管理员在后台创建，这是客户明确的范围。
 * 也没有找回密码的自助流程，忘了找管理员重置——省掉邮件服务这一整套依赖。
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { one, pool, query, tx } from '../db/index.ts'
import { hashPassword, verifyPassword } from '../auth/password.ts'
import { createSession, revokeAllSessions, revokeSession } from '../auth/session.ts'
import { HttpError, requireAuth, sendError } from '../auth/guard.ts'

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

const changePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, '新密码至少 8 位'),
})

export function authRoutes(app: FastifyInstance): void {
  app.post('/api/auth/login', async (req, reply) => {
    try {
      const body = loginBody.parse(req.body)

      const account = await one<{
        id: string
        password_hash: string
        disabled_at: Date | null
      }>(
        pool,
        `SELECT id, password_hash, disabled_at FROM accounts WHERE email = $1`,
        [body.email],
      )

      // 账号不存在时也要走一遍哈希校验，否则响应快慢会把「这个邮箱存不存在」漏出去。
      const stored = account?.password_hash ?? 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
      const ok = await verifyPassword(body.password, stored)

      if (!account || !ok) throw new HttpError(401, 'bad_credentials', '邮箱或密码不正确')
      if (account.disabled_at) throw new HttpError(403, 'account_disabled', '账号已停用，请联系管理员')

      const { token, expiresAt } = await createSession(
        pool,
        account.id,
        req.headers['user-agent'],
      )

      const me = await one(
        pool,
        `SELECT a.id, a.email, a.name, a.role, a.must_change_password,
                t.id AS tenant_id, t.name AS tenant_name, t.kind AS tenant_kind
           FROM accounts a JOIN tenants t ON t.id = a.tenant_id
          WHERE a.id = $1`,
        [account.id],
      )

      reply.send({ token, expiresAt, account: me })
    } catch (err) {
      if (err instanceof z.ZodError) {
        return sendError(reply, new HttpError(400, 'bad_request', '邮箱或密码格式不正确'))
      }
      sendError(reply, err)
    }
  })

  app.post('/api/auth/logout', async (req, reply) => {
    try {
      const p = requireAuth(req)
      await revokeSession(pool, p.sessionId)
      reply.send({ ok: true })
    } catch (err) {
      sendError(reply, err)
    }
  })

  app.get('/api/auth/me', async (req, reply) => {
    try {
      const p = requireAuth(req)
      const me = await one(
        pool,
        `SELECT a.id, a.email, a.name, a.role, a.must_change_password,
                t.id AS tenant_id, t.name AS tenant_name, t.kind AS tenant_kind
           FROM accounts a JOIN tenants t ON t.id = a.tenant_id
          WHERE a.id = $1`,
        [p.accountId],
      )
      reply.send({ account: me })
    } catch (err) {
      sendError(reply, err)
    }
  })

  app.post('/api/auth/password', async (req, reply) => {
    try {
      const p = requireAuth(req)
      const body = changePasswordBody.parse(req.body)

      const account = await one<{ password_hash: string }>(
        pool,
        `SELECT password_hash FROM accounts WHERE id = $1`,
        [p.accountId],
      )
      if (!account || !(await verifyPassword(body.currentPassword, account.password_hash))) {
        throw new HttpError(400, 'bad_credentials', '当前密码不正确')
      }

      const next = await hashPassword(body.newPassword)

      // 改完密码把所有会话踢掉，包括自己这一个，然后立刻发一个新的。
      // 别的设备上还开着的窗口当场失效，这是改密码应有的效果。
      const token = await tx(async (client) => {
        await query(
          client,
          `UPDATE accounts SET password_hash = $2, must_change_password = false, updated_at = now()
            WHERE id = $1`,
          [p.accountId, next],
        )
        await revokeAllSessions(client, p.accountId)
        const s = await createSession(client, p.accountId, req.headers['user-agent'])
        return s.token
      })

      reply.send({ ok: true, token })
    } catch (err) {
      if (err instanceof z.ZodError) {
        const first = err.errors[0]
        return sendError(reply, new HttpError(400, 'bad_request', first?.message ?? '参数不正确'))
      }
      sendError(reply, err)
    }
  })
}
