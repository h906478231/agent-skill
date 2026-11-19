/**
 * 托管记录与托管决策的读写（add-autopilot-loop design D2、D6）。
 *
 * 所属：skill openspec-autopilot。调用方：autopilot.mjs、scheduler.mjs、bridge.mjs。
 * 职责：读出托管记录与决策、分配决策编号、按预期状态比较后写入。
 * 边界：全部写入经 transition，按状态（与可选的 startedAt）比较后才写，先写临时文件再 rename（评审 CONC-02、CONC-07）。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** 托管记录的文件名（design D2）。 */
export const RECORD_FILE = 'autopilot.json'

/** 决策文件名的格式：D-0001 递增到四位数字。 */
const DECISION_FILE = /^D-(\d{4})\.json$/

/** 托管记录与决策的目录名（design D2）。 */
export const DECISIONS_DIR = 'decisions'

/**
 * 读一个 JSON 文件。文件不存在时返回 null；JSON 解析失败时返回 { error }，调用方按「跳过该文件并写日志」处理（design D6）。
 * @param {string} file 文件路径。
 * @returns {{ value: object|null, error: string|null }} 读取结果。
 */
export function readJsonFile(file) {
  if (!existsSync(file)) return { value: null, error: null }
  try {
    return { value: JSON.parse(readFileSync(file, 'utf8')), error: null }
  } catch (error) {
    return { value: null, error: `JSON 解析失败：${file}（${error.message}）` }
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
  if (!existsSync(dir)) return { decisions: [], error: null }
  const names = readdirSync(dir).filter(name => DECISION_FILE.test(name)).sort()
  const decisions = []
  const errors = []
  for (const name of names) {
    const read = readJsonFile(path.join(dir, name))
    if (read.error) {
      errors.push(read.error)
      continue
    }
    if (read.value) decisions.push({ ...read.value, id: read.value.id || name.replace(/\.json$/, '') })
  }
  return { decisions, error: errors.length ? errors.join('；') : null }
}

/**
 * 下一个决策编号：在已有决策的最大编号上加一，从 D-0001 开始（design D2）。
 * @param {string} changeDir 变更目录。
 * @returns {string} 决策编号。
 */
export function nextDecisionId(changeDir) {
  const { decisions } = listDecisions(changeDir)
  const max = decisions.reduce((last, decision) => {
    const match = DECISION_FILE.exec(`${decision.id}.json`)
    return match ? Math.max(last, Number(match[1])) : last
  }, 0)
  return `D-${String(max + 1).padStart(4, '0')}`
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
  writeJsonAtomic(file, options.replace ? patch : { ...current, ...patch })
  return { ok: true, reason: null }
}

/**
 * 原子写一个 JSON 文件：先写 <file>.tmp.<pid>，再 rename 覆盖（design D6）。
 * @param {string} file 目标文件。
 * @param {unknown} value 要写入的值。
 * @returns {string} 目标文件路径。
 */
export function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp.${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, file)
  return file
}

/**
 * 创建决策文件。目录不存在时不创建目录（design D2、D5）：目录只由 autopilot.mjs start 创建。
 * @param {string} changeDir 变更目录。
 * @param {object} decision 决策内容。
 * @returns {{ file: string, id: string }} 决策文件路径与编号。
 */
export function createDecision(changeDir, decision) {
  const id = decision.id || nextDecisionId(changeDir)
  const file = path.join(decisionsDir(changeDir), `${id}.json`)
  writeJsonAtomic(file, { ...decision, id })
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
