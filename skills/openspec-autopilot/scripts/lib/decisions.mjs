/**
 * 托管记录与托管决策的读写（add-autopilot-loop design D2、D6）。
 *
 * 所属：skill openspec-autopilot。调用方：autopilot.mjs、scheduler.mjs、bridge.mjs。
 * 职责：读出托管记录与决策、分配决策编号、按预期状态比较后写入。
 * 边界：全部写入经 transition，按状态（与可选的 startedAt）比较后才写，先写临时文件再 rename（评审 CONC-02、CONC-07）。
 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, opendirSync, statSync } from 'node:fs'
import path from 'node:path'
import { writeJsonAtomic } from './atomic-write.mjs'
import { readBoundedJson, sameObject } from './bounded-json.mjs'

/** 托管记录的文件名（design D2）。 */
export const RECORD_FILE = 'autopilot.json'

/** 决策文件名的格式：D-0001 递增到四位数字。 */
const DECISION_FILE = /^D-((?!0000)\d{4})\.json$/
const DECISION_LIMIT = 32 * 1024 * 1024
export const OPEN_STATUSES = ['pending', 'answered']
const DECISION_STATUSES = [...OPEN_STATUSES, 'used', 'void']

/** 托管记录与决策的目录名（design D2）。 */
export const DECISIONS_DIR = 'decisions'
let decisionAnchor = null
let checkAnchor = () => {}

/**
 * 项目保护区内将本机文件操作绑定到已核验的决策目录对象。
 * 同步调用使用相对路径。目录名被替换时不能误写同名新对象。
 */
export function inDecisionDirectory(target, restore, work, check = () => {}) {
  if (!target.decisionIdentity) return work(target)
  const directory = decisionsDir(target.directory)
  const original = process.cwd()
  const prior = decisionAnchor
  const priorCheck = checkAnchor
  process.chdir(directory)
  try {
    if (!sameObject(target.decisionIdentity, statSync('.'))) throw new Error('决策目录已改变')
    decisionAnchor = directory
    checkAnchor = check
    return work(target)
  } finally {
    decisionAnchor = prior
    checkAnchor = priorCheck
    try { process.chdir(original) } catch { process.chdir(restore) }
  }
}

function decisionPath(file) {
  return decisionAnchor && path.dirname(file) === decisionAnchor ? path.basename(file) : file
}

/**
 * 读一个 JSON 文件。文件不存在时返回 null；JSON 解析失败时返回 { error }，调用方按「跳过该文件并写日志」处理（design D6）。
 * @param {string} file 文件路径。
 * @returns {{ value: object|null, error: string|null }} 读取结果。
 */
export function readJsonFile(file) {
  try {
    checkAnchor()
    const value = readBoundedJson(decisionPath(file), DECISION_LIMIT)
    checkAnchor()
    return { value, error: null }
  } catch (error) {
    if (error.code === 'ENOENT' && error.path === path.dirname(file)) return { value: null, error: null }
    return { value: null, error: `决策资料读取失败：${file}（${error.code || error.message}）` }
  }
}

/**
 * 变更目录中 decisions/ 的绝对路径。
 * @param {string} changeDir 变更目录。
 * @returns {string} decisions 目录路径。
 */
export function decisionsDir(changeDir) {
  return path.join(changeDir, DECISIONS_DIR)
}

/**
 * 托管记录文件的绝对路径。
 * @param {string} changeDir 变更目录。
 * @returns {string} 托管记录文件路径。
 */
export function recordFile(changeDir) {
  return path.join(decisionsDir(changeDir), RECORD_FILE)
}

/**
 * 读出托管记录。记录不存在时返回 null。
 * @param {string} changeDir 变更目录。
 * @returns {{ value: object|null, error: string|null }} 读取结果。
 */
export function readRecord(changeDir) {
  return readJsonFile(recordFile(changeDir))
}

/**
 * 列出变更目录中的全部决策，按编号升序。JSON 解析失败的文件跳过并在 error 中说明（design D6）。
 * @param {string} changeDir 变更目录。
 * @returns {{ decisions: object[], error: string|null }} 决策列表与错误说明。
 */
export function listDecisions(changeDir) {
  return listDecisionsIn(decisionsDir(changeDir))
}

/**
 * 列出一个 decisions 目录中的全部决策，按编号升序。变更目录与归档目录都直接给这个函数用（design D7 的回退查找）。
 * @param {string} dir decisions 目录。
 * @returns {{ decisions: object[], error: string|null }} 决策列表与错误说明。
 */
export function listDecisionsIn(dir) {
  const decisions = []
  const error = scanDecisions(dir, decision => decisions.push(decision))
  return { decisions: decisions.sort((left, right) => left.id.localeCompare(right.id)), error }
}

export function decisionFile(changeDir, id) {
  if (!DECISION_FILE.test(`${id}.json`)) throw new Error('决策编号无效')
  return path.join(decisionsDir(changeDir), `${id}.json`)
}

export function readDecision(changeDir, id) {
  const result = readJsonFile(decisionFile(changeDir, id))
  if (result.value && (result.value.id !== id || !DECISION_STATUSES.includes(result.value.status))) {
    return { value: null, error: `${id} 的决策内容无效` }
  }
  return result
}

