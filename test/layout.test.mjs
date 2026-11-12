import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './harness.mjs'

const { layoutGalaxyTargets, galaxyMath: M, GALAXY } = loadClient({ test: true }).__test

const mk = (id, type, score) => ({ id, type, score, tier: 'regular' })

function seeded(seed) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))

/** 节点到最近旋臂的角偏差（取 4 条臂的最小值）。 */
function armDeviation(node, target) {
  const [x, , z] = target
  const r = Math.hypot(x, z)
  if (r < GALAXY.R0) return 0
  const theta = Math.atan2(z, x)
  let best = Infinity
  for (let arm = 0; arm < 4; arm += 1) {
    best = Math.min(best, Math.abs(wrap(theta - M.armAngle(arm, r))))
  }
  return best
}

test('确定性：同输入两次布局完全一致', () => {
  const nodes = [mk('self', 'self', 100), mk('a', 'person', 90), mk('b', 'person', 10)]
  const one = layoutGalaxyTargets(nodes, seeded(7))
  const two = layoutGalaxyTargets(nodes, seeded(7))
  for (const [id, value] of one) assert.deepEqual(two.get(id), value)
})

test('self 在原点，person 半径随分数单调（分高者更靠近核心）', () => {
  const targets = layoutGalaxyTargets([
    mk('self', 'self', 100), mk('hi', 'person', 95), mk('mid', 'person', 50), mk('lo', 'person', 5),
  ], seeded(1))
  assert.deepEqual(targets.get('self'), [0, 0, 0])
  const radius = (id) => { const [x, , z] = targets.get(id); return Math.hypot(x, z) }
  assert.ok(radius('hi') < radius('mid'), `${radius('hi')} < ${radius('mid')}`)
  assert.ok(radius('mid') < radius('lo'), `${radius('mid')} < ${radius('lo')}`)
})

test('半径与 galaxyMath.nodePolarRadius 一致（世界单位，不是屏幕像素）', () => {
  const targets = layoutGalaxyTargets([mk('a', 'person', 30)], seeded(3))
  const [x, , z] = targets.get('a')
  // 低分节点会乘一个 0.75–1.25 的抖动，所以只检查量级
  const base = M.nodePolarRadius(30)
  assert.ok(Math.abs(Math.hypot(x, z) - base) <= base * 0.26, `r=${Math.hypot(x, z)} base=${base}`)
  assert.ok(Math.hypot(x, z) < 1.3)
})

test('脏分数不会产生 NaN', () => {
  const targets = layoutGalaxyTargets([
    mk('n1', 'person', null), mk('n2', 'person', 'abc'), mk('n3', 'person', undefined),
    mk('t1', 'topic', null), mk('g1', 'group', NaN),
  ], seeded(9))
  for (const [id, value] of targets) {
    for (const component of value) assert.ok(Number.isFinite(component), `${id} -> ${value}`)
  }
})

test('S60 分流：高分节点贴臂，低分节点铺进弥散盘', () => {
  const nodes = Array.from({ length: 20 }, (_, i) => mk(`p${i}`, 'person', i + 1))
  const targets = layoutGalaxyTargets(nodes, seeded(11))
  const scores = nodes.map(n => n.score).sort((a, b) => a - b)
  const s60 = scores[Math.floor(scores.length * 0.6)]

  let highSum = 0
  let highCount = 0
  let lowSum = 0
  let lowCount = 0
  const lowSectors = new Set()
  for (const node of nodes) {
    const dev = armDeviation(node, targets.get(node.id))
    if (node.score >= s60) {
      highSum += dev
      highCount += 1
    } else {
      lowSum += dev
      lowCount += 1
      const [x, , z] = targets.get(node.id)
      lowSectors.add(Math.floor(((Math.atan2(z, x) + Math.PI) / (2 * Math.PI)) * 6) % 6)
    }
  }
  // 高分节点（约前 40%）构成结构骨架：偏差必须远小于臂间距（π/2）；
  // 防重叠的 spread 被约束在 ±0.125 rad 内，故平均偏差应在 0.1 以下。
  assert.ok(highSum / highCount < 0.12, `highMean=${highSum / highCount}`)
  // 低分节点均匀铺开：平均偏差显著大于骨干，且覆盖至少 4 个扇区
  assert.ok(lowSum / lowCount > 2 * (highSum / highCount), `lowMean=${lowSum / lowCount}`)
  assert.ok(lowSectors.size >= 4, `sectors=${[...lowSectors]}`)
})

test('group 略微抬离盘面，topic 沉在盘下并落在盘缘', () => {
  const targets = layoutGalaxyTargets([
    mk('p', 'person', 80), mk('g', 'group', 80), mk('t', 'topic', 50),
  ], seeded(5))
  const [, gy] = targets.get('g')
  const [, py] = targets.get('p')
  assert.ok(gy > py, `group y=${gy} > person y=${py}`)
  const [tx, , tz] = targets.get('t')
  assert.equal(targets.get('t')[1], -0.04)
  const tr = Math.hypot(tx, tz)
  assert.ok(tr >= 0.8 && tr <= 1.25, `topic r=${tr}`)
})
