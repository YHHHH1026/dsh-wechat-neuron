// 抽屉里的「关系热度」数据来自 nodeDetail；没有 chat 边时必须明确为 null。
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildGraph, nodeDetail } from '../lib/host/model.js'

const NOW = Math.floor(Date.UTC(2026, 4, 20) / 1000)
const DAY = 86400

function message(talker, sender, time, text = '你好') {
  return { id: `m${talker}${time}`, account: 'a', talker, sender, time, kind: 'text', type: 1, text }
}

const input = {
  contacts: [{ username: 'wxid_chen', remark: '陈墨' }],
  sessions: [],
  messages: [
    message('wxid_chen', '__self__', NOW - 30 * DAY),
    message('wxid_chen', 'wxid_chen', NOW - 30 * DAY + 60),
    message('wxid_chen', '__self__', NOW - 2 * DAY),
    message('band@chatroom', 'wxid_chen', NOW - 2 * DAY),
  ],
  options: { now: NOW, source: 'test', account: 'test' },
}
const graph = buildGraph(input)
const chenId = graph.nodes.find(node => node.type === 'person' && node.username === 'wxid_chen').id
const groupId = graph.nodes.find(node => node.type === 'group').id

test('person 节点的 detail 带 relation（含三条序列与桶标签）', () => {
  const detail = nodeDetail(graph, chenId, input.messages)
  assert.ok(detail.relation !== null)
  assert.equal(detail.relation.series.length, graph.timeline.length)
  assert.equal(detail.relation.sentSeries.length, graph.timeline.length)
  assert.equal(detail.relation.recvSeries.length, graph.timeline.length)
  assert.deepEqual(detail.relation.buckets, graph.timeline.map(bucket => bucket.t))
})

test('relation 的合计与边 weight 一致', () => {
  const detail = nodeDetail(graph, chenId, input.messages)
  const sum = detail.relation.series.reduce((a, b) => a + b, 0)
  const edge = graph.edges.find(item => item.type === 'chat' && item.target === chenId)
  assert.equal(sum, edge.weight)
})

test('group 节点也有 relation', () => {
  const detail = nodeDetail(graph, groupId, input.messages)
  assert.ok(detail.relation !== null)
})

test('没有 chat 边的节点 relation 为 null（话题节点）', () => {
  const topic = graph.nodes.find(node => node.type === 'topic')
  if (topic === undefined) return
  const detail = nodeDetail(graph, topic.id, input.messages)
  assert.equal(detail.relation, null)
})

test('未知节点返回 null，不抛异常', () => {
  assert.equal(nodeDetail(graph, 'nope', input.messages), null)
})
