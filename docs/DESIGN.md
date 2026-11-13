# wechat-neuron 设计文档

DSH（DeepSeek Harness）插件 · 把本机微信聊天记录整理成神经元结构的动态 3D 视图

- 文档版本：v0.1 设计基线
- 实测环境日期：2026-11-10
- 目标宿主：DSH Web GUI（http://127.0.0.1:<DSH端口>）
- 插件包名：`dsh-wechat-neuron`
- 安装目标 profile：`%USERPROFILE%\.dsh\profiles\desktop`

---

## 1. 项目概述与目标

### 1.1 用户原始诉求（要点）

> 编写一个 DSH 插件，读取本机上的全部微信记录，把聊天内容整理成「类似神经元结构的动态 3D 视图」，内容精良丰富、可操作内容尽可能多；参考 GitHub 上高 Star 项目并融入；必须多维度、可操作；UI 要重点突出。

拆解为可验收的目标：

| 编号 | 目标 | 验收方式 |
| --- | --- | --- |
| G1 | 读取本机微信 4.x 数据（联系人、群聊、消息、时间、类型） | 有密钥时对真实库读出联系人 ≥ 100 条；无密钥时可回退演示数据集 |
| G2 | 神经元风格 3D 图谱（胞体/神经节/轴突/突触/脉冲） | 中央面板可渲染 ≥ 800 节点、≥ 1500 边且帧率 ≥ 30fps |
| G3 | 多维度建模（时间/人员/类型/关键词/频次） | 五个维度均可独立筛选、独立着色、独立布局 |
| G4 | 高密度可操作性（旋转、缩放、点击、播放、筛选、聚焦、导出…） | 第 8 章列出的 14 项交互全部可用 |
| G5 | 参照高 Star 项目并融入 | 第 3 章逐项映射，覆盖提取/图谱/3D 三个方向 |
| G6 | 合规：只读、不联网、可清除 | 无 `net`/`http` 出站代码路径（本机 127.0.0.1 API 除外） |

### 1.2 产品定位

插件不是「微信备份工具」，而是「本机社交关系的一次性可视化切片」。数据在用户自己的机器上完成 解密 → 建模 → 渲染 三步，中间产物只有 JSON 图数据和一个可一键删除的明文缓存目录。渲染层完全跑在宿主 Web UI 的 `<canvas>` 里，不引入任何第三方前端运行时依赖（原因见 3.3）。

### 1.3 非目标

- 不做消息发送、不做协议逆向、不做账号登录、不做云端同步。
- 不读他人设备、不读非当前登录账号、不读第三方备份。
- 不做历史消息的语义大模型摘要（v0.3 之后再评估，且必须离线）。

---

## 2. 合规与协议风险声明

### 2.1 授权范围（硬边界）

| 边界 | 具体约束 | 实现落点 |
| --- | --- | --- |
| 只读本机 | 只访问 `%APPDATA%\Tencent\xwechat\config\*.ini` 指向的数据根与用户显式指定的目录 | `lib/host/discover.js` |
| 只读本人账号 | 数据根下的 `wxid_*` 目录必须与当前登录账号一致，多账号并列时由用户在设置中显式选择 | `lib/host/accounts.js` |
| 不上传 | Host 侧无任何外部出站请求；唯一 HTTP 是 `127.0.0.1` 同源前缀 API | 全局 code review 检查项 |
| 导出显式触发 | 导出仅在用户点击按钮后写文件，且默认写入用户选择的路径 | `lib/host/export.js` |
| 缓存可控 | 明文缓存位于用户目录，设置面板提供「立即清除缓存」，删除后回落到演示数据集 | `lib/host/cache.js` |
| 不改原库 | 对微信原始 `.db` 永远以只读方式打开，解密结果写入独立缓存目录，绝不写回 | `lib/host/decrypt.js` |

### 2.2 无 LICENSE 项目的处理（协议风险）

实测通过 `api.github.com` 查询，以下三个仓库的 `/license` 端点返回 **404**，仓库内**没有 LICENSE 文件**：

- `LC044/WeChatMsg`（42339 stars）
- `xaoyaoo/PyWxDump`（9634 stars）
- `sjzar/chatlog`（9178 stars）

在著作权法默认规则下，「未声明协议」= **保留所有权利**，不构成任何形式的开源授权。因此本插件对这三个项目的立场是：

> **仅借鉴其公开描述的思路、数据格式与架构经验，不复制、不移植、不改编其源代码。**

具体执行纪律：

1. 不复制源码片段（包括 SQL 语句原文、解密函数、CLI 参数解析代码）。
2. 解密算法本身按 SQLCipher 公开规范独立实现（见第 5 章），不以任何单一仓库为蓝本逐行对照。
3. 数据库表名字段名属于事实性接口信息，可依据本机实测的 `sqlite_master` 自行枚举，不抄其三方常量表。
4. 若未来需要直接复用其代码，必须先取得作者书面许可并在此文档登记。
5. `PyWxDump` 仓库当前处于「已删库」状态，任何基于其历史快照的引用都不可作为稳定依赖。

MIT / ISC / Apache-2.0 项目（`3d-force-graph`、`three.js`、`G6`、`cytoscape.js`、`vis-network`、`force-graph`、`d3-force`）允许借鉴算法与设计，但仍以「重写实现」为准——因为插件包不能直接 `require` profile 里的第三方依赖（见 3.3），实际只有算法思想能落地。

### 2.3 密钥与隐私

