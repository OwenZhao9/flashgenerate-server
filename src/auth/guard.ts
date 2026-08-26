/**
 * 鉴权与租户作用域。
 *
 * 隔离的实现方式：每个请求解析出一个 scope，业务查询一律拿 scope.tenantId 去过滤。
 * 管理员是唯一能跨租户读的角色，而且必须显式走 adminScope，
 * 不存在「忘了加条件就变成能看全部」这种默认宽松的路径。
 */

import type { FastifyReply, FastifyRequest } from 'fastify'
import { resolveSession, type Principal, type Role } from './session.ts'

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal
  }
}

/**
 * 注意：字段是显式声明再赋值的，没有用构造器参数属性。
 * Node 直接跑 TS 时只做类型擦除，不做语法降级，
 * `constructor(readonly x: number)` 这种需要生成代码的写法会直接报错。
 * 同理整个服务端不用 enum、namespace 和装饰器。
 */
export class HttpError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

export const unauthorized = () => new HttpError(401, 'unauthorized', '请先登录')
export const forbidden = () => new HttpError(403, 'forbidden', '没有权限')

function bearer(req: FastifyRequest): string {
  const raw = req.headers.authorization
  if (!raw) return ''
  const [scheme, token] = raw.split(' ')
  return scheme?.toLowerCase() === 'bearer' ? (token ?? '') : ''
}

/** 挂在 preHandler 上，解析出身份但不强制要求登录 */
export async function attachPrincipal(req: FastifyRequest): Promise<void> {
  const token = bearer(req)
  if (!token) return
  const principal = await resolveSession(token)
  if (principal) req.principal = principal
}

export function requireAuth(req: FastifyRequest): Principal {
  if (!req.principal) throw unauthorized()
  return req.principal
}

export function requireRole(req: FastifyRequest, ...roles: Role[]): Principal {
  const p = requireAuth(req)
  if (!roles.includes(p.role)) throw forbidden()
  return p
}

export const requireAdmin = (req: FastifyRequest) => requireRole(req, 'admin')
/** 管理员和内部员工都算「我们这边的人」 */
export const requireInternal = (req: FastifyRequest) => requireRole(req, 'admin', 'staff')

/**
 * 数据作用域。
 *
 * tenantId 为 null 只可能出现在管理员显式请求跨租户视图时，
 * 业务查询拿到 null 必须走 admin 分支，不能当成「不加过滤」。
 */
export interface Scope {
  tenantId: string
  accountId: string
  role: Role
}

export function scopeOf(req: FastifyRequest): Scope {
  const p = requireAuth(req)
  return { tenantId: p.tenantId, accountId: p.accountId, role: p.role }
}

/**
 * 管理员查看指定客户的数据时用。
 * 非管理员传了别人的 tenantId 一律拒绝——这是防越权的最后一道，
 * URL 上改个 id 就能看别人数据是验收第 1 条明确点名的情况。
 */
export function scopeForTenant(req: FastifyRequest, tenantId: string): Scope {
  const p = requireAuth(req)
  if (p.role !== 'admin' && tenantId !== p.tenantId) throw forbidden()
  return { tenantId, accountId: p.accountId, role: p.role }
}

export function sendError(reply: FastifyReply, err: unknown): void {
  if (err instanceof HttpError) {
    reply.code(err.status).send({ code: err.code, message: err.message })
    return
  }
  reply.log.error({ err }, '未处理的错误')
  reply.code(500).send({ code: 'internal', message: '服务异常' })
}
