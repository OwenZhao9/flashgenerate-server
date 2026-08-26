/**
 * 数据库连接与查询helper。
 *
 * 所有业务查询都要带 tenant_id。这件事没法靠类型强制，
 * 所以约定：凡是读写业务表的函数，第一个参数就是 tenant 作用域，
 * 让漏掉它变成一眼能看出来的事。管理员跨租户读走单独的 admin* 函数。
 */

import pg from 'pg'
import { env } from '../lib/env.ts'

// numeric 默认会被 pg 解析成字符串以免丢精度。
// 额度是金额性质的数，全程用 number 会有浮点问题，所以保持字符串，
// 由 quota 层用定点数处理。这里显式写出来，免得后面有人以为是 bug。
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v)
// int8 同理，但我们的 id 用 uuid，bigserial 只在日志和账本里做主键，
// 这些值不会超出安全整数范围，转成 number 更好用。
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v))

export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  // Neon 这类托管库一律要求 TLS，本地开发连 localhost 时关掉。
  ssl: env.databaseUrl.includes('localhost') || env.databaseUrl.includes('127.0.0.1')
    ? false
    : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
})

pool.on('error', (err) => {
  console.error('[db] 空闲连接出错', err)
})

export type Sql = pg.Pool | pg.PoolClient

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: Sql,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await sql.query<T>(text, params as never[])
  return res.rows
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: Sql,
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, text, params)
  return rows[0] ?? null
}

/**
 * 在一个事务里跑。
 *
 * 额度的预扣、结算、退还必须和任务状态变更在同一个事务里，
 * 否则中途崩溃就会出现「扣了钱但任务没提交」这类对不上的账。
 */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export async function closePool(): Promise<void> {
  await pool.end()
}
