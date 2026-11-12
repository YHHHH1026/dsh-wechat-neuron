/**
 * SQLCipher 解密器（纯 Node，无第三方依赖）。
 *
 * 微信 3.x / 4.x 的聊天数据库都是 SQLCipher 加密的 SQLite 文件：
 *   - 文件前 16 字节是 salt（明文）
 *   - 从第 16 字节起是加密页，每页 4096 字节
 *   - 每页尾部通过 reserve 区域存放 IV + HMAC（+ 历史遗留的 12 字节 trailer）
 *   - 加密算法 AES-256-CBC，密钥 = PBKDF2(密码, salt, iterations)
 *   - HMAC 覆盖「密文 + IV + 页号(小端 4 字节)」
 *
 * 不同微信版本使用的 SQLCipher 参数不同（v3: SHA1/64000/48；v4: SHA512/256000/80），
 * 因此这里不做版本猜测，而是把候选参数逐个试一遍，用第 1 页的 HMAC 校验来判定。
 */
import { createDecipheriv, createCipheriv, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'

export const PAGE_SIZE = 4096
export const SALT_SIZE = 16

/** 候选参数组合，按「最可能命中」的顺序排列。 */
export const PROFILES = [
  // 微信 3.9 / 4.0 主流的 SQLCipher 3 参数
  { id: 'sqlcipher3', kdf: 'sha1', iterations: 64000, macIterations: 2, hmac: 'sha1', reserve: 48, trailer: 12 },
  // 少数构建把 HMAC 密钥也走完整迭代
  { id: 'sqlcipher3-macfull', kdf: 'sha1', iterations: 64000, macIterations: 64000, hmac: 'sha1', reserve: 48, trailer: 12 },
  // SQLCipher 4 默认参数
  { id: 'sqlcipher4', kdf: 'sha512', iterations: 256000, macIterations: 2, hmac: 'sha512', reserve: 80, trailer: 0 },
  // 4.x 部分构建仍沿用 48 字节 reserve
  { id: 'sqlcipher4-reserve48', kdf: 'sha512', iterations: 256000, macIterations: 2, hmac: 'sha256', reserve: 48, trailer: 0 },
]

/**
 * 「原始密钥」候选组：微信 4.x 从进程内存里取到的是 32 字节原始密钥（x'....' 形式），
 * 此时 AES key 就是这 32 字节本身，MAC key 才走 PBKDF2。这一组必须先试，
 * 否则用 PBKDF2(password) 去猜会永远对不上第 1 页 HMAC。
 */
export const RAW_PROFILES = [
  // —— AES-256 raw key（微信 4.x 主流）——
  { id: 'raw4-sha512', raw: true, keyLen: 32, kdf: 'sha512', iterations: 0, macIterations: 2, hmac: 'sha512', reserve: 80, trailer: 0 },
  { id: 'raw4-sha256-48', raw: true, keyLen: 32, kdf: 'sha512', iterations: 0, macIterations: 2, hmac: 'sha256', reserve: 48, trailer: 0 },
  { id: 'raw3-sha1', raw: true, keyLen: 32, kdf: 'sha1', iterations: 0, macIterations: 2, hmac: 'sha1', reserve: 48, trailer: 12 },
  { id: 'raw4-macfull', raw: true, keyLen: 32, kdf: 'sha512', iterations: 0, macIterations: 256000, hmac: 'sha512', reserve: 80, trailer: 0 },
  // —— AES-128 raw key（WCDB 也允许 x'<32hex>' 形态，旧实现完全没覆盖）——
  { id: 'raw4-sha512-aes128', raw: true, keyLen: 16, kdf: 'sha512', iterations: 0, macIterations: 2, hmac: 'sha512', reserve: 80, trailer: 0 },
  { id: 'raw3-sha1-aes128', raw: true, keyLen: 16, kdf: 'sha1', iterations: 0, macIterations: 2, hmac: 'sha1', reserve: 48, trailer: 12 },
]

const HMAC_LENGTH = { sha1: 20, sha256: 32, sha512: 64 }

/**
 * 密钥长度 → AES cipher。WCDB 的 setCipherKey 接受 raw key 形态 x'<hex><salt hex>'，
 * 其中 hex 段长度可以是 32（AES-128）或 64（AES-256）。旧实现写死 aes-256-cbc，
 * 于是 AES-128 的库永远验不过——这是与 WCDB 的已知差距之一。
 */
export const CIPHER_FOR_KEY_LEN = { 16: 'aes-128-cbc', 24: 'aes-192-cbc', 32: 'aes-256-cbc' }

export function cipherFor(keyLen) {
  const name = CIPHER_FOR_KEY_LEN[keyLen]
  if (name === undefined) throw new Error('unsupported raw key length: ' + keyLen)
  return name
}

/** 把用户输入的密钥统一成 Buffer。支持 64/96 位十六进制、纯文本口令。 */
export function parseKey(raw) {
  let text = String(raw ?? '').trim()
  if (text === '') return null
  // WCDB / SQLCipher 的 raw key 写法：x'<64hex_key><32hex_salt>'（也可能是 32hex 的 AES-128）。
  // 末尾的 salt 段是冗余信息（salt 本来就在文件头里），这里只取密钥段。
  const blob = /^x'([0-9a-f]+)'$/i.exec(text)
  if (blob !== null) text = blob[1]
  text = text.replace(/^0x/i, '')
  if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0 && text.length >= 32) {
    const bytes = Buffer.from(text, 'hex')
    // 96 hex = 32B key + 16B salt（WCDB 最常见形态）；64 hex = 32B key；32 hex = 16B key
    if (bytes.length === 48) return bytes.subarray(0, 32)
    if (bytes.length > 32) return bytes.subarray(0, 32)
    return bytes
  }
  return Buffer.from(text, 'utf8')
}

