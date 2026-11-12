// Task 7：边按需浮现 + pick 退化。先写测试并确认失败，再实现。
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './harness.mjs'

const client = loadClient({ test: true })
const T = client.__test

const edge = (id, a, b, weight) => ({ id, a: { id: a }, b: { id: b }, weight, type: 'chat' })

/** 构造一个不用真 canvas 的渲染器：pick/project 只需几何字段。 */
function makeRenderer() {
  const renderer = Object.create(T.NeuronRenderer.prototype)
  renderer.canvas = null
  renderer.ctx = null
  renderer.palette = {}
  renderer.scheme = 'dark'
  renderer.nodes = []
  renderer.nodeById = new Map()
  renderer.edges = []
  renderer.adj = new Map()
  renderer.camera = { yaw: 0, pitch: 0, zoom: 1, panX: 0, panY: 0 }
  renderer.hover = null
  renderer.selected = null
  renderer.focus = null
  renderer.w = 1440
  renderer.h = 900
  renderer.fit = 360
  renderer.view = {
    showTopics: true, showGroups: true, showCooccurrence: true,
    minTier: 'weak', pulse: true, glow: 6, autoRotate: false, labels: true,
    search: '', timeIndex: -1, highlightOnly: false,
  }
  return renderer
}

test('edgesToDraw 在没有高亮时只返回 top-N 的 faint 边', () => {
  const edges = [
    edge('e1', 'a', 'b', 1),
    edge('e2', 'b', 'c', 9),
    edge('e3', 'c', 'd', 5),
  ]
  const out = T.edgesToDraw(edges, null, 2)
  assert.equal(out.length, 2)
  assert.ok(out.every(item => item.kind === 'faint'))
  // 按权重降序取前 2：e2(9)、e3(5)
  assert.deepEqual(out.map(item => item.edge.id).sort(), ['e2', 'e3'])
})

test('edgesToDraw 高亮节点时其相连边为 lit', () => {
  const edges = [
    edge('e1', 'a', 'b', 1),
    edge('e2', 'b', 'c', 9),
    edge('e3', 'c', 'd', 5),
    edge('e4', 'x', 'y', 8),
  ]
  const out = T.edgesToDraw(edges, new Set(['b']), 1)
  const lit = out.filter(item => item.kind === 'lit').map(item => item.edge.id).sort()
  const faint = out.filter(item => item.kind === 'faint').map(item => item.edge.id)
  assert.deepEqual(lit, ['e1', 'e2'])
  // faint 只有 1 条（top-1 且要与 lit 去重 → e4 权重 8 最高）
  assert.deepEqual(faint, ['e4'])
  // 无关边 e3 不出现
  assert.ok(!out.some(item => item.edge.id === 'e3'))
})

test('edgesToDraw 不会把 lit 边重复算成 faint', () => {
  const edges = [edge('e1', 'a', 'b', 10), edge('e2', 'a', 'c', 9)]
  const out = T.edgesToDraw(edges, new Set(['a']), 12)
  assert.equal(out.filter(item => item.kind === 'lit').length, 2)
  assert.equal(out.filter(item => item.kind === 'faint').length, 0)
})

test('pick 命中半径不再被 p.scale 放大（30px 外不选中）', () => {
  const renderer = makeRenderer()
  const node = { id: 'p1', type: 'person', tier: 'weak', r: 6, score: 50, x: 0.5, y: 0, z: 0, pos: [0.5, 0, 0] }
  renderer.nodes = [node]
  renderer.edges = []
  const p = renderer.project(node)
  assert.equal(renderer.pick(p.sx + 30, p.sy), null)
  const hit = renderer.pick(p.sx + 2, p.sy)
  assert.ok(hit && hit.node === node && hit.exact === true)
})

test('pick 无精确命中时退化到 28px 内最近节点', () => {
  const renderer = makeRenderer()
  const a = { id: 'p1', type: 'person', tier: 'weak', r: 2, score: 50, pos: [0.4, 0, 0], x: 0.4, y: 0, z: 0 }
  const b = { id: 'p2', type: 'person', tier: 'weak', r: 2, score: 50, pos: [0.6, 0, 0], x: 0.6, y: 0, z: 0 }
  renderer.nodes = [a, b]
  renderer.edges = []
  const pa = renderer.project(a)
  const pb = renderer.project(b)
  // 两点之间但都超出各自命中半径 → 退化选最近的 a
  const hit = renderer.pick(pa.sx + 12, pa.sy)
  assert.ok(hit && hit.node === a && hit.exact === false)
  // 距离超过 28px 就不兜底
  assert.equal(renderer.pick(pa.sx + 40, pa.sy), null)
})

test('self 不再在任何位置胜出', () => {
  const renderer = makeRenderer()
  const self = { id: 'self', type: 'self', tier: 'core', r: 13, score: 100, pos: [0, 0, 0], x: 0, y: 0, z: 0 }
  const other = { id: 'p1', type: 'person', tier: 'weak', r: 5, score: 60, pos: [0.3, 0, 0], x: 0.3, y: 0, z: 0 }
  renderer.nodes = [self, other]
  renderer.edges = []
  const pOther = renderer.project(other)
  const hit = renderer.pick(pOther.sx, pOther.sy)
  assert.ok(hit && hit.node === other)
})
