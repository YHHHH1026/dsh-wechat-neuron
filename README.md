# 微信神经元图谱 · dsh-wechat-neuron

把**本机微信聊天记录**整理成一张**神经元 / 银河风格的动态 3D 关系图谱**：谁对你最重要、你和谁在什么时候聊得最热、话题星云长什么样，一屏看完。

> DSH Desktop / Web 插件（bundle），安装后在侧边栏出现「神经元图谱」入口，占据主面板。

[![npm](https://img.shields.io/npm/v/dsh-wechat-neuron)](https://www.npmjs.com/package/dsh-wechat-neuron)
[![license](https://img.shields.io/npm/l/dsh-wechat-neuron)](<LICENSE>)

## 运行要求

| 项 | 要求 | 原因 |
| --- | --- | --- |
| 操作系统 | **仅 Windows**（`os: ["win32"]`） | 密钥提取依赖 PowerShell + Win32 API（`OpenProcess` / `ReadProcessMemory`），数据目录发现读 `%APPDATA%`。macOS / Linux 上 npm 会直接拒装。 |
| Node | `^22.15.0 \|\| ^23.8.0 \|\| >=24.0.0` | 用到 `node:sqlite` 的 `DatabaseSync`，以及 `zlib.zstdDecompressSync`（[v22.15.0 新增](https://nodejs.org/api/zlib.html)，23 线为 v23.8.0）。低于此版本会在读库时抛错。 |
| DSH | `>=0.2.2-rc.1 <0.3.0-0` | 插件双面契约（host `webServer` 路由 + client `slots`）随宿主小版本演进。 |
| 微信 | 3.x / 4.x，**已登录并保持运行** | 自动取密钥需要读主进程内存；微信退出后只能用手动粘贴的密钥读缓存。 |

> `node:sqlite` 与 zstd 同步解压在 Node 侧仍标记为实验性 API，启动时可能出现 `ExperimentalWarning`，属正常现象。

---

## 1. 功能总览

| 维度 | 能力 |
| --- | --- |
| 数据读取 | 自动发现微信 3.x / 4.x 数据目录，读取 `contact` / `session` / `message` 库；SQLCipher 加密库支持内存解密（密钥只存内存，可选记住） |
| 关系建模 | 联系人、群聊、话题三类实体；聊天 / 群成员 / 共同群聊 / 话题关联四类关系 |
| 重要度评分 | 六维加权（新近度 30% / 频次 22% / 互惠 16% / 主动 12% / 深度 10% / 亲密 10%），五档分层：核心 / 挚友 / 常联系 / 弱连接 / 沉默 |
| 3D 渲染 | Canvas 2D 自绘正交投影 + 单一星系布局（密度场弥漫星光 + 加性星点两遍光栅化）；金色核球、旋臂薄雾、星尘、星芒、光晕、脉冲 |
| 交互 | 旋转、缩放、平移、节点点击详情、双击聚焦、时间轴播放、关系边悬停/选中浮现、筛选、一键聚焦、图例开关、导入导出 |
| 星系布局 | 唯一布局：对数旋臂密度场（缠绕角 16°、恒定角宽、核外起臂）+ 尘埃暗带；关系边默认隐藏 |
| 星系调校 | 左栏常驻控制区：11 个实时旋钮（缠绕/臂宽/纯度/星数/弥漫星光/尘埃/倾角/缩放/自转/光晕/标签密度）+ 4 套恒星色族，拖动即时生效，可复位、随机、存为本机默认 |

### 五个观察维度

1. **时间维度** —— 底部时间轴按周/月分桶（`timeline`），支持播放回放；节点亮度随该时间桶内的消息量变化。回放时关系边改按当期强度浮现，粗细与透明度随桶呼吸；右侧三档速度（慢 700ms / 正常 420ms / 快 200ms）可切换。
2. **人员维度** —— 人物 / 群聊节点，按重要度分五档，颜色与半径双重编码。
3. **消息类型维度** —— 文本 / 图片 / 语音 / 视频 / 链接 / 卡片 / 表情 / 位置 / 通话 / 红包 / 文件，详情抽屉里用环形图展示分布。
4. **关键词 / 话题维度** —— TF-IDF 抽取会话话题，生成「话题节点」挂到相关会话上，可单独开关。
5. **互动频次维度** —— 边的粗细 = 消息量（进入回放后改按所选时间桶的当期互动量），箭头方向编码发送/接收比，互惠度进入重要度公式。

### 交互清单

- **旋转**：鼠标左键拖拽改变 yaw / pitch
- **缩放**：滚轮（0.32×–3.6×）
- **平移**：中键拖拽
- **节点详情**：单击节点 → 右侧抽屉（评分、六维条、互动统计、类型环、月度折线、关系热度柱图、关键词、最近消息、关联节点）
- **时间轴播放**：播放 / 暂停 / 拖动 / 全部（快捷键 `Space`）+ 回放速度三档（慢 / 正常 / 快）
- **筛选器**：左栏重要度分层**逐档独立勾选**（取消任一档不影响其他档，可全关或只留一档）、话题/群聊/共同群聊/标签/脉冲/自转开关
- **关系高亮**：选中节点后高亮其一阶邻居；悬停优先于选中/聚焦；**鼠标在画布上时标签不会整体消失**（悬停节点强制显示名字，其余标签按未被压暗的亮度判定）
- **关系边浮现**：边默认全隐（真星系没有连线）；悬停或选中节点时浮现其关系边
- **星系调校**：左栏常驻控制区（排在业务卡之后），11 个旋钮拖动即时生效（盘面类重建位图、相机类零重建）；「复位」回出厂值并清掉本机默认，「随机」只在读得出螺旋的安全带里取值且可一键撤销，「存默认」写本机
- **一键聚焦**：重要度榜「聚焦我」、节点双击聚焦（快捷键 `F`）、`R` 复位
- **图例开关**：右上「图例 ×」/ 左下「图例」
- **导入导出**：导出当前图谱为 JSON；导入 JSON 覆盖当前视图

---

## 2. 参考的开源项目（GitHub，星标为 2026-11 实测）

| 项目 | Star | 协议 | 方向 | 借鉴了什么 → 落到哪个模块 |
| --- | --- | --- | --- | --- |
| [LC044/WeChatMsg](https://github.com/LC044/WeChatMsg) | **42.3k** | **未声明 LICENSE**（仅借鉴思路，不复制代码） | 微信聊天记录提取 / 导出 | 多库（`message_0.db` / `message_1.db`）分片合并读取、`Name2Id`→`username` 发送者反查、消息类型码到语义类型的映射 → `lib/host/extract.js` |
| [sjzar/chatlog](https://github.com/sjzar/chatlog) | **9.2k** | **未声明 LICENSE**（仅借鉴思路，不复制代码） | 聊天记录工具（含密钥获取思路） | 微信 4.x 目录布局（`xwechat_files/<wxid>/db_storage`）、`session` 表驱动的会话清单、按需解密而非全量落地 → `lib/host/discover.js` + `lib/host/crypto.js` |
| [xaoyaoo/PyWxDump](https://github.com/xaoyaoo/PyWxDump) | **9.6k** | **未声明 LICENSE**（仅借鉴思路，不复制代码） | 微信数据库解密 / 取证 | SQLCipher 参数族（PBKDF2 迭代数、HMAC 算法、页保留区/trailer 长度）的候选集设计，逐 profile 试探首页 HMAC → `lib/host/crypto.js` |
| [vasturiano/3d-force-graph](https://github.com/vasturiano/3d-force-graph) | **6.6k** | MIT | 3D 力导向图 | 按深度排序绘制、发光与连线透明度的视觉配方 → `client.js` 的 `draw()`（力导向物理已随单一星系布局移除，节点改为缓动追随星系目标位） |
| [mrdoob/three.js](https://github.com/mrdoob/three.js) | **118k** | MIT | 3D 渲染 | 世界/屏幕坐标的变换次序与深度排序思路（本插件用 Canvas 2D 自绘**正交投影**，不引入依赖）→ `project()` |
| [antvis/G6](https://github.com/antvis/G6) | **12.4k** | MIT | 图分析与可视化 | 图数据模型（nodes/edges/meta）与交互三态语义 → `lib/host/model.js` 的 schema、`client.js` 的 hover/selected/active |
| [cytoscape/cytoscape.js](https://github.com/cytoscape/cytoscape.js) | **11.3k** | MIT | 图分析 | 邻居高亮与「选中即聚焦」的交互语义 → `setFocus()` / `pick()` |
| [leesingx/dsh-Memory-Galaxy](https://github.com/leesingx/dsh-Memory-Galaxy) | 17 | MIT | DSH 插件 / 银河可视化（**UI 风格基准**） | 深空底色 + 金色核球 + 三旋臂薄雾 + 星尘 + 统一标签层 + 玻璃拟态浮窗的整套视觉与动效参数 → `client.js` 的 `CSS` / `draw()` / `simulate()` |

> ⚠️ **协议说明**：WeChatMsg / PyWxDump / chatlog 三个项目仓库**没有 LICENSE 文件**，属"保留所有权利"。本插件只借鉴其公开文档与实现思路（数据结构、参数族、目录布局），**未复制任何源代码**。其余 MIT 项目同样只借鉴算法思路，运行时零第三方依赖。

---

## 3. 架构

```
wechat-neuron/
├─ index.js                 # Host half：webServer 路由 + 全部 API
├─ client.js                # Client half：React 面板 + Canvas 3D 引擎 + 全部交互
├─ cordis.patch.yml         # bundle patch（插入本插件一行）
├─ icon.svg  locale/{zh,en}.json
└─ lib/host/
   ├─ discover.js   # 数据发现：配置 ini → 候选根 → 账号 → 22 个库的角色归类
   ├─ crypto.js     # SQLCipher 解密：10 组参数族（含 AES-128 变体）、首页 HMAC 试探、AES-128/192/256-CBC 逐页
   ├─ extract.js    # 读取层：schema 别名容错、Name2Id 反查、消息类型解析
   ├─ model.js      # 建模层：实体/关系/评分/话题/时间轴/节点详情
   ├─ cipherkey.js  # 密钥获取首选：Config.Cipher 定向提取（指针链 + XOR 解码 + 逐库 HMAC）
   ├─ keyharvest.js # 密钥获取回退：微信进程内存只读扫描（C# 并行 AES 预筛 + 布局无关判定 + 三级预算）
   ├─ demo.js       # 确定性演示数据（无密钥时的降级路径）
   └─ settings.js   # 设置与密钥（内存优先，绝不回传明文）
```

### 核心数据链路

```
本地微信目录
  └─ discover.scan()        → 账号 + 库清单（22 个 .db，含角色/大小/加密态）
      └─ extract.openDatabase()  → 明文直开 / 密文解密到缓存目录
          └─ readContacts / readSessions / readMessages
              └─ model.buildGraph()  → nodes / edges / metrics / timeline
                  └─ client.js NeuronRenderer  → 银河 3D 视图
                      └─ 交互 → api('node') / 筛选 / 时间轴 / 导出
```

### Host API（`/wechat-neuron/api/*`）

| 方法 | 说明 |
| --- | --- |
| `status` | 设置、密钥状态、发现的根/账号/库清单、缓存信息、`app.url`（带 token 的 GUI 地址） |
| `scan` | 重新扫描（可传 `extraRoots`） |
| `graph` | 返回图谱（`?refresh=1` 跳过缓存） |
| `node` | 单节点画像 |
| `settings` | 读写设置 |
| `key` | 设置 / 遗忘数据库密钥（`{key, remember}`） |
| `harvestKey` | 启动后台密钥扫描任务，**立即返回** `{jobId, running:true}`；真正扫描在后台跑，避免长请求挂死。可传 `{timeoutMs, budgetMb, maxDegree}` 控制预算与并发 |
| `harvestStatus` | 轮询后台任务：`{state:'idle'\|'running'\|'done', jobId, elapsedMs, result}` |
| `diagnose` | 逐库打开并列出真实表名与前 16 张表，用于排查 schema 不匹配 |
| `clearCache` | 清理解密缓存 |
| `exportGraph` / `importGraph` | 导出 / 导入图谱 JSON |

**密钥获取错误码**（详见 [docs/SQLCIPHER-KEY.md](docs/SQLCIPHER-KEY.md)）：

| code | 含义 | 用户该做什么 |
| --- | --- | --- |
| `NO_PROCESS` | 没有正在运行的微信进程 | 打开并登录微信后重试 |
| `NO_CIPHER_CONFIG` | 主进程内存里找不到 `Config.Cipher` 配置对象 | 微信版本差异或未登录；确认微信已登录且是主进程，或手动粘贴 |
| `NO_CANDIDATE` | 预算内**扫完**且确实没有密钥 | 用设置里的手动步骤粘贴密钥 |
| `TIMEOUT` | 预算/时间先到，**没扫完**（不代表没有） | 再点一次继续，或手动粘贴 |
| `UNSUPPORTED_VERSION` | 页大小非 4096 / 文件长度异常 | 确认目录指向微信 4.x 的 `db_storage` |
| `NO_SALT` / `NO_LAYOUT` | 首页读不到 salt / 找不到 IV 模式 | 目录可能不是微信数据 |
| `VERIFY_FAILED` | 扫到候选但 HMAC 校验不过 | 密钥不完整或参数族不匹配 |

安全：所有路由只接受**回环 Host**，拒绝 `sec-fetch-site: cross-site`，`Origin` 与 `Host` 的 hostname 必须一致；响应统一 `{ok:true,value}` / `{ok:false,error}` 信封。

---

## 4. 安装

**方式一：DSH 插件市场（推荐）** —— 在市场里搜索 `dsh-wechat-neuron` 安装，或让 Agent 调用 `dshm_install`。

**方式二：按 npm 包名安装**

```bash
plugin_manager install_bundle  dsh-wechat-neuron
```

**方式三：本地源码（开发用）**

```bash
git clone https://github.com/YHHHH1026/dsh-wechat-neuron.git
# 再把克隆目录的绝对路径作为 bundle 安装
plugin_manager install_bundle  <克隆目录绝对路径>
```

安装后侧边栏出现「神经元图谱」；改代码后关闭再启用该插件即可热重载（无需重启 DSH）。

> 若安装时提示 peer 不兼容，说明宿主 DSH 版本不在 `>=0.2.2-rc.1 <0.3.0-0` 区间内。请先升级宿主，不要强行跳过预检。

## 5. 使用

1. 打开侧边栏「神经元图谱」，首次显示**演示数据**（徽章「演示」）。
2. 若已找到微信数据目录，顶部会出现橙色状态条：「已找到微信数据目录，但数据库是加密的」，点右侧**「自动获取密钥」**——保持微信已登录并运行，插件会只读访问微信**主进程**内存，定向提取每个库的密钥并逐库 HMAC 验证（实测 4.1.15.56 约 8 秒拿到 22/22）。后台任务方式执行，界面立即返回并轮询进度，不会把请求挂死。
3. 自动获取失败时，设置里有一节折叠的**手动步骤**：用 chatlog / PyWxDump 的 `get key` 拿到 64 位十六进制串 → 粘贴 → 点「载入」（可勾选「记住密钥」）→ 刷新，徽章变为「本地」。
4. 若自动发现失败，可在设置里用系统目录选择框添加微信数据目录。

## 6. 隐私与合规

- 所有数据**只在本机**读取与渲染，除本机回环 HTTP 外**不发起任何网络请求**。
- 密钥默认只驻留内存；勾选「记住密钥」才写入 `~/.dsh/wechat-neuron/settings.json`。
- 解密结果缓存在 `~/.dsh/wechat-neuron/cache/`，可一键清理。
- 仅用于读取**你自己账号**的聊天记录，请遵守当地法律与微信服务协议。

## 7. 已知限制

- **零操作取密钥（微信 4.x 已实测打通）**：首选**定向提取**——在微信主进程内存里定位 `com.Tencent.WCDB.Config.Cipher` 配置对象，顺指针链取出 XOR 编码的配置块，解码后读取每个库的 `enc_key`，再用页 1 HMAC 逐库确认。实测微信 **4.1.15.56**：**22 个库 22 把独立密钥，7.7 秒全部提取并验证通过**（扫描 877MB 内存）。注意 4.x **每个库一把密钥**，不存在「一个账号一把密钥」。
  定向提取失败时才回退到旧的**只读内存扫描**（C# 并行 AES 预筛 + 布局无关判定 + 三级预算），覆盖 32 字节 raw key、hex 口令、UTF-16LE hex、宽字符数组与 AES-128/256。
  历史结论更正：早期文档曾写「部分 4.x 把密钥交给独立安全进程、主进程不常驻」——那是在判定 oracle 有缺陷（硬编码 rollback-journal 版本字节，WAL 模式下把正确密钥判否）时得出的，**已被推翻**。DPAPI 与明文配置两条路线仍属实测排除。
- 微信 4.x 的 `message_*.db` 分片会按 mtime 合并读取，超大账号读取较慢（上限 20 万条 / 次）。
- 3D 引擎为 Canvas 2D 自绘正交投影 + 单一星系布局；真实账号实测 2093 节点 / 3556 边下约 59fps（盘面位图离屏缓存，关系边默认不绘制）。节点数超过约 3000 时按 `score` 降采样。