- 微信 4.x 的 SQLCipher 密钥存在于**微信进程内存**中，插件无法凭空取得。
- 插件不实现任何内存扫描/注入/调试器附加能力，只接受用户以三种合法方式之一提供数据源（见 5.3）。
- 密钥仅保存在内存与宿主 `settings` 存储中，不写入日志、不写入导出文件、不在 UI 明文回显（显示为 `••••` + 后 4 位）。
- 明文缓存目录默认 `%LOCALAPPDATA%\wechat-neuron\cache\`，目录内含 `README.txt` 声明其来源与删除方式。

### 2.4 用户须知（UI 首次启动弹层）

首次进入面板时展示一次性说明：数据只在本机处理、不会上传、可随时清除缓存、导出文件包含敏感聊天内容请自行保管。用户确认后写入 `acknowledged: true`。

---

## 3. 参考项目与技术选型

### 3.1 实测数据（2026-11-10 抓取，原样记录）

| 仓库 | Stars | Forks | License | 语言/主分支 | 说明 |
| --- | --- | --- | --- | --- | --- |
| LC044/WeChatMsg | 42339 | 5423 | 无 LICENSE 文件（API /license 返回 404，即「未声明协议、保留所有权利」） | Python/master | 微信聊天记录导出为 HTML/CSV/TXT/Word，带 PyQt 图形界面，topics: chatgpt, llms, pyqt, wechat |
| xaoyaoo/PyWxDump | 9634 | 1764 | 无 LICENSE 文件（404） | Python/master | 微信取证：获取密钥、解密数据库、导出聊天记录；项目仓库当前已「删库」状态 |
| sjzar/chatlog | 9178 | 2979 | 无 LICENSE 文件（404） | Go/main | 本地聊天记录工具：自动获取密钥、解密 SQLite、提供 HTTP API 与 MCP/TUI 查询；topics: chat, chatlog, database, key, redteam, wechat |
| vasturiano/3d-force-graph | 6551 | 1034 | MIT | JavaScript | 基于 ThreeJS/WebGL 的 3D 力导向图组件 |
| mrdoob/three.js | 117975 | 36930 | MIT | JavaScript | WebGL 3D 渲染引擎 |
| antvis/G6 | 12384 | 1651 | MIT | TypeScript/v5 | 图分析与图可视化引擎（布局、交互、图算法 API） |
| cytoscape/cytoscape.js | 11277 | 1692 | MIT | JavaScript | 图论分析与可视化库 |
| visjs/vis-network | 3637 | 413 | Apache-2.0 | JavaScript | 网络图可视化 |
| vasturiano/force-graph | 2166 | — | MIT | JavaScript | 2D 力导向图 |
| d3/d3-force | 2013 | — | ISC | JavaScript | 力导向物理模拟 |
| littlecodersh/ItChat | 26457 | — | MIT | Python | 微信个人号接口（协议参考） |
| wechaty/wechaty | 23533 | — | Apache-2.0 | TypeScript | 聊天机器人 SDK（协议参考） |

### 3.2 融入映射（逐项）

#### 方向一：微信聊天记录提取（至少两个）

| 项目 | 借鉴内容 | 融入模块 | 具体落点 |
| --- | --- | --- | --- |
| LC044/WeChatMsg | ①「先导出为中间态再渲染」的两段式结构；②以会话（session）为索引导出、按 `talker` 聚合消息的组织方式；③HTML/CSV 导出字段取舍（时间、发送者、类型、内容） | 本地数据读取 + 导入导出 | `lib/host/read.js` 采用「session 表驱动、message 分库按 talker 归并」的读取顺序；`export.js` 的 CSV 列集合与其思路一致（**不复制其代码**） |
| xaoyaoo/PyWxDump | ①密钥→解密→离线库的三段式取证流程；②「先产出明文库再交给上层只读」的解耦；③对多账号目录并存的枚举经验 | 本地数据读取 | `lib/host/decrypt.js` 的「一次性解密到缓存、上层只读缓存」策略；`accounts.js` 的 `wxid_*` 枚举（**不复制其代码**） |
| sjzar/chatlog | ①自动发现数据根 + 自动探测加密参数的思路；②用 HTTP API 把本地库暴露给上层查询的形态；③MCP/TUI 之外的分页查询接口 | 本地数据读取（第三种适配器） | `lib/host/adapters/chatlog.js` 直接消费其本地 HTTP API（作为**可选外部进程**，不内嵌其代码）；分页与关键词查询沿用「游标 + limit」形态 |

#### 方向二：社交关系图谱分析

| 项目 | 借鉴内容 | 融入模块 | 具体落点 |
| --- | --- | --- | --- |
| antvis/G6 | ①图数据模型 `{nodes, edges}` 与 data-driven 布局；②内置布局族（force / radial / concentric / grid）的取舍（最终收敛为单一星系布局）；③交互状态机（hover/selected/active 三态） | 多维关系建模 + 交互控制 | `lib/graph/model.js` 的节点/边 schema；单一星系布局（旋臂相位 / 倾斜盘面）的几何定义；`client.js` 的三态选择器 |
| cytoscape/cytoscape.js | ①选择器语法化的筛选（按类型/属性过滤）；②图算法 API 的命名习惯（degree、neighborhood、shortestPath） | 建模 + 交互 | 筛选器 DSL 设计为 `type=person && score>=60`；`focus` 功能用邻域查询实现 |
| vis-network | ①「物理模拟可暂停/可调参」的运行时控制（单一星系布局下物理已移除，仅保留自转/脉冲开关）；②图例与筛选 UI 的最小集合 | 交互控制 | 左栏的自转/脉冲/发光开关；图例开关的交互范式 |

#### 方向三：3D 可视化交互

| 项目 | 借鉴内容 | 融入模块 | 具体落点 |
| --- | --- | --- | --- |
| vasturiano/3d-force-graph | ①相机轨道控制的交互手感；②节点发光 + 连线透明度的视觉配方；③按深度排序绘制 | 3D 渲染 + 交互 | 轨道旋转/缩放的手势映射；发光渲染；`draw()` 的深度排序（三力模型已随单一星系布局移除） |
| mrdoob/three.js | ①`Object3D` 矩阵栈 → 世界/屏幕坐标的变换次序；②深度排序与透明度处理 | 3D 渲染 | 手写 `project()`：世界坐标 → 旋转矩阵 → **正交**缩放（`zoom × fit`）→ 屏幕坐标；`z` 排序绘制 |
| d3/d3-force | ①`forceManyBody` 的 1/r² 斥力与强度衰减；②`forceLink` 的弹簧 + 目标长度；③velocity Verlet 积分与 `alpha` 冷却 | 3D 渲染（**已作废**） | 早期 `simulate()` 的积分步进参考；单一星系布局落地后力导向整体移除，改为缓动追随目标位（见 §7.2） |
| vasturiano/force-graph | ①2D 版本的节点命中测试与拖拽锁定；②大图降采样策略 | 交互 + 性能 | 点击命中用屏幕空间距离平方；拖拽时临时 `fx/fy/fz` 锁定 |

### 3.3 技术选型结论

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 3D 渲染 | **手写 Canvas 2D 正交投影** | 插件包不能直接 `require` profile 里的 `three`/`three-spritetext`，打包 WebGL 引擎会让 Bundle 体积与构建复杂度失控；本项目节点量级 ≤ 3000，2D 投影完全够用。透视除法已删除——倾斜盘面位图在透视下是投影变换，Canvas2D 的 `setTransform` 表达不了，会与节点永久错位 |
| 节点落位 | 单一星系布局 + 缓动追随目标位（不再有力导向物理） | 真星系的构图必须稳定可复现；斥力/弹簧会让旋臂结构每帧漂移，读不出螺旋 |
| 图数据 | 纯 JSON（`{meta, nodes, edges, timeline}`） | 便于导出、便于测试、无 schema 迁移负担 |
| Host 运行时 | Node v24.13.0 内置 `node:sqlite`（`DatabaseSync`/`StatementSync`）+ `node:crypto` | 零依赖；实测该 Node 版本两模块均可用 |
| 数据传输 | 同源 HTTP JSON（`webServer.register({kind:'prefix', path:'/wechat-neuron'})`） | 无需 IPC 协议、无需序列化框架、浏览器直接 `fetch` |
| 解密 | 自实现 SQLCipher 兼容解密（`node:crypto` AES-256-CBC） | 见第 5 章 |

---

## 4. 总体架构

### 4.1 ASCII 架构图

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                          DSH Web GUI (http://127.0.0.1:9338)                 │
│                                                                              │
│  ┌────────────────────────── Client 侧（浏览器） ──────────────────────────┐  │
│  │  sidebar.panellist ──► 侧边栏入口卡片 (id: wechat-neuron)              │  │
│  │  main (key: wechat-neuron) ──► 中央面板                                │  │
│  │      ┌────────────────────────────────────────────────────────────┐    │  │
│  │      │ 交互控制层  Toolbar / Legend / Timeline / Filter / Detail  │    │  │
│  │      ├────────────────────────────────────────────────────────────┤    │  │
│  │      │ 3D 神经元渲染层  Canvas2D · project() · depthSort · glow    │    │  │
│  │      ├────────────────────────────────────────────────────────────┤    │  │
│  │      │ 本地图存储  GraphStore (nodes/edges/index/selection)       │    │  │
│  │      └────────────────────────────────────────────────────────────┘    │  │
│  └───────────────────────────────┬────────────────────────────────────────┘  │
│                                  │ fetch('/wechat-neuron/api/*')             │
│  ┌───────────────────────────────▼────── Host 侧（Node 进程） ────────────┐  │
│  │  webServer.register({kind:'prefix', path:'/wechat-neuron'})            │  │
│  │      ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐    │  │
│  │      │ 路由 /api/*  │─►│ 数据源适配器 │─►│ 建模 ModelBuilder     │    │  │
│  │      └──────────────┘  └──────┬───────┘  └───────────┬───────────┘    │  │
│  │                               │                      │                │  │
│  │   ┌───────────────────────────▼──────┐   ┌───────────▼────────────┐   │  │
│  │   │ adapters/local.js   （解密链路） │   │ graph/model.js         │   │  │
│  │   │ adapters/chatlog.js （HTTP API） │   │ graph/score.js         │   │  │
│  │   │ adapters/import.js  （导入包）   │   │ graph/dimensions.js    │   │  │
│  │   │ adapters/demo.js    （演示集）   │   └────────────────────────┘   │  │
│  │   └───────────────────────────┬──────┘                                │  │
│  │                               │                                       │  │
│  │   ┌───────────────────────────▼──────────────────────────────────┐    │  │
│  │   │ discover → accounts → key → decrypt → cache → read (sqlite)  │    │  │
│  │   └──────────────────────────────────────────────────────────────┘    │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
        │ 只读                                           │ 只读
        ▼                                               ▼
  F:\WeChat\doc\xwechat_files\            %LOCALAPPDATA%\wechat-neuron\cache\
  wxid_<账号>_<实例>\db_storage\     （明文 .db，可一键清除）
```

