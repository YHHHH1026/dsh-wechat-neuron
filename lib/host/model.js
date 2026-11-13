/**
 * 多维关系建模：把「联系人 / 会话 / 消息」三张原始表变成可渲染的神经元图谱。
 *
 * 产物遵循 docs/DESIGN.md 第 10 章的数据契约：
 *   { meta, nodes[], edges[], timeline }
 *
 * 五个维度在这里落地：
 *   时间   —— recency / span / 时间轴桶
 *   人员   —— reciprocity / initiation / 群成员关系 / 共现关系
 *   消息类型 —— depth（非短文本占比）与类型分布
 *   关键词 —— 本地中文 2-gram + 停用词 + 跨会话 IDF 的 topicProfile
 *   互动频次 —— frequency（近 90 天日均）
 * 重要度 score 由六个归一化特征加权得到（DESIGN.md 6.4）。
 */

import { bucketKeyOf, seriesForBucket } from './pulse.js'

const DAY = 86400
const TYPE_WEIGHT = { text: 0.2, image: 0.6, voice: 0.8, video: 0.7, link: 0.5, card: 0.5, sticker: 0.3, location: 0.5, call: 0.7, redpacket: 0.6, system: 0, other: 0.3, file: 0.9 }

const STOPWORDS = new Set([
  '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你',
  '会', '着', '没有', '看', '好', '自己', '这', '那', '这个', '那个', '什么', '怎么', '可以', '我们', '他们', '现在', '还是',
  '但是', '因为', '所以', '如果', '就是', '不是', '知道', '觉得', '真的', '这样', '时候', '一下', '已经', '还有', '然后',
  '嗯', '哦', '啊', '吧', '呢', '吗', '哈', '呀', '嘛', '啦', '喂', '额', 'emmm', 'ok', 'OK', 'okay', '是的', '好的',
  '收到', '谢谢', '你好', '在吗', '在么', '哈哈', '哈哈哈', '表情', '图片', '语音', '视频', '链接', '文件', '位置', '转账',
])

const INTIMATE_WORDS = ['想你', '喜欢', '爱你', '抱抱', '晚安', '早安', '亲爱', '宝贝', '开心', '难过', '累', '休息', '注意身体', '辛苦']

function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))
  return sorted[index]
}

function normalize(value, min, max) {
  if (!Number.isFinite(value)) return 0
  if (max - min < 1e-9) return max === 0 ? 0 : 0.5
  return Math.min(1, Math.max(0, (value - min) / (max - min)))
}

function expDecay(days, halfLife = 30) {
  if (!Number.isFinite(days) || days < 0) return 0
  return Math.exp(-days / halfLife)
}

function logScale(value, ceiling) {
  if (value <= 0) return 0
  return Math.min(1, Math.log10(1 + value) / Math.log10(1 + ceiling))
}

