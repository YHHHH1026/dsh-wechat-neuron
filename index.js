/**
 * wechat-neuron —— Host 侧入口。
 *
 * 职责：
 *   1. 提供 HTTP JSON API（挂在 DSH Web 服务的 /wechat-neuron 前缀下），
 *      供同包的 client half 读取本机微信数据、图谱、节点详情与设置。
 *   2. 维护明文缓存与图缓存。
 *
 * 安全边界（移植 dsh-better-sidebar 的 trust-fence 思路）：
 *   - 只接受 Host 头为 loopback 的请求；
 *   - 拒绝 sec-fetch-site: cross-site；
 *   - 有 Origin 时必须与 Host 同源。
 * 任何路径都不接受「任意文件读取」参数：数据目录只能来自设置或自动发现。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { accountTimeline, normalizeManualRoot, scan } from './lib/host/discover.js'
import { clearCache, describeTables, openDatabase, readContacts, readMessages, readSessions, LIMITS } from './lib/host/extract.js'
import { buildGraph, nodeDetail } from './lib/host/model.js'
import { demoDataset, demoMeta } from './lib/host/demo.js'
import { harvestKey, listWechatPids } from './lib/host/keyharvest.js'
import { harvestCipherKeys } from './lib/host/cipherkey.js'
import { forgetKey, getKey, getKeyFor, keyCount, loadSettings, paths, publicSettings, saveSettings, setKey, setKeys } from './lib/host/settings.js'

export const name = 'wechat-neuron'
/**
 * 必须声明 webServer 依赖：cordis 只有在 inject 列出的服务就绪后才会调用 apply()。
 * 之前这里是空数组 `[]`，apply 会被立刻调用，此时 ctx.get('webServer') 还是 undefined，
 * 于是走下面的 warn + return 分支，路由永远不会注册 —— 表现为 /wechat-neuron/api/* 全部 404。
 * connection 是可选服务（只用于回报带 token 的 GUI 地址），不放进 inject，否则它缺失时插件不加载。
 */
export const inject = ['webServer']

const API_PREFIX = '/wechat-neuron/api'

/** 图谱缓存：settings 签名 → { graph, messages, contacts, sessions, builtAt } */
let graphCache = { signature: '', value: null }

/**
 * 密钥扫描任务：PowerShell 启动 + 内存扫描要几十秒，HTTP 同步等待会被浏览器掐断，
 * 因此改成「后台跑 + 轮询」。同一时刻只允许一个任务，重复点击复用同一个。
 */
let harvestJob = { id: '', startedAt: 0, done: false, result: null, promise: null }
let harvestSeq = 0

/** apply() 时捕获的宿主服务句柄，用于回报带 token 的 GUI 地址。 */
let connectionRef = null
let webServerRef = null

/**
 * 生成当前 DSH Web GUI 的登录地址（带一次性进程 token）。
 * connection.authenticatedUrl() 是官方入口；不可用时退回裸 URL。
 */
function appOrigin() {
  const protocol = webServerRef?.protocol ?? 'http:'
  const port = webServerRef?.port
  if (typeof port !== 'number') return null
  const base = `${protocol}//127.0.0.1:${String(port)}`
  try {
    if (connectionRef !== null && typeof connectionRef.authenticatedUrl === 'function') {
      return connectionRef.authenticatedUrl(base)
    }
  } catch { /* 退化为裸地址 */ }
  return base
}

function isLoopbackHost(host) {
  if (typeof host !== 'string') return false
  const name = host.replace(/:\d+$/, '').toLowerCase()
  return name === 'localhost' || name === '[::1]' || name === '::1' || /^127\.\d+\.\d+\.\d+$/.test(name)
}

function isTrustedRequest(req) {
  const host = req.headers.host
  if (!isLoopbackHost(host)) return false
  if (String(req.headers['sec-fetch-site'] ?? '') === 'cross-site') return false
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    try {
      const originHost = new URL(origin).host
      if (originHost !== host) return false
    } catch { return false }
  }
  return true
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function ok(res, value) {
  json(res, 200, { ok: true, value })
}

function fail(res, status, code, message, meta) {
  json(res, status, { ok: false, error: { code, message, ...(meta === undefined ? {} : { meta }) } })
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return resolve({})
      try { resolve(JSON.parse(text)) } catch { resolve({ raw: text }) }
    })
    req.on('error', reject)
  })
}

function signatureOf(settings, mode) {
  return JSON.stringify({
    mode,
    roots: settings.manualRoots,
    account: settings.accountId,
    key: keyCount() > 0 ? 'set' : '',
    remember: settings.rememberKey,
  })
}

