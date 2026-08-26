/**
 * 测试用的 S3 兼容假件。只实现 PUT / GET / DELETE，不校验签名。
 * 只用于本地端到端验证，不属于产品代码。
 */

import { createServer } from 'node:http'

const store = new Map<string, { body: Buffer; mime: string }>()

const server = createServer((req, res) => {
  // 路径形如 /bucket/key...
  const url = new URL(req.url ?? '/', 'http://localhost')
  const key = decodeURIComponent(url.pathname.replace(/^\/[^/]+\//, ''))

  if (req.method === 'PUT') {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(Buffer.from(c)))
    req.on('end', () => {
      store.set(key, {
        body: Buffer.concat(chunks),
        mime: req.headers['content-type'] ?? 'application/octet-stream',
      })
      res.writeHead(200, { ETag: '"fake"' }).end()
    })
    return
  }

  if (req.method === 'GET') {
    const obj = store.get(key)
    if (!obj) return void res.writeHead(404).end('not found')
    res.writeHead(200, { 'Content-Type': obj.mime, 'Content-Length': String(obj.body.length) })
    res.end(obj.body)
    return
  }

  if (req.method === 'DELETE') {
    store.delete(key)
    return void res.writeHead(204).end()
  }

  res.writeHead(405).end()
})

const port = Number(process.env.FAKE_S3_PORT ?? 55433)
server.listen(port, () => console.log(`[fake-s3] 监听 ${port}`))

// 便于测试脚本查看内容
process.on('SIGUSR2', () => {
  console.log(`[fake-s3] 共 ${store.size} 个对象`)
  for (const [k, v] of store) console.log(`  ${k}  ${v.body.length} bytes  ${v.mime}`)
})