function xorSalt(salt) {
  const out = Buffer.from(salt)
  for (let i = 0; i < out.length; i += 1) out[i] ^= 0x3a
  return out
}

/** 由密码 + salt + 参数推导 [AES key, MAC key]。raw 模式下 AES key 直接用密钥本身。 */
function deriveKeys(password, salt, profile) {
  if (profile.raw === true) {
    const keyLen = profile.keyLen ?? 32
    const key = Buffer.from(password).subarray(0, keyLen)
    if (key.length < keyLen) throw new Error('raw key must be ' + keyLen + ' bytes')
    const macKey = pbkdf2Sync(password, xorSalt(salt), profile.macIterations, 32, profile.kdf)
    return { key, macKey, cipher: cipherFor(keyLen) }
  }
  const key = pbkdf2Sync(password, salt, profile.iterations, 32, profile.kdf)
  const macKey = pbkdf2Sync(password, xorSalt(salt), profile.macIterations, 32, profile.kdf)
  return { key, macKey, cipher: 'aes-256-cbc' }
}

/** 单页的 HMAC 校验值。 */
function pageMac(macKey, hmacName, cipher, iv, pageNumber) {
  const mac = createHmac(hmacName, macKey)
  mac.update(cipher)
  mac.update(iv)
  const pgno = Buffer.alloc(4)
  pgno.writeUInt32LE(pageNumber, 0)
  mac.update(pgno)
  return mac.digest()
}

/**
 * 页内布局：密文 / IV / HMAC。
 * 注意 body 长度本身已经体现了第 1 页「少 16 字节 salt」的差异：
 *   第 1 页 body = 4080 字节（4096 - salt），其余页 body = 4096 字节。
 * 因此 cipherLen 必须由 body.length 推出，而不是用 PAGE_SIZE 常量，
 * 否则第 1 页会多算 16 字节，IV/HMAC 位置全错（这是最初校验永远失败的根因）。
 */
function pageSlots(body, profile) {
  const hmacLen = HMAC_LENGTH[profile.hmac]
  const cipherLen = body.length - profile.reserve
  if (cipherLen <= 0) return null
  const cipher = body.subarray(0, cipherLen)
  const iv = body.subarray(cipherLen, cipherLen + 16)
  const macStart = cipherLen + 16
  const mac = body.subarray(macStart, macStart + hmacLen)
  if (iv.length < 16 || mac.length < hmacLen) return null
  return { cipher, iv, mac, cipherLen, hmacLen }
}

