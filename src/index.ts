/**
 * 服务入口。
 */

import Fastify from 'fastify'
import { env } from './lib/env.ts'
import { closePool } from './db/index.ts'
import { migrate } from './db/migrate.ts'
import { seed } from './db/seed.ts'
import { attachPrincipal } from './auth/guard.ts'
import { authRoutes } from './routes/auth.ts'
import { taskRoutes } from './routes/tasks.ts'
import { assetRoutes } from './routes/assets.ts'
import { assetExtraRoutes } from './routes/assets-extra.ts'
import { catalogRoutes } from './routes/catalog.ts'
import { adminRoutes } from './routes/admin.ts'
import { startWorker, stopWorker } from './worker/index.ts'
import { startReconcile, stopReconcile } from './worker/reconcile.ts'
import { purgeExpiredSessions } from './auth/session.ts'
import './providers/chanjing/index.ts'

const app = Fastify({
  logger: {
    level: env.isProd ? 'info' : 'debug',
    transport: env.isProd ? undefined : { target: 'pino-pretty' },
  },
  trustProxy: true,
  // 上传走原始流自己读，不让 fastify 先把 body 解析掉
  bodyLimit: 8 * 1024 * 1024,
})

// 上传接口收的是二进制流，注册一个直通的解析器，交给路由自己按流读取
app.addContentTypeParser('*', (_req, payload, done) => done(null, payload))

app.addHook('onRequest', async (req, reply) => {
  const origin = req.headers.origin
  if (origin && env.corsOrigins.includes(origin)) {
    reply.header('Access-Control-Allow-Origin', origin)
    reply.header('Vary', 'Origin')
    reply.header('Access-Control-Allow-Credentials', 'true')
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Idempotency-Key')
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
  }
  if (req.method === 'OPTIONS') reply.code(204).send()
})

app.addHook('preHandler', attachPrincipal)

app.get('/health', async () => ({ ok: true, at: new Date().toISOString() }))

authRoutes(app)
taskRoutes(app)
assetRoutes(app)
assetExtraRoutes(app)
catalogRoutes(app)
adminRoutes(app)

async function main(): Promise<void> {
  // 启动时自动迁移和初始化。这套东西最终要交给客户自己部署，
  // 少一个「记得先跑某个命令」的步骤就少一次上线事故。
  await migrate()
  await seed()

  await app.listen({ port: env.port, host: '0.0.0.0' })

  startWorker()
  startReconcile()

  // 每天清一次过期会话
  setInterval(() => void purgeExpiredSessions().catch(() => {}), 24 * 60 * 60 * 1000)

  app.log.info(`服务已启动，端口 ${env.port}`)
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    app.log.info(`收到 ${sig}，正在关闭`)
    stopWorker()
    stopReconcile()
    app
      .close()
      .then(closePool)
      .then(() => process.exit(0))
      .catch(() => process.exit(1))
  })
}

main().catch((err) => {
  app.log.error({ err }, '启动失败')
  process.exit(1)
})
