// v0.2 关系演化的纯函数层：时间桶键、逐桶序列、强度归一。
// 这些函数决定「回放时这条关系该有多亮」，错了整张图会骗人，所以先钉死。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DAY, RECENT_WINDOW_DAYS, weekKey, monthKey, bucketKeyOf,
  seriesForBucket, edgePulse, baselinePerBucket,
} from '../lib/host/pulse.js'

const NOW = 1785000000 // 固定时间，避免测试随真实时钟漂移

test('400 天以内的点用周桶，更早用月桶', () => {
  const recent = NOW - 10 * DAY
  const old = NOW - 500 * DAY
  assert.match(bucketKeyOf(recent, NOW), /^\d{4}-W\d{2}$/)
  assert.match(bucketKeyOf(old, NOW), /^\d{4}-M\d{2}$/)
  assert.equal(RECENT_WINDOW_DAYS, 400)
})

test('周桶按 ISO 周编号，跨年边界不能串年', () => {
  // 2021-01-01 是周五，ISO 上属于 2020 年第 53 周
  const friday = Date.UTC(2021, 0, 1) / 1000
  assert.equal(weekKey(friday), '2020-W53')
  // 2021-01-04 是周一，属于 2021 年第 1 周
  const monday = Date.UTC(2021, 0, 4) / 1000
  assert.equal(weekKey(monday), '2021-W01')
})

test('月桶补齐两位，字符串序与时间序一致', () => {
  assert.equal(monthKey(Date.UTC(2025, 0, 15) / 1000).endsWith('-M01'), true)
  assert.ok(monthKey(Date.UTC(2025, 0, 15) / 1000) < monthKey(Date.UTC(2025, 10, 15) / 1000))
})

test('序列长度与时间轴一致；时间轴为空时返回空数组', () => {
  assert.deepEqual(seriesForBucket([{ time: NOW }], [], NOW), [])
  const timeline = [{ t: '2026-W01' }, { t: '2026-W02' }]
  const series = seriesForBucket([{ time: NOW }], timeline, NOW)
  assert.equal(series.length, 2)
})

test('同桶消息累加，桶外消息不丢也不串位', () => {
  const day = Date.UTC(2026, 4, 4) / 1000 // 周一
  const now = day + 10 * DAY
  const k1 = bucketKeyOf(day, now)
  const k2 = bucketKeyOf(day + 7 * DAY, now)
  const timeline = [{ t: k1 }, { t: k2 }]
  const series = seriesForBucket([
    { time: day }, { time: day + 3600 }, { time: day + 7 * DAY }, { time: 0 },
  ], timeline, now)
  assert.deepEqual(series, [2, 1])
})

test('时间轴用字符串数组或对象数组都能吃', () => {
  const day = Date.UTC(2026, 4, 4) / 1000
  const now = day + 10 * DAY
  const key = bucketKeyOf(day, now)
  assert.deepEqual(seriesForBucket([{ time: day }], [key], now), [1])
  assert.deepEqual(seriesForBucket([{ time: day }], [{ t: key }], now), [1])
})

test('当期没有消息的关系强度为 0（回放时应当断掉）', () => {
  assert.equal(edgePulse([0, 0], [4, 4], 1, 20, 100), 0)
})

test('强度落在 0..1，且达到基线就明显亮起', () => {
  const baseline = [4, 4]
  const weak = edgePulse([1, 1], baseline, 0, 20, 100)
  const solid = edgePulse([4, 4], baseline, 0, 20, 100)
  const hot = edgePulse([40, 4], baseline, 0, 20, 100)
  for (const value of [weak, solid, hot]) assert.ok(value >= 0 && value <= 1)
  assert.ok(solid > weak, '刚好达基线要比不足基线亮')
  assert.ok(hot > solid, '远超基线要更亮')
  assert.ok(hot > 0.99, '远超基线要接近满格')
})

test('没有逐桶序列时退回全生命周期总量（老图/兼容路径）', () => {
  assert.equal(edgePulse(undefined, undefined, 0, 50, 100), 0.5)
  assert.equal(edgePulse([], [], 5, 50, 100), 0.5, '越界下标也走回退')
  assert.equal(edgePulse([1, 1], [1, 1], -1, 50, 100), 0.5, '回到「全部时间」时走回退')
  // 回退路径遇到 0 总量不能返回 NaN/Infinity
  assert.ok(Math.abs(edgePulse([1], [1], 0, 0, 0) - (1 - Math.exp(-1))) < 1e-12, '单条消息对基线 1 → 1-e^-1')
})

test('基线按桶求均值，只统计有消息的关系', () => {
  const baseline = baselinePerBucket([[4, 0], [8, 0], [0, 6]], 2)
  assert.equal(baseline[0], 6, '第 0 桶只有两条有消息的关系参与均值')
  assert.equal(baseline[1], 6)
  assert.deepEqual(baselinePerBucket([], 3), [0, 0, 0])
  assert.deepEqual(baselinePerBucket([[1, 1]], 0), [])
})

test('空关系不把基线拉到 0（否则一切都会显得「过亮」）', () => {
  const baseline = baselinePerBucket([[2, 0], [0, 0], [0, 0]], 1)
  assert.equal(baseline[0], 2)
})
