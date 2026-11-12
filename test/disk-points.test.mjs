import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './harness.mjs'

const { generateDiskPoints, renderDiskBitmap, galaxyMath: M, GALAXY } = loadClient({ test: true }).__test

function seeded(seed) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))

/** 到最近旋臂的角偏差（4 条臂在角度上按 π/2 交错）。 */
function dev(points, i) {
  const r = Math.hypot(points.xs[i], points.zs[i])
  if (r < 1e-6) return 0
  const theta = Math.atan2(points.zs[i], points.xs[i])
  let best = Infinity
  for (let arm = 0; arm < 4; arm += 1) best = Math.min(best, Math.abs(wrap(theta - M.armAngle(arm, r))))
  return best
}

const points = generateDiskPoints(seeded(20261112))

test('星点数是设计的固定 20000', () => {
  assert.equal(points.count, 20000)
  assert.equal(points.xs.length, 20000)
  assert.equal(points.bs.length, 20000)
  assert.equal(points.colors.length, 20000 * 3)
})

test('全部坐标有限且落在位图跨度内', () => {
  for (let i = 0; i < points.count; i += 1) {
    assert.ok(Number.isFinite(points.xs[i]) && Number.isFinite(points.ys[i]) && Number.isFinite(points.zs[i]))
    assert.ok(Math.hypot(points.xs[i], points.zs[i]) <= GALAXY.DISK_R + 1e-6, `r out of range at ${i}`)
  }
})

test('亮度落在 [0.08, 1]，且成幂律（亮星极少数）', () => {
  let bright = 0
  for (let i = 0; i < points.count; i += 1) {
    assert.ok(points.bs[i] >= 0.08 - 1e-6 && points.bs[i] <= 1 + 1e-6, `b=${points.bs[i]}`)
    if (points.bs[i] > 0.9) bright += 1
  }
  assert.ok(bright / points.count > 0.02 && bright / points.count < 0.04, `bright=${bright / points.count}`)
})

test('径向分布：核球 + 指数盘让 35%–50% 的星点落在 r<0.3', () => {
  let inner = 0
  for (let i = 0; i < points.count; i += 1) {
    if (Math.hypot(points.xs[i], points.zs[i]) < 0.3) inner += 1
  }
  const frac = inner / points.count
  assert.ok(frac > 0.35 && frac < 0.50, `inner=${frac}`)
})

test('旋臂聚集明显强于均匀盘（否则就是一圈糊住的环）', () => {
  let tight = 0
  for (let i = 0; i < points.count; i += 1) if (dev(points, i) < 0.12) tight += 1
  const frac = tight / points.count
  // 均匀分布在 π/2 晶格上的基线是 0.12/(π/4)≈0.153
  const baseline = 0.12 / (Math.PI / 4)
  assert.ok(frac > baseline * 1.8, `tight=${frac} baseline=${baseline}`)
  assert.ok(frac < 0.80, `tight=${frac} 过于均匀等于没有盘间星`)
})

test('薄盘：z 的厚度随半径增大', () => {
  const bands = { inner: [], outer: [] }
  for (let i = 0; i < points.count; i += 1) {
    const r = Math.hypot(points.xs[i], points.zs[i])
    if (r >= 0.30 && r < 0.50) bands.inner.push(points.ys[i])
    else if (r >= 0.80 && r < 1.00) bands.outer.push(points.ys[i])
  }
  const std = (list) => {
    const mean = list.reduce((a, b) => a + b, 0) / list.length
    return Math.sqrt(list.reduce((a, b) => a + (b - mean) ** 2, 0) / list.length)
  }
  assert.ok(bands.inner.length > 200 && bands.outer.length > 200)
  assert.ok(std(bands.outer) > std(bands.inner) * 1.25, `inner=${std(bands.inner)} outer=${std(bands.outer)}`)
})

test('色温：核心偏暖金，品红只做点缀，其余蓝白', () => {
  const BLUE = [0xcf, 0xe0, 0xff]
  const WARM = [0xff, 0xe6, 0xc4]
  const MAGENTA = [0xff, 0x9e, 0xcf]
  const same = (i, c) => points.colors[i * 3] === c[0] && points.colors[i * 3 + 1] === c[1] && points.colors[i * 3 + 2] === c[2]
  let warmInner = 0
  let innerTotal = 0
  let magenta = 0
  for (let i = 0; i < points.count; i += 1) {
    if (same(i, MAGENTA)) magenta += 1
    const r = Math.hypot(points.xs[i], points.zs[i])
    if (r < 0.3) {
      innerTotal += 1
      if (same(i, WARM)) warmInner += 1
    }
    // 只允许三种色，避免调色时混进渐变导致整套设计走样
    assert.ok(same(i, BLUE) || same(i, WARM) || same(i, MAGENTA), `unknown color at ${i}`)
  }
  assert.ok(warmInner / innerTotal > 0.5, `warm inner=${warmInner / innerTotal}`)
  assert.ok(magenta / points.count < 0.04, `magenta=${magenta / points.count}`)
})

test('renderDiskBitmap 在无 DOM 环境下返回 null 而不是抛错', () => {
  assert.equal(renderDiskBitmap(points), null)
})
