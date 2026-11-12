# 星系图单布局重做 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `client.js` 的 6 种布局砍成一个「像真星系」的星系视图：正交相机 + 2 万星点密度盘面 + 节点嵌进盘面结构，边默认隐藏、悬停浮现。

**Architecture:** 盘面是一次性离屏预渲染的位图（密度场而非描线），每帧只做一次仿射 `drawImage`；节点用预渲染 sprite 加性混合绘制，层次由显式深度调制提供；相机的 `scale` 与深度无关，屏幕坐标严格正交。

**Tech Stack:** 纯浏览器 Canvas 2D（无 WebGL、无第三方依赖）+ Node 24 `node:test` 做纯函数级回归。

**Spec:** `docs/superpowers/specs/2026-11-12-galaxy-single-layout-design.md`（执行者必须同时读，本计划只写「怎么做」，不做原理论证）

## Global Constraints

- 运行时**零第三方依赖**：不新增 `dependencies`，不引入 WebGL、不引入任何 polyfill。
- `client.js` 是单文件，运行时**不支持相对 `require`**（同目录模块不存在）；所有新增代码必须内联在 `client.js` 内。
- 画布**恒为深空**（已与用户裁决）：浅色主题只改面板/标签/边框，不做事画布反极性。
- 不改 Host 数据契约（`Graph`/`node`/`edge` 字段一个都不动），不改 `index.js`。
- `node --check client.js` 必须始终通过；测试只用 `node:test` + `node:assert/strict`。
- 测试不随包发布：`package.json` 的 `files` 白名单**不得**加入 `test/`。
- 唯一验收标准：缩略图尺寸下一眼认出是螺旋星系。

## Review Focus

这些是本计划的任务测试不一定覆盖、但最可能被真实数据打中的地方，按可能性排序；每行都已在某任务里指定了钉住它的测试。

1. **单节点/空图的图**（刚装好、只导入一个好友）：`computeFit` 的分位数采样在 `length===1` 与 `length===0` 时不能给出 `fit=1`，否则整张星系只有 ~25px（Task 3 测试）。
2. **全部 `score` 相同的数据**（demo 数据集常见）：第 60 分位分流会退化成「一半贴臂一半弥散」或者全贴臂，若切分实现用 `>=` 与排序不稳定会每次刷新都换一批人（Task 4 测试）。
3. **节点数远超 2093 的图**（>8000 好友）：`pick()` 的线性扫描与 `project()` 每帧调用仍是 O(n)，但 `zMin/zMax` 遍历必须只做一次而不是在节点循环里做两次（Task 6 的深度调制函数签名是纯的，Task 7 的 pick 退化路径也是线性一次）。
4. **`score` 为 `null`/字符串**的脏数据：`Math.pow(1 - score/100, 1.35)` 得到 `NaN` 会让节点目标位置变成 `NaN`、整张图消失（Task 2/4 的 `Number(node.score) || 0` 归一化 + 测试）。
5. **盘面位图尚未生成时**（首帧 / `requestIdleCallback` 未触发）：不能白屏，也不能画一颗居中的点（Task 6 的占位路径 + Task 5 的 `null` 返回值测试）。

---

### Task 1: 测试骨架与可测缝

**Files:**
- Create: `test/harness.mjs`
- Create: `test/seam.test.mjs`
- Delete: `test/_probe.test.mjs`
- Modify: `client.js:1985`（`return {` → 先构造 `exported`，末尾条件挂 `__test`）
- Modify: `package.json`（新增 `scripts.test`）

**Interfaces:**
- Consumes: 无。
- Produces: `test/harness.mjs` 导出 `loadClient({ test = true } = {}) -> module`；`client.js` 在 `globalThis.__WNEUR_TEST__ === true` 时于返回值上挂 `__test` 对象（后续每个任务往里加自己的导出）。

- [ ] **Step 1: 写失败测试 `test/seam.test.mjs`**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './harness.mjs'

test('生产模式只导出 inject 与 apply', () => {
  const m = loadClient({ test: false })
  assert.deepEqual(Object.keys(m).sort(), ['apply', 'inject'])
})

