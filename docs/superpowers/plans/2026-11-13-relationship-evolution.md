# 关系演化（v0.2）实施计划

> **For agentic workers:** 按任务顺序执行；每个任务都以「写失败测试 → 跑测试确认失败 → 最小实现 → 跑测试确认通过 → 提交」为一个循环。

**目标**：让「关系」在时间轴回放时活起来，并在抽屉里给出「我和这个人」的关系热度曲线。

**架构**：时间键与强度公式集中在 `lib/host/pulse.js`（纯函数，可单测）；Host 侧 `buildGraph` 用它给 chat 边补 `series`/`sentSeries`/`recvSeries`；渲染层 `client.js` 用同一公式在回放态决定边是否浮现。

**技术栈**：Node 24、零依赖、Canvas 2D、`node --test`。

**规格**：`docs/superpowers/specs/2026-11-13-relationship-evolution-design.md`

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `lib/host/pulse.js`（新增） | 时间桶键、逐桶序列、强度归一、基线。纯函数，无 IO。 |
| `lib/host/model.js` | 改为复用 pulse 的键函数；给 chat 边补三个序列字段。 |
| `client.js` | 回放态边浮现、播放速度三档、抽屉关系热度曲线、`__test` 导出新函数。 |
| `test/pulse.test.mjs`（新增） | pulse 纯函数单测。 |
| `test/edge-pulse.test.mjs`（新增） | 渲染层与 Host 侧强度公式一致 + 回放态边过滤。 |

---

## 任务 1：时间键与逐桶序列（pulse.js）

**已完成的准备工作**：`lib/host/pulse.js` 已写好 `weekKey`/`monthKey`/`bucketKeyOf`/`seriesForBucket`/`edgePulse`/`baselinePerBucket`，`test/pulse.test.mjs` 11 条已全绿。

**步骤**

1. 跑 `node --test test/pulse.test.mjs`，确认 11 pass。
2. `node --check lib/host/pulse.js`。
3. 提交：`feat(pulse): 抽出时间桶与关系强度纯函数`。

**验收**：11 条测试全绿；`bucketKeyOf` 与 model.js 原表达式对同一输入给出相同键。

---

## 任务 2：Host 侧给 chat 边补序列

**文件**：`lib/host/model.js`

**步骤**

1. 写测试 `test/edge-series.test.mjs`：用最小输入跑 `buildGraph`，断言
   - 每条 `type === 'chat'` 的边都有 `series`，长度 === `graph.timeline.length`；
   - `sentSeries[i] + recvSeries[i] === series[i]`；
   - 非 chat 边没有 `series`（不付多余体积）。
2. 跑测试确认失败。
3. 实现（已写好，见 model.js «关系序列» 段）。
4. 跑测试确认通过。
5. 提交：`feat(model): chat 边带逐桶关系序列`。

**验收**：新测试全绿且 `npm test` 全绿。

---

## 任务 3：回放态边浮现（渲染层）

**文件**：`client.js`

**步骤**

1. 写测试 `test/edge-pulse.test.mjs`：
   - `T.edgePulse` 与 `pulse.js` 的 `edgePulse` 对同一组输入结果完全相等（防漂移）；
   - 回放态（`timeIndex >= 0`）下 `edgesToDraw` 不返回强度为 0 的边；
   - 非回放态（`timeIndex < 0`）下行为与 v0.1 一致（top12 极淡线）。
2. 跑测试确认失败。
3. 在 `client.js` 里加 `edgePulse` 本地实现（与 pulse.js 同公式），并把 `edgesToDraw` 改成吃 `{ timeIndex, scale }`。
4. 跑测试确认通过。
5. 提交：`feat(render): 回放时关系随当期强度浮现`。

**验收**：真机回放时可见边随桶亮暗、断联边消失；退出回放恢复干净星系。

---

## 任务 4：播放速度三档

**文件**：`client.js`

**步骤**

1. 测试：`T.PLAYBACK_SPEEDS` 恰为 `[{id:'slow',ms:700},…]`，默认 `normal`。
2. 跑测试确认失败。
3. 时间轴 UI 加三档按钮；`setInterval` 用 `view.playbackMs`。
4. 跑测试确认通过。
5. 提交：`feat(timeline): 播放速度三档`。

**验收**：三档切换真的改变回放速度。

---

## 任务 5：抽屉关系热度曲线

**文件**：`client.js`、`lib/host/model.js`

**步骤**

1. 测试：`nodeDetail` 返回的 `relation` 字段含 `series/sentSeries/recvSeries/buckets`；无 chat 边时为 `null`。
2. 跑测试确认失败。
3. `nodeDetail` 里补 `relation`；抽屉加「关系热度」卡片（双色叠加 + 当期竖线）。
4. 跑测试确认通过。
5. 提交：`feat(drawer): 关系热度曲线`。

**验收**：抽屉里能看到我发/对方发的双色走势。

---

## 任务 6：收尾

1. `npm test` 全绿。
2. 真机 GUI 验证（回放 + 抽屉 + 速度）。
3. 更新 `CHANGELOG.md`、`README.md`、`docs/DESIGN.md` 相关段落。
4. `git push origin main`。
