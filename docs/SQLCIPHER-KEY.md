# SQLCipher 密钥自动获取改造方案（参考腾讯 WCDB）

> **2026-11-11 重大更新：自动获取已在真实环境打通。**
> 微信 **4.1.15.56** 实测：**22 个库 → 22 把独立密钥，7.7 秒全部提取并通过页 1 HMAC 验证**。
> 实现见 `lib/host/cipherkey.js`（首选，定向提取）；本文其余章节描述的内存扫描
> （`lib/host/keyharvest.js`）已降级为**回退路径**。
> 关键结论更正：
> 1. **4.x 每个库一把密钥**，不存在「一个账号一把密钥」——必须逐库校验、按库存储。
> 2. 早期「主进程不常驻密钥」的结论**是错的**，根因是判定 oracle 硬编码了 rollback-journal
>    版本字节（`01 01`），而 WAL 模式下真实值是 `02 02`，导致正确密钥被一律判否。
> 3. 可用方法是**定位 `com.Tencent.WCDB.Config.Cipher` 配置对象 → 指针链 → XOR 解码 → 读 `enc_key`**，
>    而不是暴力逐偏移试 AES。
> 算法参考 wechatauto-replica 1.2.8.0（Apache-2.0，见 `NOTICE`），本项目为独立实现。

> 目标：把 `wechat-neuron` 的「自动获取微信数据库密钥」从**一次无界全量内存扫描**，改造成
> **有差距表、有候选矩阵、有分级预算、有明确错误码**的可交付能力。
> 本文对应代码：`lib/host/crypto.js`、`lib/host/cipherkey.js`、`lib/host/keyharvest.js`、`index.js`、`client.js`。

---

## 0. 结论先行

| 项 | 改造前 | 改造后 |
| --- | --- | --- |
| 密钥长度 | 只认 32 字节（AES-256） | **16 / 24 / 32 字节**（AES-128/192/256） |
| 密钥书写形态 | 裸 hex / utf8 | 追加 `x'...'` 包裹、`96 hex = key+salt` 自动截断 |
| 内存扫描范围 | 无界全量（可跑满 GB 级、CPU 打满） | **三级预算**：128MB → 512MB → `budgetMb`，每级限区段大小、限并发（默认 2） |
| 失败语义 | 只有 `NO_CANDIDATE` | `NO_PROCESS` / `NO_CANDIDATE` / **`TIMEOUT`** / **`UNSUPPORTED_VERSION`** / `NO_SALT` / `NO_LAYOUT` |
| GUI 阻塞 | 同步长请求（浏览器会掐断） | **后台任务 + jobId 轮询**，可看进度、可复用同一任务 |
| 用户兜底 | 提示「粘贴密钥」 | 折叠式手动步骤 + 明确「TIMEOUT 不代表没有密钥，可再点一次」 |

**能力边界（历史结论，已被上文更正）**：本节原写「本机微信 4.x 的原始密钥不保证能直读，
已实测穷举 732MB / 7.3 亿候选、800+ hex 串池、DPAPI、明文配置全部 0 命中」。
**这些 0 命中是判定缺陷造成的假阴性，不是密钥不存在**：
- 判定 oracle 把 SQLite 页头写/读版本硬编码为 `01 01`，而本机所有库都是 **WAL 模式**（`02 02`）；
- 校验函数无去重/无预算，对 6 库 × 178 词逐一跑 256000 次 KDF，单次错配 ~1.5s，会挂死 20+ 分钟。
两处修复后改走定向提取，**同一台机器 7.7 秒拿到 22/22**。DPAPI 与明文配置两条路线仍属实测排除。

---

## 1. 与 WCDB / SQLCipher 的差距表