### 4.2 模块职责表

| 模块 | 目录/文件 | 职责 | 输入 | 输出 |
| --- | --- | --- | --- | --- |
| 本地微信数据读取 | `lib/host/discover.js` `accounts.js` `key.js` `decrypt.js` `cache.js` `read.js` `adapters/*` | 发现数据根、枚举账号、取得密钥、解密、缓存、SQL 读取；四适配器统一接口 | 环境（APPDATA / 用户输入 / 本地 HTTP） | `RawDataset` |
| 多维关系建模 | `lib/graph/model.js` `score.js` `dimensions.js` `topics.js` | 实体抽取、边构建、五维特征、重要度评分、话题聚类 | `RawDataset` | `Graph`（nodes/edges/timeline） |
| 3D 神经元图谱渲染 | `client.js`（渲染段） `lib/client/render.js` `simulate.js` | 正交投影管线、深度排序、星系盘面两遍光栅化（弥漫星光 + 解析星点）、发光与脉冲 | `Graph` | Canvas 帧 |
| 交互控制 | `lib/client/interact.js` `toolbar.js` `timeline.js` `filter.js` `detail.js` | 手势、命中测试、选择、播放、筛选、关系边按需浮现、快捷键 | 用户事件 | 渲染参数 / 选中集 |
| 导入导出与设置 | `lib/host/export.js` `import.js` `settings.js` | JSON/CSV/GraphML 导出、bundle 导入、设置持久化 | `Graph` / 用户配置 | 文件 / `settings.json` |

### 4.3 进程边界

| 侧 | 运行环境 | 能做 | 不能做 |
| --- | --- | --- | --- |
| Host | DSH 主进程内的 Cordis 插件（Node v24.13.0） | 读文件、`node:sqlite`、`node:crypto`、注册 HTTP 前缀、注册 slot | 访问 DOM、访问浏览器存储 |
| Client | 宿主 Web GUI 的浏览器上下文 | Canvas 绘制、`fetch` 同源 API、DOM 交互 | 读文件、解密、访问 SQLite |

硬规则：**解密与 SQL 只在 Host 侧发生**。Client 只接收已脱敏的 JSON 图数据；`talker` 原始 wxid 由 Host 映射为稳定短 id（`p_0001`），映射表留在 Host 内存。

### 4.4 数据契约总览（详见第 10 章）

```
GET  /wechat-neuron/api/status          → {source, account, counts, cache, warnings}
GET  /wechat-neuron/api/graph?dim=...   → {meta, nodes, edges, timeline}
GET  /wechat-neuron/api/node/:id        → {node, samples, stats, topKeywords}
POST /wechat-neuron/api/source          → {ok, source}
POST /wechat-neuron/api/key             → {ok, verified}
POST /wechat-neuron/api/cache/clear     → {ok, freed}
POST /wechat-neuron/api/export          → {ok, path}
POST /wechat-neuron/api/import          → {ok, counts}
GET  /wechat-neuron/api/settings        → {...}
POST /wechat-neuron/api/settings        → {...}
```

---

## 5. 本地微信数据读取模块

### 5.1 本机实测环境（2026-11-10）

| 项 | 实测值 |
| --- | --- |
| 微信版本 | 4.x |
| 数据根目录 | `F:\WeChat\doc\xwechat_files\wxid_<账号>_<实例>` |
| 配置发现 | `%APPDATA%\Tencent\xwechat\config\*.ini`，内含明文数据根路径（实测内容 `F:\WeChat\doc`） |
| Node | v24.13.0，`node:sqlite` 可用（`DatabaseSync`/`StatementSync`），`node:crypto` 可用 |
| 加密状态 | **全部 22 个 `.db` 均为 SQLCipher 加密**；文件头不是 `SQLite format 3`；`node:sqlite` 打开报 `file is not a database` |

`db_storage` 下 22 个库：

| 库文件 | 大小 | 用途（本插件是否读取） |
| --- | --- | --- |
| `message/message_0.db` | 49.8 MB | 消息主体，**读** |
| `message/message_1.db` | 36.5 MB | 消息分库，**读** |
| `biz_message_0.db` | — | 公众号消息，v0.2 读（计入 type=system） |
| `message_fts.db` | — | 全文索引，可选（关键词加速） |
| `media_0.db` / `media_1.db` | — | 媒体元数据，v0.3 |
| `message_resource.db` | — | 资源引用，不读 |
| `contact/contact.db` | 6.0 MB | 联系人，**读** |
| `contact_fts.db` | — | 联系人索引，不读 |
| `session/session.db` | 241 KB | 会话列表，**读**（首屏加速） |
| `sns.db` | 20 MB | 朋友圈，v0.3（可作为「亲密强度」辅证） |
| `favorite.db` | — | 收藏，不读 |
| `hardlink.db` | — | 硬链接索引，不读 |
| `head_image.db` | 17.8 MB | 头像缓存，v0.2（节点贴图） |
| `emoticon.db` | — | 表情，不读 |
| `general.db` | — | 杂项，不读 |
| `solitaire.db` | — | 接龙，不读 |
| `bizchat.db` | — | 企业微信会话，v0.2 |
| `chatbot_message.db` | — | 机器人消息，不读 |
| `third_app_icon.db` | — | 三方图标，不读 |
| `weclaw.db` | — | 内部库，不读 |

### 5.2 数据根发现 → 账号枚举

```
discover():
  1. 读 %APPDATA%\Tencent\xwechat\config\*.ini
     → 逐行匹配 root/dataRoot/dbPath 等键，取到 F:\WeChat\doc
  2. 兼容旧版：%USERPROFILE%\Documents\WeChat Files\（v3 布局）
  3. 用户手动指定目录（设置项 dataRoot，优先级最高）
  4. 候选根下扫 xwechat_files\wxid_*\ 与 wxid_*\(v3)
accounts():
  → 每个 wxid_* 目录读 db_storage 的存在性与总大小
  → 若仅一个账号则自动选中；多个则要求用户在设置中选择
  → 记录 db 清单与 mtime（用于缓存失效判定）
```

### 5.3 密钥获取：三条途径（不实现内存扫描）

密钥来自微信进程内存，插件**不做**任何注入/扫描，只提供三个合法入口：

| 途径 | 形态 | 适用 | 风险 |
| --- | --- | --- | --- |
| A. 用户粘贴密钥 | 设置面板输入 64 位 hex（32 字节 raw key）或 32 位 hex（16 字节，derive 模式） | 用户已从自身可信渠道获得 | 无 |
| B. 外部工具产出 | 用户自行运行第三方工具（如 chatlog 的本地服务），插件只消费其输出 | 用户已具备环境 | 由用户自行评估第三方 |
| C. 本地 HTTP 服务 | 设置 `chatlogApi=http://127.0.0.1:PORT`，插件走 chatlog 适配器直接取**明文 JSON**，完全不解密 | 最省事 | 需用户自行启动该进程 |

密钥校验：解密第一页后检查 `"SQLite format 3\0"` 魔数；不匹配则判定密钥错误或库非 SQLCipher。