/** 真实数据链路：发现 → 读取 → 建模。 */
function buildRealGraph(options = {}) {
  const settings = loadSettings()
  const warnings = []
  const keyInfo = getKey()
  // 按库密钥模型下 getKey().key 为空但按库表有密钥，必须用 keyCount() 判断「有没有密钥」。
  const hasAnyKey = keyCount() > 0
  if (!hasAnyKey) {
    warnings.push({ code: 'KEY_MISSING', level: 'warning', message: '未配置数据库密钥，无法解密 SQLCipher 数据库；可提供明文库或先配置密钥。' })
  }
  const discovered = scan({ extraRoots: settings.manualRoots ?? [] })
  if (discovered.accounts.length === 0) {
    warnings.push({ code: 'NO_ACCOUNT', level: 'warning', message: '未找到微信账号目录，请在设置里手动指定数据目录。' })
  }
  let accounts = discovered.accounts
  if (typeof options.accountId === 'string' && options.accountId !== '') {
    const filtered = accounts.filter(account => account.id === options.accountId || account.dir === options.accountId)
    if (filtered.length > 0) accounts = filtered
  }
  const cacheDir = paths().cache
  mkdirSync(cacheDir, { recursive: true })
  const extractOptions = { key: keyInfo.key, keyFor: getKeyFor, cacheDir }
  const diagnostics = []
  const contacts = readContacts(accounts, extractOptions, diagnostics)
  const sessions = readSessions(accounts, extractOptions, diagnostics)
  const messages = readMessages(accounts, extractOptions, diagnostics, LIMITS.MAX_MESSAGES)
  for (const item of diagnostics.slice(0, 10)) {
    const detail = item.reason ?? (item.read === undefined ? 'ok' : `read=${item.read} tables=${item.tables ?? 0}`)
    warnings.push({ code: 'DB_DIAGNOSTIC', level: 'info', message: `${item.stage} · ${item.file} · ${detail}` })
  }
  const empty = contacts.length === 0 && messages.length === 0
  if (empty) {
    const fallback = buildDemoGraph()
    fallback.accounts = accounts
    fallback.diagnostics = diagnostics
    fallback.graph.meta.warnings = [
      ...warnings,
      {
        code: hasAnyKey ? 'REAL_EMPTY' : 'REAL_NEEDS_KEY',
        level: 'warning',
        message: hasAnyKey
          ? '已配置密钥但没能从数据库里读出消息，已先展示演示图谱；可在「设置 → 诊断」查看真实表结构。'
          : '数据库是加密的，已先展示演示图谱。点「自动获取密钥」或手动填写密钥后会切换为你的真实聊天记录。',
      },
    ]
    return { graph: fallback.graph, messages: fallback.messages, contacts: fallback.contacts, sessions: fallback.sessions, accounts, diagnostics, warnings: fallback.graph.meta.warnings }
  }
  const graph = buildGraph({
    contacts,
    sessions,
    messages,
    options: {
      source: 'local',
      account: accounts[0]?.id ?? 'local',
      warnings,
      selfName: settings.selfName ?? '我',
    },
  })
  return { graph, messages, contacts, sessions, accounts, diagnostics, warnings }
}

function buildDemoGraph() {
  const dataset = demoDataset()
  const meta = demoMeta()
  const graph = buildGraph({
    contacts: dataset.contacts,
    sessions: dataset.sessions,
    messages: dataset.messages,
    options: { source: 'demo', account: 'demo', warnings: meta.warnings, selfName: '我' },
  })
  return { graph, messages: dataset.messages, contacts: dataset.contacts, sessions: dataset.sessions, accounts: [], diagnostics: [], warnings: meta.warnings }
}

function buildWithMode(mode) {
  if (mode === 'real') {
    try {
      return buildRealGraph()
    } catch (error) {
      const fallback = buildDemoGraph()
      fallback.graph.meta.warnings.push({ code: 'REAL_FAILED', level: 'error', message: `真实数据构建失败，已回退演示数据：${String(error.message)}` })
      return fallback
    }
  }
  return buildDemoGraph()
}

function currentBundle(force = false) {
  const settings = loadSettings()
  const keyInfo = getKey()
  const mode = keyInfo.key !== '' || (settings.manualRoots ?? []).length > 0 ? 'real' : 'demo'
  const signature = signatureOf(settings, mode)
  if (!force && graphCache.value !== null && graphCache.signature === signature) return graphCache.value
  const value = buildWithMode(mode)
  graphCache = { signature, value }
  return value
}

