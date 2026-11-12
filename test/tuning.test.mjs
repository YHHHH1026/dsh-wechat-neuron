/**
 * 「星系调校」控制区的契约测试：
 * 旋钮表是唯一真源 —— 面板、随机、复位、存默认都从它派生。
 * 这里守住三件事：数量与范围合法、随机结果永远落在滑轨内、脏存储不会让面板崩。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './harness.mjs'

const {
  TUNING, RANDOM_RANGES, GALAXY, GALAXY_DEFAULTS, VIEW_DEFAULTS,
  tuningDefaults, tuningRandom, formatKnob, applyStarPalette,
  readSavedTuning, writeSavedTuning, TUNING_STORAGE_KEY, PALETTE_IDS, STAR_PALETTES,
} = loadClient({ test: true }).__test

function seeded(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

test('旋钮不少于 7 个，且覆盖盘面与相机两层', () => {
  assert.ok(TUNING.length >= 7, `只有 ${TUNING.length} 个旋钮`)
  const disk = TUNING.filter(knob => knob.scope === 'disk')
  const view = TUNING.filter(knob => knob.scope === 'view')
  assert.ok(disk.length >= 5, '盘面旋钮不足')
  assert.ok(view.length >= 4, '相机/节点旋钮不足')
  for (const knob of TUNING) {
    assert.ok(knob.min < knob.max, `${knob.key} 区间非法`)
    assert.ok(knob.step > 0 && knob.step <= knob.max - knob.min, `${knob.key} 步长非法`)
    assert.ok(typeof knob.label === 'string' && knob.label.length > 0)
  }
  assert.equal(new Set(TUNING.map(knob => knob.key)).size, TUNING.length, '旋钮 key 重复')
})

test('出厂值全部落在滑轨内，且 disk/view 都能取到', () => {
  const defaults = tuningDefaults()
  for (const knob of TUNING) {
    const value = defaults[knob.key]
    assert.ok(Number.isFinite(value), `${knob.key} 出厂值缺失`)
    assert.ok(value >= knob.min && value <= knob.max, `${knob.key}=${value} 越界`)
    const source = knob.scope === 'disk' ? GALAXY_DEFAULTS : VIEW_DEFAULTS
    assert.equal(value, source[knob.key])
  }
  assert.equal(defaults.PALETTE, GALAXY_DEFAULTS.PALETTE)
})

test('随机结果永远落在滑轨内且对齐步长（拖回去不会跳值）', () => {
  for (let round = 0; round < 40; round += 1) {
    const random = tuningRandom(seeded(round + 1))
    for (const knob of TUNING) {
      const value = random[knob.key]
      assert.ok(value >= knob.min && value <= knob.max, `${knob.key}=${value} 越界`)
      const steps = (value - knob.min) / knob.step
      assert.ok(Math.abs(steps - Math.round(steps)) < 1e-6, `${knob.key}=${value} 未对齐步长`)
      const [lo, hi] = RANDOM_RANGES[knob.key]
      assert.ok(value >= lo - knob.step && value <= hi + knob.step, `${knob.key} 超出安全带`)
    }
    assert.ok(PALETTE_IDS.includes(random.PALETTE))
  }
})

test('随机不会跑出「读得出螺旋」的安全带：缠绕角与臂宽', () => {
  const [pitchLo, pitchHi] = RANDOM_RANGES.PITCH_DEG
  const [sigmaLo, sigmaHi] = RANDOM_RANGES.ARM_SIGMA
  assert.ok(pitchLo >= 10 && pitchHi <= 26, '缠绕角安全带过宽，会随机出毛球')
  assert.ok(sigmaHi <= 0.18, '臂宽上限过大，四条臂会糊在一起')
  assert.ok(sigmaLo >= 0.05)
  // 圈数 = ln(R/R0)/tan(pitch)：安全带两端都必须是「看得出臂」的圈数
  const turns = (deg) => Math.log(GALAXY.DISK_R / GALAXY.R0) / Math.tan((deg * Math.PI) / 180) / (Math.PI * 2)
  assert.ok(turns(pitchHi) > 0.7, '最舒展时不足 0.7 圈')
  assert.ok(turns(pitchLo) < 2.6, '最卷时超过 2.6 圈')
})

test('色族切换真的改星点颜色，非法 id 退回 deep', () => {
  const before = GALAXY.PALETTE
  try {
    for (const id of PALETTE_IDS) {
      const palette = applyStarPalette(id)
      assert.equal(GALAXY.PALETTE, id)
      assert.equal(palette, STAR_PALETTES[id])
      assert.equal(palette.blue.length, 3)
      assert.equal(palette.core.length, 3)
    }
    applyStarPalette('not-a-palette')
    assert.equal(GALAXY.PALETTE, 'deep')
  } finally {
    applyStarPalette(before)
  }
})

test('数值格式化：百分比 / 千 / 角度 / 小数位', () => {
  const byKey = Object.fromEntries(TUNING.map(knob => [knob.key, knob]))
  assert.equal(formatKnob(byKey.ARM_PURITY, 0.88), '88%')
  assert.equal(formatKnob(byKey.STARS, 26000), '26k')
  assert.equal(formatKnob(byKey.STARS, 26500), '26.5k')
  assert.equal(formatKnob(byKey.PITCH_DEG, 16), '16.0°')
  assert.equal(formatKnob(byKey.PITCH_DEG, 16.5), '16.5°')
  assert.equal(formatKnob(byKey.tiltDeg, 41), '41°')
  assert.equal(formatKnob(byKey.ARM_SIGMA, 0.115), '0.115')
  assert.equal(formatKnob(byKey.zoom, 1.3), '1.30×')
})

test('本机存储：往返一致、脏数据退回 null、越界值被夹回', () => {
  const store = new Map()
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  }
  try {
    assert.equal(readSavedTuning(), null)
    const value = tuningRandom(seeded(99))
    assert.equal(writeSavedTuning(value), true)
    assert.deepEqual(readSavedTuning(), value)

    store.set(TUNING_STORAGE_KEY, '{ not json')
    assert.equal(readSavedTuning(), null, '坏 JSON 必须退回 null')
    store.set(TUNING_STORAGE_KEY, 'null')
    assert.equal(readSavedTuning(), null)

    store.set(TUNING_STORAGE_KEY, JSON.stringify({ PITCH_DEG: 999, ARM_SIGMA: -5, PALETTE: 'nope', STARS: 'abc' }))
    const repaired = readSavedTuning()
    const byKey = Object.fromEntries(TUNING.map(knob => [knob.key, knob]))
    assert.equal(repaired.PITCH_DEG, byKey.PITCH_DEG.max)
    assert.equal(repaired.ARM_SIGMA, byKey.ARM_SIGMA.min)
    assert.equal(repaired.STARS, GALAXY_DEFAULTS.STARS)
    assert.equal(repaired.PALETTE, GALAXY_DEFAULTS.PALETTE)
  } finally {
    delete globalThis.localStorage
  }
})

test('存储不可用时不抛异常（隐私模式 / 禁用 localStorage）', () => {
  globalThis.localStorage = {
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('denied') },
  }
  try {
    assert.equal(readSavedTuning(), null)
    assert.equal(writeSavedTuning(tuningDefaults()), false)
  } finally {
    delete globalThis.localStorage
  }
})