### 5.4 SQLCipher 解密算法细节

微信 4.x 使用 SQLCipher 4 默认参数族。核心参数：

| 参数 | 值 | 说明 |
| --- | --- | --- |
| `pageSize` | 4096 | 页大小；首 16 字节为 salt（不参与后续页加密） |
| `salt` | 页 0 的 byte[0..16) | 用于 PBKDF2 派生 key 与 HMAC key（derive 模式） |
| 加密算法 | AES-256-CBC | 每页独立加密 |
| `IV` | 每页 16 字节，位于**保留区**（页末 HMAC 之前的 16 字节） | 从密文页中提取 |
| `HMAC` | SHA-512，截断到 64 字节，位于页尾 | 完整性校验 + 可选 HMAC key |
| 密钥模式 | raw key（32 字节）或 passphrase（PBKDF2-HMAC-SHA512，256000 轮，16 字节 salt） | 实测微信 4.x 为 raw key |
| KDF 迭代 | 256000（SQLCipher 4 默认） | 仅 passphrase 模式用到 |

单页解密流程：

```
decryptPage(pageBytes, key32, pageIndex, hmacKey?):
  if pageIndex == 0:
     salt = pageBytes[0..16)
     cipher = pageBytes[16 .. pageSize - reserve)
  else:
     iv     = pageBytes[pageSize - reserve .. pageSize - reserve + 16)   # reserve = 16 + hmacLen
     cipher = pageBytes[0 .. pageSize - reserve)
  plain = AES-256-CBC-Decrypt(key32, iv, cipher)
  if hmacKey: verify HMAC-SHA512(hmacKey, pageBytes[0..pageSize-hmacLen)) == pageBytes[tail]
  return plain
```

组装明文库：

```
decryptDatabase(srcPath, dstPath, key32):
  header = read 16 bytes → salt
  pages  = fileSize / 4096
  out.write("SQLite format 3\0")
  for i in 0..pages:
     src.read page i
     plain = decryptPage(...)
     if i == 0: plain = plain[16..]           # 去掉 salt 占位，保留原 header 剩余 4080 字节
     out.write(plain)
  # 第 0 页解密后前 16 字节是 SQLite header 的一部分（含 pageSize），需与标准 header 对齐
  out.fsync()

优化：只处理 payload 页（微信库存在大量 freelist，可跳过 page type 0x00 之外的空白页）——
      首版不做该优化，先保证正确性；49.8MB 库实测一次性解密耗时为秒级（v0.1 实测后回填）。
```

**加密参数自动探测策略**（`lib/host/detect.js`）：

1. 读文件头 16 字节，若等于 `SQLite format 3\0` → 明文库，跳过解密。
2. 否则按候选参数表依次尝试解密 page 0：`{KDF 迭代: 256000/64000/4000} × {HMAC: sha512/sha1} × {pageSize: 4096/1024}`，用「解密后 header 是否为 `SQLite format 3\0` 且 pageSize 自洽」作为唯一判据。
3. 首个通过者胜出，参数组合记入 `cache/manifest.json`，后续库直接复用。

### 5.5 明文缓存与清理

| 项 | 值 |
| --- | --- |
| 缓存目录 | `%LOCALAPPDATA%\wechat-neuron\cache\<accountHash>\` |
| 内容 | 解密后的 `contact.db`、`session.db`、`message_0.db`、`message_1.db` + `manifest.json` |
| 失效条件 | 源库 `mtime` 或 `size` 变化 → 重新解密该库 |
| 清理 | 设置面板「立即清除缓存」→ 递归删除目录 → 回落到当前数据源或演示集 |
| 用户可见 | 侧边栏小字显示缓存占用大小 |

### 5.6 四类数据源适配器（统一接口）

```js
// 所有适配器实现同一契约
interface DataSourceAdapter {
  id: 'local' | 'chatlog' | 'import' | 'demo'
  probe(): Promise<{available: boolean, reason?: string}>
  listContacts(): Promise<Contact[]>
  listSessions(): Promise<Session[]>
  listMessages(cursor, opts): AsyncIterable<Message[]>   // 游标分页
  capabilities: {realtime, media, sns}
}
```

#### (1) local 适配器（解密链路）

`discover → accounts → key → decrypt → cache → read`，用 `node:sqlite` 的 `DatabaseSync` 以 `readOnly: true` 打开缓存库。表结构通过 `sqlite_master` 运行时枚举，不硬编码列名（微信 4.x 的 message 表存在 `real_sender_id`、`create_time`、`local_type` 等列，实际列集以枚举结果为准，缺列时降级为 `NULL` 并记录 warning）。

#### (2) chatlog 适配器（本地 HTTP）

```
GET http://127.0.0.1:<port>/api/v1/chatroom      → 群列表
GET http://127.0.0.1:<port>/api/v1/contact       → 联系人
GET http://127.0.0.1:<port>/api/v1/messages?talker=...&limit=...
```

只消费 JSON，不解密、不读库；失败时给出「请先启动本地服务」的可操作提示。

#### (3) import 适配器（文件导入）

支持本插件自身导出的 `bundle.json`、以及通用 `{contacts, messages}` JSON/CSV（列名映射在设置中可配）。

#### (4) demo 适配器（演示数据集）

内置 1 个 self + 24 个 person + 5 个群 + 12 个话题，约 1800 条合成消息，覆盖全部消息类型与时间跨度（近 3 年）。用于：无密钥环境的首次体验、UI 回归测试、性能基准。演示集在 UI 顶部有明确 `DEMO` 徽标，不可与真实数据混淆。

### 5.7 读取策略与产物

```
RawDataset = {
  self: {wxid, nickname},
  contacts: [{wxid, nickname, remark, type, avatarHash}],
  sessions: [{talker, lastTime, unread}],
  messages: [{talker, sender, time, type, text, keywords}],
  stats: {totalMessages, timeRange}
}
```

采样上限：默认最多读取近 **180 天**、每会话 **2000** 条、全局 **200,000** 条，可在设置中调整（防大库卡死）。首屏只取 `session.db` + `contact.db`，图数据按需二次拉取。

---

## 6. 多维关系建模模块

### 6.1 实体（节点）

| 类型 | id 前缀 | 视觉隐喻 | 关键字段 |
| --- | --- | --- | --- |
| `self` | `s` | 中央胞体（最大、常亮） | nickname, totalMessages |
| `person` | `p` | 胞体（大小 ∝ 重要度） | nickname, score, tier, msgCount, lastTime |
| `group` | `g` | 神经节（环形胞体簇） | name, memberCount, msgCount |
| `topic` | `t` | 突触簇（小、成簇分布） | label, weight, msgCount |

### 6.2 边（连接）

| 类型 | 端点 | 权重定义 | 视觉 |
| --- | --- | --- | --- |
| `chat` | self ↔ person | 双向消息总量（对数压缩） | 轴突（发光曲线） |
| `group-member` | group ↔ person | 该成员在群内发言量 | 细轴突 |
| `co-occurrence` | person ↔ person | 同群 + 同话题共现强度（Jaccard 加权） | 半透明虚线 |
| `topic` | person/group ↔ topic | 该实体在该话题下的消息占比 | 短突触 |

### 6.3 五维特征表

| 维度 | 特征名 | 定义 | 归一化 |
| --- | --- | --- | --- |
| 时间 | `recency` | 最近一次互动距今的天数 `d` | `exp(-d / 30)` |
| 时间 | `span` | 首次至末次互动的持续天数 | `min(1, span/365)` |
| 人员 | `reciprocity` | 对方发我的 / 我发对方的 比值平衡度 | `1 - |a-b| / max(a,b)` |
| 人员 | `initiation` | 由对方发起的会话占比 | `initiatedByThem / sessions` |
| 消息类型 | `depth` | 非短文本消息占比（语音/图片/文件/长文/引用） | `weightedCount / total` |
| 关键词/话题 | `intimacy` | 亲密词表命中密度 + 话题私密度 | `min(1, hits / 50)` 加权 |
| 互动频次 | `frequency` | 近 90 天日均消息数 | `min(1, log10(1+x) / log10(1+50))` |

话题维度单独产出 `topicProfile`：`{topic: weight}`，用于着色与「突触簇」聚合；关键词抽取用「中文停用词表 + bigram 频次 + TF-IDF（跨会话）」的纯本地实现，不引入分词依赖（按标点/空白切分 + 2-gram 滑窗）。

### 6.4 重要度评分模型

```
score = 100 × (0.30·recency
             + 0.22·frequency
             + 0.16·reciprocity
             + 0.12·initiation
             + 0.10·depth
             + 0.10·intimacy)
