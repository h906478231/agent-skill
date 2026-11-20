/** 持久保存未完成的托管核对。只有持运行锁的调度脚本调用写入入口。 */
import { createHash } from 'node:crypto'
import path from 'node:path'
import { writeJsonAtomic } from './atomic-write.mjs'
import { readBoundedJson } from './bounded-json.mjs'
import { homeDir } from './home.mjs'
import { validTrace } from './trace-check.mjs'

const KIB = 1024
export const TRACE_LIMIT = 4 * KIB * KIB
const FILE_LIMIT = 64 * KIB * KIB
const ENTRY_LIMIT = 32
const META_LIMIT = 16 * KIB
const KEY_LIMIT = 8 * KIB
const DEFAULT = () => ({ version: 1, entries: {} })
const fileOf = () => path.join(homeDir(), 'pending-trace.json')
const bytes = text => Buffer.byteLength(text, 'utf8')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = value => typeof value === 'string' && value.length > 0
const id = value => typeof value === 'string' && /^D-(?!0000)\d{4}$/.test(value)
const resultKinds = ['question', 'stage-alert', 'check-alert', 'early-archive-alert']
const baseKeys = ['root', 'name', 'startedAt', 'directory', 'location', 'mode', 'traceBefore', 'alertId']
const stageKeys = [...baseKeys, 'stage', 'runId', 'writer', 'consumedDecisionId', 'sessionId', 'deferredToolUseId',
  'unavailable', 'resultDecisionId', 'resultKind', 'traceAfter', 'boundaryDigest']
const versionKeys = [...baseKeys, 'sourceDecisionId']
const metadataText = value => nonempty(value) && bytes(value) <= 1024
const digest = value => object(value) && value.version === 1 && value.algo === 'sha256' && /^[a-f0-9]{64}$/.test(value.value)

