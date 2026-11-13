// Host 侧：每条 chat 边都要带逐桶关系序列，非 chat 边不付这个体积。
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildGraph } from '../lib/host/model.js'

const NOW = Math.floor(Date.UTC(2026, 4, 20) / 1000)
const DAY = 86400

function message({ talker, sender, time, kind = 'text', text = '你好' }) {
  return { id: `m_${talker}_${time}_${Math.random().toString(36).slice(2, 7)}`, account: 'a', talker, sender, time, kind, type: 1, text }
}

function sampleInput() {
  const messages = []
  // 陈墨：稳定高频，跨 6 周
  for (let week = 0; week < 6; week += 1) {
    for (let i = 0; i < 5; i += 1) {
      messages.push(message({ talker: 'wxid_chen', sender: i % 2 === 0 ? '__self__' : 'wxid_chen', time: NOW - (20 - week * 3) * DAY + i * 60 }))
    }
  }
  // 林秋白：只在最近两周出现（回放时应当「后出现」）
  for (let i = 0; i < 4; i += 1) {
    messages.push(message({ talker: 'wxid_lin', sender: '__self__', time: NOW - (4 + i) * DAY }))
  }
  // 一个群
  messages.push(message({ talker: 'band@chatroom', sender: 'wxid_chen', time: NOW - 2 * DAY }))
  messages.push(message({ talker: 'band@chatroom', sender: '__self__', time: NOW - 2 * DAY + 60 }))
  return {
    contacts: [
      { username: 'wxid_chen', remark: '陈墨' },
      { username: 'wxid_lin', remark: '林秋白' },
    ],
    sessions: [],
    messages,
    options: { now: NOW, source: 'test', account: 'test' },
  }
}

const graph = buildGraph(sampleInput())

test('每条 chat 边都带 series，长度等于时间轴桶数', () => {
  const chat = graph.edges.filter(edge => edge.type === 'chat')
  assert.ok(chat.length >= 2, `至少要两个 chat 边，实际 ${chat.length}`)
  for (const edge of chat) {
    assert.ok(Array.isArray(edge.series), `${edge.id} 缺 series`)
    assert.equal(edge.series.length, graph.timeline.length)
  }
})

test('我发 + 对方发 = 当期总量（逐桶守恒）', () => {
  for (const edge of graph.edges.filter(item => item.type === 'chat')) {
    for (let index = 0; index < edge.series.length; index += 1) {
      assert.equal(edge.sentSeries[index] + edge.recvSeries[index], edge.series[index],
        `${edge.id} 第 ${index} 桶不守恒`)
    }
  }
})

test('序列总量等于该关系的真实消息数', () => {
  const chen = graph.edges.find(edge => edge.type === 'chat' && edge.weight === 30)
  assert.ok(chen !== undefined, '陈墨应有 30 条消息的边')
  const sum = chen.series.reduce((a, b) => a + b, 0)
  assert.equal(sum, chen.weight)
})

test('只在最近出现的联系人，早期桶全为 0', () => {
  const lin = graph.edges.find(edge => edge.type === 'chat' && edge.weight === 4)
  assert.ok(lin !== undefined)
  assert.ok(lin.series[0] === 0, '林秋白第一个桶不该有消息')
  assert.ok(lin.series.reduce((a, b) => a + b, 0) === 4)
})

test('非 chat 边不带序列（不付多余体积）', () => {
  for (const edge of graph.edges) {
    if (edge.type === 'chat') continue
    assert.equal(edge.series, undefined, `${edge.id} 是 ${edge.type}，不该有 series`)
  }
})

test('群边同样有序列', () => {
  const group = graph.edges.find(edge => edge.type === 'chat' && edge.target.startsWith('g_'))
  assert.ok(group !== undefined, '应有到群的 chat 边')
  assert.equal(group.series.reduce((a, b) => a + b, 0), group.weight)
})