/** 用候选参数判断第 1 页 HMAC 是否匹配，命中即返回该参数。 */
export function detectProfile(buffer, password, profiles = null) {
  if (buffer.length < PAGE_SIZE) return null
  const salt = buffer.subarray(0, SALT_SIZE)
  const list = profiles ?? PROFILES
  for (const profile of list) {
    let keys
    try {
      keys = deriveKeys(password, salt, profile)
    } catch {
      continue
    }
    const body = buffer.subarray(SALT_SIZE, PAGE_SIZE)
    const slots = pageSlots(body, profile)
    if (slots === null) continue
    const { cipher, iv, mac } = slots
    const expect = pageMac(keys.macKey, profile.hmac, cipher, iv, 1)
    if (expect.length === mac.length && expect.equals(mac)) return { profile, keys }
  }
  return null
}

/** 先按 raw key 组、再按口令组依次尝试（微信 4.x 内存里拿到的就是 raw key）。 */
export function detectAnyProfile(buffer, password) {
  return detectProfile(buffer, password, RAW_PROFILES) ?? detectProfile(buffer, password, PROFILES)
}

/**
 * 解密整个数据库文件，返回明文 SQLite Buffer。
 * 明文按 4096 字节/页重建，reserve 区域补 0（SQLite 把该区域视为保留字节）。
 */
export function decryptDatabase(buffer, password, options = {}) {
  const detected = options.profile && options.keys
    ? { profile: options.profile, keys: options.keys }
    : detectAnyProfile(buffer, password)
  if (detected === null) {
    const allZero = buffer.length <= SALT_SIZE || buffer.subarray(SALT_SIZE).every(byte => byte === 0)
    if (allZero) return { ok: true, plain: Buffer.alloc(0), profile: null, empty: true }
    return { ok: false, reason: 'hmac-mismatch' }
  }
  const { profile, keys } = detected
  const pages = Math.floor(buffer.length / PAGE_SIZE)
  const out = Buffer.alloc(pages * PAGE_SIZE)
  const reserve = profile.reserve
  const usable = PAGE_SIZE - reserve

  for (let index = 0; index < pages; index += 1) {
    const start = index === 0 ? SALT_SIZE : index * PAGE_SIZE
    const body = buffer.subarray(start, start + PAGE_SIZE - (index === 0 ? SALT_SIZE : 0))
    const slots = pageSlots(body, profile)
    if (slots === null) return { ok: false, reason: 'page-layout', page: index + 1 }
    const { cipher, iv, mac } = slots
    const expect = pageMac(keys.macKey, profile.hmac, cipher, iv, index + 1)
    if (!expect.equals(mac)) {
      return { ok: false, reason: 'hmac-mismatch', page: index + 1 }
    }
    const decipher = createDecipheriv(keys.cipher ?? cipherFor(keys.key.length), keys.key, iv)
    decipher.setAutoPadding(false)
    const plain = Buffer.concat([decipher.update(cipher), decipher.final()])
    const target = index * PAGE_SIZE
    // 第 1 页：文件里那 16 字节 salt 占掉了明文页的首 16 字节（永远是 SQLite 魔数），
    // 它是隐含值、不参与加密，所以解密结果要从页内偏移 16 开始写回。
    if (index === 0) {
      SQLITE_HEADER.copy(out, target)
      plain.copy(out, target + SALT_SIZE)
    } else {
      plain.copy(out, target)
    }
    // 明文内容之后的 reserved 区留 0
    out.fill(0, target + SALT_SIZE * (index === 0 ? 1 : 0) + plain.length, target + PAGE_SIZE)
  }
  return { ok: true, plain: out, profile: profile.id, pages }
}

