/**
 * 微信本地数据发现模块。
 *
 * 目标：在「不启动微信、不联网」的前提下，找到当前用户机器上的微信数据根目录、
 * 账号目录、数据库文件清单，并给出每个库的加密状态。
 *
 * 微信版本的目录布局：
 *   3.x  <root>/WeChat Files/wxid_xxx/Msg/Multi/MSG0.db  + Msg/MicroMsg.db + Msg/<hash>.db
 *   4.x  <root>/xwechat_files/wxid_xxx_xxxx/db_storage/{message,contact,session,...}/*.db
 * 数据根目录本身记录在 %APPDATA%\Tencent\xwechat\config\*.ini（明文一行路径）。
 */
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** 微信 4.x 数据库分类：目录名 → 语义。 */
const DB_ROLES = {
  message: 'message',
  contact: 'contact',
  session: 'session',
  sns: 'sns',
  favorite: 'favorite',
  media: 'media',
  general: 'general',
  hardlink: 'hardlink',
  head_image: 'head-image',
  emoticon: 'emoticon',
  bizchat: 'bizchat',
  chatbot: 'chatbot',
  solitaire: 'solitaire',
  weclaw: 'weclaw',
  third_app_icon: 'icon',
}

function safeList(dir) {
  try { return readdirSync(dir, { withFileTypes: true }) } catch { return [] }
}

function readHead(file, bytes = 16) {
  try {
    const fd = openSync(file, 'r')
    const buf = Buffer.alloc(bytes)
    const read = readSync(fd, buf, 0, bytes, 0)
    closeSync(fd)
    return buf.subarray(0, read)
  } catch { return Buffer.alloc(0) }
}

/** 判断文件是否是明文 SQLite（头部魔数）。 */
export function classifyFile(file) {
  const head = readHead(file, 16)
  if (head.length < 16) return 'empty'
  if (head.toString('latin1') === 'SQLite format 3\u0000') return 'plain'
  return 'encrypted'
}

/** 从 %APPDATA%\Tencent\xwechat\config\*.ini 读取用户自定义的数据根目录。 */
export function readConfiguredRoots() {
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  const dirs = [
    join(appData, 'Tencent', 'xwechat', 'config'),
    join(appData, 'Tencent', 'WeChat', 'config'),
  ]
  const roots = new Set()
  for (const dir of dirs) {
    for (const entry of safeList(dir)) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.ini')) continue
      try {
        const text = readFileSync(join(dir, entry.name), 'latin1').replace(/\u0000/g, '').trim()
        if (/^[a-zA-Z]:[\\/]/.test(text)) roots.add(text.replace(/[\\/]+$/, ''))
      } catch { /* 忽略不可读的配置 */ }
    }
  }
  return [...roots]
}

/** 候选数据根：配置里读到的优先，其次是各盘符下的标准目录。 */
export function candidateRoots(extra = []) {
  const home = homedir()
  const list = [...extra, ...readConfiguredRoots()]
  const bases = [home, join(home, 'Documents')]
  for (const drive of ['C:', 'D:', 'E:', 'F:', 'G:']) bases.push(drive + '\\')
  for (const base of bases) {
    for (const name of ['xwechat_files', 'WeChat Files', 'wechat_files']) {
      list.push(join(base, name))
    }
    list.push(join(base, 'WeChat', 'doc', 'xwechat_files'))
    list.push(join(base, 'WeChat', 'doc'))
  }
  const seen = new Set()
  const out = []
  for (const item of list) {
    const normalized = resolve(item)
    if (seen.has(normalized.toLowerCase())) continue
    seen.add(normalized.toLowerCase())
    out.push(normalized)
  }
  return out
}

/** 在给定目录下找出所有含 db_storage 或 Msg 的账号目录。 */
function accountsIn(root) {
  const accounts = []
  const push = (accountDir, layout) => {
    const name = accountDir.split(/[\\/]/).pop()
    accounts.push({ dir: accountDir, name, layout, id: name })
  }
  for (const entry of safeList(root)) {
    if (entry.isDirectory()) {
      const dir = join(root, entry.name)
      if (existsSync(join(dir, 'db_storage'))) push(dir, 'wechat4')
      else if (existsSync(join(dir, 'Msg'))) push(dir, 'wechat3')
    }
  }
  // 4.x 有时账号目录直接位于 root/xwechat_files 下，但也可能 root 本身就是账号目录
  if (accounts.length === 0 && existsSync(join(root, 'db_storage'))) push(root, 'wechat4')
  return accounts
}

