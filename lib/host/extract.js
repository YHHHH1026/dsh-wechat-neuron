/**
 * 微信数据库读取层：把「加密/明文 SQLite」统一成结构化记录。
 *
 * 读取策略：
 *   1. 若文件是明文 SQLite（第三方导出/演示数据），直接打开。
 *   2. 若是 SQLCipher 加密，用用户提供的密钥解密到本地缓存目录，再打开明文副本。
 *   3. 一切读取都是只读 + 有上限（MAX_MESSAGES），并记录诊断信息供 UI 展示。
 *
 * 兼容性：微信 3.x（MSG.db / MicroMsg.db）与 4.x（db_storage/message_*.db）的表结构
 * 差异较大，因此这里不写死 SQL，而是先探测表名与列名，再按别名映射取值。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'

import { decryptDatabase, detectProfile, isPlainSqlite, parseKey } from './crypto.js'

const MAX_MESSAGES = 200000
const MAX_CACHE_BYTES = 512 * 1024 * 1024

/** 表名/列名候选，按优先级排列。 */
const SCHEMA = {
  contact: {
    tables: ['contact', 'Contact', 'rcontact'],
    columns: {
      username: ['username', 'UserName', 'user_name'],
      nickname: ['nickname', 'NickName', 'nick_name'],
      remark: ['remark', 'Remark', 'remark_name'],
      alias: ['alias', 'Alias'],
      type: ['local_type', 'LocalType', 'type'],
      avatar: ['big_head_url', 'small_head_url', 'HeadImgUrl'],
    },
  },
  session: {
    // 微信 4.x 实测表名是 SessionTable（不是 session/Session），少了它整条会话链路空转。
    tables: ['SessionTable', 'session', 'Session'],
    columns: {
      username: ['username', 'strUsrName', 'UserName'],
      type: ['type', 'nType'],
      lastTime: ['last_timestamp', 'nTime', 'last_time'],
      lastMsgType: ['last_msg_type', 'nMsgType'],
      summary: ['summary', 'strContent', 'digest'],
      unread: ['unread_count', 'nUnreadCount'],
      display: ['last_sender_display_name', 'strNickName'],
    },
  },
  message4: {
    tables: ['message', 'Message', 'message_*', 'msg_*', 'Msg_*'],
    columns: {
      id: ['local_id', 'server_id', 'rowid'],
      type: ['local_type', 'type', 'msg_type'],
      time: ['create_time', 'createTime', 'timestamp'],
      content: ['message_content', 'content', 'compress_content'],
      sender: ['real_sender_id', 'sender_id', 'talker'],
      talker: ['username', 'talker', 'session_id', 'str_talker'],
      sortSeq: ['sort_seq', 'server_seq', 'sequence'],
      status: ['status'],
      source: ['source', 'origin_source'],
      // WCDB 逐列压缩标记：4 = zstd。不读它就无法判断 message_content 是文本还是压缩块。
      contentCompress: ['WCDB_CT_message_content'],
    },
    core: ['content', 'type', 'time'],
  },
  message3: {
    tables: ['MSG', 'Msg', 'MSG_*'],
    columns: {
      id: ['localId', 'MsgSvrID', 'rowid'],
      type: ['Type', 'type'],
      subType: ['SubType', 'sub_type'],
      time: ['CreateTime', 'create_time'],
      content: ['StrContent', 'content'],
      talker: ['StrTalker', 'talker'],
      isSender: ['IsSender', 'is_sender'],
      display: ['DisplayContent'],
      bytesExtra: ['BytesExtra', 'Reserved'],
    },
  },
  name2id: {
    tables: ['Name2Id', 'name2id'],
    columns: { id: ['rowid', 'id'], username: ['usr_name', 'user_name', 'username'] },
    // 映射表只有一两列，且 rowid 是隐式列（pragma table_info 里看不到），
    // 不能套用 message/contact 的「至少 2 个核心列」判定，否则整张表被判为无关表。
    core: ['username'],
    minScore: 1,
  },
}

function safeOpen(file) {
  try {
    const db = new DatabaseSync(file, { readOnly: true })
    db.exec('PRAGMA query_only = 1;')
    return db
  } catch (error) {
    return { error: String(error && error.message ? error.message : error) }
  }
}