/** 供自测使用的加密器：按给定参数把明文 SQLite 文件加密回 SQLCipher 格式。 */
export function encryptDatabase(plain, password, profile = PROFILES[0]) {
  const salt = randomBytes(SALT_SIZE)
  const { key, macKey } = deriveKeys(password, salt, profile)
  const pages = Math.ceil(plain.length / PAGE_SIZE)
  const reserve = profile.reserve
  const padded = Buffer.alloc(pages * PAGE_SIZE)
  plain.copy(padded)
  const chunks = [salt]

  for (let index = 0; index < pages; index += 1) {
    const target = index * PAGE_SIZE
    const iv = randomBytes(16)
    // 第 1 页在文件里少 16 字节（那 16 字节是文件 salt，明文里对应的是
    // SQLite 魔数，不需要存），因此该页可存内容比其他页少 16 字节；
    // 每页末尾的 reserve 区用来放 IV + MAC（+ 尾部保留），不承载内容。
    const bodyLength = PAGE_SIZE - (index === 0 ? SALT_SIZE : 0)
    const cipherLen = bodyLength - reserve
    const plainStart = target + (index === 0 ? SALT_SIZE : 0)
    const plainPage = padded.subarray(plainStart, plainStart + cipherLen)
    const cipher = createCipheriv('aes-256-cbc', key, iv)
    cipher.setAutoPadding(false)
    const encrypted = Buffer.concat([cipher.update(plainPage), cipher.final()])
    const mac = pageMac(macKey, profile.hmac, encrypted, iv, index + 1)
    const page = Buffer.alloc(bodyLength)
    encrypted.copy(page, 0)
    iv.copy(page, encrypted.length)
    mac.copy(page, encrypted.length + 16)
    chunks.push(page)
  }
  return Buffer.concat(chunks)
}

/** 明文库自检：能否读出 sqlite_master。 */
const SQLITE_HEADER = Buffer.from([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00])

function hasSqliteHeader(buffer) {
  if (buffer.length < 16) return false
  for (let i = 0; i < 16; i += 1) {
    if (buffer[i] !== SQLITE_HEADER[i]) return false
  }
  return true
}

export function looksLikeSqlite(plain) {
  return hasSqliteHeader(plain)
}

/** 判断文件是否是「未加密的 SQLite」（有些第三方导出会直接给明文）。 */
export function isPlainSqlite(buffer) {
  return hasSqliteHeader(buffer)
}

/**
 * 极快的 raw key 探测：把候选 32 字节直接当 AES key，解第 1 页首个分组，
 * 用 SQLite 页头特征做判定。不做 PBKDF2，因此可以毫秒级跑完数十万候选。
 *
 * 注意第 1 页的两种约定都要兼容：SQLCipher 在第 1 页用文件 salt 顶掉明文的
 * 前 16 字节（"SQLite format 3\0"），所以首分组解出来要么就是魔数本身，
 * 要么是明文的 16..32 字节（页大小 0x1000 + 读写版本 1/1）。
 */
export function probeRawKey(buffer, keyRaw) {
  if (buffer.length < PAGE_SIZE) return null
  if (keyRaw.length !== 16 && keyRaw.length !== 32) return null
  const key32 = keyRaw
  const page = buffer.subarray(SALT_SIZE, PAGE_SIZE)
  const reserves = []
  for (const profile of [...RAW_PROFILES, ...PROFILES]) {
    if (!reserves.includes(profile.reserve)) reserves.push(profile.reserve)
  }
  // 个别构建的 reserve 与预设不同，额外把常见取值都试一遍（每个只解一个分组，代价极小）
  for (const extra of [80, 48, 64, 32, 16]) {
    if (!reserves.includes(extra)) reserves.push(extra)
  }
  for (const reserve of reserves) {
    if (reserve >= PAGE_SIZE) continue
    // page 是「去掉 16 字节 salt 之后」的第 1 页主体，长度 4080，
    // 因此 IV 的页内偏移是 page.length - reserve（不是 4096 - reserve）。
    const ivAt = page.length - reserve
    const iv = page.subarray(ivAt, ivAt + 16)
    if (iv.length < 16) continue
    let block
    try {
      const decipher = createDecipheriv(cipherFor(keyRaw.length), keyRaw, iv)
      decipher.setAutoPadding(false)
      block = Buffer.concat([decipher.update(page.subarray(0, 16)), decipher.final()])
    } catch {
      continue
    }
    const magicHit = hasSqliteHeader(block)
    // Conv B：解密结果其实是明文 16..32，页大小 4096(0x10 0x00) + 读写版本 1/1
    const headerHit = block.length >= 4 && block[0] === 0x10 && block[1] === 0x00 && block[2] <= 0x02 && block[3] <= 0x02 && block[2] > 0 && block[3] > 0
    if (magicHit || headerHit) {
      const match = [...RAW_PROFILES, ...PROFILES].find(item => item.reserve === reserve)
      return match !== undefined ? match.id : `reserve-${reserve}`
    }
  }
  return null
}

