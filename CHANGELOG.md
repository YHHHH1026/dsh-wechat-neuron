# Changelog

本项目的所有显著变更记录在此。版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 0.1.0

首个公开版本。已在真实环境（Windows 11 + 微信 4.1.15.56 + Node v24.13.0）端到端验收。

### 数据与密钥

- 自动发现微信 3.x / 4.x 数据目录（含 `%APPDATA%\Tencent\xwechat\config\*.ini` 里的自定义根路径）。
- **SQLCipher 密钥定向提取**：只读微信主进程内存，定位 `com.Tencent.WCDB.Config.Cipher`
  配置对象 → 指针链 → XOR 解码 → 读 `enc_key` → 逐库页 1 HMAC 验证。
  实测 22 个库 → 22 把独立密钥，约 7.7 秒全部通过。
- 按库密钥模型：`getKeyFor(dbPath)`，不存在「一个账号一把密钥」的错误假设。
- 密钥默认只驻内存；勾选「记住密钥」才落盘。手动粘贴 64 位 hex 作为回退。
- 内存扫描（`lib/host/keyharvest.js`）保留为回退路径。

### 读库（微信 4.x 真实 schema）

- 会话表 `SessionTable`；消息按会话拆成 `Msg_<md5(user_name)>` 多表（单库 150~240 张）。
- WCDB 逐列压缩：`WCDB_CT_message_content=4` → zstd 解压。
- `local_type` 低 32 位为主类型、高 32 位为子类型。
- 发送者映射按库建立（各库 `Name2Id` 的 rowid 各自从 1 编号）。

### 建模与渲染

- 联系人 / 群聊 / 话题三类实体，四类关系边；六维加权重要度评分与五档分层。
- Canvas 2D 自绘伪 3D 管线 + 六种布局（银河 / 球体 / 时间螺旋 / 类型星团 / 放射 / 力导向）。
- 时间轴分桶与播放、节点详情、聚焦、筛选、图例、导入导出 JSON。

### 实测规模

```
nodes=2093  edges=3556  messages=156158  contacts=5835
person=1919  group=149  topic=24
timeRange 2025-05-30 → 2026-11-11
```

### 已知限制

- **仅支持 Windows**（`os: ["win32"]`）：密钥提取依赖 PowerShell / Win32 API。
- 页大小仅支持 4096；其它页大小返回 `UNSUPPORTED_VERSION`。
- `Config.Cipher` 的结构偏移按微信 4.1.x 实测得到，微信改版本可能失效并返回 `NO_CIPHER_CONFIG`。
- 不做 Hook / 注入，不写目标进程。