```

| 权重 | 项 | 定义 | 衰减/映射函数 |
| --- | --- | --- | --- |
| 0.30 | `recency` | 最近互动新鲜度 | `exp(-daysSinceLast / 30)`，30 天半衰期约 0.5 |
| 0.22 | `frequency` | 近 90 天互动频次 | `min(1, log10(1+msgPerDay) / log10(51))` |
| 0.16 | `reciprocity` | 互动对称性 | `1 - |sent-recv| / max(sent, recv, 1)` |
| 0.12 | `initiation` | 对方主动度 | `sessionsStartedByThem / max(1, sessionsTotal)` |
| 0.10 | `depth` | 内容深度 | `Σ typeWeight / Σ messages`，typeWeight：文本 0.2、图片 0.6、语音 0.8、文件 0.9、引用/长文 1.0 |
| 0.10 | `intimacy` | 亲密词与私密话题密度 | `min(1, intimateHits/50) × 0.7 + privateTopicRatio × 0.3` |

补充规则：

- 全体 `person` 的六个特征先做 **min-max 归一化**（跨人群），再做加权；`self` 不参与评分。
- 群聊计入 `frequency` 时按 `0.5` 折算权重（群消息噪声大）。
- 冷启动（消息 < 5 条）时 `score` 取 `min(计算值, 12)`，避免偶然一条消息把陌生人顶到高分。
- 分数每 24h 或数据源变更时重算；UI 显示一位小数。

### 6.5 分档

| 档位 | 分数区间 | 视觉 | 默认可见 |
| --- | --- | --- | --- |
| 核心 | 75–100 | 最大胞体 + 持续脉冲 + 金边 | 是 |
| 挚友 | 60–75 | 大胞体 + 常亮 | 是 |
| 常联系 | 40–60 | 中胞体 | 是 |
| 弱连接 | 20–40 | 小胞体、低亮度 | 是（可筛掉） |
| 沉默 | 0–20 | 极暗小点 | 默认隐藏 |

---

## 7. 3D 神经元图谱渲染模块

### 7.1 自研 Canvas 2D 正交投影管线

不引入 three.js / d3，全部手写。每帧流程：

```
每个节点 (x,y,z)
  ① 旋转：先绕 Y 轴 yaw，再绕 X 轴 pitch
       x1 = x·cosY - z·sinY ;  z1 = x·sinY + z·cosY
       y2 = y·cosP - z1·sinP ; z2 = y·sinP + z1·cosP
  ② 正交缩放：scale = zoom × fit        // 无透视除法，深度只用于排序与明暗
       sx = W/2 + panX + x1·scale ; sy = H/2 + panY + y2·scale
  ③ 深度排序：按 z2 降序（远的先画）
  ④ 绘制：深空背景 → 核球柔光 → 盘面位图（lighter，一次 drawImage）
          → 关系边（仅高亮时 + 12 条常显极淡线）→ 节点光晕 → 节点实心 → 脉冲 → 标签
