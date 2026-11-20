/** 托管批次的定位、项目写入保护与回会话交接核验。 */
import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { lstatSync, opendirSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { readBoundedJson, sameObject } from './bounded-json.mjs'
import { inDecisionDirectory, readDecision, recordFile } from './decisions.mjs'
import { homeDir } from './home.mjs'
import { acquireLock, isAlive, readLockFile, takeLock } from './lock.mjs'
import { realPath } from './project.mjs'
import { bootIdentity, processInstance } from './writer-instance.mjs'

const RECORD_LIMIT = 32 * 1024 * 1024
const STATES = ['active', 'exiting', 'void', 'closed']
const PROTECTED_SCAN_MS = 2_000
let deadline = Infinity

export function checkProtectionTime() {
  if (performance.now() >= deadline) throw new Error('项目保护区内的核验时间已用完')
}
const waitCell = new Int32Array(new SharedArrayBuffer(4))
const fail = (directory, reason) => new Error(`${directory}（${reason}）`)

function checkedDir(directory, allowMissing = false) {
  try {
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || realPath(directory) !== directory) throw fail(directory, '目录类型或归属无效')
    return stat
  } catch (error) {
    if (error.code === 'ENOENT' && allowMissing) return null
    throw error
  }
}

/** 枚举全部同名候选。目录和记录的合法性先于 startedAt 匹配。 */
export function enumerateBatches(projectRoot, name, budget = () => {}) {
  const checkBudget = () => { checkProtectionTime(); budget() }
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || name === 'archive'
    || path.basename(name) !== name) throw new Error('变更名无效')
  const root = realPath(projectRoot)
  const openspec = path.join(root, 'openspec')
  const openspecIdentity = checkedDir(openspec)
  const changes = path.join(openspec, 'changes')
  const changesIdentity = checkedDir(changes)
  const archive = path.join(changes, 'archive')
  const archiveIdentity = checkedDir(archive, true)
  const archives = []
  if (archiveIdentity) {
    const stream = opendirSync(archive)
    try {
      for (let item = stream.readSync(); item; item = stream.readSync()) {
        checkBudget()
        if (/^\d{4}-\d{2}-\d{2}-/.test(item.name) && item.name.slice(11) === name) archives.push(item.name)
      }
    } finally {
      stream.closeSync()
    }
  }
  const active = path.join(changes, name)
  const directories = [active, ...archives.sort().map(item => path.join(archive, item))]
  const candidates = []
  for (const directory of directories) {
    checkBudget()
    const identity = checkedDir(directory, true)
    if (!identity) continue
    const decisionDir = path.join(directory, 'decisions')
    const decisionIdentity = checkedDir(decisionDir, true)
    let record = null
    if (decisionIdentity) {
      try {
        record = readBoundedJson(recordFile(directory), RECORD_LIMIT)
      } catch (error) {
        throw fail(directory, error.code || error.message)
      }
      if (!sameObject(decisionIdentity, lstatSync(decisionDir))) throw fail(directory, '决策目录已改变')
    }
    if (!sameObject(identity, lstatSync(directory))) throw fail(directory, '变更目录已改变')
    if (record && (!STATES.includes(record.status) || typeof record.startedAt !== 'string' || !record.startedAt)) {
      throw fail(directory, '托管记录字段无效')
    }
    candidates.push({ directory, location: directory === active ? 'active' : 'archived', record, identity, decisionIdentity })
    checkBudget()
  }
  for (const [directory, before] of [[openspec, openspecIdentity], [changes, changesIdentity], [archive, archiveIdentity]]) {
    const after = checkedDir(directory, !before)
    if ((before && !sameObject(before, after)) || (!before && after)) throw fail(directory, '候选根目录已改变')
    checkBudget()
  }
  return { root, active, candidates }
}

/** 按实际项目、变更、startedAt 唯一匹配。完整扫描完成前不能宣布撤回或重托管。 */
export function locateBatch(batch, checkBudget) {
  const scan = enumerateBatches(batch.root, batch.name, checkBudget)
  const hits = scan.candidates.filter(item => item.record?.startedAt === batch.startedAt)
  if (hits.length === 1) return { ...hits[0], recreated: hits[0].location === 'archived'
    && batch.location === 'active' && scan.candidates.some(item => item.location === 'active') ? scan.active : null }
  if (!hits.length && scan.candidates.some(item => item.directory === batch.directory && item.record)) {
    return { superseded: true }
  }
  const paths = (hits.length ? hits : scan.candidates).map(item => item.directory)
  throw new Error(`${hits.length ? '同一批次有多份托管记录' : '缺少本次批次的托管记录'}：${(paths.length ? paths : [batch.directory]).join('、')}`)
}

export function batchOf(project, entry, directory, record, location = 'active') {
  return { root: realPath(project.root), name: entry.change, directory: realPath(directory), startedAt: record.startedAt, location }
}

/** 尽量缩短保护区，只放本机读取和写入。归属未知的保护文件保留。 */
export function withProjectProtection(root, work, checkBudget = () => {}) {
  const key = createHash('sha256').update(root).digest('hex')
  const file = path.join(homeDir(), 'project-locks', `${key}.lock`)
  const token = randomUUID()
  const bootId = bootIdentity()
  const instance = processInstance(process.pid)?.instance
  if (!bootId || !instance) throw new Error('无法核验项目保护进程实例')
  const own = { pid: process.pid, token, bootId, instance }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    checkBudget()
    const existing = readLockFile(file).value
    const retired = existing?.token && existing.bootId && existing.instance
      && !isAlive(existing.pid)
    const lock = retired ? acquireLock(file, own) : takeLock(file, own)
    if (lock.ok) {
      const previous = deadline
      deadline = Math.min(previous, performance.now() + PROTECTED_SCAN_MS)
      try {
        return work()
      } finally {
        deadline = previous
        if (readLockFile(file).value?.token === token) unlinkSync(file)
      }
    }
    Atomics.wait(waitCell, 0, 0, 20)
  }
  throw new Error('未能取得项目写入保护')
}

/** 在项目保护内重新定位，并将本机决策读写绑定至该目录的当前对象。 */
export function withVerifiedBatch(batch, work, checkBudget = () => {}) {
  return withProjectProtection(batch.root, () => {
    const target = locateBatch(batch, checkBudget)
    if (target.superseded) throw new Error('原目录已重新托管')
    checkBudget()
    return inDecisionDirectory(target, batch.root, work, checkProtectionTime)
  }, checkBudget)
}

/** 交接完成依据绑定批次和原决策；只有第一次写下该依据的进程尝试通知。 */
export function readReturnHandoff(directory, record, ownerOpenId) {
  const id = record.returnHandoff
  if (!id) return null
  if (record.status !== 'void') throw fail(directory, '回会话批次状态无效')
  if (record.returnHandoffCompleted?.id === id && record.returnHandoffCompleted.startedAt === record.startedAt) {
    return { id, status: 'used', completed: true }
  }
  const { value, error } = readDecision(directory, id)
  const context = `${record.startedAt} ${id}`
  if (error) throw fail(directory, `${context} 回会话告警读取失败`)
  if (!value) throw fail(directory, `${context} 缺少回会话告警`)
  if (value.kind !== 'alert' || !['answered', 'used'].includes(value.status)
    || value.answer?.choice !== '回会话处理' || value.answer.operatorId !== ownerOpenId
    || (value.batchStartedAt && value.batchStartedAt !== record.startedAt)) {
    throw fail(directory, `${context} 回会话告警归属或状态不符`)
  }
  return value
}
