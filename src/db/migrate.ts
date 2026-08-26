/**
 * 迁移执行器。
 *
 * 每个 .sql 文件跑一次，跑过的记在 schema_migrations 里。
 * 整个文件包在一个事务里，中途失败就整体回滚，不会留下半套结构。
 */

import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { closePool, pool, query, tx } from './index.ts'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations')

export async function migrate(): Promise<string[]> {
  await query(
    pool,
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name       text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  )

  const applied = new Set(
    (await query<{ name: string }>(pool, 'SELECT name FROM schema_migrations')).map((r) => r.name),
  )

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()
  const ran: string[] = []

  for (const file of files) {
    if (applied.has(file)) continue
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8')
    await tx(async (client) => {
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
    })
    ran.push(file)
    console.log(`[migrate] 已执行 ${file}`)
  }

  if (!ran.length) console.log('[migrate] 没有待执行的迁移')
  return ran
}

// 直接跑这个文件时执行一次。
// 必须用 pathToFileURL 转一道再比：仓库路径里有空格和中文，
// import.meta.url 是百分号编码的，跟 argv[1] 直接拼字符串永远不相等，
// 迁移会被静默跳过——没有报错，只是什么都没发生，很难查。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate()
    .then(() => closePool())
    .catch((err) => {
      console.error('[migrate] 失败', err)
      process.exit(1)
    })
}