```

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `zoom` | 1.3 | 滚轮缩放，范围 0.32–3.6；调校面板「视距缩放」同源 |
| `fit` | `computeFit()` 自动 | 让盘面恰好装进视口的归一化系数 |
| `yaw/pitch` | 0.62 / -41° | 初始视角；pitch 由调校面板「盘面倾角」写入 |
| `GALAXY.TAN_I` | `tan(16°)` | 旋臂缠绕角（pitch angle），由 `GALAXY.PITCH_DEG` 派生 |
| `GALAXY.ARM_SIGMA` | 0.115 | 旋臂**角宽**（弧度），恒定角宽 + 轻微径向渐扩 |
| `NEBULA_STEP` | 2 | Pass 1 弥漫星光的采样步长 |
| `GALAXY.NEBULA` / `DUST` | 1 / 1 | 弥漫星光强度 / 尘埃暗带强度（调校旋钮） |
| `glow` | 4.2 | 光晕半径倍数（过大会盖住旋臂） |
| `labelDensity` | 0.34 | 标签按重要度分位取样，0 = 只留「我」 |
| 标签可见性 | `labelShouldShow` | 强制显示：自己 / **悬停** / 选中 / 聚焦；其余按「未被 dim 压过」的亮度（`labelAlpha = alpha × depth.a`，在 `dimmed × 0.55` 之前取值）判定 `> 0.3` 且分位命中且半径 `> 2.2`。**不要在 dim 之后再判亮度** —— 鼠标一进画布 `highlight` 变非空，全盘标签会同时跌破阈值集体消失（这就是「鼠标移过去名字全没了、选不到人」的成因） |
| `pulseHz` | 0.8–2.0 | 脉冲频率随 score 提升（只在被点亮的边上走） |

盘面位图（`renderDiskBitmap`，离屏缓存，每帧只贴一次）：

- **Pass 1 弥漫星光**：低频密度场，管旋臂结构；**不按半径加权亮度**（三种指数加权都让核心炸白吃掉盘面结构，核心亮度本就由密度自然叠出）。
- **Pass 2 解析星点**：加性混合的 2–3px 星点，管细节。裸画 2 万颗星点屏幕覆盖 <5%，是「散沙」，必须靠 Pass 1 打底。
- 贴图矩阵与 `project()` 严格同源：先 `setTransform(dpr,0,0,dpr,0,0)` 恢复 DPR 基准，再 `transform(cosY·s, -sinY·sinP·s, -sinY·s, -cosY·sinP·s, cx+panX, cy+panY)`；中心恒为 `h/2`，退回旧的 `h*0.48` 会让盘面相对节点下沉 0.02h。
- 无 canvas 环境下 `gradient`/`sprite` 返回 null，`renderDiskBitmap` 返回 null，`draw()` 跳过盘面（只画背景 + 核球占位）。

视觉配方（借鉴 3d-force-graph 的发光 + 连线透明度思路，重写实现）：

- 节点：`ctx.createRadialGradient` 三层（核心白 → 主色 → 透明），alpha 随 `depthFactor` 与 `tier` 变化。
- 连线：**默认全隐**（真星系没有连线）；`edgesToDraw(visibleEdges, highlight, 12)` 只在悬停/选中/聚焦时浮现一跳邻居（alpha `0.30 + weight×0.25`），外加权重最高的 12 条常显极淡线（alpha 0.10）提示这张图有关系。二次贝塞尔轻微弯曲。
- 脉冲：沿边 `t = (now·speed + seed) % 1` 取贝塞尔点画小圆点，形成「信号传导」。
- 背景：低频径向暗角 + 极淡星点，突出中央神经元团。

### 7.2 节点落位：缓动追随星系目标位

力导向物理已随单一星系布局移除。`layoutGalaxyTargets()` 为每个节点算出唯一的星系目标位（半径 ∝ 重要度、角度 = 旋臂相位 + 抖动），`simulate()` 只做缓动追随：

```
if (targets === null) return                 // 无目标位则不动
blend = max(0, blend - 0.022)                // 换图时的过渡混合系数
ease  = blend > 0 ? 0.09 : 0.06
p_i  += (target_i - p_i) · ease              // 三轴各自线性缓动
```

理由：真星系的构图必须稳定可复现。斥力/弹簧会让旋臂结构每帧漂移，缩略图下读不出螺旋；缓动追随既保证换图/筛选时有动画，又保证静止时构图不动。`project()` 已不再返回 `p.scale`（正交投影下无逐点缩放），任何新代码引用它会得到 undefined。

### 7.3 神经元隐喻映射

| 生物结构 | 图中对象 | 视觉手段 |
| --- | --- | --- |
| 胞体（soma） | person（含 self） | 径向发光圆，半径 ∝ `score`，`self` 最大且位于中心 |
| 神经节（ganglion） | group | 环形簇：中心小核 + 成员卫星点 |
| 突触簇（synapse cluster） | topic | 多个极小点围绕一个隐形中心，按 TF-IDF 权重分布 |
| 轴突（axon） | `chat` / `group-member` 边 | 发光曲线，粗细 ∝ 权重；**默认隐藏**，悬停/选中才浮现 |
| 树突（dendrite） | `co-occurrence` 边 | 半透明虚线，短程；同样按需浮现 |
| 信号脉冲 | 时间维度的「当前播放时刻」消息 | 沿边运动的小亮点，频率 ∝ 近期活跃度 |
| 髓鞘（myelin） | 高重要度连线 | 额外一层柔和外发光 |
| 突触间隙 | 边中段的空心断点 | 用于表现「关系强度中等」 |

### 7.4 性能预算与降采样

| 指标 | 预算 | 手段 |
| --- | --- | --- |
| 节点数 | ≤ 3000 绘制 | 超限时按 `score` 降采样，其余折叠为「+N」聚合节点 |
| 边数 | ≤ 6000 绘制 | 只画每个节点的 top-K 边（默认 K=8） |
| 帧率 | ≥ 30fps @ 1920×1080 | 盘面位图离屏缓存，每帧只一次 `drawImage`；关系边默认不绘制；无高亮时降为 15fps |
| 每帧绘制调用 | ≤ 9000 次 | 批量 `beginPath`；光晕用离屏 canvas 缓存为精灵图 |
| 首次渲染 | ≤ 800ms | 先画骨架（无光晕）再补发光 |
| 内存 | ≤ 200MB | 节点数据用 TypedArray（`Float32Array` 存 xyz/颜色索引） |

其它策略：`devicePixelRatio` 上限 2；离屏精灵图按 tier 预渲染 5 档；`requestAnimationFrame` 中按 `dt` 截断（> 50ms 视为切后台）；视口外节点（投影不可见）跳过绘制。

---

## 8. 交互控制模块

| # | 交互 | 实现 | 细节 |
| --- | --- | --- | --- |
| 1 | 旋转 | 左键拖拽改 `yaw/pitch` | 每像素 0.005 rad，pitch 钳制 ±1.4 |
| 2 | 缩放 | 滚轮 / 双指捏合 | `zoom` 0.25–4.0，指数步进，围绕光标 |
| 3 | 平移 | 右键拖拽 / 中键拖拽 | 改相机中心 `(cx,cy)`，与旋转解耦 |
| 4 | 节点点击详情 | 屏幕空间命中测试（距离² < r²） | 右侧抽屉：昵称、分档、六维雷达、消息统计、Top 关键词、最近 5 条样例（脱敏） |
| 5 | 拖拽节点 | 拖拽时设 `fx/fy/fz` 锁定，松手释放 | 拖拽期间该节点不追随星系目标位，松手后缓动归位 |
| 6 | 时间轴播放 | 底部时间轴，按天/周分桶 | 播放速度 0.5×/1×/2×/4×；进度决定哪些消息参与脉冲与亮度 |
| 7 | 关系高亮 | 选中节点 → 邻域高亮，非邻居 alpha × 0.15 | 支持 1 跳/2 跳切换 |
| 8 | 筛选器 | DSL + 表单双模式 | 类型（人/群/话题）、时间范围、重要度阈值、关键词、分档；左栏分层为**逐档独立集合**（`tierVisible`），不是互斥阈值 |
| 9 | 关系边按需浮现 | 默认全隐；悬停/选中节点时浮现其一阶关系边 | 真星系没有连线，但图谱价值在边 |
| 10 | 一键聚焦 | 双击节点或 `F` 键 → 相机缓动到该节点 | 250ms ease-out；聚焦后隐藏非邻域 |
| 11 | 图例开关 | 右上角胶囊面板 | 可折叠；点击图例项即等于一类筛选 |
| 12 | 全屏 | 面板右上角按钮 | 仅中央面板区域全屏（CSS `position: fixed`） |
| 13 | 键盘快捷键 | `Space` 播放/暂停、`R` 重置视角、`F` 聚焦、`Esc` 取消选择 | 面板聚焦时才生效，避免劫持宿主快捷键 |
| 14 | 搜索定位 | 顶部搜索框，模糊匹配昵称/话题 | 命中即高亮并列表展示，回车聚焦首个 |

星系布局定义（唯一布局，代码中不存在布局选择器）：

| 要素 | 几何 | 说明 |
| --- | --- | --- |
| 倾斜盘面 | 相机俯角 41°（`view.tiltDeg`）的正交投影圆盘 | 与旋臂缠绕角是两个独立参数，别混 |
| 对数旋臂 | 缠绕角 `GALAXY.PITCH_DEG = 16°`（`TAN_I = tan(16π/180)`），r=0.12→1.25 约 1.3 圈 | 13° 曾像毛球、20° 只有 1.02 圈偏散；16° 配合恒定角宽才读出臂 |
| 恒定角宽 | `armSigma(r) = ARM_SIGMA × (0.72 + 0.28·r/R)` | **关键修复**：旧式 `0.11/r` 在 r=0.2 处角宽 31°，四臂在质量最集中的内盘完全重叠 → 絮状星云 |
| 起臂半径 | `ARM_INNER = 0.22`，核球内星点归入平滑核球 | 「亮核 + 核外起臂」的经典结构 |
| 两遍光栅化 | Pass 1 低频弥漫星光（不按半径加权亮度）+ Pass 2 加性星点 | 2.6 万颗 2–3px 星点裸画是散沙，屏幕覆盖 <5% |
| 尘埃暗带 | 沿主臂内缘 `destination-out` 擦 4 条低 alpha 暗带 | 把「一坨发光斑块」变成「有结构的盘」，不可省 |
| 核球 | 中心柔光色温跟随恒星色族（`STAR_PALETTES[*].core`） | 指数加权会让核心炸白吃掉盘面结构 |

视觉验收唯一判据：**缩略图尺寸下一眼认出是螺旋星系**（见 `docs/superpowers/specs/2026-11-12-galaxy-single-layout-design.md` §6.1）。

调校不再是「改代码里的三个常量」：左栏常驻**星系调校**控制区（`GalaxyTuning`），11 个实时旋钮 + 4 套恒星色族 + 复位/随机/存默认。旋钮表 `TUNING` 是唯一真源，面板、随机、复位、导出都从它派生：

| 层 | 旋钮 | 生效方式 |
| --- | --- | --- |
| disk（重建位图） | 旋臂缠绕 / 旋臂宽度 / 旋臂纯度 / 恒星数量 / 弥漫星光 / 尘埃暗带 | 写 `GALAXY` → `rebuildGalaxy()`，idle 合并重建（拖动多次只重建最后一次） |
| view（零重建） | 盘面倾角 / 视距缩放 / 自转速度 / 节点光晕 / 标签密度 | 写相机与节点层，每帧读 |

「随机」只在 `RANDOM_RANGES` 的安全带里抖（缠绕 11–24°、臂宽 0.07–0.16 等），保证一键随机也读得出螺旋；「存默认」写 `localStorage['wechat-neuron.tuning.v1']`，脏数据/越界值一律夹回或退回出厂值。

三个动作的语义边界（评审后收紧）：

| 动作 | 语义 | 可逆性 |
| --- | --- | --- |
| 复位 | 回出厂值 **并** `clearSavedTuning()` 清掉本机默认 | 无需撤销（出厂值随时可再取） |
| 随机 | 在安全带内取一套新值 | toast 带「撤销」按钮，6s 内一键回到随机前的那套值 |
| 存默认 | 把当前值写进本机默认 | 用「复位」清除 |

调校区排在业务卡（分层 / 显示 / 榜单）**之后**：窄栏首屏留给业务信息，工具墙不喧宾夺主。可达性基线：滑块命中区 24px（WCAG 2.2 SC 2.5.8）、焦点环 2px accent、hint 小字 ≥4.5:1、未填充轨道 ≥3:1、`aria-valuetext` 念百分比而非原始小数、`prefers-reduced-motion` 在 CSS 层兜底。滚动条自绘（`scrollbar-color` + `::-webkit-scrollbar`），色值取自深空色板，不用系统灰条。

---

## 9. 导入导出与设置模块

### 9.1 导出

| 格式 | 内容 | 用途 |
| --- | --- | --- |
| `bundle.json` | 完整 `{meta, nodes, edges, timeline, settingsSnapshot}`（不含原始消息正文，只含统计与样例） | 换机复现、分享视图 |
| `nodes.csv` / `edges.csv` | 扁平化表格（UTF-8 BOM，Excel 友好） | 数据分析 |
| `graph.graphml` | 节点/边属性映射为 `<data key>`，便于 Gephi/yEd 打开 | 学术与二次分析 |
| `summary.md` | 人类可读摘要：Top 20 关系、分档分布、话题榜 | 归档 |

导出前二次确认：提示文件含敏感社交信息；提供「脱敏模式」（昵称替换为 `联系人 01`、去掉样例文本）。

### 9.2 导入

`POST /api/import` 接受 `bundle.json`，校验 `meta.schemaVersion` 后直接进入渲染（跳过建模）；schema 不兼容时给出明确错误码。

### 9.3 设置项

| 分组 | 项 | 默认 |
| --- | --- | --- |
| 数据源 | `source` = local / chatlog / import / demo | demo |
| 数据源 | `dataRoot`（覆盖自动发现） | 空 |
| 数据源 | `account`（多账号选择） | 自动 |
| 数据源 | `chatlogApi` | `http://127.0.0.1:5030` |
| 密钥 | `keyMode` = raw / derive | raw |
| 密钥 | `key`（写入时掩码显示） | 空 |
| 缓存 | `cacheDir` | `%LOCALAPPDATA%\wechat-neuron\cache` |
| 读取 | `days` / `perTalkerLimit` / `globalLimit` | 180 / 2000 / 200000 |
| 渲染 | `quality` = low / medium / high | high |
| 渲染 | `animations`（脉冲/光晕） | true |
| 渲染 | `maxNodes` | 3000 |
| 隐私 | `mask`（昵称脱敏） | false |
| 隐私 | `blurSamples`（样例文本打码） | true |
| 其他 | `acknowledged`（首次合规提示） | false |