function tables(db) {
  try {
    const rows = db.prepare("select name from sqlite_master where type in ('table','view')").all()
    return rows.map(row => String(row.name))
  } catch { return [] }
}

function columns(db, table) {
  try {
    const rows = db.prepare(`pragma table_info("${table.replace(/"/g, '""')}")`).all()
    return rows.map(row => ({ name: String(row.name), lower: String(row.name).toLowerCase() }))
  } catch { return [] }
}

/** 候选名支持尾部 `*` 做前缀/模式匹配：`Msg_*`、`message_*`。 */
function nameMatches(name, candidate) {
  if (!candidate.includes('*')) return name.toLowerCase() === candidate.toLowerCase()
  const pattern = candidate
    .toLowerCase()
    .split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${pattern}$`).test(name.toLowerCase())
}

function mapColumns(db, table, spec) {
  const cols = columns(db, table)
  const lowerMap = new Map(cols.map(col => [col.lower, col.name]))
  const mapping = {}
  for (const [key, aliases] of Object.entries(spec.columns)) {
    for (const alias of aliases) {
      const real = lowerMap.get(alias.toLowerCase())
      if (real !== undefined) { mapping[key] = real; break }
    }
  }
  return { table, mapping, columns: cols.map(col => col.name) }
}

/**
 * 找出所有匹配候选名的表，并解析列映射。
 *
 * 为什么必须返回「全部」而不是第一张：微信 4.x 把消息按会话拆成
 * `Msg_<md5(user_name)>`，一个库里有 150~240 张同构表（实测 message_0.db 有 232 张）。
 * 旧实现只取第一张命中的表，于是每个库只读到一个会话的消息，
 * 且那张表恰好没有 username 列 → talker 为空 → 全部被丢弃 → 图谱全空。
 */
function resolveTables(db, spec) {
  const existing = tables(db)
  const hits = []
  for (const candidate of spec.tables) {
    for (const name of existing) {
      if (nameMatches(name, candidate) && !hits.includes(name)) hits.push(name)
    }
    if (hits.length > 0) break // 优先级更高的候选先命中就不再放宽
  }
  const out = []
  const core = spec.core ?? ['content', 'type', 'time', 'username', 'talker']
  const minScore = spec.minScore ?? 2
  for (const hit of hits) {
    const resolved = mapColumns(db, hit, spec)
    const score = core.filter(key => resolved.mapping[key] !== undefined).length
    if (score >= minScore) out.push(resolved)
  }
  return out
}

/** 在候选表里找出实际存在的那张，并解析出每列对应的真实列名。 */
function resolveTable(db, spec) {
  return resolveTables(db, spec)[0] ?? null
}

/**
 * 4.x 的会话归属：表名后缀就是 md5(user_name)（实测 232/232 全命中）。
 * 所以用本库 Name2Id 反查后缀即可得到会话 username，无需猜列。
 */
function conversationByHash(db) {
  const map = new Map()
  for (const spec of resolveTables(db, SCHEMA.name2id)) {
    const idCol = spec.mapping.id ?? 'rowid'
    const userCol = spec.mapping.username
    if (userCol === undefined) continue
    try {
      const rows = db.prepare(`select "${idCol}" as id, "${userCol}" as username from "${spec.table}"`).all()
      for (const row of rows) {
        const username = String(row.username ?? '')
        if (username === '') continue
        map.set(createHash('md5').update(username).digest('hex'), username)
      }
    } catch { /* 该表不可读则忽略 */ }
  }
  return map
}

/** 本库的发送者映射：real_sender_id 是 Name2Id 的 rowid，且各库独立编号，不能跨库共用。 */
function senderByRowId(db) {
  const map = new Map()
  for (const spec of resolveTables(db, SCHEMA.name2id)) {
    const idCol = spec.mapping.id ?? 'rowid'
    const userCol = spec.mapping.username
    if (userCol === undefined) continue
    try {
      for (const row of db.prepare(`select "${idCol}" as id, "${userCol}" as username from "${spec.table}"`).all()) {
        if (row.username !== undefined) map.set(Number(row.id), String(row.username))
      }
    } catch { /* 忽略 */ }
  }
  return map
}

/**
 * WCDB 逐列压缩：WCDB_CT_message_content=4 表示该列是 zstd 块（magic 28 b5 2f fd）。
 * 实测 156158 条消息里 61121 条是压缩的，不解压就会把二进制当文本或直接丢内容。
 */
function decodeContent(value, compressFlag) {
  if (value === null || value === undefined) return ''
  const isBytes = Buffer.isBuffer(value) || value instanceof Uint8Array
  if (!isBytes) return String(value)
  const buf = Buffer.from(value)
  if (buf.length === 0) return ''
  const looksZstd = buf.length >= 4 && buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd
  if (Number(compressFlag) === 4 || looksZstd) {
    try { return zstdDecompressSync(buf).toString('utf8') } catch { /* 解压失败则退回下面的猜测 */ }
  }
  // 没有标记但确实是 UTF-8 文本时也直接返回，避免把正常文本变成乱码。
  const text = buf.toString('utf8')
  return text.includes('\ufffd') ? '' : text
}

/** 诊断用：列出库里前若干个表名，便于判断真实 schema。 */
export function describeTables(db, limit = 12) {
  const all = tables(db)
  return { count: all.length, names: all.slice(0, limit), columns: all.slice(0, 3).map(name => ({ name, columns: columns(db, name).map(col => col.name).slice(0, 16) })) }
}

function selectExpr(mapping, keys) {
  return keys
    .filter(key => mapping[key] !== undefined)
    .map(key => `"${mapping[key]}" as "${key}"`)
    .join(', ')
}

/** 缓存目录：<cacheDir>/<account>/<相对路径>.db */
function cacheTarget(cacheDir, accountId, relative) {
  const safe = `${accountId}/${relative}`.replace(/[\\/]+/g, '/').replace(/\.\.+/g, '_')
  return join(cacheDir, safe)
}

/**
 * 把某个数据库准备好并打开。
 * @returns {{ok:true, db:DatabaseSync, path:string, decrypted:boolean, profile?:string} | {ok:false, reason:string, message?:string}}
 */
export function openDatabase(entry, options) {
  const { cacheDir, forceDecrypt = false } = options
  const source = entry.path
  // 每库独立密钥：优先用该库的专属密钥，没有才回退到手动填写的通用密钥。
  const key = typeof options.keyFor === 'function' ? options.keyFor(source) : options.key
  const password = parseKey(key)

  if (!existsSync(source)) return { ok: false, reason: 'missing', message: source }
  let buffer
  try {
    buffer = readFileSync(source)
  } catch (error) {
    return { ok: false, reason: 'unreadable', message: String(error.message) }
  }
  if (buffer.length === 0) return { ok: false, reason: 'empty' }

  const isPlain = isPlainSqlite(buffer)
  if (isPlain) {
    const db = safeOpen(source)
    if (db.error !== undefined) return { ok: false, reason: 'sqlite-error', message: db.error }
    return { ok: true, db, path: source, decrypted: false }
  }

  if (password === null) return { ok: false, reason: 'needs-key' }
  if (detectProfile(buffer, password) === null) return { ok: false, reason: 'wrong-key' }

  const target = cacheTarget(cacheDir, entry.accountId ?? 'default', entry.group ? `${entry.group}/${entry.file}` : entry.file)
  let needWrite = forceDecrypt || !existsSync(target)
  if (!needWrite) {
    try {
      needWrite = statSync(target).mtimeMs < statSync(source).mtimeMs
    } catch { needWrite = true }
  }
  if (needWrite) {
    const result = decryptDatabase(buffer, password)
    if (!result.ok) return { ok: false, reason: result.reason }
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, result.plain)
  }
  const db = safeOpen(target)
  if (db.error !== undefined) return { ok: false, reason: 'sqlite-error', message: db.error }
  return { ok: true, db, path: target, decrypted: true }
}

function parseMessageType(raw) {
  const value = Number(raw)
  if (!Number.isFinite(value)) return { type: 0, kind: 'unknown' }
  // 微信消息类型：**低 32 位是主类型，高 32 位是子类型**。
  // 实测 4.x：244813135921 → low32=49（应用/链接消息）、high32=57（子类型）。
  // 旧实现取高 32 位当主类型，导致 32115 条链接/引用消息全被归为 other。
  const main = value % 0x100000000
  const kindByType = {
    1: 'text',
    3: 'image',
    34: 'voice',
    42: 'card',
    43: 'video',
    47: 'sticker',
    48: 'location',
    49: 'link',
    50: 'call',
    51: 'call',
    10000: 'system',
    10002: 'system',
    436207665: 'redpacket',
    469762097: 'redpacket',
  }
  const kind = kindByType[main] ?? 'other'
  return { type: value, kind }
}

/** 读取联系人。 */
export function readContacts(accounts, options, diagnostics) {
  const out = []
  for (const account of accounts) {
    for (const entry of account.databases) {
      if (entry.role !== 'contact' || entry.kind === 'fts') continue
      const opened = openDatabase({ ...entry, accountId: account.id, group: entry.group }, options)
      if (!opened.ok) { diagnostics.push({ file: entry.file, stage: 'contacts', reason: opened.reason }); continue }
      const spec = resolveTable(opened.db, SCHEMA.contact)
      if (spec === null) { diagnostics.push({ file: entry.file, stage: 'contacts', reason: 'no-contact-table' }); opened.db.close(); continue }
      const sql = `select ${selectExpr(spec.mapping, ['username', 'nickname', 'remark', 'alias', 'type', 'avatar'])} from "${spec.table}"`
      try {
        for (const row of opened.db.prepare(sql).all()) {
          const username = String(row.username ?? '')
          if (username === '') continue
          out.push({
            username,
            nickname: String(row.nickname ?? ''),
            remark: String(row.remark ?? ''),
            alias: String(row.alias ?? ''),
            wxType: Number(row.type ?? 0),
            avatar: String(row.avatar ?? ''),
            account: account.id,
          })
        }
      } catch (error) {
        diagnostics.push({ file: entry.file, stage: 'contacts', reason: String(error.message) })
      }
      opened.db.close()
    }
  }
  return out
}

/** 读取会话列表（用于拿到「最近一次对话时间」和未读数）。 */
export function readSessions(accounts, options, diagnostics) {
  const out = []
  for (const account of accounts) {
    for (const entry of account.databases) {
      if (entry.role !== 'session') continue
      const opened = openDatabase({ ...entry, accountId: account.id, group: entry.group }, options)
      if (!opened.ok) { diagnostics.push({ file: entry.file, stage: 'sessions', reason: opened.reason }); continue }
      const spec = resolveTable(opened.db, SCHEMA.session)
      if (spec === null) { diagnostics.push({ file: entry.file, stage: 'sessions', reason: 'no-session-table' }); opened.db.close(); continue }
      const sql = `select ${selectExpr(spec.mapping, ['username', 'type', 'lastTime', 'lastMsgType', 'summary', 'unread', 'display'])} from "${spec.table}"`
      try {
        for (const row of opened.db.prepare(sql).all()) {
          const username = String(row.username ?? '')
          if (username === '') continue
          out.push({
            username,
            wxType: Number(row.type ?? 0),
            lastTime: Number(row.lastTime ?? 0),
            lastMsgType: Number(row.lastMsgType ?? 0),
            summary: String(row.summary ?? ''),
            unread: Number(row.unread ?? 0),
            display: String(row.display ?? ''),
            account: account.id,
          })
        }
      } catch (error) {
        diagnostics.push({ file: entry.file, stage: 'sessions', reason: String(error.message) })
      }
      opened.db.close()
    }
  }
  return out
}

/**
 * 本人 wxid：4.x 账号目录名形如 `wxid_xxx_44bf`，尾部 `_xxxx` 是实例后缀，
 * 去掉它才是真实 wxid。用于把「我发出的消息」标成 __self__，
 * 否则 reciprocity/initiation 两个亲密度维度会恒为 0。
 */
function selfWxidOf(account) {
  const id = String(account?.id ?? '')
  const m = /^(wxid_[0-9a-zA-Z]+)_[0-9a-f]{4}$/.exec(id)
  return m === null ? id : m[1]
}

/** 读取消息。4.x 与 3.x 分别走两条路径。 */
export function readMessages(accounts, options, diagnostics, limit = MAX_MESSAGES) {
  const messages = []
  for (const account of accounts) {
    const selfWxid = selfWxidOf(account)
    for (const entry of account.databases) {
      if (entry.role !== 'message') continue
      if (entry.kind === 'fts' || entry.kind === 'media') continue
      const opened = openDatabase({ ...entry, accountId: account.id, group: entry.group }, options)
      if (!opened.ok) { diagnostics.push({ file: entry.file, stage: 'messages', reason: opened.reason }); continue }
      const db = opened.db
      const specs4 = resolveTables(db, SCHEMA.message4)
      const specs3 = specs4.length === 0 ? resolveTables(db, SCHEMA.message3) : []
      if (specs4.length === 0 && specs3.length === 0) {
        diagnostics.push({ file: entry.file, stage: 'messages', reason: 'no-message-table' })
        db.close()
        continue
      }
      // 会话归属与发送者映射都必须按「本库」建立：各库 Name2Id 的 rowid 各自从 1 开始。
      const byHash = specs4.length > 0 ? conversationByHash(db) : new Map()
      const senders = specs4.length > 0 ? senderByRowId(db) : new Map()
      const is4 = specs4.length > 0
      const specs = is4 ? specs4 : specs3
      const keys = is4
        ? ['id', 'type', 'time', 'content', 'sender', 'talker', 'sortSeq', 'contentCompress']
        : ['id', 'type', 'time', 'content', 'talker', 'isSender', 'display']
      let read = 0
      let tablesRead = 0
      let unmapped = 0
      try {
        for (const spec of specs) {
          // 4.x：表名后缀 md5 → 会话 username；映射不到就跳过（宁缺勿造）。
          let talkerFromTable = ''
          if (is4) {
            const suffix = /^Msg_([0-9a-f]{32})$/i.exec(spec.table)
            talkerFromTable = suffix === null ? '' : (byHash.get(suffix[1].toLowerCase()) ?? '')
            if (talkerFromTable === '' && spec.mapping.talker === undefined) { unmapped += 1; continue }
          }
          const timeCol = spec.mapping.time ?? 'rowid'
          const sql = `select ${selectExpr(spec.mapping, keys)} from "${spec.table}" order by "${timeCol}" desc limit ${Math.max(1, limit - messages.length)}`
          tablesRead += 1
          for (const row of db.prepare(sql).all()) {
            let talker = row.talker === undefined ? talkerFromTable : String(row.talker)
            if (talker === '') talker = talkerFromTable
            let sender = ''
            if (is4) {
              sender = row.sender === undefined ? '' : (senders.get(Number(row.sender)) ?? String(row.sender))
              if (sender === selfWxid) sender = '__self__'
              if (talker === '' && sender !== '') talker = sender
            } else {
              sender = Number(row.isSender ?? 0) === 1 ? '__self__' : talker
            }
            if (talker === '') continue
            const parsed = parseMessageType(row.type)
            const time = Number(row.time ?? 0)
            const content = is4
              ? decodeContent(row.content, row.contentCompress)
              : String(row.content ?? row.display ?? '')
            messages.push({
              id: row.id === undefined ? `${account.id}:${spec.table}:${time}:${read}` : `${account.id}:${spec.table}:${row.id}`,
              account: account.id,
              talker,
              sender: sender || talker,
              time: time > 1e12 ? Math.floor(time / 1000) : time,
              kind: parsed.kind,
              type: parsed.type,
              text: content,
            })
            read += 1
            if (messages.length >= limit) break
          }
          if (messages.length >= limit) break
        }
      } catch (error) {
        diagnostics.push({ file: entry.file, stage: 'messages', reason: String(error.message) })
      }
      diagnostics.push({ file: entry.file, stage: 'messages', read, tables: tablesRead, unmappedTables: unmapped })
      db.close()
      if (messages.length >= limit) return messages.slice(0, limit)
    }
  }
  return messages
}

/** 缓存清理。 */
export function clearCache(cacheDir) {
  try {
    const { rmSync } = requireRm()
    rmSync(cacheDir, { recursive: true, force: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, message: String(error.message) }
  }
}

function requireRm() {
  // 用静态 import 会破坏打包器的 tree-shaking 语义，这里集中取一次
  return { rmSync: rmSyncImpl }
}

import { rmSync as rmSyncImpl } from 'node:fs'

export const LIMITS = { MAX_MESSAGES, MAX_CACHE_BYTES }