test('测试模式暴露 __test 缝', () => {
  const m = loadClient({ test: true })
  assert.equal(typeof m.__test, 'object')
  assert.equal(typeof m.__test.NeuronRenderer, 'function')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/seam.test.mjs`
Expected: FAIL —— `Cannot find module './harness.mjs'`

- [ ] **Step 3: 创建 `test/harness.mjs`**

必须用 Windows 形式路径（`E:/...`）；MSYS 的 `/e/...` 在 node 里会被解析成 `E:\e\...` 而 ENOENT。

```js
import { readFileSync } from 'node:fs'

const SRC_PATH = 'E:/AI/Workspace/wechat-neuron/client.js'

/** 在 Node 里加载 client.js：stub 掉 window/React，只取 factory 的返回值。 */
export function loadClient({ test = false } = {}) {
  const previous = globalThis.__WNEUR_TEST__
  if (test) globalThis.__WNEUR_TEST__ = true
  else delete globalThis.__WNEUR_TEST__
  try {
    const source = readFileSync(SRC_PATH, 'utf8')
    let module = null
    const fakeReact = new Proxy(function noop() {}, {
      get: (target, key) => (key === 'createElement' ? () => null : () => () => null),
      apply: () => null,
    })
    const stubRequire = (id) => (id === 'react'
      ? fakeReact
      : new Proxy({}, { get: () => () => null }))
    const stubWindow = {
      __ModuleLoader__: { load: (config) => { module = config.factory(stubRequire) } },
    }
    // eslint-disable-next-line no-new-func
    new Function('window', source)(stubWindow)
    return module
  } finally {
    if (previous === undefined) delete globalThis.__WNEUR_TEST__
    else globalThis.__WNEUR_TEST__ = previous
  }
}
```

- [ ] **Step 4: 在 `client.js:1985` 加缝**

`return { inject: ['slots'], apply(ctx) { … } }` 改为先建对象再返回：

```js
    const exported = {
      inject: ['slots'],
      apply(ctx) {
        /* 原内容一字不动 */
      },
    }

    if (globalThis.__WNEUR_TEST__ === true) {
      exported.__test = { NeuronRenderer }
    }

    return exported
```

- [ ] **Step 5: 加 test script 并跑通**

`package.json` 增加 `"scripts": { "test": "node --test test/*.test.mjs" }`（不要动 `files` 白名单）。

Run: `node --test test/*.test.mjs`
Expected: PASS 2 tests。删掉 `test/_probe.test.mjs`。

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers test client.js package.json
git commit -m "test: 建立 node:test 骨架与 client.js 可测缝; docs: 星系单布局设计与实施计划"
```

---

### Task 2: 星系几何纯函数

**Files:**
- Modify: `client.js`（在 `const FOV` 原位置附近新增 `GALAXY` 常量块与 `galaxyMath` 函数块）
- Create: `test/galaxy-geometry.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `exported.__test`。
- Produces（全部挂在 `__test.galaxyMath` 与 `__test.GALAXY`）：
  - `GALAXY = { R: 1.15, DISK_R: 1.25, R0: 0.12, TAN_I: Math.tan(13*Math.PI/180), H: 0.28, BULGE_FRACTION: 0.15, BULGE_H: 0.10, BULGE_TRUNC: 0.25, ARM_STARTS: [0, Math.PI/2, Math.PI, 3*Math.PI/2], ARM_WEIGHT: [1, 0.45, 1, 0.45], STARS: 20000, DISK_BITMAP: 3072 }`
  - `hash01(id: string) -> number`（FNV-1a，返回 `[0,1)`，确定性）
  - `gauss(rng: () => number, sigma: number) -> number`（Box-Muller 单值）
  - `armAngle(armIndex: number, r: number) -> number` = `ARM_STARTS[i] + Math.log(r / R0) / TAN_I`
  - `armSigma(r: number) -> number` = `clamp(0.11 / r, 0.06, 0.55)`
  - `diskRadius(rng) -> number` = `-H * Math.log(rng() * rng())`
  - `bulgeRadius(rng) -> number` = `Math.min(BULGE_TRUNC, -BULGE_H * Math.log(rng() * rng()))`
  - `starBrightness(u: number) -> number` = `0.08 + 0.92 * u ** 4`
  - `nodePolarRadius(score: unknown) -> number` = `0.10 + Math.pow(1 - safeScore(score) / 100, 1.35) * 0.92`
  - `safeScore(value: unknown) -> number` = `Math.max(0, Math.min(100, Number(value) || 0))`

- [ ] **Step 1: 写失败测试 `test/galaxy-geometry.test.mjs`**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './harness.mjs'

const { galaxyMath: M, GALAXY } = loadClient().__test

test('armAngle 起点正确且随半径单调递增', () => {
  assert.ok(Math.abs(M.armAngle(0, GALAXY.R0) - 0) < 1e-12)
  assert.ok(Math.abs(M.armAngle(1, GALAXY.R0) - Math.PI / 2) < 1e-12)
  assert.ok(M.armAngle(2, 1.0) > M.armAngle(2, 0.5))
})

test('armSigma 在 r>=0.2 时弧宽恒定 0.11', () => {
  for (const r of [0.30, 0.60, 1.00, 1.15]) assert.ok(Math.abs(M.armSigma(r) - 0.11) < 1e-12)
  assert.equal(M.armSigma(0.12), 0.55) // 下限 0.55 才是 r=0.12 的实际取值
})

test('diskRadius 的均值等于 2h（Gamma(2,h) 反演）', () => {
  let seed = 42
  const rng = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }
  let sum = 0
  const n = 200000
  for (let i = 0; i < n; i += 1) sum += M.diskRadius(rng)
  assert.ok(Math.abs(sum / n - 2 * GALAXY.H) < 0.01, `mean=${sum / n}`)
})

test('starBrightness 幂律：暗星占绝大多数、亮星约 1%', () => {
  let bright = 0
  for (let i = 0; i < 10000; i += 1) if (M.starBrightness(i / 10000) > 0.9) bright += 1
  assert.ok(bright > 80 && bright < 130, `bright=${bright}`)
})

test('nodePolarRadius 单调且落在盘内', () => {
  assert.ok(Math.abs(M.nodePolarRadius(100) - 0.10) < 1e-12)
  assert.ok(Math.abs(M.nodePolarRadius(0) - 1.02) < 1e-12)
  assert.ok(M.nodePolarRadius(40) > M.nodePolarRadius(70))
})

test('safeScore 把脏数据折成 0..100', () => {
  assert.equal(M.safeScore(null), 0)
  assert.equal(M.safeScore('abc'), 0)
  assert.equal(M.safeScore('55'), 55)
  assert.equal(M.safeScore(999), 100)
  assert.equal(M.safeScore(-3), 0)
})

test('hash01 确定且在 [0,1)', () => {
  for (const id of ['p_0001', 'g_12', 'self', '']) {
    const v = M.hash01(id)
    assert.ok(v >= 0 && v < 1, `${id} -> ${v}`)
    assert.equal(M.hash01(id), v)
  }
  assert.notEqual(M.hash01('p_0001'), M.hash01('p_0002'))
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/galaxy-geometry.test.mjs`
Expected: FAIL —— `Cannot read properties of undefined (reading 'armAngle')`

- [ ] **Step 3: 在 `client.js` 实现 `GALAXY` 与 `galaxyMath`**

放在 `const FOV = 900` 的位置（`FOV` 本任务先不删，Task 3 删）。`gauss` 用 Box-Muller 只取一个值（另一个丢弃），`safeScore` 必须先 clamp 再乘。全部写成模块级 `const`/`function`，不依赖 `this`。

- [ ] **Step 4: 把 `galaxyMath` 挂进 `__test` 并跑通**

Run: `node --test test/*.test.mjs`
Expected: PASS 全部

- [ ] **Step 5: Commit**

```bash
git add client.js test/galaxy-geometry.test.mjs
git commit -m "feat: 星系几何纯函数（螺旋臂/指数盘/幂律亮度/节点半径）"
```

---

### Task 3: 正交投影、computeFit、spread 归一化、radiusOf 收小

**Files:**
- Modify: `client.js:424`（删 `FOV`）、`client.js:822-840`（`project`）、`client.js:497-531`（`resize`/`computeFit`）、`client.js:574-590`（`spread`）、`client.js:592-599`（`radiusOf`）
- Create: `test/projection.test.mjs`

**Interfaces:**
- Consumes: Task 2 的 `GALAXY`。
- Produces:
  - `project(node) -> { sx, sy, depth }`（**不再返回 `scale`**；屏幕坐标 = `w/2+panX+x1*scale`、`h/2+panY+y2*scale`，`scale = fit*zoom`，`depth = z2`）
  - `computeFit()` 后的 `this.fit` 恒为 `0.40 * Math.min(w,h)`（唯一例外见测试）
  - `radiusOf(node)`：`self` 13、`topic` `1.6 + Math.min(1.2, Math.sqrt(safeScore)*0.19)`、其余 `Math.min(9, base + Math.pow(score/100,1.3)*3.1)`，`base = group?7.6:5.9`
  - `spread()` 把初始位置撒在 `±1.15` 球壳

- [ ] **Step 1: 写失败测试 `test/projection.test.mjs`**

用 `new NeuronRenderer({ getContext: () => ({}) }, {})` 构造（constructor 不碰 canvas）；直接设 `r.w=1440; r.h=900; r.fit=331; r.camera={yaw:0.62,pitch:-0.58,zoom:1.2,panX:0,panY:0}` 再断言。构造前需 `Object.defineProperty(globalThis,'requestAnimationFrame',{value:()=>0,configurable:true})`。

断言清单：

```js
// 1) 正交：project 不再返回 scale
const a = r.project({ x: 0.5, y: 0, z: 0 })
assert.equal(a.scale, undefined, 'project 不再返回 scale')
// 2) 与闭式公式逐项一致（含 yaw/pitch 的 z 混入），偏差 < 1e-12
{
  const { yaw, pitch, zoom, panX, panY } = r.camera
  const s = zoom * r.fit
  const node = { x: 0.4, y: -0.2, z: 0.7 }
  const cosY = Math.cos(yaw), sinY = Math.sin(yaw), cosP = Math.cos(pitch), sinP = Math.sin(pitch)
  const x1 = node.x * cosY - node.z * sinY
  const z1 = node.x * sinY + node.z * cosY
  const y2 = node.y * cosP - z1 * sinP
  const z2 = node.y * sinP + z1 * cosP
  const p = r.project(node)
  assert.ok(Math.abs(p.sx - (720 + panX + x1 * s)) < 1e-12)
  assert.ok(Math.abs(p.sy - (450 + panY + y2 * s)) < 1e-12)
  assert.ok(Math.abs(p.depth - z2) < 1e-12)
}
// 3) 世界原点落在画布中心
const o = r.project({ x: 0, y: 0, z: 0 })
assert.ok(Math.abs(o.sx - 720) < 1e-12); assert.ok(Math.abs(o.sy - 450) < 1e-12)
// 4) 正交：屏幕尺寸不随深度变化（深度只出现在返回值里）
r.camera = { yaw: 0, pitch: 0, zoom: 1, panX: 0, panY: 0 }
assert.ok(Math.abs(r.project({ x: 1, y: 0, z: 0 }).sx - (720 + r.fit)) < 1e-9)
assert.ok(Math.abs(r.project({ x: 0, y: 1, z: 0 }).sy - (450 + r.fit)) < 1e-9)
// 5) computeFit：0.46*min(w,h)/R
r.nodes = [{ id: 'a', x: 1.15, y: 0, z: 0 }]; r.targets = new Map(); r.computeFit()
assert.ok(Math.abs(r.fit - 0.46 * 900 / 1.15) < 1e-6, `fit=${r.fit}`)
// 6) 单节点 / 空图不能退化成 fit=1
r.nodes = []; r.computeFit(); assert.ok(r.fit > 300, `empty fit=${r.fit}`)
// 7) radiusOf 收小
assert.equal(r.radiusOf({ type: 'self' }), 13)
assert.ok(r.radiusOf({ type: 'person', score: 100 }) <= 9.0001)
assert.ok(Math.abs(r.radiusOf({ type: 'topic', score: 100 }) - 2.8) < 1e-9)
// 8) spread 归一化：所有节点初始 |p| <= 1.16
r.nodes = []; r.setGraph?; // 见下
```

第 8 条用纯数据：`r.nodes = Array.from({length:50},(_,i)=>({id:'n'+i,x:0,y:0,z:0})); r.spread(); for (const n of r.nodes) assert.ok(Math.hypot(n.x,n.y,n.z) <= 1.16)`。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/projection.test.mjs`
Expected: FAIL —— 至少 4 条断言失败（`project` 仍返回 `scale`、`fit` 被夹成 4、空图 `fit=1`）

- [ ] **Step 3: 改 `project()`**

```js
project(node) {
  const { yaw, pitch, zoom, panX, panY } = this.camera
  const cosY = Math.cos(yaw), sinY = Math.sin(yaw)
  const cosP = Math.cos(pitch), sinP = Math.sin(pitch)
  const x1 = node.x * cosY - node.z * sinY
  const z1 = node.x * sinY + node.z * cosY
  const y2 = node.y * cosP - z1 * sinP
  const z2 = node.y * sinP + z1 * cosP
  const scale = zoom * (this.fit || 1)
  return { sx: this.w / 2 + panX + x1 * scale, sy: this.h / 2 + panY + y2 * scale, depth: z2 }
}
```

删 `client.js:424` 的 `const FOV = 900`（grep 确认再无 `FOV` 引用）。

- [ ] **Step 4: 改 `computeFit()`**

四处一起改：空图分支 `this.fit = 0.46 * Math.min(this.w||800, this.h||600) / GALAXY.R`；`projected = maxRadius`；去掉 `Math.min(4, …)`；`maxRadius = Math.max(GALAXY.R, pick)`，最后 `this.fit = Math.min(wanted / Math.max(1e-6, maxRadius), 0.46 * Math.min(this.w||800, this.h||600) / GALAXY.R)`。

- [ ] **Step 5: 改 `spread()` 与 `radiusOf()`**

`spread`：三处 `320` → `1.15` 的倍数写法 `const r = GALAXY.R`，坐标乘 `r`。保留 `Math.random()` 初速。
`radiusOf` 按 Interfaces 的公式实现，`topic` 用 `safeScore`。

- [ ] **Step 6: 跑测试并全量回归**

Run: `node --test test/*.test.mjs && node --check client.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add client.js test/projection.test.mjs
git commit -m "feat: 正交相机与归一化 fit，修复 4 处会缩成一点的 computeFit"
```

---

### Task 4: `layoutGalaxy()` 节点落位（含 S60 分流与确定性防重叠）

**Files:**
- Modify: `client.js:611-719`（`applyLayout` 6 分支 → `layoutGalaxy()`）、`client.js:569`（`setGraph` 调用点）、`client.js:721-726`（`setView` 删布局切换）、`client.js:1254-1258`（`reset`）、`client.js:37-44`（删 `LAYOUTS`）、`client.js:1860-1867`（删 rail 布局卡片）、`client.js:451-455` 与 `client.js:1610-1613`（删 `view.layout` 字段）、`client.js:749-820`（`simulate` 删力导向分支）
- Create: `test/layout.test.mjs`

**Interfaces:**
- Consumes: Task 2 的 `galaxyMath`、Task 3 的 `radiusOf`/`computeFit`。
- Produces: `__test.layoutGalaxyTargets(nodes, rng) -> Map<string,[number,number,number]>`（**纯函数**，`applyLayout` 只是把它的结果写进 `this.targets`）。`this.applyLayout()` 不再接受布局参数。

- [ ] **Step 1: 写失败测试 `test/layout.test.mjs`**

```js
const { layoutGalaxyTargets, galaxyMath: M } = loadClient().__test
const mk = (id, type, score) => ({ id, type, score, tier: 'regular' })

test('确定性：同输入两次布局完全一致', () => {
  const nodes = [mk('self', 'self', 100), mk('a', 'person', 90), mk('b', 'person', 10)]
  const one = layoutGalaxyTargets(nodes, seeded(7))
  const two = layoutGalaxyTargets(nodes, seeded(7))
  for (const [id, v] of one) assert.deepEqual(two.get(id), v)
})

test('self 在原点，person 落在盘内且半径随分数单调', () => {
  const t = layoutGalaxyTargets([mk('self','self',100), mk('hi','person',95), mk('lo','person',5), mk('mid','person',50)], seeded(1))
  assert.deepEqual(t.get('self'), [0, 0, 0])
  const rad = (id) => { const [x, , z] = t.get(id); return Math.hypot(x, z) }
  assert.ok(rad('hi') < rad('mid') && rad('mid') < rad('lo'))
})
```

再加三条：`score=null` 的节点 `Number.isFinite` 全为 true；S60 分流——构造 100 个分数 1..100 的 person，断言「分数 >= S60 的节点到最近臂的角度偏差 < 0.12」而「低于 S60 的节点角度分布覆盖 > 6 个 60° 扇区」；`topic` 的 `z === -0.04` 且 `hypot(x,z) ∈ [0.8, 1.25]`。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/layout.test.mjs`
Expected: FAIL —— `layoutGalaxyTargets is not a function`

- [ ] **Step 3: 实现 `layoutGalaxyTargets(nodes, rng)`**

规则（与 spec §4.3 一致）：`self` → `[0,0,0]`；`person`/`group` 按 `score` 降序，`r = nodePolarRadius(score)`；取 `S60`（把可见 person/group 的 `safeScore` 排序取第 60 百分位）；`score >= S60` 走防重叠（`load` 数组挑承载最少的臂、`spread = 0.075*load[pick]`、`theta = armAngle(pick,r) + spread + (hash01(id)-0.5)*0.05`），`score < S60` 走 `theta = hash01(id)*2*Math.PI`、`r *= 0.75 + 0.5*hash01(id+'r')`；`z = gauss(rng, 0.055*Math.sqrt(r))`，`group` 再加 `+0.06`；`topic` → `r = 0.85 + 0.30*hash01(id)`、`theta = hash01(id+'t')*2*Math.PI`、`z = -0.04`。

- [ ] **Step 4: `applyLayout()` 改为无参并调用纯函数**

```js
applyLayout() {
  this.targets = layoutGalaxyTargets(this.nodes, Math.random)
  this.alpha = Math.max(this.alpha, 0.35)
  this.computeFit()
}
```

`setGraph` 里 `this.applyLayout(this.view.layout)` → `this.applyLayout()`；`reset()`、`setView` 同理（`setView` 删掉 `patch.layout` 分支）。

- [ ] **Step 5: 删除六布局残留**

删 `LAYOUTS`、rail「布局」卡片整块、`view` 初始值里的 `layout`、`simulate` 的力导向分支（保留向目标缓动的那段，即原 `client.js:751-763`，`pinned` 恒为 true 后可简化为无 `blend` 判断的版本 —— 保留 `blend` 逻辑亦可）。

Run: `ops_grep pattern="LAYOUTS|view\.layout|layout ===" path=client.js` → 0 命中。

- [ ] **Step 6: 跑测试并全量回归**

Run: `node --test test/*.test.mjs && node --check client.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add client.js test/layout.test.mjs
git commit -m "feat: layoutGalaxy 单布局落位（S60 分流 + 确定性防重叠），删除六布局"
```

---

### Task 5: 盘面点云生成器与位图光栅化

**Files:**
- Modify: `client.js`（新增 `generateDiskPoints(rng) -> Float32Array[]` 与 `renderDiskBitmap(points) -> HTMLCanvasElement`）
- Create: `test/disk-points.test.mjs`

**Interfaces:**
- Consumes: Task 2 的 `galaxyMath`/`GALAXY`。
- Produces: `__test.generateDiskPoints(rng) -> { count, xs, ys, zs, bs, colors }`（全部 `Float32Array`，`colors` 是 `Uint8` 三通道扁平数组）；点云是**纯数据**，不碰 canvas —— 这是本任务可测的部分。

- [ ] **Step 1: 写失败测试 `test/disk-points.test.mjs`**

断言：`count === 20000`；`b` 全部在 `[0.08, 1.0]`；径向直方图——`r<0.3` 的点占 `35%–50%`（指数盘 + 核球）；臂内聚集——按 `|角度偏差|` 统计，贴臂（<0.12）的占 `60%–78%`（70% 目标 + 30% 均匀盘的贡献）；`z` 的 `std` 随 `r` 增大（对比 `r<0.3` 与 `r>0.8` 两组的 `std`，后者更大）；三色占比：暖金 `<0.35` 区域的点里 `>50%`，品红总数 `<4%`。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/disk-points.test.mjs`
Expected: FAIL —— `generateDiskPoints is not a function`

- [ ] **Step 3: 实现 `generateDiskPoints`**

按 spec §4.2：15% 核球（`bulgeRadius`、球对称）；其余 85% 中 70% 贴臂（臂索引按 `ARM_WEIGHT` 加权随机、`theta = armAngle(i,r) + gauss(0, armSigma(r))`）、30% 均匀 `theta`；`z = gauss(0, 0.055*sqrt(r))`；`b = starBrightness(rng())`；颜色：`r<0.3` 以 0.55 概率暖金 `#ffe6c4`，否则 3% 品红 `#ff9ecf`，其余蓝白 `#cfe0ff`。

- [ ] **Step 4: 实现 `renderDiskBitmap(points)`**

3072×3072 离屏 canvas，映射 `[-1.25,1.25] → [0,3072]`；`globalCompositeOperation='lighter'`；暗星（`b<=0.9`）画 2–3 位图像素、亮星画 `6 + 8*b` 位图像素的高斯点；之后 `destination-out` 沿主臂内缘（`armAngle(i, r) - armSigma(r)*2.2`，3–5 条、`alpha 0.10–0.18`）画尘埃带；返回 canvas。**盘面生成不查任何视口尺寸**。

- [ ] **Step 5: 挂进 `__test` 并跑通**

Run: `node --test test/*.test.mjs && node --check client.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add client.js test/disk-points.test.mjs
git commit -m "feat: 2 万星点盘面点云与离屏位图光栅化"
```

---

### Task 6: 绘制管线（盘面 + sprite 节点 + 深度调制 + 暗角/标签顺序）

**Files:**
- Modify: `client.js:865-1142`（`draw()` 整体重写）、`client.js:1049-1071`（渐变 → sprite）、`client.js:958-964`（暗角位置）
- Create: `test/depth.test.mjs`

**Interfaces:**
- Consumes: Task 3 的 `project`、Task 5 的 `renderDiskBitmap`、Task 2 的 `nodePolarRadius`。
- Produces: `__test.depthFactor(depth, zMin, zMax) -> { r: number, a: number }`（纯函数，`r = 0.80+0.45*(1-k)`、`a = 0.70+0.35*(1-k)`，`k` 夹到 `[0,1]`、`zMax===zMin` 时 `k=0`）；`this.disk = { bitmap, dpr }`；`this.sprites = Map<color, canvas>`。

- [ ] **Step 1: 写失败测试 `test/depth.test.mjs`**

`depthFactor(0,0,1)` → `{r:1.25, a:1.05}`（近端）；`depthFactor(1,0,1)` → `{r:0.80, a:0.70}`；`depthFactor(5,5,5)` → `{r:1.25, a:1.05}`（退化不 NaN）；`depthFactor` 对 `zMin/zMax` 反转（`depthFactor(0,1,0)`）不产生越界。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/depth.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现 `depthFactor` 并重写 `draw()` 的骨架顺序**

顺序硬约束：背景 → 核球辉光 → 盘面 `drawImage`（矩阵见 spec §4.1：`setTransform(dpr,0,0,dpr,0,0)` 后 `transform(cosY*s, -sinY*sinP*s, -sinY*s, -cosY*sinP*s, this.w/2+panX, this.h/2+panY)`，`drawImage(bitmap, -DISK_R, -DISK_R, 2*DISK_R, 2*DISK_R)`，再恢复 `setTransform(dpr,0,0,dpr,0,0)`）→ 节点 sprite → 星芒 → 边（Task 7 接管）→ 暗角 → 标签。

`this.disk === null` 时跳过盘面（背景+核球占位，不白屏）。位图在 `requestIdleCallback`（无则 `setTimeout(0)`）里生成，生成完只赋值不阻塞。

- [ ] **Step 4: 节点改 sprite + 深度调制**

删除 `client.js:1049-1071` 的两处 `createRadialGradient`；新增 `spriteFor(color)` 缓存 32×32 预渲染光晕；每帧先算一次 `zMin/zMax`（**在节点循环之前**），再 `const f = depthFactor(p.depth, zMin, zMax)`，`radius = Math.max(1.4, node.r * f.r)`、`alpha *= f.a`。删掉 `persp`（`client.js:1043`）。

- [ ] **Step 5: 暗角移到节点之后、标签之前；标签去背景块**

暗角改 `source-over` 一层；标签改 `shadowBlur` 光晕描边，保留矩形避让。

同时在 `PanelInner` 的 `view` 初始化里加低动效兜底：`autoRotate: !matchMedia('(prefers-reduced-motion: reduce)').matches`（`matchMedia` 不存在时回退 `true`）。这是 spec §4.6 唯一一条尚未落到别处的保留项。

- [ ] **Step 6: 跑测试并 GUI 里程碑验证**

Run: `node --test test/*.test.mjs && node --check client.js`
然后**只画盘面 + 十字准星**的临时开关验证对齐（在 `draw()` 里临时跳过节点段），刷新 http://127.0.0.1:5903 确认盘面与准星在任意 yaw/pitch/zoom 下同步；确认后移除开关。

- [ ] **Step 7: Commit**

```bash
git add client.js test/depth.test.mjs
git commit -m "feat: 盘面位图 + 节点 sprite + 显式深度调制，重排绘制顺序"
```

---

### Task 7: 边按需浮现 + hover 高亮 + pick 退化 + 标签门槛

**Files:**
- Modify: `client.js:973-1020`（边绘制）、`client.js:1157-1173`（`pick`）、`client.js:1104`（标签门槛）、`client.js:1199-1229`（hover 驱动 highlight）、`client.js:969-971`（highlight 计算）
- Create: `test/interaction.test.mjs`

**Interfaces:**
- Consumes: Task 3 的 `project`、Task 6 的 `depthFactor`。
- Produces: `__test.edgesToDraw(edges, highlight, topIds) -> [{ edge, kind: 'faint'|'lit' }]`（纯函数）；`pick(sx, sy)` 返回 `{ node, exact: boolean }` 或 `null`（**改返回值形状**，调用点全部更新）。

- [ ] **Step 1: 写失败测试 `test/interaction.test.mjs`**

`edgesToDraw`：`highlight=null` 时只返回 top-12 的 `faint`；`highlight=Set(['a'])` 时返回与 `a` 相连的边为 `lit`、top-12 其余仍为 `faint`、无关边不出现；`topIds` 由 `weight` 降序前 12 且跨 `highlight` 去重。
`pick`：命中半径用 `Math.max(9, node.r)`（构造一个 `fit=360`、`zoom=1` 的渲染器，断言 30px 外的节点不被选中）；无精确命中时 28px 内最近节点被选中且 `exact=false`；`self` 不再在任何位置胜出（把 `self` 放原点、另一个节点放鼠标下，选中的是后者）。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/interaction.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现 `edgesToDraw` 与新的边绘制段**

边段重写：默认不画任何边；`highlight !== null` 时画一跳边（`alpha 0.35`、细、加性、选中时脉冲一次）；top-12 恒常显（`alpha 0.10`、1px、不着色）。删掉 `client.js:991` 的 `pa.scale` 衰减与 `dimmed` 分支。

- [ ] **Step 4: 改 `pick` 与调用点**

`pick` 返回 `{ node, exact }`；`onPointerMove`/`onPointerUp`/`onDoubleClick` 取 `.node`；`hover` 也参与 `highlight`（`const highlight = selectedSet ?? focusSet ?? hoverSet`）。

- [ ] **Step 5: 标签门槛 `radius > 8.5` → `radius > 5`**

- [ ] **Step 6: 跑测试并全量回归**

Run: `node --test test/*.test.mjs && node --check client.js`
GUI 手测：悬停任意节点应浮现其关系线；弱节点可点中（28px 兜底）；top-12 淡线常显。

- [ ] **Step 7: Commit**

```bash
git add client.js test/interaction.test.mjs
git commit -m "feat: 边按需浮现与 hover 高亮，pick 退化到 28px 最近节点"
```

---

### Task 8: 收尾清理与验收

**Files:**
- Modify: `lib/host/settings.js:44`（删 `preferences.layout`）
- Modify: `docs/superpowers/specs/2026-11-12-galaxy-single-layout-design.md:4`（状态改「已实现」）
- Create: `test/render-snapshot.test.mjs`（可选，见 Step 3）

**Interfaces:**
- Consumes: 全部前序任务。
- Produces: 无新接口。

- [ ] **Step 1: 删 `lib/host/settings.js` 的 `preferences.layout`**

只删这一行；确认 `loadSettings` 对缺省键的合并逻辑不因此报错（读一次函数体验证）。

- [ ] **Step 2: 重启 dsh web 验证 Host 侧改动**

Run: 重启 DSH web（用户确认后）→ `curl -s http://127.0.0.1:5903/wechat-neuron/api/status` 返回 `ok:true`。
Expected: 返回正常，无 `KEY_MISSING`/`SCHEMA_MISMATCH`。**只刷新 5903 不生效**，必须重启。

- [ ] **Step 3: 全量回归**

Run: `node --check client.js && node --check index.js && npm test`
Expected: 语法通过、测试全 PASS。

- [ ] **Step 4: 截图验收（唯一验收标准）**

用 ego-browser 打开 5903 的星系面板，1440×900 深色/浅色各取一张；缩略图尺寸下能一眼认出螺旋星系。浅色下检查面板/标签对比度（画布仍是深空）。把两张截图路径写进汇报。

- [ ] **Step 5: 更新设计文档状态并 commit**

```bash
git add client.js lib/host/settings.js docs/superpowers
git commit -m "chore: 删除 preferences.layout，星系单布局收尾"
```
