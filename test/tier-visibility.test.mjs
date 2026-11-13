// 重要度分层必须逐档独立勾选；悬停节点必须无条件显示标签。
// 这两条都是用户实测报上来的 BUG，先写断言再改实现。
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './harness.mjs'

const client = loadClient({ test: true })
const T = client.__test

const rendererWith = (view) => {
  const renderer = Object.create(T.NeuronRenderer.prototype)
  renderer.view = view
  return renderer
}

test('默认可见档位是 core/friend/regular/weak，silent 不在内', () => {
  assert.deepEqual(T.TIER_VISIBLE_DEFAULT, ['core', 'friend', 'regular', 'weak'])
})

test('取消一档只影响该档，其余档位原样保留', () => {
  const next = T.toggleTier(['core', 'friend', 'regular', 'weak'], 'friend')
  assert.deepEqual(next, ['core', 'regular', 'weak'])
})

test('重新勾上被取消的档位能加回来（旧实现这里勾不动）', () => {
  const off = T.toggleTier(['core', 'friend', 'regular', 'weak'], 'core')
  assert.ok(!off.includes('core'))
  const back = T.toggleTier(off, 'core')
  assert.ok(back.includes('core'))
  // 加回来以后仍然保持 core→friend→regular→weak→silent 的顺序
  assert.deepEqual(back, ['core', 'friend', 'regular', 'weak'])
})

test('取消第一行不得连带清掉第二行（用户报的核心 BUG）', () => {
  const start = ['core', 'friend', 'regular', 'weak']
  const afterFirst = T.toggleTier(start, 'core')
  assert.ok(afterFirst.includes('friend'), '取消 core 后 friend 必须还在')
  assert.ok(afterFirst.includes('regular'))
  assert.ok(afterFirst.includes('weak'))
})

test('可以只留一档，也可以一档都不留', () => {
  assert.deepEqual(T.toggleTier(['core', 'friend', 'regular', 'weak'], 'friend') .includes('friend'), false)
  let list = ['core']
  list = T.toggleTier(list, 'core')
  assert.deepEqual(list, [])
})

test('非法档位 id 不改变集合（防脏数据）', () => {
  assert.deepEqual(T.toggleTier(['core', 'weak'], 'nope'), ['core', 'weak'])
  // 集合缺失（老配置 / 脏数据）时从出厂集合起算，再应用这次切换
  assert.deepEqual(T.toggleTier(undefined, 'friend'), ['core', 'regular', 'weak'])
  assert.deepEqual(T.toggleTier(null, 'silent'), ['core', 'friend', 'regular', 'weak', 'silent'])
})

test('visible() 按逐档集合判断，不再用阈值推导', () => {
  const renderer = rendererWith({ tierVisible: ['core', 'friend'], showTopics: true, showGroups: true })
  assert.equal(renderer.visible({ type: 'person', tier: 'core' }), true)
  assert.equal(renderer.visible({ type: 'person', tier: 'friend' }), true)
  assert.equal(renderer.visible({ type: 'person', tier: 'regular' }), false)
  // 自己永远可见，不受分层影响
  assert.equal(renderer.visible({ type: 'self', tier: 'silent' }), true)
})

test('老配置只有 minTier 时仍兼容成档位集合', () => {
  const renderer = rendererWith({ minTier: 'weak', showTopics: true, showGroups: true })
  assert.deepEqual(renderer.tierVisible(), ['core', 'friend', 'regular', 'weak'])
  const strict = rendererWith({ minTier: 'friend', showTopics: true, showGroups: true })
  assert.deepEqual(strict.tierVisible(), ['core', 'friend'])
})

test('悬停节点即使被 dim 也必须显示标签', () => {
  // forced=true（悬停）：alpha 已被压到 0.3 以下、rank 也很差，仍然要显示
  assert.equal(T.labelShouldShow(true, 0.05, 0.99, 1.4, 0.34), true)
})

test('非 forced 节点仍受密度、亮度、半径三重约束', () => {
  assert.equal(T.labelShouldShow(false, 0.9, 0.1, 6, 0.34), true)
  assert.equal(T.labelShouldShow(false, 0.1, 0.1, 6, 0.34), false, '太暗不画')
  assert.equal(T.labelShouldShow(false, 0.9, 0.9, 6, 0.34), false, '分位不够不画')
  assert.equal(T.labelShouldShow(false, 0.9, 0.1, 1.4, 0.34), false, '半径太小不画')
  assert.equal(T.labelShouldShow(false, 0.9, 0.1, 6, 0), false, '密度为 0 只留 forced')
})
