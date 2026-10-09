/** AI 创作状态回归：已经拿到结果地址时，记录必须与真实结果一致。 */

import assert from 'node:assert/strict'
import { fromAigcStatus } from '../src/providers/chanjing/index.ts'

assert.equal(fromAigcStatus('Success', 1), 'success')
assert.equal(
  fromAigcStatus('Error', 3),
  'success',
  '供应商文字状态滞后时，有有效图片地址必须判成功',
)
assert.equal(fromAigcStatus('Fail', 0), 'fatal')
assert.equal(fromAigcStatus('Generating', 0), 'running')

console.log('  ✓ AI 创作有结果地址时最终状态为成功')