/** 状态汇总：给 UI 顶部状态条与设置页用。 */
function statusPayload() {
  const settings = loadSettings()
  const keyInfo = getKey()
  const discovered = scan({ extraRoots: settings.manualRoots ?? [] })
  const accounts = discovered.accounts.map(account => ({
    id: account.id,
    name: account.name,
    dir: account.dir,
    layout: account.layout,
    stats: account.stats,
    databases: account.databases.map(db => ({ file: db.file, group: db.group, role: db.role, size: db.size, state: db.state })),
    timeline: accountTimeline(account),
  }))
  return {
    settings: publicSettings(),
    key: { hasKey: keyCount() > 0, count: keyCount(), persisted: keyInfo.persisted },
    discovery: { roots: discovered.roots, accounts },
    cache: { dir: paths().cache, exists: existsSync(paths().cache) },
    mode: keyCount() > 0 || (settings.manualRoots ?? []).length > 0 ? 'real' : 'demo',
    app: { url: appOrigin() },
  }
}

const handlers = {
  async status() { return statusPayload() },

  async scan(body) {
    const extraRoots = []
    if (typeof body?.root === 'string' && body.root !== '') {
      const normalized = normalizeManualRoot(body.root)
      if (normalized === null) return { ok: false, error: { code: 'BAD_ROOT', message: '路径不存在或不是有效的微信数据目录' } }
      extraRoots.push(normalized)
    }
    const discovered = scan({ extraRoots: [...(loadSettings().manualRoots ?? []), ...extraRoots] })
    return {
      roots: discovered.roots,
      accounts: discovered.accounts.map(account => ({
        id: account.id, dir: account.dir, layout: account.layout, stats: account.stats,
        databases: account.databases.map(db => ({ file: db.file, group: db.group, role: db.role, size: db.size, state: db.state })),
      })),
    }
  },

  async settings(body) {
    if (body?.patch !== undefined) {
      const patch = body.patch
      if (patch.manualRoots !== undefined) {
        const roots = Array.isArray(patch.manualRoots) ? patch.manualRoots : []
        patch.manualRoots = roots.map(item => normalizeManualRoot(item)).filter(item => item !== null)
      }
      saveSettings(patch)
      graphCache = { signature: '', value: null }
    }
    return publicSettings()
  },

  async key(body) {
    if (body?.forget === true) { forgetKey(); graphCache = { signature: '', value: null }; return publicSettings() }
    if (typeof body?.key === 'string') {
      setKey(body.key, body.remember === true)
      graphCache = { signature: '', value: null }
    }
    return publicSettings()
  },

  /**
   * 自动获取微信数据库密钥：只读扫描 Weixin 进程内存里的 raw key，
   * 命中后用库文件首页 HMAC 验证，成功则写入设置（默认只在内存里）。
   */
  /**
   * 启动一次「自动获取密钥」后台任务。立即返回 jobId，前端轮询 harvestStatus。
   * 同一时刻只跑一个任务：重复点击直接复用正在跑的那个。
   */
  async harvestKey(body) {
    if (harvestJob.promise !== null && harvestJob.done === false) {
      return { ok: true, jobId: harvestJob.id, running: true, elapsedMs: Date.now() - harvestJob.startedAt }
    }
    const settings = loadSettings()
    const discovered = scan({ extraRoots: settings.manualRoots ?? [] })
    const dbPaths = []
    for (const account of discovered.accounts) {
      for (const entry of account.databases) {
        if (entry.state === 'plain') continue
        // 每库独立密钥：必须收全部加密库（实测 22 个库 22 把密钥），
        // 不能像旧的单密钥模型那样只取 6 个代表库。
        dbPaths.push(entry.path)
      }
    }
    if (dbPaths.length === 0) {
      return { ok: false, reason: 'NO_DB', message: '没有找到加密的微信数据库，请先在设置里指定数据目录。' }
    }
    harvestSeq += 1
    const id = `harvest-${harvestSeq}`
    const remember = body?.remember === true
    // 默认 45 秒：内存扫描是「尽力而为」，不能让 GUI 请求挂死；
    // 真正的扫描跑在后台任务里，超时后 harvestStatus 仍能给出 TIMEOUT 结果。
    const timeoutMs = Number(body?.timeoutMs ?? 45000)
    const budgetMb = Number(body?.budgetMb ?? 512)
    const maxDegree = Number(body?.maxDegree ?? 2)
    harvestJob = { id, startedAt: Date.now(), done: false, result: null, promise: null }
    harvestJob.promise = (async () => {
      let result
      try {
        const pids = Array.isArray(body?.pids)
          ? body.pids.map(Number).filter(Number.isFinite)
          : await listWechatPids()
        // 先走定向提取（微信 4.1.13+ 的 Config.Cipher 结构）：
        // 实测 4s 拿到 22/22 个库的密钥；旧的暴力扫描 200s 仍 0 命中，只作回退。
        const targeted = await harvestCipherKeys({ dbPaths, pids, timeoutMs })
        if (targeted.ok === true) {
          result = { ok: true, keys: targeted.keys, total: targeted.total, source: 'cipher-config', steps: targeted.steps }
        } else {
          result = await harvestKey({
            dbPaths,
            pids,
            timeoutMs,
            budgetMb,
            maxDegree,
            cacheFile: join(paths().dir, 'key-cache.json'),
          })
          if (result.ok === true) result = { ...result, steps: [...targeted.steps, ...(result.steps ?? [])] }
          else result = { ...result, steps: [...targeted.steps, ...(result.steps ?? [])], targetedError: targeted.error }
        }
      } catch (error) {
        result = { ok: false, error: 'SCAN_THREW', detail: String(error?.message ?? error) }
      }
      if (result.ok === true) {
        if (Array.isArray(result.keys)) {
          setKeys(result.keys, remember)
        } else {
          setKey(result.key, remember)
        }
        graphCache = { signature: '', value: null }
        harvestJob.result = {
          ok: true, key: result.key, keys: result.keys?.length, total: result.total, profile: result.profile,
          source: result.source, steps: result.steps, elapsedMs: Date.now() - harvestJob.startedAt,
        }
      } else {
        const reason = result.error ?? 'UNKNOWN'
        const hint = reason === 'NO_PROCESS'
          ? '没有检测到正在运行的微信。请先打开并登录微信（保持运行），再点一次「自动获取密钥」。'
          : reason === 'NO_CIPHER_CONFIG'
            ? '微信在运行，但内存里没找到 WCDB 密钥配置结构（可能是微信版本不同或主进程未登录）。请确认微信已登录并保持运行，或按设置里的手动步骤粘贴密钥。'
            : reason === 'NO_CANDIDATE'
              ? '微信在运行，内存里没有找到可用的密钥（已尝试 Config.Cipher 定向提取与 32/16 字节 raw key、hex 口令、UTF-16LE 形态）。请按设置里的手动步骤粘贴密钥。'
              : reason === 'TIMEOUT'
                ? '扫描在时间/预算上限内没有扫完，还不能确定是否没有密钥。可以再点一次「自动获取密钥」继续，或直接手动粘贴密钥。'
                : reason === 'UNSUPPORTED_VERSION'
                  ? '数据库页大小不是 4096（或文件长度异常），当前版本无法解密。请确认目录指向微信 4.x 的 db_storage。'
                  : reason === 'NO_SALT'
                    ? '数据库首页读不到 salt，可能目录指向了非微信数据。请在设置里重新选择目录。'
                    : `未能自动获取密钥（${reason}），可手动粘贴，或确认微信正在运行。`
        harvestJob.result = { ok: false, reason, steps: result.steps, message: hint, elapsedMs: Date.now() - harvestJob.startedAt }
      }
      harvestJob.done = true
      return harvestJob.result
    })()
    // 后台任务不阻塞 HTTP；异常已在内部捕获，这里只防止 unhandledRejection。
    harvestJob.promise.catch(() => {})
    return { ok: true, jobId: id, running: true, elapsedMs: 0 }
  },

  /** 轮询密钥任务状态：running / done + 结果。 */
  async harvestStatus() {
    if (harvestJob.id === '') return { state: 'idle' }
    if (harvestJob.done === false) {
      return { state: 'running', jobId: harvestJob.id, elapsedMs: Date.now() - harvestJob.startedAt }
    }
    return { state: 'done', jobId: harvestJob.id, result: harvestJob.result }
  },

  /**
   * 诊断真实库：逐库打开、列出真实表名与关键表行数，
   * 用于排查「真实数据只有我一个节点」这类 schema 不匹配问题。
   */
  async diagnose() {
    const settings = loadSettings()
    const keyInfo = getKey()
    const discovered = scan({ extraRoots: settings.manualRoots ?? [] })
    const cacheDir = paths().cache
    mkdirSync(cacheDir, { recursive: true })
    const extractOptions = { key: keyInfo.key, keyFor: getKeyFor, cacheDir }
    const databases = []
    for (const account of discovered.accounts) {
      for (const entry of account.databases) {
        if (entry.kind === 'fts' || entry.kind === 'media') continue
        const opened = openDatabase({ ...entry, accountId: account.id, group: entry.group }, extractOptions)
        const item = { file: entry.file, group: entry.group, role: entry.role, size: entry.size, state: entry.state }
        if (!opened.ok) {
          item.error = opened.reason
          databases.push(item)
          continue
        }
        try {
          item.tables = describeTables(opened.db, 16)
        } catch (error) {
          item.error = String(error.message)
        }
        opened.db.close()
        databases.push(item)
      }
    }
    return { key: keyCount() > 0 ? 'set' : '', databases }
  },

  async graph(body) {
    const mode = body?.mode === 'real' ? 'real' : body?.mode === 'demo' ? 'demo' : undefined
    const bundle = mode === undefined ? currentBundle(body?.refresh === true) : (() => {
      const value = buildWithMode(mode)
      graphCache = { signature: signatureOf(loadSettings(), mode), value }
      return value
    })()
    return {
      graph: bundle.graph,
      warnings: bundle.warnings,
      diagnostics: bundle.diagnostics.slice(0, 40),
      accounts: (bundle.accounts ?? []).map(account => ({ id: account.id, name: account.name, dir: account.dir, layout: account.layout, stats: account.stats })),
    }
  },

  async node(body) {
    const bundle = currentBundle()
    const id = typeof body?.id === 'string' ? body.id : ''
    const detail = nodeDetail(bundle.graph, id, bundle.messages)
    if (detail === null) return { ok: false, error: { code: 'NODE_NOT_FOUND', message: id } }
    return detail
  },

  async clearCache() {
    const result = clearCache(paths().cache)
    graphCache = { signature: '', value: null }
    return result
  },

  async exportGraph(body) {
    const bundle = currentBundle()
    const settings = loadSettings()
    return {
      graph: bundle.graph,
      exportedAt: new Date().toISOString(),
      preferences: settings.preferences,
    }
  },

  async importGraph(body) {
    const graph = body?.graph
    if (graph === null || typeof graph !== 'object' || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
      return { ok: false, error: { code: 'BAD_IMPORT', message: '文件不是有效的图谱 JSON（需要 nodes / edges 数组）' } }
    }
    if (graph.meta === undefined) graph.meta = { schemaVersion: 1, generatedAt: new Date().toISOString(), source: 'import' }
    graphCache = { signature: 'imported', value: { graph, messages: [], contacts: [], sessions: [], accounts: [], diagnostics: [], warnings: [] } }
    return { ok: true, counts: { nodes: graph.nodes.length, edges: graph.edges.length } }
  },
}