/** 列出账号下的所有数据库文件（含角色标签）。 */
function listDatabases(accountDir, layout) {
  const files = []
  if (layout === 'wechat4') {
    const storage = join(accountDir, 'db_storage')
    for (const group of safeList(storage)) {
      if (!group.isDirectory()) continue
      const role = DB_ROLES[group.name] ?? group.name
      const groupDir = join(storage, group.name)
      for (const file of safeList(groupDir)) {
        if (!file.isFile() || !/\.db$/i.test(file.name)) continue
        const full = join(groupDir, file.name)
        let size = 0
        try { size = statSync(full).size } catch { /* 忽略 */ }
        files.push({
          path: full,
          file: file.name,
          group: group.name,
          role,
          size,
          kind: /_fts\.db$/i.test(file.name) ? 'fts'
            : /^media_/i.test(file.name) ? 'media'
              : /^message_/i.test(file.name) ? 'message'
                : 'main',
        })
      }
    }
  } else {
    // 3.x：MSG*.db 是消息库，MicroMsg.db 是联系人+会话
    for (const sub of ['Msg', 'Msg/Multi', 'Msg/Multi/Media']) {
      const dir = join(accountDir, sub)
      for (const file of safeList(dir)) {
        if (!file.isFile() || !/\.db$/i.test(file.name)) continue
        const full = join(dir, file.name)
        let size = 0
        try { size = statSync(full).size } catch { /* 忽略 */ }
        files.push({
          path: full,
          file: file.name,
          group: sub.replace(/[\\/]/g, '/'),
          role: /^MSG\d*\.db$/i.test(file.name) ? 'message' : /MicroMsg/i.test(file.name) ? 'contact' : 'other',
          size,
          kind: 'main',
        })
      }
    }
  }
  return files.sort((a, b) => b.size - a.size)
}

/**
 * 扫描全部候选根，返回 { roots, accounts }。
 * 每个账号带数据库清单与加密状态（encrypted / plain / empty）。
 */
export function scan(options = {}) {
  const roots = candidateRoots(options.extraRoots ?? [])
  const accounts = []
  const scannedRoots = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    const found = accountsIn(root)
    if (found.length === 0) continue
    scannedRoots.push(root)
    for (const account of found) {
      const databases = listDatabases(account.dir, account.layout)
      if (databases.length === 0) continue
      let encrypted = 0
      let plain = 0
      for (const db of databases) {
        db.state = classifyFile(db.path)
        if (db.state === 'encrypted') encrypted += 1
        if (db.state === 'plain') plain += 1
      }
      accounts.push({
        ...account,
        root,
        databases,
        stats: {
          files: databases.length,
          bytes: databases.reduce((sum, db) => sum + db.size, 0),
          encrypted,
          plain,
        },
      })
    }
  }
  // 同一账号可能被多个候选根命中，按目录去重
  const deduped = new Map()
  for (const account of accounts) {
    const key = account.dir.toLowerCase()
    const previous = deduped.get(key)
    if (previous === undefined || previous.stats.bytes < account.stats.bytes) deduped.set(key, account)
  }
  return { roots: scannedRoots, accounts: [...deduped.values()] }
}

/** 读取账号目录下的其他可读元数据（不依赖密钥）：文件数量、最近修改时间。 */
export function accountTimeline(account) {
  let latest = 0
  for (const db of account.databases) {
    try {
      const stat = statSync(db.path)
      if (stat.mtimeMs > latest) latest = stat.mtimeMs
    } catch { /* 忽略 */ }
  }
  return { latestModified: latest }
}

/** 规范化用户输入的数据目录：允许直接粘贴到 db_storage 或账号目录。 */
export function normalizeManualRoot(input) {
  const raw = String(input ?? '').trim().replace(/^"|"$/g, '')
  if (raw === '') return null
  let dir = resolve(raw)
  if (!existsSync(dir)) return null
  // 允许用户点到具体 db 文件
  if (/\.db$/i.test(dir)) dir = dirname(dir)
  if (dir.split(/[\\/]/).pop().toLowerCase() === 'db_storage') dir = dirname(dir)
  return dir
}
