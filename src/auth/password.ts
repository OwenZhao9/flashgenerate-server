/**
 * 口令哈希。
 *
 * 用 Node 自带的 scrypt，不引原生模块。argon2 的实现都要编译，
 * 换个部署平台就可能装不上，而这套东西以后是要交给客户自己部署的，
 * 少一个能在半夜炸掉的环节比多几分安全余量更划算。scrypt 本身是标准 KDF，够用。
 *
 * 存储格式：scrypt$N$r$p$salt$hash，全部 base64。
 * 参数写进串里，以后调强度不影响老口令能不能验通过。
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>

const N = 2 ** 15
const r = 8
const p = 1
const KEYLEN = 32
// 默认 maxmem 是 32MB，N=32768 时不够用，给足两倍余量。
const MAXMEM = 128 * N * r * 2

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(plain.normalize('NFKC'), salt, KEYLEN, { N, r, p, maxmem: MAXMEM })
  return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$')
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false

  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts
  const n = Number(nRaw)
  const rr = Number(rRaw)
  const pp = Number(pRaw)
  if (!n || !rr || !pp || !saltB64 || !hashB64) return false

  const expected = Buffer.from(hashB64, 'base64')
  const key = await scrypt(plain.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: n,
    r: rr,
    p: pp,
    maxmem: 128 * n * rr * 2,
  })

  return key.length === expected.length && timingSafeEqual(key, expected)
}