/** 中文友好分词：按标点/空白切段，段内取 2-gram，过滤停用词与纯数字。 */
export function tokenize(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const out = []
  const segments = text.split(/[\s，。！？、；：""''（）()\[\]{}<>,.!?;:'"\/\\|~`@#$%^&*+=_-]+/u)
  for (const segment of segments) {
    const clean = segment.replace(/\[[^\]]*\]/g, '').replace(/https?:\/\/\S+/g, '').trim()
    if (clean.length === 0) continue
    if (clean.length <= 3) {
      if (!STOPWORDS.has(clean) && !/^\d+$/.test(clean)) out.push(clean)
      continue
    }
    if (/^[a-zA-Z0-9]+$/.test(clean)) {
      if (clean.length >= 3 && !STOPWORDS.has(clean.toLowerCase())) out.push(clean.toLowerCase())
      continue
    }
    for (let i = 0; i + 2 <= clean.length; i += 1) {
      const gram = clean.slice(i, i + 2)
      if (STOPWORDS.has(gram)) continue
      out.push(gram)
    }
  }
  return out
}

function guessIsGroup(username) {
  if (typeof username !== 'string') return false
  return username.endsWith('@chatroom') || username.startsWith('@chatroom')
}

function looksLikeOfficial(username) {
  if (typeof username !== 'string') return false
  return username.startsWith('gh_') || username === 'filehelper' || username === 'weixin' || username === 'fmessage' || username === 'medianote' || username === 'floatbottle' || username.startsWith('@placeholder')
}

function dateKey(seconds) {
  const date = new Date(seconds * 1000)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

// weekKey / monthKey / bucketKeyOf 统一在 pulse.js 里实现：
// 造图与回放取桶必须用同一套键，否则边序列会整体错位一格。

/**
 * 构建图谱。
 * @param {object} input
 * @param {Array} input.contacts  readContacts 的结果
 * @param {Array} input.sessions  readSessions 的结果
 * @param {Array} input.messages  readMessages 的结果
 * @param {object} [input.options] { selfName, maxTopics, now }
 */
export function buildGraph(input) {
  const contacts = input.contacts ?? []
  const sessions = input.sessions ?? []
  const messages = input.messages ?? []
  const now = Math.floor((input.options?.now ?? Date.now()) / 1000)
  const maxTopics = input.options?.maxTopics ?? 24

  const contactByUsername = new Map()
  for (const contact of contacts) contactByUsername.set(contact.username, contact)

  // ---------- 1. 会话聚合 ----------
  /** @type {Map<string, {msgs:Array, sent:number, recv:number, first:number, last:number, byType:Record<string,number>, senderCounts:Map<string,number>}>} */
  const talks = new Map()
  const ensureTalk = (talker) => {
    let talk = talks.get(talker)
    if (talk === undefined) {
      talk = { msgs: [], sent: 0, recv: 0, first: Number.POSITIVE_INFINITY, last: 0, byType: {}, senderCounts: new Map(), dateSet: new Set() }
      talks.set(talker, talk)
    }
    return talk
  }

  for (const message of messages) {
    const talker = message.talker
    if (typeof talker !== 'string' || talker === '') continue
    const talk = ensureTalk(talker)
    talk.msgs.push(message)
    if (message.time > 0) {
      if (message.time < talk.first) talk.first = message.time
      if (message.time > talk.last) talk.last = message.time
      talk.dateSet.add(dateKey(message.time))
    }
    talk.byType[message.kind] = (talk.byType[message.kind] ?? 0) + 1
    if (message.sender === '__self__') talk.sent += 1
    else if (guessIsGroup(talker)) talk.senderCounts.set(message.sender, (talk.senderCounts.get(message.sender) ?? 0) + 1)
    else talk.recv += 1
  }

  // 会话表补时间（有些账号消息被清理但会话行还在）
  for (const session of sessions) {
    const talk = talks.get(session.username)
    if (talk === undefined) continue
    if (talk.last === 0 && session.lastTime > 0) talk.last = session.lastTime > 1e12 ? Math.floor(session.lastTime / 1000) : session.lastTime
  }

  // ---------- 2. 关键词 / 话题 ----------
  const docFreq = new Map()
  const talkTokens = new Map()
  for (const [talker, talk] of talks) {
    const counts = new Map()
    for (const message of talk.msgs) {
      if (message.kind !== 'text' && message.kind !== 'link') continue
      for (const token of tokenize(message.text)) counts.set(token, (counts.get(token) ?? 0) + 1)
    }
    talkTokens.set(talker, counts)
    for (const token of counts.keys()) docFreq.set(token, (docFreq.get(token) ?? 0) + 1)
  }
  const docCount = Math.max(1, talks.size)
  const topicScores = new Map()
  for (const [talker, counts] of talkTokens) {
    for (const [token, count] of counts) {
      if (count < 3) continue
      const idf = Math.log((docCount + 1) / ((docFreq.get(token) ?? 1) + 0.5))
      const tf = Math.log(1 + count) / 10
      const weighted = tf * Math.max(0.05, idf)
      const bucket = topicScores.get(token) ?? { token, score: 0, talks: new Set() }
      bucket.score += weighted
      bucket.talks.add(talker)
      topicScores.set(token, bucket)
    }
  }
  const topics = [...topicScores.values()].sort((a, b) => b.score - a.score).slice(0, maxTopics)
  const topicId = new Map()
  topics.forEach((topic, index) => topicId.set(topic.token, `t_${String(index + 1).padStart(2, '0')}`))

  // ---------- 3. 人员特征 ----------
  const people = []
  for (const [talker, talk] of talks) {
    const isGroup = guessIsGroup(talker)
    const contact = contactByUsername.get(talker)
    const total = talk.msgs.length
    if (total === 0) continue
    const lastDays = talk.last > 0 ? Math.max(0, (now - talk.last) / DAY) : 9999
    const spanDays = Number.isFinite(talk.first) && talk.last > talk.first ? (talk.last - talk.first) / DAY : 0
    const recent90 = talk.msgs.filter(message => message.time > now - 90 * DAY).length
    const msgPerDay = recent90 / 90
    const depthSum = talk.msgs.reduce((sum, message) => sum + (TYPE_WEIGHT[message.kind] ?? 0.3), 0)
    const depth = total === 0 ? 0 : depthSum / total
    const sent = talk.sent
    const recv = isGroup ? [...talk.senderCounts.values()].reduce((a, b) => a + b, 0) : talk.recv
    const reciprocity = sent + recv === 0 ? 0 : 1 - Math.abs(sent - recv) / Math.max(sent, recv)
    // 主动度：按「会话日」里对方先开口的比例近似（近 30 天）
    const byDay = new Map()
    for (const message of talk.msgs) {
      if (message.time < now - 30 * DAY) continue
      const key = dateKey(message.time)
      const bucket = byDay.get(key)
      if (bucket === undefined) byDay.set(key, { first: message, count: 1 })
      else {
        if (message.time < bucket.first.time) bucket.first = message
        bucket.count += 1
      }
    }
    let initiatedByThem = 0
    for (const bucket of byDay.values()) if (bucket.first.sender !== '__self__') initiatedByThem += 1
    const initiation = byDay.size === 0 ? 0 : initiatedByThem / byDay.size
    const intimateHits = talk.msgs.reduce((sum, message) => {
      if (message.kind !== 'text') return sum
      const text = String(message.text ?? '')
      let hits = 0
      for (const word of INTIMATE_WORDS) if (text.includes(word)) hits += 1
      return sum + hits
    }, 0)
    const intimacy = Math.min(1, intimateHits / 50)

    people.push({
      talker,
      isGroup,
      contact,
      label: contact?.remark || contact?.nickname || contact?.alias || (isGroup ? `群 ${talker.slice(0, 8)}` : talker),
      total,
      sent,
      recv,
      lastDays,
      spanDays,
      msgPerDay,
      depth,
      reciprocity,
      initiation,
      intimacy,
      last: talk.last,
      first: talk.first,
      byType: talk.byType,
      senderCounts: talk.senderCounts,
      msgs: talk.msgs,
      recent90,
      official: looksLikeOfficial(talker),
    })
  }

  // 归一化（person/group 一起算，保持可比）
  const recipients = people.filter(person => !person.official)
  const recencyRaw = recipients.map(person => expDecay(person.lastDays))
  const freqRaw = recipients.map(person => logScale(person.msgPerDay, 50))
  const recipRaw = recipients.map(person => person.reciprocity)
  const initRaw = recipients.map(person => person.initiation)
  const depthRaw = recipients.map(person => person.depth)
  const intimRaw = recipients.map(person => person.intimacy)

  const bounds = (values) => {
    if (values.length === 0) return [0, 1]
    const lo = percentile(values, 0.05)
    const hi = percentile(values, 0.95)
    return lo === hi ? [0, Math.max(1e-6, hi)] : [lo, hi]
  }
  const bRecency = bounds(recencyRaw)
  const bFreq = bounds(freqRaw)
  const bRecip = bounds(recipRaw)
  const bInit = bounds(initRaw)
  const bDepth = bounds(depthRaw)
  const bIntim = bounds(intimRaw)

  const nodes = []
  const edges = []
  const selfId = 's'

  const totalMessages = messages.length
  const firstTime = messages.reduce((min, message) => (message.time > 0 && message.time < min ? message.time : min), Number.POSITIVE_INFINITY)
  const lastTime = messages.reduce((max, message) => (message.time > max ? message.time : max), 0)

  nodes.push({
    id: selfId,
    type: 'self',
    label: input.options?.selfName || '我',
    score: 100,
    tier: 'core',
    metrics: { recency: 1, frequency: 1, reciprocity: 1, initiation: 1, depth: 1, intimacy: 1 },
    stats: { msgCount: totalMessages, sent: recipients.reduce((s, p) => s + p.sent, 0), recv: recipients.reduce((s, p) => s + p.recv, 0), lastTime: lastTime > 0 ? dateKey(lastTime) : null },
    topics: [],
    pos: [0, 0, 0],
  })

  let index = 0
  for (const person of recipients) {
    index += 1
    const recency = normalize(expDecay(person.lastDays), bRecency[0], bRecency[1])
    const frequency = normalize(logScale(person.msgPerDay, 50), bFreq[0], bFreq[1])
    const reciprocity = normalize(person.reciprocity, bRecip[0], bRecip[1])
    const initiation = normalize(person.initiation, bInit[0], bInit[1])
    const depth = normalize(person.depth, bDepth[0], bDepth[1])
    const intimacy = normalize(person.intimacy, bIntim[0], bIntim[1])
    let score = 100 * (0.30 * recency + 0.22 * frequency + 0.16 * reciprocity + 0.12 * initiation + 0.10 * depth + 0.10 * intimacy)
    if (person.total < 5) score = Math.min(score, 12)
    score = Math.round(score * 10) / 10
    const tier = score >= 75 ? 'core' : score >= 60 ? 'friend' : score >= 40 ? 'regular' : score >= 20 ? 'weak' : 'silent'

    // 话题归属：该会话 top3 topic
    const counts = talkTokens.get(person.talker) ?? new Map()
    const personTopics = [...counts.entries()]
      .filter(([token]) => topicId.has(token))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([token, count]) => ({ id: topicId.get(token), label: token, weight: Math.min(1, count / Math.max(1, person.total)) }))

    const nodeId = `${person.isGroup ? 'g' : 'p'}_${String(index).padStart(4, '0')}`
    person.nodeId = nodeId
    nodes.push({
      id: nodeId,
      type: person.isGroup ? 'group' : 'person',
      label: person.label,
      username: person.talker,
      score,
      tier,
      metrics: {
        recency: Math.round(recency * 100) / 100,
        frequency: Math.round(frequency * 100) / 100,
        reciprocity: Math.round(reciprocity * 100) / 100,
        initiation: Math.round(initiation * 100) / 100,
        depth: Math.round(depth * 100) / 100,
        intimacy: Math.round(intimacy * 100) / 100,
      },
      stats: {
        msgCount: person.total,
        sent: person.sent,
        recv: person.recv,
        lastTime: person.last > 0 ? dateKey(person.last) : null,
        firstTime: Number.isFinite(person.first) ? dateKey(person.first) : null,
        spanDays: Math.round(person.spanDays),
        recent90: person.recent90,
        memberCount: person.isGroup ? person.senderCounts.size : 0,
      },
      distribution: person.byType,
      topics: personTopics,
      pos: null,
    })

    edges.push({
      id: `e_${nodeId}`,
      source: selfId,
      target: nodeId,
      type: 'chat',
      weight: person.total,
      directed: true,
      sent: person.sent,
      recv: person.recv,
      // 逐桶强度（v0.2）：回放时这条关系自己会呼吸，而不是只有节点在变。
      // 序列在时间轴造好之后再填，见下面的 «关系序列» 一段。
    })
  }

  // 群 → 成员边（成员若也单独聊过天，则连到那个人节点）
  const nodeByUsername = new Map()
  for (const node of nodes) if (node.username !== undefined) nodeByUsername.set(node.username, node.id)
  for (const person of recipients) {
    if (!person.isGroup) continue
    const groupNode = nodes.find(node => node.username === person.talker)
    if (groupNode === undefined) continue
    for (const [member, count] of person.senderCounts) {
      if (member === '' || member === '__self__') continue
      const targetId = nodeByUsername.get(member)
      if (targetId !== undefined) {
        edges.push({ id: `e_${groupNode.id}_${targetId}`, source: groupNode.id, target: targetId, type: 'group-member', weight: count, directed: false })
      } else {
        // 只出现在群里的人：补一个轻量成员节点
        const memberContact = contactByUsername.get(member)
        const memberId = `p_m_${String(nodes.length).padStart(4, '0')}`
        // 4.x 的 real_sender_id 是自增整数，Name2Id 反查失败时会剩下裸数字
        const memberFallback = /^\d+$/.test(member) ? `成员 #${member}` : member.slice(0, 10)
        nodes.push({
          id: memberId,
          type: 'person',
          label: memberContact?.remark || memberContact?.nickname || memberFallback,
          username: member,
          score: 8,
          tier: 'silent',
          metrics: { recency: 0, frequency: 0, reciprocity: 0, initiation: 0, depth: 0, intimacy: 0 },
          stats: { msgCount: count, sent: 0, recv: count, lastTime: null, memberCount: 0 },
          distribution: {},
          topics: [],
          groupOnly: true,
          pos: null,
        })
        nodeByUsername.set(member, memberId)
        edges.push({ id: `e_${groupNode.id}_${memberId}`, source: groupNode.id, target: memberId, type: 'group-member', weight: count, directed: false })
      }
    }
  }

  // person ↔ person 共现（同群发言）
  const cooccur = new Map()
  for (const person of recipients) {
    if (!person.isGroup) continue
    const members = [...person.senderCounts.keys()].filter(member => nodeByUsername.has(member))
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const a = members[i]
        const b = members[j]
        const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`
        cooccur.set(key, (cooccur.get(key) ?? 0) + 1)
      }
    }
  }
  let coIndex = 0
  for (const [key, strength] of [...cooccur.entries()].sort((a, b) => b[1] - a[1]).slice(0, 400)) {
    if (strength < 2) continue
    const [a, b] = key.split('\u0000')
    const sourceId = nodeByUsername.get(a)
    const targetId = nodeByUsername.get(b)
    if (sourceId === undefined || targetId === undefined) continue
    coIndex += 1
    edges.push({ id: `e_co_${coIndex}`, source: sourceId, target: targetId, type: 'co-occurrence', weight: strength, directed: false })
  }

  // 话题节点 + 边
  const topicNodes = []
  for (const topic of topics) {
    const id = topicId.get(topic.token)
    topicNodes.push({
      id,
      type: 'topic',
      label: topic.token,
      score: Math.round(Math.min(100, topic.score * 30) * 10) / 10,
      tier: 'topic',
      metrics: { recency: 0, frequency: 0, reciprocity: 0, initiation: 0, depth: 0, intimacy: 0 },
      stats: { msgCount: topic.talks.size },
      topics: [],
      pos: null,
    })
  }
  nodes.push(...topicNodes)
  for (const node of nodes) {
    if (node.type !== 'person' && node.type !== 'group') continue
    for (const topic of node.topics) {
      edges.push({ id: `e_t_${node.id}_${topic.id}`, source: node.id, target: topic.id, type: 'topic', weight: Math.round(topic.weight * 100), directed: false })
    }
  }

  // ---------- 4. 时间轴 ----------
  const buckets = new Map()
  for (const message of messages) {
    if (message.time <= 0) continue
    const key = bucketKeyOf(message.time, now)
    const bucket = buckets.get(key) ?? { t: key, messages: 0, activeNodes: new Set(), top: new Map() }
    bucket.messages += 1
    if (message.talker !== '') {
      bucket.top.set(message.talker, (bucket.top.get(message.talker) ?? 0) + 1)
      const id = nodeByUsername.get(message.talker)
      if (id !== undefined) bucket.activeNodes.add(id)
    }
    buckets.set(key, bucket)
  }
  const timeline = [...buckets.values()]
    .sort((a, b) => (a.t < b.t ? -1 : 1))
    .map(bucket => ({
      t: bucket.t,
      messages: bucket.messages,
      activeNodes: bucket.activeNodes.size,
      top: [...bucket.top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([username]) => nodeByUsername.get(username)).filter(Boolean),
    }))

  // 每个人员/群节点在时间轴每个桶上的活跃度序列（时间轴播放用）
  const bucketIndex = new Map(timeline.map((bucket, index) => [bucket.t, index]))
  const bucketKeyFor = (seconds) => bucketKeyOf(seconds, now)
  for (const node of nodes) {
    if (node.type !== 'person' && node.type !== 'group') continue
    const person = recipients.find(item => item.nodeId === node.id)
    if (person === undefined) continue
    const series = new Array(timeline.length).fill(0)
    for (const message of person.msgs) {
      if (message.time <= 0) continue
      const index = bucketIndex.get(bucketKeyFor(message.time))
      if (index !== undefined) series[index] += 1
    }
    node.series = series
  }

  // 关系序列（v0.2）：每条「我 ↔ 某人/某群」的 chat 边也带逐桶计数，
  // 外加我发 / 对方发的分桶计数，用来在抽屉里画「这段关系怎么变的」。
  const chatUsers = new Map()
  for (const person of recipients) {
    if (person.nodeId !== undefined) chatUsers.set(person.nodeId, person)
  }
  for (const edge of edges) {
    if (edge.type !== 'chat') continue
    const person = chatUsers.get(edge.target)
    if (person === undefined) continue
    edge.series = seriesForBucket(person.msgs, timeline, now)
    const mine = []
    const theirs = []
    for (const message of person.msgs) {
      if (!Number.isFinite(message.time) || message.time <= 0) continue
      ;(message.sender === '__self__' ? mine : theirs).push(message)
    }
    edge.sentSeries = seriesForBucket(mine, timeline, now)
    edge.recvSeries = seriesForBucket(theirs, timeline, now)
  }

  // ---------- 5. 元信息 ----------
  const graph = {
    meta: {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      source: input.options?.source ?? 'local',
      account: input.options?.account ?? 'self',
      counts: { nodes: nodes.length, edges: edges.length, messages: totalMessages, contacts: contacts.length },
      timeRange: Number.isFinite(firstTime) && lastTime > 0 ? [dateKey(firstTime), dateKey(lastTime)] : null,
      warnings: input.options?.warnings ?? [],
    },
    nodes,
    edges,
    timeline,
  }
  return graph
}

/** 节点详情：给 UI 右侧抽屉用。 */
function distributionFor(node, relevant) {
  const base = node.distribution
  if (base !== undefined && base !== null && Object.keys(base).length > 0) return base
  const counts = {}
  for (const message of relevant) {
    const kind = message.kind ?? 'other'
    counts[kind] = (counts[kind] ?? 0) + 1
  }
  return counts
}

export function nodeDetail(graph, nodeId, messages) {
  const node = graph.nodes.find(item => item.id === nodeId)
  if (node === undefined) return null
  const related = graph.edges.filter(edge => edge.source === nodeId || edge.target === nodeId)
  const nodeById = new Map(graph.nodes.map(item => [item.id, item]))
  const talker = node.username
  const relevant = node.type === 'self'
    ? messages
    : (talker === undefined ? [] : messages.filter(message => message.talker === talker))

  const keyCounts = new Map()
  for (const message of relevant) {
    if (message.kind !== 'text') continue
    for (const token of tokenize(message.text)) keyCounts.set(token, (keyCounts.get(token) ?? 0) + 1)
  }
  const topKeywords = [...keyCounts.entries()]
    .filter(([token]) => !STOPWORDS.has(token) && token.length >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([w, n]) => ({ w, n }))

  const byMonth = new Map()
  for (const message of relevant) {
    if (message.time <= 0) continue
    const key = dateKey(message.time).slice(0, 7)
    byMonth.set(key, (byMonth.get(key) ?? 0) + 1)
  }
  const monthly = [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([month, count]) => ({ month, count }))

  const samples = [...relevant]
    .sort((a, b) => b.time - a.time)
    .slice(0, 20)
    .map(message => ({
      time: new Date(message.time * 1000).toISOString(),
      from: message.sender === '__self__' ? 'me' : 'them',
      type: message.kind,
      text: message.kind === 'text' ? String(message.text ?? '').slice(0, 160) : `[${message.kind}]`,
    }))

  // 关系热度（v0.2）：抽屉里画「我和这个人」的走势。
  // 只有 chat 边带序列；群成员/共现/话题边没有时间维度，明确返回 null。
  const chatEdge = graph.edges.find(edge => edge.type === 'chat'
    && (edge.source === nodeId || edge.target === nodeId)
    && Array.isArray(edge.series))
  const relation = chatEdge === undefined
    ? null
    : {
      edgeId: chatEdge.id,
      series: chatEdge.series,
      sentSeries: Array.isArray(chatEdge.sentSeries) ? chatEdge.sentSeries : [],
      recvSeries: Array.isArray(chatEdge.recvSeries) ? chatEdge.recvSeries : [],
      buckets: (graph.timeline ?? []).map(bucket => bucket.t),
    }

  return {
    node: {
      id: node.id,
      label: node.label,
      type: node.type,
      score: node.score,
      tier: node.tier,
      username: node.username ?? null,
    },
    metrics: node.metrics,
    stats: node.stats,
    distribution: distributionFor(node, relevant),
    topKeywords,
    monthly,
    relation,
    samples,
    neighbors: related.map(edge => {
      const otherId = edge.source === nodeId ? edge.target : edge.source
      const other = nodeById.get(otherId)
      return { id: otherId, label: other?.label ?? otherId, type: other?.type ?? 'unknown', edgeType: edge.type, weight: edge.weight }
    }).sort((a, b) => b.weight - a.weight).slice(0, 40),
  }
}

export const MODEL_CONST = { DAY, TYPE_WEIGHT, STOPWORDS, INTIMATE_WORDS }
