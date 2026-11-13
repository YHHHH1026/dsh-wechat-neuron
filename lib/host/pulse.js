/**
 * 关系演化（v0.2）：把「关系」变成随时间变化的量。
 *
 * v0.1 的边是时间盲的——chat 边的 weight 用的是 person.total（全生命周期总量），
 * 拖时间轴时只有节点亮暗在变，关系线纹丝不动。这里的三个函数把同一套时间桶
 * 规则抽出来，让 Host 侧（边序列）与渲染层（回放取桶）用同一份 key 逻辑，
 * 避免两边各写一遍、日后悄悄漂移。
 *
 * 本模块是纯函数：不读文件、不碰全局，可在 Node 里直接单测。
 */

export const DAY = 86400
/** 近期用「周桶」，更早用「月桶」——这与 model.js 造时间轴时的粒度切换点一致。 */
export const RECENT_WINDOW_DAYS = 400

/**
 * ISO 周 key，例如 2026-W21。
 *
 * 算法与 model.js 原有实现逐字一致（取本地年月日 → 归一到本周周四 → ISO 周数），
 * 因为这里是从 model.js 抽出来的唯一来源；改算法会让旧图的时间轴对不上新边序列。
 */
export function weekKey(seconds) {
  const date = new Date(seconds * 1000)
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNumber = (target.getUTCDay() + 6) % 7
  target.setUTCDate(target.getUTCDate() - dayNumber + 3)
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4))
  const week = 1 + Math.round(((target - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7)
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/** 月 key，例如 2025-M12。与 model.js 的 `年-M月` 写法一致。 */
export function monthKey(seconds) {
  const date = new Date(seconds * 1000)
  return `${date.getFullYear()}-M${String(date.getMonth() + 1).padStart(2, '0')}`
}

/**
 * 某个时间点落到哪个桶。now 必须是「当前时间秒」，粒度切换点 = now - 400 天。
 * 判据取自 model.js 造时间轴时的同一表达式，两边必须一致，否则回放会取错桶。
 */
export function bucketKeyOf(seconds, now) {
  return seconds > now - RECENT_WINDOW_DAYS * DAY ? weekKey(seconds) : monthKey(seconds)
}

/**
 * 把一组消息压成「每个时间桶上的强度」。
 *
 * @param {Array<{time:number}>} messages 该关系上的消息（time 为秒）
 * @param {Array<{t:string}>} timeline 图的时间轴（有序）
 * @param {number} now 当前时间秒
 * @returns {number[]} 与 timeline 等长；timeline 为空时返回 []
 *
 * 用「桶 key → 计数」再摊平，而不是对每条消息二分查找：
 * 一条关系上的消息数可能上千，桶数一般几十到几百。
 */
export function seriesForBucket(messages, timeline, now) {
  const length = Array.isArray(timeline) ? timeline.length : 0
  if (length === 0) return []
  const indexOfKey = new Map()
  for (let index = 0; index < length; index += 1) {
    const bucket = timeline[index]
    const key = typeof bucket === 'string' ? bucket : bucket?.t
    if (typeof key === 'string' && !indexOfKey.has(key)) indexOfKey.set(key, index)
  }
  const counts = new Array(length).fill(0)
  const list = Array.isArray(messages) ? messages : []
  for (const message of list) {
    const time = message?.time
    if (!Number.isFinite(time) || time <= 0) continue
    const index = indexOfKey.get(bucketKeyOf(time, now))
    if (index !== undefined) counts[index] += 1
  }
  return counts
}

/**
 * 「这段关系在当期有多强」的归一化强度（0..1）。
 *
 * @param {Array<number>} series 关系自身的逐桶计数
 * @param {number[]} scale 全局基线：每个桶「一条满强度关系大约有多少条消息」
 * @param {number} index 当前桶下标；<0 或越界时退回全生命周期总量归一
 * @param {number} total 全生命周期总量（回退用）
 * @param {number} maxTotal 全图最大总量（回退用）
 *
 * baseline = max(1, scale[index]) 是「该桶里一条普通关系大约多少条消息」。
 * 强度 = 1 - exp(-value / baseline)，所以：不足基线→暗淡，达到基线→约 0.63，
 * 远超基线→接近 1。指数曲线保证强弱能拉开，但不会让极端值独占亮度。
 */
export function edgePulse(series, scale, index, total, maxTotal) {
  const fallback = () => {
    const max = Number.isFinite(maxTotal) && maxTotal > 0 ? maxTotal : 1
    return Math.min(1, Math.max(0, (Number.isFinite(total) && total > 0 ? total : 0) / max))
  }
  if (!Array.isArray(series) || !Array.isArray(scale)) return fallback()
  if (!Number.isInteger(index) || index < 0 || index >= series.length || index >= scale.length) return fallback()
  const value = Number.isFinite(series[index]) ? series[index] : 0
  if (value <= 0) return 0
  const baseline = Math.max(1, Number.isFinite(scale[index]) ? scale[index] : 1)
  // 饱和曲线：刚好达到基线 ≈ 0.63，四倍基线 ≈ 0.98。
  // 用指数而不是线性截断，好处是偶发的「一周猛聊」不会把别的关系压成一条线。
  return Math.min(1, 1 - Math.exp(-value / baseline))
}

/**
 * 每个时间桶的强度基线：把「每条关系在每个桶上的计数」按桶求均值。
 * 只统计 >0 的样本——没发过消息的关系不该把基线拉到 0。
 */
export function baselinePerBucket(seriesList, length) {
  const total = Number.isInteger(length) && length > 0 ? length : 0
  if (total === 0) return []
  const sums = new Array(total).fill(0)
  const counts = new Array(total).fill(0)
  for (const series of Array.isArray(seriesList) ? seriesList : []) {
    if (!Array.isArray(series)) continue
    const limit = Math.min(total, series.length)
    for (let index = 0; index < limit; index += 1) {
      const value = series[index]
      if (Number.isFinite(value) && value > 0) {
        sums[index] += value
        counts[index] += 1
      }
    }
  }
  return sums.map((sum, index) => (counts[index] === 0 ? 0 : sum / counts[index]))
}
