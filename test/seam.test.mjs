import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './harness.mjs'

test('生产模式只导出 inject 与 apply', () => {
  const m = loadClient({ test: false })
  assert.deepEqual(Object.keys(m).sort(), ['apply', 'inject'])
})

test('测试模式暴露 __test 缝', () => {
  const m = loadClient({ test: true })
  assert.equal(typeof m.__test, 'object')
  assert.equal(typeof m.__test.NeuronRenderer, 'function')
})
