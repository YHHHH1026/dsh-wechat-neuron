/**
 * 设置持久化与密钥保管。
 *
 * 原则：
 *   - 密钥（SQLCipher key）默认**不落盘**，只保存在宿主进程内存里；
 *     用户显式勾选「记住密钥」时才写入本机设置文件（并在 UI 明确提示风险）。
 *   - 其他设置（数据目录、显示偏好、重要度权重覆盖等）落在
 *     <DSH_HOME>/wechat-neuron/settings.json。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function settingsDir() {
  const dir = join(dshHome(), 'wechat-neuron')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function paths() {
  const dir = settingsDir()
  return {
    dir,
    settings: join(dir, 'settings.json'),
    cache: join(dir, 'cache'),
    exports: join(dir, 'exports'),
  }
}

const DEFAULT_SETTINGS = {
  version: 1,
  manualRoots: [],
  accountId: null,
  rememberKey: false,
  key: '',
  /** 按库密钥表（仅 rememberKey=true 时落盘）：{ "<归一化库路径>": {key, salt?, profile?} } */
  keys: {},
  theme: 'neuron',
  preferences: {
    showTopics: true,
    showGroups: true,
    showCooccurrence: true,
    minTier: 'weak',
    pulse: true,
    glow: 6,
    autoRotate: true,
    labels: true,
  },
}

let cached = null

export function loadSettings() {
  if (cached !== null) return cached
  const file = paths().settings
  let loaded = {}
  try {
    if (existsSync(file)) loaded = JSON.parse(readFileSync(file, 'utf8'))
  } catch { loaded = {} }
  cached = {
    ...DEFAULT_SETTINGS,
    ...loaded,
    preferences: { ...DEFAULT_SETTINGS.preferences, ...(loaded.preferences ?? {}) },
  }
  if (cached.rememberKey !== true) { cached.key = ''; cached.keys = {} }
  if (cached.keys === null || typeof cached.keys !== 'object') cached.keys = {}
  return cached
}

export function saveSettings(patch) {
  const current = loadSettings()
  const next = {
    ...current,
    ...patch,
    preferences: { ...current.preferences, ...(patch?.preferences ?? {}) },
  }
  if (next.rememberKey !== true) { next.key = ''; next.keys = {} }
  if (next.keys === null || typeof next.keys !== 'object') next.keys = {}
  cached = next
  try {
    writeFileSync(paths().settings, JSON.stringify(next, null, 2), 'utf8')
    return { ok: true }
  } catch (error) {
    return { ok: false, message: String(error.message) }
  }
}

/** 仅存内存的密钥（不写盘，进程退出即失效）。 */
let memoryKey = ''
/**
 * 按库密钥表（内存）。
 * 实测微信 4.1.15.56：22 个 .db → 22 个**各自独立**的密钥，
 * 不存在「一个账号一把密钥」，所以必须按库路径存。
 * @type {Map<string, {key:string, salt?:string, profile?:string}>}
 */
let memoryKeys = new Map()

/** 路径归一：Windows 大小写不敏感，分隔符统一，避免同一个库被当成两个。 */
function normalizeDbPath(p) {
  return String(p ?? '').trim().replace(/\\/g, '/').toLowerCase()
}

export function getKey() {
  if (memoryKey !== '') return { key: memoryKey, persisted: false }
  const settings = loadSettings()
  if (settings.rememberKey === true && typeof settings.key === 'string' && settings.key !== '') {
    return { key: settings.key, persisted: true }
  }
  return { key: '', persisted: false }
}

/** 取某个库的密钥；没有专属密钥时回退到手动填写的通用密钥。 */
export function getKeyFor(dbPath) {
  const norm = normalizeDbPath(dbPath)
  const hit = memoryKeys.get(norm)
  if (hit !== undefined) return hit.key
  const settings = loadSettings()
  if (settings.rememberKey === true && settings.keys && typeof settings.keys === 'object') {
    const stored = settings.keys[norm]
    if (stored && typeof stored.key === 'string' && stored.key !== '') return stored.key
  }
  return getKey().key
}

/** 当前已持有密钥的库数量（用于 UI 展示，绝不回传密钥明文）。 */
export function keyCount() {
  if (memoryKeys.size > 0) return memoryKeys.size
  const settings = loadSettings()
  if (settings.rememberKey === true && settings.keys && typeof settings.keys === 'object') {
    return Object.keys(settings.keys).length
  }
  return getKey().key === '' ? 0 : 1
}

export function setKey(key, remember = false) {
  const value = String(key ?? '').trim()
  memoryKey = value
  // 手动填写通用密钥时清掉按库表，避免旧的专属密钥盖住用户的新输入。
  memoryKeys = new Map()
  if (remember) {
    saveSettings({ rememberKey: true, key: value, keys: {} })
  } else {
    saveSettings({ rememberKey: false, key: '', keys: {} })
  }
  return { ok: true, stored: memoryKey !== '', persisted: remember && value !== '' }
}

/**
 * 保存按库密钥表。
 * @param {Array<{db:string, key:string, salt?:string, profile?:string}>} entries
 */
export function setKeys(entries, remember = false) {
  const next = new Map()
  const persisted = {}
  for (const entry of Array.isArray(entries) ? entries : []) {
    const norm = normalizeDbPath(entry?.db)
    const key = String(entry?.key ?? '').trim()
    if (norm === '' || key === '') continue
    const record = { key }
    if (typeof entry.salt === 'string' && entry.salt !== '') record.salt = entry.salt
    if (typeof entry.profile === 'string' && entry.profile !== '') record.profile = entry.profile
    next.set(norm, record)
    persisted[norm] = record
  }
  memoryKeys = next
  // 通用密钥保留为空：真实密钥都在按库表里，避免误用一把密钥去开所有库。
  memoryKey = ''
  saveSettings(remember
    ? { rememberKey: true, key: '', keys: persisted }
    : { rememberKey: false, key: '', keys: {} })
  return { ok: true, stored: next.size, persisted: remember ? next.size : 0 }
}

export function forgetKey() {
  memoryKey = ''
  memoryKeys = new Map()
  saveSettings({ rememberKey: false, key: '', keys: {} })
  return { ok: true }
}

/** 设置页里可以安全回传的字段（绝不回传密钥明文）。 */
export function publicSettings() {
  const settings = loadSettings()
  const key = getKey()
  const count = keyCount()
  return {
    ...settings,
    key: undefined,
    keys: undefined,
    hasKey: count > 0 || key.key !== '',
    keyCount: count,
    keyPersisted: key.persisted || (settings.rememberKey === true && count > 0),
    rememberKey: settings.rememberKey === true,
  }
}