### 9.4 持久化位置

- Host 侧：插件 `settings`（Cordis 配置），落盘在 profile 的插件配置中；密钥字段单独打标 `secret: true`，读取时不回传明文。
- Client 侧：仅缓存 UI 偏好（上次布局、图例状态、面板宽度）于 `localStorage['wechat-neuron.ui']`。
- 明文缓存与图数据**不**进入 `localStorage`（体积与隐私双重考虑）。

---

## 10. 数据契约

### 10.1 Graph

```json
{
  "meta": {
    "schemaVersion": 1,
    "generatedAt": "2026-11-10T03:20:00.000Z",
    "source": "demo",
    "account": "p_self",
    "counts": { "nodes": 42, "edges": 137, "messages": 1800 },
    "timeRange": ["2023-11-01", "2026-11-09"],
    "warnings": []
  },
  "nodes": [
    {
      "id": "p_0007",
      "type": "person",
      "label": "示例联系人",
      "score": 68.4,
      "tier": "friend",
      "metrics": {
        "recency": 0.91, "frequency": 0.62, "reciprocity": 0.78,
        "initiation": 0.44, "depth": 0.35, "intimacy": 0.52
      },
      "stats": { "msgCount": 1284, "sent": 690, "recv": 594, "lastTime": "2026-11-08" },
      "topics": [{ "id": "t_03", "label": "项目协作", "weight": 0.41 }],
      "pos": [112.4, -38.2, 240.9]
    }
  ],
  "edges": [
    {
      "id": "e_0012", "source": "s", "target": "p_0007", "type": "chat", "weight": 1284, "directed": true,
      "series":     [0, 3, 0, 12, 7, 0, 0, 21],
      "sentSeries": [0, 1, 0,  5, 6, 0, 0,  9],
      "recvSeries": [0, 2, 0,  7, 1, 0, 0, 12]
    }
  ],
  "timeline": {
    "bucket": "week",
    "buckets": [
      { "t": "2026-W44", "messages": 96, "activeNodes": 19, "top": ["p_0007", "g_02"] }
    ]
  }
}
```

### 10.2 节点详情

```json
{
  "node": { "id": "p_0007", "label": "示例联系人", "score": 68.4, "tier": "friend" },
  "metrics": { "recency": 0.91, "frequency": 0.62, "reciprocity": 0.78,
               "initiation": 0.44, "depth": 0.35, "intimacy": 0.52 },
  "distribution": { "text": 0.71, "image": 0.14, "voice": 0.08, "file": 0.05, "other": 0.02 },
  "topKeywords": [{ "w": "需求", "n": 88 }, { "w": "评审", "n": 51 }],
  "relation": {
    "edgeId": "e_0012",
    "series": [0, 3, 0, 12, 7, 0, 0, 21], "sentSeries": [0, 1, 0, 5, 6, 0, 0, 9], "recvSeries": [0, 2, 0, 7, 1, 0, 0, 12],
    "buckets": ["2026-W37", "2026-W38", "2026-W39", "2026-W40", "2026-W41", "2026-W42", "2026-W43", "2026-W44"]
  },
  "samples": [
    { "time": "2026-11-08T14:02:00+08:00", "from": "them", "type": "text", "text": "● ● ● ●" }
  ]
}
```

### 10.3 状态与错误

```json
{
  "source": "local",
  "account": { "id": "p_self", "label": "wxid_***822" },
  "cache": { "dir": "…", "sizeBytes": 91357184, "stale": false },
  "warnings": [
    { "code": "KEY_MISSING", "level": "error", "message": "未配置密钥，已回退演示数据集" }
  ]
}
```

错误码表：`KEY_MISSING` / `KEY_INVALID` / `DB_NOT_SQLCIPHER` / `DB_LOCKED` / `SCHEMA_MISMATCH` / `ADAPTER_UNAVAILABLE` / `LIMIT_EXCEEDED`。

---

## 11. 目录结构与文件清单

> 下面是 v0.1 设计期的蓝图。实际落地时 Host 侧合并为 `lib/host/{discover,extract,crypto,cipherkey,keyharvest,model,demo,settings}.js`，Client 侧全部内联在单文件 `client.js`（渲染 / 物理 / 交互 / 工具栏 / 时间轴 / 筛选 / 详情 / 主题），未拆出 `lib/client/*` 与 `lib/graph/*`；locale 实际为 `locale/zh.json` + `locale/en.json`，图标为根目录 `icon.svg`。单一星系布局的几何纯函数与可测缝见 `test/{galaxy-geometry,projection,depth,disk-points,layout,interaction,seam}.test.mjs`。

