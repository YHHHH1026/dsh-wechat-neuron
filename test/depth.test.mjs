import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './harness.mjs'

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps

test('depthFactor：近端（depth 最小）放大且更亮', () => {
  const { depthFactor } = loadClient({ test: true }).__test
  const near = depthFactor(0, 0, 1)
  assert.ok(close(near.r, 1.25), `r=${near.r}`)
  assert.ok(close(near.a, 1.05), `a=${near.a}`)
})

test('depthFactor：远端（depth 最大）缩小且更暗', () => {
  const { depthFactor } = loadClient({ test: true }).__test
  const far = depthFactor(1, 0, 1)
  assert.ok(close(far.r, 0.80), `r=${far.r}`)
  assert.ok(close(far.a, 0.70), `a=${far.a}`)
})

test('depthFactor：zMin === zMax 退化时取 k=0，不产生 NaN', () => {
  const { depthFactor } = loadClient({ test: true }).__test
  const same = depthFactor(5, 5, 5)
  assert.ok(Number.isFinite(same.r) && Number.isFinite(same.a), JSON.stringify(same))
  assert.ok(close(same.r, 1.25), `r=${same.r}`)
  assert.ok(close(same.a, 1.05), `a=${same.a}`)
})

test('depthFactor：zMin/zMax 反转也不越界', () => {
  const { depthFactor } = loadClient({ test: true }).__test
  for (const depth of [-2, 0, 1, 3]) {
    const f = depthFactor(depth, 1, 0)
    assert.ok(f.r >= 0.80 - 1e-9 && f.r <= 1.25 + 1e-9, `r=${f.r}`)
    assert.ok(f.a >= 0.70 - 1e-9 && f.a <= 1.05 + 1e-9, `a=${f.a}`)
  }
})

test('depthFactor：深度单调递减（越远越小越暗）', () => {
  const { depthFactor } = loadClient({ test: true }).__test
  let prevR = Infinity
  let prevA = Infinity
  for (let depth = 0; depth <= 1; depth += 0.1) {
    const f = depthFactor(depth, 0, 1)
    assert.ok(f.r <= prevR + 1e-9, `r 在 depth=${depth} 反弹`)
    assert.ok(f.a <= prevA + 1e-9, `a 在 depth=${depth} 反弹`)
    prevR = f.r
    prevA = f.a
  }
})
