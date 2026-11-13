// 回放速度三档：慢/正常/快。默认必须是「正常」，否则老用户会觉得序列变快了。
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './harness.mjs'

const T = loadClient({ test: true }).__test

test('三档速度：慢 700 / 正常 420 / 快 200', () => {
  assert.deepEqual(T.PLAYBACK_SPEEDS.map(item => item.ms), [700, 420, 200])
  assert.deepEqual(T.PLAYBACK_SPEEDS.map(item => item.id), ['slow', 'normal', 'fast'])
})

test('默认速度是正常档，且等于 v0.1 的老间隔 420ms', () => {
  assert.equal(T.PLAYBACK_DEFAULT, 'normal')
  const normal = T.PLAYBACK_SPEEDS.find(item => item.id === T.PLAYBACK_DEFAULT)
  assert.equal(normal.ms, 420)
})

test('speedMs 对未知档位退回默认，不返回 undefined', () => {
  assert.equal(T.speedMs('fast'), 200)
  assert.equal(T.speedMs('nope'), 420)
  assert.equal(T.speedMs(undefined), 420)
})