/** 创建 HTTP 处理器（prefix 路由：/wechat-neuron/api/<method>）。 */
export function createApiHandler() {
  return async (req, res) => {
    try {
      if (!isTrustedRequest(req)) return fail(res, 403, 'UNTRUSTED', '请求来源不受信任')
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const pathname = url.pathname
      if (!pathname.startsWith(API_PREFIX)) return fail(res, 404, 'NOT_FOUND', pathname)
      const method = pathname.slice(API_PREFIX.length).replace(/^\/+/, '')
      if (method === '') return ok(res, { methods: Object.keys(handlers) })
      const handler = handlers[method]
      if (handler === undefined) return fail(res, 404, 'UNKNOWN_METHOD', method)
      let body = {}
      if (req.method === 'POST' || req.method === 'PUT') body = await readBody(req)
      else {
        const query = {}
        for (const [key, value] of url.searchParams) query[key] = value
        body = query
      }
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
        return fail(res, 405, 'METHOD_NOT_ALLOWED', req.method ?? '')
      }
      const value = await handler(body)
      if (value !== null && typeof value === 'object' && value.ok === false && value.error !== undefined) {
        return fail(res, 400, value.error.code ?? 'ERROR', value.error.message ?? '')
      }
      return ok(res, value)
    } catch (error) {
      return fail(res, 500, 'INTERNAL', String(error && error.message ? error.message : error))
    }
  }
}

export function apply(ctx) {
  // inject 已声明 webServer，apply 被调用时服务必定就绪；两种取法都试一遍更稳。
  const webServer = ctx.webServer ?? ctx.get('webServer')
  if (webServer === undefined) {
    ctx.logger?.warn?.('wechat-neuron: webServer 不可用，API 路由未注册')
    return
  }
  webServerRef = webServer
  connectionRef = ctx.get('connection') ?? null
  const handler = createApiHandler()
  ctx.effect(() => () => {
    webServerRef = null
    connectionRef = null
  }, 'wechat-neuron: refs')
  ctx.effect(() => webServer.register({ kind: 'prefix', path: API_PREFIX, handler }), 'wechat-neuron: api route')
  ctx.logger?.info?.('wechat-neuron: API 已挂载于 ' + API_PREFIX)
}
