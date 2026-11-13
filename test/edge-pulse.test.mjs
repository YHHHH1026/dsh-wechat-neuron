// 渲染层与 Host 的强度公式必须一致；回放态只画当期有消息的边。
// 这是「图会不会骗人」的守门测试：两边漂移会让边和节点错位。
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './harness.mjs'
import { edgePulse as hostPulse, baselinePerBucket as hostBaseline } from '../lib/host/pulse.js'

const T = loadClient({ test: true }).__test

const nodes = { a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' } }
const edge = (id, weight, series, target = 'b') => ({ id, a: nodes.a, b: nodes[target], weight, series, type: 'chat' })

test('两边的 edgePulse 对同一组输入结果完全相同', () => {
  const cases = [
    [[4, 0, 9], [2, 3, 4], 0, 20, 100],
    [[4, 0, 9], [2, 3, 4], 1, 20, 100],
    [[4, 0, 9], [2, 3, 4], -1, 20, 100],
    [[4, 0, 9], [2, 3, 4], 7, 20, 100],
    [undefined, undefined, 0, 50, 100],
    [[], [], 0, 50, 100],
    [[0, 0], [1, 1], 0, 10, 10],
  ]
  for (const args of cases) {
    assert.equal(T.edgePulse(...args), hostPulse(...args), `输入 ${JSON.stringify(args)} 两边不一致`)
  }
})

test('两边的 baselinePerBucket 结果相同', () => {
  const cases = [[[[4, 0], [8, 0], [0, 6]], 2], [[], 3], [[[1, 1]], 0]]
  for (const args of cases) {
    assert.deepEqual(T.baselinePerBucket(...args), hostBaseline(...args))
  }
})

test('非回放态：行为与 v0.1 一致（高亮优先 + top12 极淡线）', () => {
  const edges = Array.from({ length: 20 }, (_, i) => edge(`e${i}`, 20 - i, [1]))
  const drawn = T.edgesToDraw(edges, null, 12)
  assert.equal(drawn.length, 12)
  assert.ok(drawn.every(item => item.kind === 'faint'))
  assert.equal(drawn[0].edge.id, 'e0', '按静态权重取前 12')
})

test('回放态：当期没有消息的边不画', () => {
  const edges = [
    edge('hot', 30, [5, 0]),
    edge('cold', 90, [0, 3]),
  ]
  const drawn = T.edgesToDraw(edges, null, 16, { index: 0, scale: [2, 2], maxWeight: 90 })
  assert.deepEqual(drawn.map(item => item.edge.id), ['hot'])
  assert.equal(drawn[0].kind, 'replay')
  assert.ok(drawn[0].pulse > 0)
})

test('回放态：按当期强度排序，而不是全生命周期总量', () => {
  const edges = [
    edge('oldGiant', 900, [1, 0]),
    edge('newLight', 30, [0, 9]),
  ]
  const drawn = T.edgesToDraw(edges, null, 16, { index: 1, scale: [2, 2], maxWeight: 900 })
  assert.deepEqual(drawn.map(item => item.edge.id), ['newLight'])
})

test('回放态：高亮的边即使在「当期无消息」时也画（用户正看着它）', () => {
  const edges = [edge('quiet', 10, [0, 0])]
  const drawn = T.edgesToDraw(edges, new Set(['a']), 16, { index: 1, scale: [1, 1], maxWeight: 10 })
  assert.deepEqual(drawn.map(item => item.kind), ['lit'])
})

test('回放态：topN 截断生效，不会把整屏铺满', () => {
  const edges = Array.from({ length: 40 }, (_, i) => edge(`e${i}`, 10 + i, [5]))
  const drawn = T.edgesToDraw(edges, null, 16, { index: 0, scale: [2], maxWeight: 50 })
  assert.equal(drawn.length, 16)
})
