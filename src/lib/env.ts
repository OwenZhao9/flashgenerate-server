/**
 * 配置读取。
 *
 * 缺了必填项就在启动时直接退出，不要等第一个请求打进来才发现。
 * 少一个 DATABASE_URL 却能把服务拉起来，只会让人以为是代码有问题。
 */

function required(key: string): string {
  const v = process.env[key]?.trim()
  if (!v) {
    console.error(`[config] 缺少必填环境变量 ${key}，参考 .env.example`)
    process.exit(1)
  }
  return v
}

function optional(key: string, fallback: string): string {
  return process.env[key]?.trim() || fallback
}

export const env = {
  port: Number(optional('PORT', '8080')),
  isProd: process.env.NODE_ENV === 'production',

  corsOrigins: optional('CORS_ORIGINS', 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  databaseUrl: required('DATABASE_URL'),
  sessionSecret: required('SESSION_SECRET'),

  s3: {
    endpoint: optional('S3_ENDPOINT', ''),
    region: optional('S3_REGION', 'auto'),
    bucket: optional('S3_BUCKET', ''),
    accessKeyId: optional('S3_ACCESS_KEY_ID', ''),
    secretAccessKey: optional('S3_SECRET_ACCESS_KEY', ''),
    signedUrlTtl: Number(optional('S3_SIGNED_URL_TTL', '900')),
  },

  bootstrap: {
    email: optional('BOOTSTRAP_ADMIN_EMAIL', ''),
    password: optional('BOOTSTRAP_ADMIN_PASSWORD', ''),
  },
} as const

/** 对象存储配置齐不齐。缺了就只是不能上传和转存，其它功能照常。 */
export function hasStorage(): boolean {
  const s = env.s3
  return !!(s.endpoint && s.bucket && s.accessKeyId && s.secretAccessKey)
}