微信把 SQLCipher 封装在 [Tencent/wcdb](https://github.com/Tencent/wcdb) 里，用的是 SQLCipher 的
**C 层核心库**而非官方 Android 封装层 —— 因为微信需要手动控制 KDF 迭代次数等底层参数来兼容历史数据。
这意味着：**同一台机器上不同库、不同微信版本，参数族可能不同**，只认一种组合必然漏。

| 维度 | WCDB / SQLCipher 事实 | 改造前本项目 | 差距 | 本次处理 |
| --- | --- | --- | --- | --- |
| **密钥形态** | 原始密钥（raw key）或口令（passphrase）；WCDB 常用 `x'<64hex_key><32hex_salt>'` | 只解析裸 hex / utf8；不认 `x'...'`；96 hex 直接取前 32 字节 | 认不出 WCDB 写法 | `parseKey` 支持 `x'...'` 包裹、96 hex 取前 32 字节 |
| **密钥长度** | AES-128（16B）/ AES-192（24B）/ AES-256（32B）都可能 | 硬校验 32 字节，`createDecipheriv('aes-256-cbc')` 写死 | AES-128 库完全解不开 | `CIPHER_FOR_KEY_LEN` + `cipherFor()`；`probeRawKey` 接受 16/32 |
| **KDF 迭代** | SQLCipher 3 默认 64000；4 默认 256000；raw key 模式迭代 0 | 4 组 profile 已覆盖 64000 / 256000 / raw | 基本覆盖 | 保留，并新增 AES-128 变体 |
| **HMAC 算法** | SQLCipher 3 用 SHA1，4 用 SHA512（也有 SHA256 配置） | `sha1` / `sha256` / `sha512` 三档 | 已覆盖 | 保留 |
| **保留区 reserve** | 常见 48（SQLCipher 3）/ 80（SQLCipher 4）；也有 32/64/16/12 | `RESERVES = [80,48,64,32,16,12]` | 已覆盖 | 保留，并在探测时加候选 |
| **页大小** | 默认 4096；理论上可改 1024/8192/16384 | 假定 4096，非 4096 只会静默 0 命中 | 用户看不到原因 | 新增文件长度/页对齐校验 → `UNSUPPORTED_VERSION` |
| **AES 实现** | C 层，Nk 由密钥长度决定 | C# `ExpandKey` 写死 Nk=8 / 14 轮 | AES-128 扫不出来 | `ExpandKey(key, keyLen, rk, out rounds)`，Nk=4→10 轮 / Nk=8→14 轮 |
| **扫描策略** | 无需扫描（微信自己知道密钥） | 一次无界全扫，超时只能 kill | 高负载、易蓝屏、无法区分「没扫完」与「真没有」 | 三级预算 + 限并发 + `exhausted`/`truncated` 语义 |

> 合规：以上仅依据 WCDB / SQLCipher 的公开文档与公开实现思路自行实现，**未复制任何未声明 LICENSE 项目的源码**。
> 内存读取限定为本机当前用户自己的微信进程，且只读、不注入、不 Hook、不修改目标进程。

---

## 2. 候选参数族与密钥形态矩阵

### 2.1 参数族（profile）

| profile id | 密钥 | KDF | 迭代 | HMAC | reserve | trailer |
| --- | --- | --- | --- | --- | --- | --- |
| `sqlcipher3` | 口令 | SHA1 | 64000 | SHA1 | 48 | 12 |
| `sqlcipher3-macfull` | 口令 | SHA1 | 64000 | SHA1 | 48 | 0 |
| `sqlcipher4` | 口令 | SHA512 | 256000 | SHA512 | 80 | 0 |
| `sqlcipher4-reserve48` | 口令 | SHA512 | 256000 | SHA256 | 48 | 0 |
| `raw4-sha512` | raw 32B | — | 0 | SHA512 | 80 | 0 |
| `raw4-sha256-48` | raw 32B | — | 0 | SHA256 | 48 | 0 |
| `raw3-sha1` | raw 32B | — | 0 | SHA1 | 48 | 12 |
| `raw4-macfull` | raw 32B | — | 0 | SHA512 | 80 | 0 |
| **`raw4-sha512-aes128`** | **raw 16B** | — | 0 | SHA512 | 80 | 0 |
| **`raw3-sha1-aes128`** | **raw 16B** | — | 0 | SHA1 | 48 | 12 |

### 2.2 密钥形态 × 长度矩阵

内存里的密钥**不一定以裸字节存在**，因此按「形态 × 长度」共 8 格穷举，每格都有独立的提取器：

| 形态 | 提取方式 | AES-128 | AES-256 | 代码位置 |
| --- | --- | --- | --- | --- |
| ① 裸字节（raw key） | `Buffer.BlockCopy(window, offset, keyBytes, 0, len)` | ✅ | ✅ | `ProbeKeyLength` / `Run` 主循环 |
| ② ASCII hex 串（32/64 字符） | `HexVal(buffer[p+k*2])<<4 \| HexVal(...)` | ✅ | ✅ | `ScanHexRuns` |
| ③ UTF-16LE hex（宽字符 hex） | 同上但步长 4，只读低字节 | ✅ | ✅ | `ScanHexRunsWide` |
| ④ 宽字符数组（每 wchar 只存 1 字节） | `keyBytes[k] = buffer[i + k*2]` | — | ✅ | `ScanByteStride2` |
| ⑤ `x'<hex>'` 文本 | 走 JS 侧 `parseKey`（用户粘贴场景） | ✅ | ✅ | `crypto.js parseKey` |

### 2.3 判定依据（为什么不会误报）

不做「解密后猜内容」，而是用**布局无关的 IV 模式判定**：

1. 已知明文页头前 8 字节 `P1_known = [0x10,0x00,0x01,0x01,0x00,0x40,0x20,0x20]`
   （SQLite 页 1：page type + first freeblock + cell count + cell content start + fragmented bytes），
   第 5 字节是「保留区字节数」，随 profile 变化 → **掩码掉不比较**。
2. 用候选密钥对第 1 页首个密文块 `C1` 做一次 AES 解密得到 `D_K(C1)`。
3. 由于 CBC 下 `P1 = D_K(C1) XOR IV`，所以 `IV_candidate = D_K(C1) XOR P1_known`。
4. 该 `IV_candidate` 必须**真实出现在数据库首页里**（我们在 `buildTargets` 阶段已把首页所有
   偏移 16 起的 8 字节窗口收进 `patterns` 集合）。
5. 命中即 `patterns.Contains(packXor(plain, 0))`。误报率 ≈ **1 / 2^56**（跳过第 5 字节后 56 bit）。

> 好处：不依赖 reserve/IV 位置假设，因此对「布局未知」的库同样有效 —— 这正是本项目早期版本能
> 从 4 种 reserve 布局里挑出正确解的原因。

### 2.4 耗时上限与短路条件

| 层级 | stride | 区段大小上限 | 读取预算 | 短路条件 |
| --- | --- | --- | --- | --- |
| L1 快筛 | `stride×4` | 16 MB | 128 MB | 命中 / 预算耗尽 / 超时 |
| L2 常规 | `stride×2` | 256 MB | 512 MB | 同上 |
| L3 细扫 | `stride` | 不限 | `budgetMb`（默认 512MB，上限 4096MB） | 同上 |

- **并发上限**：`MaxDegreeOfParallelism = min(4, maxDegree)`，默认 **2**。
  （用户曾因内存扫描把机器拖到蓝屏 `IRQL_NOT_LESS_OR_EQUAL`，所以默认保守。）
- **每 chunk 4 MB** 读取，读完立即扫描并释放，不累积大缓冲。
- **总时限**：`timeoutMs` 默认 45000（GUI 侧），PowerShell 进程超时 `killSignal: SIGKILL`。
- **短路**：任一层命中立即 `job.found = 1` → `state.Stop()` → 后续层不再进入。

---

## 3. 流程与时序

```
[GUI] 点「自动获取密钥」
   │
   ├─(1) POST /wechat-neuron/api/harvestKey  {} 
   │        └─ Host 立即返回 { ok:true, jobId:"harvest-N", running:true, elapsedMs:0 }   ← 不等扫描
   │           若已有任务在跑 → 直接复用同一个 jobId（不重复开扫描）
   │
   ├─(2) 后台 Promise 真正执行 harvestKey():
   │        读首页 → 校验页大小 → buildTargets(IV patterns) → 读缓存 → listWechatPids
   │        → 写临时 scan.ps1（带 BOM）→ PowerShell Add-Type 编译 C# → Run(...)
   │        → C# 三级预算扫描 → 每 24 个区段 Flush 一次进度 JSON
   │        → 读到 keys[] → validateCandidates(16/32B) → detectAnyProfile 确认
   │
   ├─(3) GET /wechat-neuron/api/harvestStatus   每 1.5s 一次
   │        ├─ { state:"idle" }                     → 无任务
   │        ├─ { state:"running", jobId, elapsedMs } → 继续轮询（每 4 轮提示已用秒数）
   │        └─ { state:"done", result:{...} }        → 结束
   │
   └─(4) result.ok === true → setKey() → 清 graphCache → loadGraph({refresh:true})
          result.ok === false → 按 reason 给文案（见 §4）
```

**验收标准**（对应用户要求 ⑤）：

| 场景 | 期望 |
| --- | --- |
| 无密钥、目录已配置 | 顶部状态条明确引导（橙条 + 「自动获取密钥 / 设置」两个按钮），**不出现只有「我」一个节点的空图** |
| 无密钥、目录未配置 | 状态条提示「未找到微信数据目录」，按钮引导选择目录 |
| 有密钥 | `extract → model` 跑通，输出多节点图（实测 10 节点 / 13 边 / 180 消息） |
| 扫描超时 | 返回 `TIMEOUT`，文案说明「不代表没有密钥，可再点一次」 |
| 页大小异常 | 返回 `UNSUPPORTED_VERSION`，提示目录可能不是微信 4.x `db_storage` |
| 微信未运行 | 返回 `NO_PROCESS`，提示先打开并登录微信 |

---

## 4. 接口与错误码

### 4.1 API

| 方法 | 路径 | 入参 | 出参 |
| --- | --- | --- | --- |
| POST | `/wechat-neuron/api/harvestKey` | `{ remember?, timeoutMs?, budgetMb?, maxDegree?, pids? }` | `{ ok:true, jobId, running:true, elapsedMs }` |
| GET | `/wechat-neuron/api/harvestStatus` | — | `{ state:'idle' }` \| `{ state:'running', jobId, elapsedMs }` \| `{ state:'done', jobId, result }` |
| POST | `/wechat-neuron/api/key` | `{ key, remember? }` | `{ ok, profile?, error? }`（手动粘贴入口） |

### 4.2 错误码

| code | 含义 | 用户可见文案要点 |
| --- | --- | --- |
| `NO_PROCESS` | 没有正在运行的微信进程 | 先打开并登录微信，保持运行 |
| `NO_CANDIDATE` | 预算内**扫完**且确实没有密钥 | 已尝试 32/16 字节 raw key、hex 口令、UTF-16LE、宽字符数组；请手动粘贴 |
| `TIMEOUT` | 预算/时间上限先到，**没扫完** | 不代表没有密钥，可再点一次或手动粘贴 |
| `UNSUPPORTED_VERSION` | 页大小非 4096 或文件长度异常 | 确认目录指向微信 4.x 的 `db_storage` |
| `NO_SALT` | 首页读不到 salt | 目录可能不是微信数据 |
| `NO_LAYOUT` | 首页里找不到可用的 IV 模式 | 库结构异常 / 不是 SQLCipher 库 |
| `VERIFY_FAILED` | 扫到候选但 HMAC 校验不过 | 密钥不完整或参数族不匹配 |
| `NO_DB` | 没有可读数据库文件 | 目录为空或权限不足 |

> `NO_CANDIDATE` 与 `TIMEOUT` 的区分由 C# 侧 `exhausted` / `truncated` 标志决定：
> 预算内所有区段都扫完且 0 命中 → `exhausted=1` → `NO_CANDIDATE`；
> 任一层因预算/时间被 `state.Stop()` → `truncated=1` → `TIMEOUT`。

---

## 5. 代码改动清单

| 文件 | 改动 |
| --- | --- |
| `lib/host/crypto.js` | 新增 `CIPHER_FOR_KEY_LEN` / `cipherFor()`；`RAW_PROFILES` 加 `keyLen` 与两个 AES-128 变体；`deriveKeys` 按 `keyLen` 取长并回传 `cipher`；`decryptDatabase` 用 `keys.cipher`；`parseKey` 支持 `x'...'` 与 96 hex；`probeRawKey` 接受 16/32 字节 |
| `lib/host/keyharvest.js` | C# `ExpandKey` 支持任意 Nk；`DecryptBlock` 轮数参数化；新增 `ProbeKeyLength` / `TryCandidateKey` / `ScanByteStride2`；`Job` 加 `exhausted/truncated/level/levels`；`Run` 改三级预算 + 限并发；JS 侧加 `budgetMb/maxDegree`、页大小校验、`TIMEOUT`/`UNSUPPORTED_VERSION` 判定、`validateCandidates` 接受 16/32 字节 |
| `index.js` | `harvestKey` 拆成后台任务 + `harvestStatus` 轮询；`timeoutMs` 默认 45000；透传 `budgetMb`/`maxDegree`；失败按 reason 分派文案（含 `TIMEOUT`、`UNSUPPORTED_VERSION`） |
| `client.js` | `autoKey` 与 `SettingsModal.harvest` 都改为「立即返回 jobId + 轮询」；扫描中每 4 轮显示已用秒数；新增 `TIMEOUT` 专属提示；设置里保留折叠手动步骤 |

### 验证结果

```
$ node --check index.js            → INDEX_OK
$ node --check client.js           → CLIENT_OK
$ node --check lib/host/crypto.js  → CRYPTO_OK
$ node --check lib/host/keyharvest.js → HARVEST_OK
```

端到端自测（`.tools/e2e.mjs`，造明文微信 4.x 库 → `scan` → `readContacts/readSessions/readMessages` → `buildGraph`）：

```
accounts=2 contacts=4 sessions=3 messages=180
nodes=10 edges=13
byType={self:1, group:1, person:2, topic:6}
tiers={core:1, friend:1, regular:2, topic:6}
topPeople=[{老鲍 47 regular 60}, {爱丽丝 47 regular 60}]
E2E_OK
```

→ AES-128 分支的引入**没有破坏原有链路**；「只有我一个节点」的根因确认为缺密钥，而非 extract/model 缺陷。

---

## 6. 已知限制与后续可选项

1. **定向提取依赖结构偏移**：`Config.Cipher` 的指针链偏移（`+0x28` → `+0x88` → `+0x8/+0x10`）
   与 32 字节 XOR 掩码是按微信 4.1.x 实测得到的。微信改版本可能变动，此时返回
   `NO_CIPHER_CONFIG` 并回退到内存扫描；不会静默给出错误密钥（一律过页 1 HMAC）。
2. **不做 Hook / 注入**：只读 `OpenProcess(VM_READ|QUERY_INFORMATION)` + `ReadProcessMemory`，
   不写目标进程、不注入 DLL。需要 100% 可靠时仍可用社区工具取 hex 后手动粘贴。
3. **页大小仅支持 4096**：其它页大小会返回 `UNSUPPORTED_VERSION` 而不是猜测。
4. **只扫主进程**：`Weixin.exe` 中带 `--type=` 的都是 helper（wxocr/wxutility/xplayer/wxpublic），
   `WeChatAppEx.exe` 是 CEF 渲染器，均不持密钥，已排除以免浪费预算。
5. **DPAPI / 明文配置路线**：本机实测 0 命中，未纳入默认流程。

---

## 7. 真实环境端到端实测记录（2026-11-11，微信 4.1.15.56）

密钥提取（真实插件 API `harvestKey` → `harvestStatus`）：

```
HARVEST ok=true keys=22/22 source=cipher-config ms=7661
steps: dbs=22 pids=16088 / scanned=877MB needles=1 nodes=184 blobs=183 candidates=27
       verified=22/22 distinctKeys=22
forms=["raw32"]  profiles=["raw4-sha512"]
```

读库与图谱（`graph` API）：

```
COUNTS={"nodes":2093,"edges":3556,"messages":156158,"contacts":5835}
timeRange=["2025-05-30","2026-11-11"]
SELF sent=26657 recv=107264
nodeTypes={"self":1,"person":1919,"group":149,"topic":24}
messages: biz_message_0.db read=24336 tables=149
          message_0.db     read=72135 tables=232
          message_1.db     read=59687 tables=150
```

性能修复轨迹（同一台机器、同一批库）：

| 阶段 | 耗时 | 结果 |
| --- | --- | --- |
| 暴力扫描（oracle 硬编码版本字节） | 200s | TIMEOUT，0 命中（假阴性） |
| 定向提取首版（朴素 IndexOf + 无界校验） | 17 分钟 | 22/22 但不可用 |
| C# `Array.IndexOf` 首字节跳跃 | 扫描 3.06s | 校验仍挂死 |
| 校验分级判据修正（见下） | **总 4.9s** | 22/22 |

**校验分级判据的坑（务必记住）**：判断一个参数族是否「廉价」必须同时看
`iterations` 与 `macIterations`。`sqlcipher4` 的 `macIterations=2` 但 `iterations=256000`，
只看前者会把它误判成廉价组：27 候选 × 22 库 = 594 次错配 × 378ms ≈ 4 分钟。
真正命中的 `raw4-sha512`（两者都 ≤2）单次只要 1ms。

### 7.1 读库链路的四处 schema 缺陷（与密钥无关，但同样导致图谱全空）

拿到密钥后图谱仍为空，实测定位到 `lib/host/extract.js` 四处问题：

1. **会话表名**：4.x 是 `SessionTable`，旧候选只有 `session`/`Session` → `no-session-table`。
2. **消息表是多张**：4.x 按会话拆成 `Msg_<md5(user_name)>`，单库 150~240 张同构表
   （实测 message_0.db 有 232 张）。旧实现只取第一张命中表，且该表无 `username` 列
   → talker 为空 → 全部丢弃。**表名后缀 = md5(user_name)，实测 232/232 全命中**，
   用本库 `Name2Id` 反查即得会话归属。
3. **WCDB 逐列压缩**：`WCDB_CT_message_content=4` 表示该列是 **zstd** 块（magic `28 b5 2f fd`）。
   实测 156158 条里 61121 条压缩，用 `node:zlib` 的 `zstdDecompressSync` 解开。
4. **类型位序**：`local_type` **低 32 位是主类型、高 32 位是子类型**
   （实测 `244813135921` → low32=49 链接、high32=57）。旧实现取高位当主类型，
   导致 32115 条链接/引用消息全归为 `other`。

另外两处修正：`Name2Id` 的 `rowid` 是隐式列（`pragma table_info` 看不到），
核心列判定需放宽到 1 列；各库 `Name2Id` 的 rowid **各自从 1 开始编号**，
发送者映射必须按库建立，不能跨库共用。本人 wxid 由账号目录名去掉尾部 `_xxxx` 实例后缀得到，
用于标记 `__self__`，否则 reciprocity/initiation 两个亲密度维度恒为 0。