```
wechat-neuron/
├── package.json                 # 包名、版本、dsh 插件声明、engines
├── cordis.patch.yml             # Bundle 补丁：注册插件、slot、Host 服务
├── index.js                     # Host 入口：apply(ctx)，注册 webServer 前缀与 API
├── client.js                    # Client 入口：注册 sidebar.panellist 与 main slot
├── lib/
│   ├── host/
│   │   ├── discover.js          # %APPDATA% ini 解析 → 数据根
│   │   ├── accounts.js          # wxid_* 枚举、多账号
│   │   ├── key.js               # 密钥校验（魔数探测）
│   │   ├── detect.js            # 加密参数自动探测
│   │   ├── decrypt.js           # SQLCipher 分页解密 → 明文库
│   │   ├── cache.js             # 缓存写入/失效/清除
│   │   ├── read.js              # node:sqlite 只读查询
│   │   ├── adapters/
│   │   │   ├── local.js
│   │   │   ├── chatlog.js
│   │   │   ├── import.js
│   │   │   └── demo.js
│   │   ├── export.js
│   │   ├── import.js            # bundle 校验与载入
│   │   ├── settings.js
│   │   └── routes.js            # /wechat-neuron/api/* 路由表
│   ├── graph/
│   │   ├── model.js             # 实体/边构建
│   │   ├── dimensions.js        # 五维特征
│   │   ├── score.js             # 重要度公式与分档
│   │   └── topics.js            # 关键词抽取与话题聚类
│   └── client/
│       ├── render.js            # 3D 投影、深度排序、发光
│       ├── simulate.js          # 节点缓动追随星系目标位（原力导向已移除）
│       ├── interact.js          # 手势、命中、选择
│       ├── toolbar.js
│       ├── timeline.js
│       ├── filter.js
│       ├── detail.js
│       └── theme.js
├── locale/
│   ├── zh-CN.json
│   └── en.json
├── icon/
│   └── neuron.svg               # 侧边栏图标
├── docs/
│   └── DESIGN.md                # 本文档
└── test/
    ├── crypto.roundtrip.test.js # 自加密往返：明文 → 加密 → 解密 → 比对
    ├── score.test.js            # 评分公式边界与单调性
    ├── model.test.js            # 实体/边构建
    ├── schema.test.js           # 数据契约校验
    └── fixtures/
        └── demo.bundle.json
```

`cordis.patch.yml` 关键片段：

```yaml
- id: wechat-neuron
  name: wechat-neuron
  config:
    source: demo
    maxNodes: 3000
```

slot 注册形态：

```js
// index.js（Host）
ctx.webServer.register({ kind: 'prefix', path: '/wechat-neuron', handler })

// client.js（Client）
ctx.slot('sidebar.panellist').register({ id: 'wechat-neuron', title: '微信神经元', icon, order: 60 })
ctx.slot('main').register({ key: 'wechat-neuron', component: NeuronPanel })
```

---

## 12. 验证方案与已知限制

### 12.1 无法端到端验证的部分（必须诚实登记）

| 项 | 现状 | 后果 |
| --- | --- | --- |
| 真实微信库端到端 | 无密钥时**无法**解密；`node:sqlite` 打开原库直接报 `file is not a database` | v0.1 不声称「已在真实库跑通」，需用户提供密钥后再验收 |
| 真实表结构 | 22 个库全部加密，`sqlite_master` 不可读 | 列名走运行时枚举 + 缺列降级，不硬编码 |
| 密钥自动获取 | 不做内存扫描 | 依赖用户提供或 chatlog 外部服务 |
| 消息全文 | 受采样上限约束 | 大库只渲染采样窗口，UI 标明覆盖范围 |

### 12.2 可验证的部分

| 层 | 手段 | 判据 |
| --- | --- | --- |
| 密码学管线 | 自加密往返测试：用 `node:crypto` 按 5.4 的参数把 `test/fixtures` 的明文库加密成 SQLCipher 形态，再用 `decrypt.js` 解回，逐字节比对 | 100% 一致；篡改任意一页 → HMAC 校验失败 |
| 参数探测 | 用 3 组不同参数（迭代/HMAC/pageSize）加密同一库 | `detect.js` 全部识别正确 |
| 评分模型 | 单测覆盖：无消息、单条消息、极高频、极久远、完全单边 | 单调性与边界符合 6.4 的补充规则 |
| 建模 | 演示集 + 手工构造的边界集 | 节点数/边数/无自环/无重复边 |
| 渲染与交互 | 演示数据集（1800 条 / 42 节点）在 1920×1080 下 | ≥ 30fps；14 项交互逐条手测 |
| 性能 | 合成 3000 节点 / 6000 边压测 | 帧率不塌陷，降采样生效 |
| DSH 侧 slot | `cordis_inspect_query` 读取 live slot 树 | `sidebar.panellist` 出现 `dsh-wechat-neuron`；`main` 出现同名 key |
| API | `curl http://127.0.0.1:9338/wechat-neuron/api/status` | 200 + 合法 JSON；四适配器分别可达/给出明确错误码 |

### 12.3 已知限制

1. 微信 4.x 加密参数若发生版本变更（pageSize/HMAC 变化），需更新 `detect.js` 的候选表。
2. `message_1.db` 的分库边界由 SQLite 自身决定，跨库会话需按 `talker` 合并后再统计。
3. Canvas 2D 无真 3D 深度缓冲，交叉连线在极端视角下会有排序瑕疵（用「远先画 + 近后画」近似）。
4. 超过 3000 节点必须降采样，聚合节点不可点击展开（v0.2 计划支持）。
5. 头像贴图（`head_image.db`）在 v0.2 才接入，v0.1 用色相哈希代替。
6. 宿主提供 `cordis_inspect_query` 的 slot 树验证依赖页面已连接，超时需重连后重试。

---

## 13. 里程碑与后续路线

### v0.1（可用骨架）

| 项 | 内容 |
| --- | --- |
| 数据 | demo 适配器 + local 适配器的解密链路（含自加密往返测试） |
| 建模 | 四类实体、四类边、五维特征、评分公式与分档 |
| 渲染 | Canvas 2D 正交投影 + 单一星系布局（密度场 + 加性星点）+ 神经元视觉（光晕/脉冲） |
| 交互 | 旋转/缩放/平移、点击详情、拖拽、图例、聚焦、全屏、快捷键 |
| 导出 | `bundle.json` + `summary.md` |
| 验收 | 演示集 30fps；slot 注册经 `cordis_inspect_query` 确认 |

### v0.2（真实数据与多维深化）

- **已完成**：关系随时间活起来 —— 聊天边逐桶序列（`series`/`sentSeries`/`recvSeries`）、回放态按当期强度浮现的关系边、「关系热度」抽屉柱图、回放速度三档（慢 700 / 正常 420 / 快 200 ms）。
- chatlog 适配器打通 + import 适配器（CSV 列映射 UI）。
- 筛选器 DSL 落地。
- 头像贴图、群内成员卫星点、话题突触簇聚合。
- 导出 CSV / GraphML；脱敏模式。
- 聚合节点可展开（LOD 两级）。

### v0.3（分析与体验）

- 社区发现（Louvain 简化版）自动着色 + 桥接节点标记。
- 朋友圈（`sns.db`）作为亲密强度辅证（需用户显式开启）。
- 大图 WebGL 后端评估（仅在节点 > 8000 时启用）。
- 离线话题摘要（本地小模型可选，默认关闭）。

### 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 微信升级改加密参数 | local 适配器全挂 | `detect.js` 候选表 + 明确错误码 + 引导用 chatlog 适配器 |
| 无 LICENSE 项目被误用 | 法律风险 | 第 2.2 节的纪律 + code review 检查项 |
| 大库读取超时 | 首屏卡死 | 采样上限 + 分页游标 + 进度事件 |
| 渲染性能 | 交互卡顿 | 盘面位图离屏缓存 + 边按需绘制 + 降采样 + LOD + TypedArray |