/** 逐项访问决策。中断或任一读取失败时，返回的清单不能用来证明没有未完成决策。 */
export function scanDecisions(dir, visit, checkBudget = () => {}) {
  let stream
  let failure = null
  try {
    const target = dir === decisionAnchor ? '.' : dir
    if (!lstatSync(target).isDirectory()) throw new Error('决策目录类型无效')
    stream = opendirSync(target)
    for (let item = stream.readSync(); item; item = stream.readSync()) {
      checkAnchor()
      checkBudget()
      if (!DECISION_FILE.test(item.name)) continue
      const id = item.name.slice(0, -5)
      const result = readDecision(path.dirname(dir), id)
      checkAnchor()
      checkBudget()
      if (result.value) visit(result.value)
      else failure ||= result.error || `${id} 在枚举后消失`
    }
    return failure
  } catch (error) {
    if (!stream && error.code === 'ENOENT') return null
    return error.code || error.message
  } finally {
    stream?.closeSync()
  }
}

export function voidOpenDecisions(changeDir, voidReason, { preserve = null } = {}) {
  const open = []
  const failed = []
  const error = scanDecisions(decisionsDir(changeDir), decision => {
    if (OPEN_STATUSES.includes(decision.status)) open.push(decision)
  })
  for (const decision of open) {
    if (decision.id === preserve) continue
    const result = transition(decisionFile(changeDir, decision.id), OPEN_STATUSES, { status: 'void', voidReason })
    if (!result.ok) failed.push({ id: decision.id, reason: result.reason })
  }
  return { open, failed, error }
}

/**
 * 下一个决策编号：在已有决策的最大编号上加一，从 D-0001 开始（design D2）。
 * @param {string} changeDir 变更目录。
 * @returns {string} 决策编号。
 */
export function nextDecisionId(changeDir, after = '', checkBudget = () => {}) {
  const directory = decisionsDir(changeDir)
  const target = directory === decisionAnchor ? '.' : directory
  if (!lstatSync(target).isDirectory()) throw new Error('决策目录类型无效')
  const stream = opendirSync(target)
  let max = Number(DECISION_FILE.exec(`${after}.json`)?.[1] || 0)
  try {
    for (let item = stream.readSync(); item; item = stream.readSync()) {
      checkAnchor()
      checkBudget()
      const match = DECISION_FILE.exec(item.name)
      if (match) max = Math.max(max, Number(match[1]))
    }
  } finally {
    stream.closeSync()
  }
  return max < 9999 ? `D-${String(max + 1).padStart(4, '0')}` : null
}

/**
 * 提问指纹：`deferred_tool_use.input` 的 JSON 文本的 SHA-256 前 12 位（design D5）。
 * 指纹绑定提问原文，问题变化时旧回复不能填回。
 * @param {unknown} input 提问的 input 对象。
 * @returns {string} 12 位十六进制指纹。
 */
export function fingerprintOf(input) {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 12)
}

/**
 * 按预期状态比较后写入一个 JSON 文件（design D6，评审 CONC-02、CONC-07）。
 * 先比较再写：后到的写入因状态不符而放弃。写入先写临时文件再 rename，读者只读到完整的新文件。
 * @param {string} file 目标文件。
 * @param {string[]} expectedStatuses 允许的当前状态。
 * @param {object} patch 要合并的字段。
 * @param {{ startedAt?: string, replace?: boolean, allowMissing?: boolean }} [options]
 *   startedAt 给出时，文件中的 startedAt 不等于该值时放弃写入；replace 为 true 时写整个 patch，不合并旧字段
 *   （重新托管时不保留上一次的 implSnapshot 与 exit，design D1）；allowMissing 为 true 时文件不存在也算状态符合。
 * @returns {{ ok: boolean, reason: string|null }} ok 为 false 时 reason 说明放弃的原因。
 */
export function transition(file, expectedStatuses, patch, options = {}) {
  const read = readJsonFile(file)
  if (read.error) return { ok: false, reason: read.error }
  const exists = read.value !== null
  if (!exists && !options.allowMissing) {
    return { ok: false, reason: `文件不存在：${file}` }
  }
  const current = read.value || {}
  const status = current.status
  if (exists && !expectedStatuses.includes(status)) {
    return { ok: false, reason: `状态为 ${status || '（无）'}，不在预期状态 ${expectedStatuses.join('、')} 中` }
  }
  if (options.startedAt !== undefined && current.startedAt !== options.startedAt) {
    return { ok: false, reason: `startedAt 为 ${current.startedAt || '（无）'}，与预期 ${options.startedAt} 不同` }
  }
  try {
    writeDecisionJson(file, options.replace ? patch : { ...current, ...patch })
    return { ok: true, reason: null }
  } catch (error) {
    return { ok: false, reason: error.code || error.message }
  }
}

function writeDecisionJson(file, value, replace = true) {
  if (Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8') + 1 > DECISION_LIMIT) {
    throw new Error('决策资料超过 32 MiB')
  }
  checkAnchor()
  writeJsonAtomic(decisionPath(file), value, { replace })
}

/**
 * 创建决策文件。目录不存在时不创建目录（design D2、D5）：目录只由 autopilot.mjs start 创建。
 * @param {string} changeDir 变更目录。
 * @param {object} decision 决策内容。
 * @returns {{ file: string, id: string }} 决策文件路径与编号。
 */
export function createDecision(changeDir, decision) {
  const id = decision.id || nextDecisionId(changeDir)
  if (!id) throw new Error('四位决策编号已用尽')
  const file = decisionFile(changeDir, id)
  const present = readDecision(changeDir, id)
  if (present.value || present.error) throw new Error('决策编号已占用')
  writeDecisionJson(file, { ...decision, id }, false)
  return { file, id }
}

/**
 * 创建 decisions 目录（0o700）。只有 autopilot.mjs start 调它（design D2）。
 * @param {string} changeDir 变更目录。
 * @returns {string} decisions 目录路径。
 */
export function ensureDecisionsDir(changeDir) {
  const dir = decisionsDir(changeDir)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}
