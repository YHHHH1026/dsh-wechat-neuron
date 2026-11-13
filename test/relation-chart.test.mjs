// 抽屉里的「关系热度」曲线：纯数据函数必须先钉死，UI 只是它的投影。
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './harness.mjs'

const T = loadClient({ test: true }).__test

const relation = {
  series: [0, 3, 9, 0, 6],
  sentSeries: [0, 1, 4, 0, 2],
  recvSeries: [0, 2, 5, 0, 4],
  buckets: ['2026-W01', '2026-W02', '2026-W03', '2026-W04', '2026-W05'],
}

test('relationBars：每桶给出高度比例与收发拆分', () => {
  const bars = T.relationBars(relation)
  assert.equal(bars.length, 5)
  assert.equal(bars[2].value, 9)
  assert.equal(bars[2].ratio, 1)
  assert.ok(Math.abs(bars[1].ratio - 3 / 9) < 1e-9, '比例用浮点近似比较')
  assert.equal(bars[2].sent, 4)
  assert.equal(bars[2].recv, 5)
  assert.equal(bars[2].t, '2026-W03')
})

test('relationBars：空桶不产生 NaN（除零保护）', () => {
  const bars = T.relationBars({ series: [0, 0, 0], sentSeries: [0, 0, 0], recvSeries: [0, 0, 0], buckets: [] })
  assert.equal(bars.length, 3)
  assert.ok(bars.every(bar => bar.ratio === 0))
  assert.ok(bars.every(bar => Number.isFinite(bar.value)))
})

test('relationBars：脏数据不炸（缺序列/非数组/负数）', () => {
  assert.deepEqual(T.relationBars(null), [])
  assert.deepEqual(T.relationBars({ series: [] }), [])
  const bars = T.relationBars({ series: [-3, 2], sentSeries: [99], recvSeries: null, buckets: ['a'] })
  assert.equal(bars[0].value, 0, '负数按 0 处理')
  assert.equal(bars[1].sent, 0, '缺失序列按 0')
  assert.equal(bars[1].recv, 0)
  assert.equal(bars[0].t, 'a')
  assert.equal(bars[1].t, '', '桶标签不足时不臆造')
})

test('relationBars：sent+recv 不超过总量（脏数据兜底）', () => {
  const bars = T.relationBars({ series: [4], sentSeries: [9], recvSeries: [9], buckets: ['x'] })
  assert.equal(bars[0].sent + bars[0].recv, 4)
})

test('relationTrend：峰值、活跃桶数、最近活跃桶', () => {
  const trend = T.relationTrend(relation)
  assert.equal(trend.peakT, '2026-W03')
  assert.equal(trend.peakValue, 9)
  assert.equal(trend.activeBuckets, 3)
  assert.equal(trend.totalBuckets, 5)
  assert.equal(trend.lastActiveT, '2026-W05')
})

test('relationTrend：全空时给出安全默认值', () => {
  const trend = T.relationTrend({ series: [0, 0], buckets: ['a', 'b'] })
  assert.equal(trend.peakT, '')
  assert.equal(trend.peakValue, 0)
  assert.equal(trend.activeBuckets, 0)
  assert.equal(trend.lastActiveT, '')
})
