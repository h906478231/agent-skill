/**
 * 托管目录与配置的读取（add-autopilot-loop design D2）。
 *
 * 所属：skill openspec-autopilot。调用方：autopilot.mjs、scheduler.mjs、bridge.mjs、perm-host.mjs、install.mjs。
 * 职责：解析托管目录的位置、读出 config.json、提供进度视图脚本的缺省路径、写托管日志。
 * 边界：只读配置与建目录，不写业务状态；托管状态只写在变更目录中。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本 skill 的目录：脚本在 <skill>/scripts/lib/，向上两级是 skill 根。 */
const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** 托管目录的缺省名（design D2）：~/.openspec-autopilot/，可用环境变量 OPENSPEC_AUTOPILOT_HOME 改。 */
const DEFAULT_HOME_NAME = '.openspec-autopilot'
const startupDirectory = process.cwd()

/**
 * 托管目录的绝对路径。测试用环境变量指向临时目录（design D2）。
 * @returns {string} 托管目录路径。
 */
export function homeDir() {
  const fromEnv = process.env.OPENSPEC_AUTOPILOT_HOME
  return fromEnv && fromEnv.trim() ? path.resolve(startupDirectory, fromEnv.trim()) : path.join(homedir(), DEFAULT_HOME_NAME)
}

/**
 * 进度视图脚本的缺省路径：相对本 skill 的 ../openspec-change-progress/scripts/progress.mjs（design D2）。
 * @returns {string} 脚本绝对路径。
 */
export function defaultProgressBin() {
  return path.resolve(SKILL_DIR, '../openspec-change-progress/scripts/progress.mjs')
}

/**
 * 读出托管配置。配置不存在或格式错误时抛出，由调用方转为退出码 2。
 * @returns {object} 配置内容，progressBin 缺省时补上缺省路径。
 */
export function readConfig() {
  const file = path.join(homeDir(), 'config.json')
  if (!existsSync(file)) throw new Error(`找不到托管配置：${file}。运行 install.mjs --write 写出配置模板`)
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`托管配置不是合法 JSON：${file}（${error.message}）`)
  }
  if (!Array.isArray(parsed.projects) || !parsed.projects.length) {
    throw new Error(`托管配置缺少 projects：${file}`)
  }
  return { ...parsed, progressBin: parsed.progressBin || defaultProgressBin() }
}

/**
 * 创建托管目录（0o700，design D2 与评审 SEC-08）。
 * @returns {string} 托管目录路径。
 */
export function ensureHomeDir() {
  const dir = homeDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/**
 * 在托管目录中写一个文件（0o600，design D2 与评审 SEC-08）。
 * @param {string} name 相对托管目录的文件名。
 * @param {string} content 文件内容。
 * @returns {string} 文件的绝对路径。
 */
export function writeHomeFile(name, content) {
  const dir = ensureHomeDir()
  const file = path.join(dir, name)
  writeFileSync(file, content, { mode: 0o600 })
  return file
}

/**
 * 写托管目录中的 JSON 文件（0o600）。
 * @param {string} name 相对托管目录的文件名。
 * @param {unknown} value 要写入的 JSON 值。
 * @returns {string} 文件的绝对路径。
 */
export function writeHomeJson(name, value) {
  return writeHomeFile(name, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * 写一条托管日志到 logs/<name>.log。日志字段由调用方决定，不写回调 token 与整行事件（design D2）。
 * 写不进去时不抛出：日志不能阻断调度、点选处理与权限拒绝。
 * @param {string} name 日志名：scheduler、bridge、perm-host。
 * @param {string} event 事件名。
 * @param {object} fields 其余字段。
 */
export function appendLog(name, event, fields = {}) {
  try {
    const dir = path.join(homeDir(), 'logs')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    appendFileSync(path.join(dir, `${name}.log`), `${JSON.stringify({
      time: new Date().toISOString(), event, ...fields,
    })}\n`, { mode: 0o600 })
  } catch {
    // 日志写不进去不阻断调用方。
  }
}
