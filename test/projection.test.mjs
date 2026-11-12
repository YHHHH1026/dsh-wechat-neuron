import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './harness.mjs'

Object.defineProperty(globalThis, 'requestAnimationFrame', { value: () => 0, configurable: true })

const { NeuronRenderer } = loadClient({ test: true }).__test

function makeRenderer() {
  const r = new NeuronRenderer({ getContext: () => ({}) }, {})
  r.w = 1440
  r.h = 900
  r.fit = 331
  r.camera = { yaw: 0.62, pitch: -0.58, zoom: 1.2, panX: 0, panY: 0 }
  return r
}

test('project 不再返回 scale（正交投影没有透视缩放）', () => {
  const p = makeRenderer().project({ x: 0.5, y: 0, z: 0 })
  assert.equal(p.scale, undefined)
})

test('project 与闭式正交公式逐项一致', () => {
  const r = makeRenderer()
  const { yaw, pitch, zoom, panX, panY } = r.camera
  const s = zoom * r.fit
  const node = { x: 0.4, y: -0.2, z: 0.7 }
  const cosY = Math.cos(yaw), sinY = Math.sin(yaw)
  const cosP = Math.cos(pitch), sinP = Math.sin(pitch)
  const x1 = node.x * cosY - node.z * sinY
  const z1 = node.x * sinY + node.z * cosY
  const y2 = node.y * cosP - z1 * sinP
  const z2 = node.y * sinP + z1 * cosP
  const p = r.project(node)
  assert.ok(Math.abs(p.sx - (720 + panX + x1 * s)) < 1e-12, `sx=${p.sx}`)
  assert.ok(Math.abs(p.sy - (450 + panY + y2 * s)) < 1e-12, `sy=${p.sy}`)
  assert.ok(Math.abs(p.depth - z2) < 1e-12, `depth=${p.depth}`)
})

test('世界原点落在画布中心', () => {
  const o = makeRenderer().project({ x: 0, y: 0, z: 0 })
  assert.ok(Math.abs(o.sx - 720) < 1e-12)
  assert.ok(Math.abs(o.sy - 450) < 1e-12)
})

test('正交：屏幕位置只由 fit*zoom 决定，与深度无关', () => {
  const r = makeRenderer()
  r.camera = { yaw: 0, pitch: 0, zoom: 1, panX: 0, panY: 0 }
  assert.ok(Math.abs(r.project({ x: 1, y: 0, z: 0 }).sx - (720 + r.fit)) < 1e-9)
  assert.ok(Math.abs(r.project({ x: 0, y: 1, z: 0 }).sy - (450 + r.fit)) < 1e-9)
  // 同一 x/y、不同 z 的屏幕上无位移
  const near = r.project({ x: 0.3, y: 0.4, z: -1 })
  const far = r.project({ x: 0.3, y: 0.4, z: 1 })
  assert.ok(Math.abs(near.sx - far.sx) < 1e-12)
  assert.ok(Math.abs(near.sy - far.sy) < 1e-12)
})

test('computeFit 给出 0.46*min(w,h)/R，不被 4 夹住', () => {
  const r = makeRenderer()
  r.nodes = [{ id: 'a', x: 1.15, y: 0, z: 0 }]
  r.targets = new Map()
  r.computeFit()
  assert.ok(Math.abs(r.fit - (0.46 * 900) / 1.15) < 1e-6, `fit=${r.fit}`)
})

test('空图不退化成 fit=1（盘面无条件绘制）', () => {
  const r = makeRenderer()
  r.nodes = []
  r.targets = new Map()
  r.computeFit()
  assert.ok(r.fit > 300, `empty fit=${r.fit}`)
})

test('fit 不会让盘面溢出画布', () => {
  const r = makeRenderer()
  // 所有节点挤在原点时不能放大到盘面超出视口
  r.nodes = [{ id: 'a', x: 0.001, y: 0, z: 0 }]
  r.targets = new Map()
  r.computeFit()
  // DISK_R=1.25 的盘面正好触到短边的一半
  assert.ok(r.fit * 1.25 <= 900 / 2 + 1e-9, `fit=${r.fit} disk=${r.fit * 1.25}`)
})

test('radiusOf 收小到星点尺度', () => {
  const r = makeRenderer()
  assert.equal(r.radiusOf({ type: 'self' }), 13)
  assert.ok(r.radiusOf({ type: 'person', score: 100 }) <= 9.0001)
  assert.ok(Math.abs(r.radiusOf({ type: 'topic', score: 100 }) - 2.8) < 1e-9)
  assert.ok(r.radiusOf({ type: 'person', score: 70 }) > r.radiusOf({ type: 'person', score: 40 }))
})

test('spread 归一化到盘内尺度（不再撒在 320）', () => {
  const r = makeRenderer()
  r.nodes = Array.from({ length: 50 }, (_, i) => ({ id: `n${i}`, x: 0, y: 0, z: 0 }))
  r.spread()
  for (const n of r.nodes) assert.ok(Math.hypot(n.x, n.y, n.z) <= 1.16, `${n.id} r=${Math.hypot(n.x, n.y, n.z)}`)
})
