import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './harness.mjs'

const { galaxyMath: M, GALAXY } = loadClient({ test: true }).__test

test('armAngle 起点正确且随半径单调递增', () => {
  assert.ok(Math.abs(M.armAngle(0, GALAXY.R0) - 0) < 1e-12)
  assert.ok(Math.abs(M.armAngle(1, GALAXY.R0) - Math.PI / 2) < 1e-12)
  assert.ok(M.armAngle(2, 1.0) > M.armAngle(2, 0.5))
})

test('armSigma 恒定角宽：内盘不再糊成一团（旧式 0.11/r 的回归防线）', () => {
  // 角宽必须近似恒定（只允许轻微径向渐扩），否则质量最集中的内盘会被四条臂填满。
  const inner = M.armSigma(0.25)
  const outer = M.armSigma(1.15)
  assert.ok(outer / inner < 1.5, `角宽扩张过大 inner=${inner} outer=${outer}`)
  assert.ok(inner < 0.20, `内盘角宽 ${inner} rad 仍过宽（旧实现 0.44）`)
  // 世界宽度随半径增长 —— 教科书螺旋的臂是越往外越宽的
  assert.ok(1.15 * outer > 0.25 * inner * 2, '世界宽度未随半径增长')
  assert.equal(M.armSigma(0), GALAXY.ARM_SIGMA * 0.72)
  assert.ok(M.armSigma(99) <= 0.6)
})

test('ARM_INNER 让旋臂从核球之外起笔', () => {
  assert.ok(M.ARM_INNER > GALAXY.BULGE_TRUNC * 0.8, '起臂半径落在核球内部')
  assert.ok(M.ARM_INNER < 0.4, '起臂半径过大，盘面只剩外圈')
})

test('diskRadius 的均值等于 2h（Gamma(2,h) 反演）', () => {
  let seed = 42
  const rng = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }
  let sum = 0
  const n = 200000
  for (let i = 0; i < n; i += 1) sum += M.diskRadius(rng)
  assert.ok(Math.abs(sum / n - 2 * GALAXY.H) < 0.01, `mean=${sum / n}`)
})

test('starBrightness 幂律：b>0.9 的比例解析值为 1-(0.82/0.92)^0.25≈2.84%', () => {
  const analytic = 1 - Math.pow(0.82 / 0.92, 0.25)
  let bright = 0
  const n = 20000
  for (let i = 0; i < n; i += 1) if (M.starBrightness((i + 0.5) / n) > 0.9) bright += 1
  assert.ok(Math.abs(bright / n - analytic) < 0.002, `bright=${bright / n} analytic=${analytic}`)
  assert.ok(Math.abs(M.starBrightness(0) - 0.08) < 1e-12)
  assert.ok(Math.abs(M.starBrightness(1) - 1) < 1e-12)
})

test('nodePolarRadius 单调且落在盘内', () => {
  assert.ok(Math.abs(M.nodePolarRadius(100) - 0.10) < 1e-12)
  assert.ok(Math.abs(M.nodePolarRadius(0) - 1.02) < 1e-12)
  assert.ok(M.nodePolarRadius(40) > M.nodePolarRadius(70))
})

test('safeScore 把脏数据折成 0..100', () => {
  assert.equal(M.safeScore(null), 0)
  assert.equal(M.safeScore('abc'), 0)
  assert.equal(M.safeScore('55'), 55)
  assert.equal(M.safeScore(999), 100)
  assert.equal(M.safeScore(-3), 0)
})

test('hash01 确定且在 [0,1)', () => {
  for (const id of ['p_0001', 'g_12', 'self', '']) {
    const v = M.hash01(id)
    assert.ok(v >= 0 && v < 1, `${id} -> ${v}`)
    assert.equal(M.hash01(id), v)
  }
  assert.notEqual(M.hash01('p_0001'), M.hash01('p_0002'))
})

test('hash01 对顺序 id 也要雪崩（否则节点全挤在一个角度）', () => {
  const buckets = new Array(10).fill(0)
  const n = 1000
  for (let i = 0; i < n; i += 1) buckets[Math.floor(M.hash01(`p${i}`) * 10)] += 1
  // 每桶期望 100，允许 ±50% 波动；纯 FNV-1a 会全部落进同一两桶
  for (const [index, count] of buckets.entries()) {
    assert.ok(count > 50 && count < 150, `bucket ${index} = ${count}`)
  }
})