/** 使用 Unicode 码点比较。直接输出键，数字形式的键也保持指定顺序。 */
function compareKeys(left, right) {
  const a = Array.from(left, char => char.codePointAt(0))
  const b = Array.from(right, char => char.codePointAt(0))
  const difference = a.findIndex((value, index) => value !== b[index])
  return difference < 0 || difference >= b.length ? a.length - b.length : a[difference] - b[difference]
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (!object(value)) return JSON.stringify(value)
  return `{${Object.keys(value).sort(compareKeys).map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

export function traceDigest(value) {
  return { version: 1, algo: 'sha256', value: createHash('sha256').update(canonicalJson(value)).digest('hex') }
}

export function traceFits(value) {
  return object(value) && bytes(canonicalJson(value)) <= TRACE_LIMIT
}

export const batchKey = ({ root, name, startedAt }) => JSON.stringify([root, name, startedAt])

function validateEntry(key, entry) {
  const { traceBefore, traceAfter, ...metadata } = entry
  const allowed = entry.mode === 'version-handoff' ? versionKeys : stageKeys
  if (Object.keys(entry).some(field => !allowed.includes(field))) throw new Error('核对条目包含未知字段')
  if (key !== batchKey(entry) || !path.isAbsolute(entry.root || '') || !nonempty(entry.name)
    || !nonempty(entry.startedAt) || !path.isAbsolute(entry.directory || '')
    || !['active', 'archived'].includes(entry.location)) throw new Error('核对条目身份无效')
  if (entry.mode === 'version-handoff') {
    if (!id(entry.sourceDecisionId) || !id(entry.alertId) || entry.sourceDecisionId >= entry.alertId
      || entry.runId !== undefined || entry.writer !== undefined || entry.resultDecisionId !== undefined
      || traceAfter !== undefined || !object(traceBefore)) throw new Error('版本转交条目无效')
  } else if (entry.mode !== 'stage' || !nonempty(entry.runId) || !nonempty(entry.stage)
    || !object(traceBefore) || !Array.isArray(traceBefore.resumedDecisionIds) || !traceBefore.resumedDecisionIds.every(id)
    || (entry.consumedDecisionId !== undefined && !id(entry.consumedDecisionId))) {
    throw new Error('阶段核对条目无效')
  }
  if (entry.mode === 'stage') {
    if (['sessionId', 'deferredToolUseId'].some(key => entry[key] !== undefined && !metadataText(entry[key]))
      || (entry.unavailable !== undefined && typeof entry.unavailable !== 'boolean')
      || (entry.boundaryDigest !== undefined && (!digest(entry.boundaryDigest) || (!entry.alertId && !entry.resultDecisionId)))
      || (entry.consumedDecisionId && !traceBefore.resumedDecisionIds.includes(entry.consumedDecisionId))) {
      throw new Error('阶段核对元数据无效')
    }
    if (!object(entry.writer) || !['unreleased', 'published', 'exited'].includes(entry.writer.state)) {
      throw new Error('阶段运行身份无效')
    }
    if (entry.writer.state === 'published'
      && (!Number.isSafeInteger(entry.writer.pid) || entry.writer.pid < 1
        || !nonempty(entry.writer.bootId) || !nonempty(entry.writer.instance))) throw new Error('阶段进程实例无效')
  }
  if (entry.resultDecisionId !== undefined && (!id(entry.resultDecisionId)
    || !resultKinds.includes(entry.resultKind) || entry.alertId !== undefined
    || (entry.resultKind === 'question' ? !validTrace(traceAfter) : traceAfter !== undefined))) throw new Error('结果预留无效')
  if (entry.alertId !== undefined && !id(entry.alertId)) throw new Error('告警编号无效')
  if (entry.resultDecisionId === undefined && (entry.resultKind !== undefined || traceAfter !== undefined)) {
    throw new Error('结果预留字段不完整')
  }
  if (!traceFits(traceBefore) || (traceAfter !== undefined && !traceFits(traceAfter))) throw new Error('快照超过 4 MiB')
  if (bytes(JSON.stringify(key)) > KEY_LIMIT || bytes(JSON.stringify(key)) + bytes(JSON.stringify(metadata)) + 2 > META_LIMIT) {
    throw new Error('核对条目元数据超过上限')
  }
  return META_LIMIT + bytes(JSON.stringify(traceBefore)) + (traceAfter === undefined ? 0 : bytes(JSON.stringify(traceAfter)))
}

function validate(store) {
  if (store.version !== 1 || !object(store.entries)
    || Object.keys(store).some(key => !['version', 'entries', 'cursor'].includes(key))) throw new Error('核对文件版本或格式无效')
  const { entries, cursor, ...envelope } = store
  const rows = Object.entries(entries)
  if (rows.length > ENTRY_LIMIT) throw new Error('核对文件超过 32 条')
  if (cursor !== undefined && (!nonempty(cursor) || bytes(JSON.stringify(cursor)) > KEY_LIMIT)) {
    throw new Error('核对游标超过上限或格式无效')
  }
  if (bytes(JSON.stringify({ ...envelope, cursor })) + 32 > META_LIMIT) throw new Error('核对文件元数据超过上限')
  let charged = META_LIMIT
  for (const [key, entry] of rows) {
    if (!object(entry)) throw new Error('核对条目无效')
    charged += validateEntry(key, entry)
  }
  if (charged > FILE_LIMIT || bytes(JSON.stringify(store)) + 1 > FILE_LIMIT) throw new Error('核对文件超过 64 MiB')
}

export function readPendingTrace() {
  let value
  try {
    value = readBoundedJson(fileOf(), FILE_LIMIT) || DEFAULT()
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(error.code || error.message)
    // 管理命令可在尚未创建托管目录时读取。已存在的文件消失属于读取失败。
    if (error.path !== path.dirname(fileOf())) throw new Error('核对文件读取时消失')
    value = DEFAULT()
  }
  validate(value)
  return value
}

/** 校验整份候选文件后替换。失败时继续使用已经落盘的版本。 */
export function replacePendingTrace(store, key, entry) {
  const entries = { ...store.entries }
  if (entry) entries[key] = entry
  else delete entries[key]
  const next = { ...store, entries }
  validate(next)
  writeJsonAtomic(fileOf(), next, { indent: 0 })
  store.entries = entries
}

export function writeRecoveryCursor(store, cursor) {
  const next = { ...store, cursor }
  validate(next)
  writeJsonAtomic(fileOf(), next, { indent: 0 })
  store.cursor = cursor
}

export function pendingForName(store, root, name) {
  return Object.values(store.entries).find(entry => entry.root === root && entry.name === name)
}
