/**
 * 演示数据集：在没有密钥、或用户还没配置微信数据目录时，让 3D 视图依然可用。
 *
 * 数据是确定性生成的（固定随机种子），这样每次打开看到的图谱一致，
 * 便于用户理解各个维度与交互，也便于截图/回归。
 */

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PEOPLE = [
  ['陈墨', '产品协作 · 每日同步', 96],
  ['林秋白', '设计评审 / 灵感交换', 78],
  ['周砚', '技术方案 · 架构讨论', 71],
  ['苏晗', '家人 · 晚安安', 88],
  ['顾青禾', '客户对接 · 需求变更', 54],
  ['许亦', '老同学 · 偶尔叙旧', 33],
  ['沈子航', '读书会 · 每周分享', 41],
  ['白露', '健身搭子 · 打卡', 46],
  ['孟轲', '前同事 · 行业消息', 22],
  ['温言', '写作伙伴 · 长文互评', 62],
  ['江迟', '摄影群 · 约拍', 28],
  ['叶知秋', '邻居 · 生活互助', 18],
]

const GROUPS = [
  ['星火产品组', ['陈墨', '林秋白', '周砚', '顾青禾'], 220],
  ['家庭群', ['苏晗'], 160],
  ['读书会 · 深夜书房', ['沈子航', '温言', '叶知秋'], 130],
  ['夜跑打卡', ['白露', '江迟'], 90],
  ['行业观察 · 前沿', ['孟轲', '周砚', '许亦'], 70],
]

const TOPIC_POOL = [
  '需求评审', '版本发布', '设计稿', '性能优化', '接口联调', '预算', '招聘', '周报',
  '晚安', '周末', '旅行', '摄影', '读书', '电影', '跑步', '咖啡', '天气', '会议',
  '复盘', '数据看板', '用户反馈', '上线', '加班', '灵感', '长文', '合同', '验收',
]

const KIND_POOL = [
  ['text', 0.66], ['image', 0.12], ['voice', 0.08], ['link', 0.06],
  ['video', 0.03], ['sticker', 0.03], ['call', 0.01], ['redpacket', 0.01],
]

function pickKind(random) {
  let roll = random()
  for (const [kind, weight] of KIND_POOL) {
    roll -= weight
    if (roll <= 0) return kind
  }
  return 'text'
}

/**
 * 生成演示数据，返回与 extract.js 一致的 { contacts, sessions, messages }。
 * @param {{now?:number, seed?:number, messageCount?:number}} options
 */
export function demoDataset(options = {}) {
  const random = mulberry32(options.seed ?? 20261110)
  const now = Math.floor((options.now ?? Date.now()) / 1000)
  const targetMessages = options.messageCount ?? 2600
  const contacts = []
  const sessions = []
  const messages = []

  const personState = new Map()
  for (const [name, note, activity] of PEOPLE) {
    contacts.push({ username: `wxid_${name}`, nickname: name, remark: '', alias: '', wxType: 3, avatar: '', account: 'demo', note })
    personState.set(name, { activity, last: 0, count: 0 })
  }
  for (const [name] of GROUPS) {
    contacts.push({ username: `${name}@chatroom`, nickname: name, remark: '', alias: '', wxType: 2, avatar: '', account: 'demo', note: 'group' })
    personState.set(name, { activity: 60, last: 0, count: 0 })
  }

  const senderOf = (group) => {
    const members = GROUPS.find(item => item[0] === group)?.[1] ?? []
    return members[Math.floor(random() * members.length)] ?? '我'
  }

  let cursor = now - 330 * 86400
  let produced = 0
  while (produced < targetMessages && cursor < now) {
    cursor += Math.floor(random() * 9000) + 600
    // 选择会话：按活跃度加权
    const candidates = [...personState.entries()]
    const totalWeight = candidates.reduce((sum, [, state]) => sum + state.activity, 0)
    let roll = random() * totalWeight
    let chosen = candidates[0][0]
    for (const [name, state] of candidates) {
      roll -= state.activity
      if (roll <= 0) { chosen = name; break }
    }
    const isGroup = GROUPS.some(item => item[0] === chosen)
    const kind = pickKind(random)
    const topic = TOPIC_POOL[Math.floor(random() * TOPIC_POOL.length)]
    const text = kind === 'text'
      ? `${topic}这事儿我看了下，${['明天上午', '今天下午', '下周一', '本周内'][Math.floor(random() * 4)]}给你回。`
      : ''
    const sender = isGroup
      ? (random() < 0.35 ? '__self__' : senderOf(chosen))
      : (random() < 0.5 ? '__self__' : `wxid_${chosen}`)
    messages.push({
      id: `demo_${produced}`,
      account: 'demo',
      talker: isGroup ? `${chosen}@chatroom` : `wxid_${chosen}`,
      sender,
      time: cursor,
      kind,
      type: 1,
      text,
    })
    const state = personState.get(chosen)
    state.last = cursor
    state.count += 1
    produced += 1
  }

  for (const [name, state] of personState) {
    const isGroup = GROUPS.some(item => item[0] === name)
    sessions.push({
      username: isGroup ? `${name}@chatroom` : `wxid_${name}`,
      wxType: isGroup ? 2 : 3,
      lastTime: state.last,
      lastMsgType: 1,
      summary: '',
      unread: Math.floor(random() * 5),
      display: name,
      account: 'demo',
    })
  }

  return { contacts, sessions, messages }
}

/** 演示数据集的多维分析（给节点详情用）。 */
export function demoMeta() {
  return { source: 'demo', account: 'demo', warnings: [{ code: 'DEMO_DATA', level: 'info', message: '当前展示的是内置演示数据；配置微信数据目录与密钥后可切换到真实记录。' }] }
}
