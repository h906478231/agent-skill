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

/** 单份托管记录的读取上限。 */
export const RECORD_LIMIT = 32 * 1024 * 1024
const STATES = ['active', 'exiting', 'void', 'closed']
/** 项目保护区及状态查询定位共用的时间预算（毫秒）。 */
export const PROTECTED_SCAN_MS = 2_000
/**
 * 等待项目保护的上限（毫秒）：持有方最多用 PROTECTED_SCAN_MS，再留 500 毫秒。
 * 原来只重试 10 次（约 200 毫秒），管理命令持有保护 2 秒时调度的 writeExitState 会在出口中途失败（design D0 第 2 条，评审 CONC-19）。
 */
export const PROTECTION_WAIT_MS = PROTECTED_SCAN_MS + 500
/** 等待项目保护时两次尝试的间隔（毫秒）。 */
const PROTECTION_RETRY_MS = 20
/** 管理命令在一次项目保护内读取托管记录与待核对文件的累计上限，与状态文件的 4 MiB 额度分开计算（design D0 第 3 条，评审 PERF-12）。 */
export const MANAGEMENT_READ_LIMIT = 16 * 1024 * 1024
let deadline = Infinity

export function checkProtectionTime() {
  if (Math.floor(deadline - performance.now()) < 1) throw new Error('项目保护区内的核验时间已用完')
}

/** 保护区内的本机进程探测不能超过同一个截止时间。 */
export function protectionProbeTimeout() {
  const remaining = Math.floor(deadline - performance.now())
  if (remaining < 1) throw new Error('项目保护区内的核验时间已用完')
  return Math.min(1_000, remaining)
}
const waitCell = new Int32Array(new SharedArrayBuffer(4))
const fail = (directory, reason) => new Error(`${directory}（${reason}）`)
/** 预算或条目上限用尽时的错误带 scanBudget 标记，调用方据此与记录损坏等错误区分。 */
const budgetError = message => Object.assign(new Error(message), { scanBudget: true })

/**
 * 管理命令的累计读取额度：以实际读取的字节数调用，超出 MANAGEMENT_READ_LIMIT 时抛出带 readBudget 标记的错误。
 * 调用方拒绝写入或登记，不用部分结果（design D0 第 3 条，评审 PERF-12）。调度按名称定位批次的扫描不使用本额度。
 * @returns {Function} charge(bytes)。
 */
export function managementReadBudget() {
  let bytes = 0
  return amount => {
    if (bytes + amount > MANAGEMENT_READ_LIMIT) {
      throw Object.assign(new Error('托管记录与待核对文件累计读取超过 16 MiB'), { readBudget: true })
    }
    bytes += amount
  }
}

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

/** 新状态操作每次只检查活跃与归档目录合计 1,024 个条目。 */
export const PROJECT_SCAN_LIMIT = 1_024

/**
 * 枚举同名或全项目候选。目录和记录的合法性先于 startedAt 匹配。
 * options.charge 为管理命令的累计读取额度（managementReadBudget），用尽时按扫描预算错误拒绝，并写出已检查条目数。
 */
export function enumerateBatches(projectRoot, name, budget = () => {}, { all = false, limit = Infinity, charge } = {}) {
  let inspected = 0
  let phase = '候选目录核验'
  const checkBudget = () => {
    try { checkProtectionTime(); budget() } catch (error) {
      throw budgetError(`${phase}（已检查 ${inspected} 个条目）：${error.message}`)
    }
  }
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || name === 'archive'
    || path.basename(name) !== name) throw new Error('变更名无效')
  const root = realPath(projectRoot)
  const openspec = path.join(root, 'openspec')
  const openspecIdentity = checkedDir(openspec)
  const changes = path.join(openspec, 'changes')
  const changesIdentity = checkedDir(changes)
  const archive = path.join(changes, 'archive')
  const active = path.join(changes, name)
  function entries(directory, label, keep) {
    phase = label
    checkBudget()
    const names = []
    const stream = opendirSync(directory)
    try {
      for (;;) {
        checkBudget()
        const item = stream.readSync()
        checkBudget()
        if (!item) return names.sort()
        if (inspected >= limit) throw budgetError(`${phase}（已检查 ${inspected} 个条目）：目录条目超过 ${limit}`)
        inspected += 1
        if (keep(item)) names.push(path.join(directory, item.name))
      }
    } finally {
      stream.closeSync()
    }
  }
  const candidates = []
  function collect(directories, location, allowMissing) {
    phase = `${location === 'active' ? '活跃' : '归档'}批次读取`
    for (const directory of directories) {
      checkBudget()
      const identity = checkedDir(directory, allowMissing)
      if (!identity) continue
      const decisionDir = path.join(directory, 'decisions')
      const decisionIdentity = checkedDir(decisionDir, true)
      let record = null
      if (decisionIdentity) {
        try {
          checkBudget()
          record = readBoundedJson(recordFile(directory), RECORD_LIMIT, charge)
        } catch (error) {
          if (error.readBudget) throw budgetError(`${phase}（已检查 ${inspected} 个条目）：${error.message}`)
          throw fail(directory, error.code || error.message)
        }
        if (!sameObject(decisionIdentity, lstatSync(decisionDir))) throw fail(directory, '决策目录已改变')
      }
      if (!sameObject(identity, lstatSync(directory))) throw fail(directory, '变更目录已改变')
      if (record && (!STATES.includes(record.status) || typeof record.startedAt !== 'string' || !record.startedAt)) {
        throw fail(directory, '托管记录字段无效')
      }
      candidates.push({ directory, location, record, identity, decisionIdentity })
      checkBudget()
    }
  }
  // 先检查活跃候选，随后检查归档；归档移动不能让同一批次在两边都被漏掉。
  collect(all ? entries(changes, '活跃目录扫描', item => item.name !== 'archive' && (item.isDirectory() || item.isSymbolicLink()))
    : [active], 'active', !all)
  const archiveIdentity = checkedDir(archive, true)
  if (archiveIdentity) {
    const archived = entries(archive, '归档目录扫描', item => /^\d{4}-\d{2}-\d{2}-.+$/.test(item.name)
      && (all || item.name.slice(11) === name))
    collect(archived, 'archived', false)
  }
  function verify() {
    phase = '候选目录身份复核'
    for (const [directory, before] of [[openspec, openspecIdentity], [changes, changesIdentity], [archive, archiveIdentity]]) {
      checkBudget()
      const after = checkedDir(directory, !before)
      if ((before && (!after || !sameObject(before, after) || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs))
          || (!before && after)) throw fail(directory, '候选根目录已改变')
    }
    for (const item of candidates) {
      checkBudget()
      if (!sameObject(item.identity, checkedDir(item.directory))) throw fail(item.directory, '变更目录已改变')
    }
    checkBudget()
  }
  verify()
  return { root, active, candidates, inspected, verify }
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
  // 从首次尝试起按单调时钟计算等待上限；调度与三个管理命令共用本实现，锁顺序不变（design D0 第 2 条）。
  const until = performance.now() + PROTECTION_WAIT_MS
  for (;;) {
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
    const left = until - performance.now()
    if (left <= 0) break
    Atomics.wait(waitCell, 0, 0, Math.min(PROTECTION_RETRY_MS, left))
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
