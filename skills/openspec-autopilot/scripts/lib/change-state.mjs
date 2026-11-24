/** 托管读门禁快照，并在项目保护下核对原始字节；状态内容仍只由门禁解析。 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { checkProtectionTime } from './batch.mjs'
import { realPath } from './project.mjs'

export const STATE_VERSION = 1
export const STATE_FILE = 'change-state.json'
const FILE_LIMIT = 16 * 1024
const TOTAL_LIMIT = 4 * 1024 * 1024
const REASON_LIMIT = 1_024
const FACTS_TIMEOUT = 60_000
const STALE_TEMP = /^change-state\.json\.tmp\.[1-9]\d*\.[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i

/** 管理入口和调度用同一错误分类：2 表示环境或文件无效，1 表示保护内的竞争或预算。 */
export class StateError extends Error {
  constructor(message, code = 2) {
    super(message)
    this.code = code
  }
}

const identityOf = (file, stat) => ({ path: file, dev: String(stat.dev), ino: String(stat.ino) })
export const sameDirectory = (a, b) => !!a && !!b && a.path === b.path && a.dev === b.dev && a.ino === b.ino
export const validChangeName = name => typeof name === 'string' && name && !['.', '..', 'archive'].includes(name)
  && !/[\\/\0]/.test(name)

/** 首次定位只核对选定项目下的固定目录，不扫描不需要的归档条目。 */
export function activeDirectory(root, name) {
  let directory = root
  let stat
  for (const part of ['openspec', 'changes', name]) {
    directory = path.join(directory, part)
    try { stat = lstatSync(directory, { bigint: true }) } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
    if (!stat.isDirectory() || realPath(directory) !== directory) throw new StateError(`变更目录归属无法核验：${directory}`)
  }
  return identityOf(directory, stat)
}

const hasField = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

/** 这里只验证跨进程信封，不重写状态文件的内容规则。 */
export function stateSnapshot(value) {
  const reason = '变更状态契约无法核验，请配套同步托管、进度视图和门禁副本'
  const state = value?.changeState
  const directory = value?.changeDirectory
  if (!state || !['state', 'reason', 'updatedAt', 'error', 'digest'].every(key => hasField(state, key))
      || (state.digest !== null && (typeof state.digest !== 'string' || !/^[a-f0-9]{64}$/.test(state.digest)))) {
    throw new StateError(reason)
  }
  if (state.state === 'unknown') throw new StateError(state.error || reason)
  if (!directory || typeof directory.path !== 'string' || !path.isAbsolute(directory.path)
      || typeof directory.dev !== 'string' || !/^\d+$/.test(directory.dev)
      || typeof directory.ino !== 'string' || !/^\d+$/.test(directory.ino) || state.error !== null
      || !['enabled', 'paused'].includes(state.state)
      || (state.digest === null ? state.state !== 'enabled' || state.reason !== null || state.updatedAt !== null
        : typeof state.reason !== 'string' || typeof state.updatedAt !== 'string')) throw new StateError(reason)
  return { changeState: state, changeDirectory: directory }
}

/**
 * 以选定项目根运行门禁，读取一个目录的推进意愿快照。
 * @param {string} gate 已核验来源的门禁脚本。
 * @param {string} root 选定项目的真实根，显式传给 --repo，不由目标路径推导（design D2，评审 SEC-13）。
 * @param {string} target 选定的变更目录。
 * @param {'facts'|'state'} command 写入前的快照沿用 facts；只读查询用 state，不计算实现指纹（评审 ARCH-13）。
 * @returns {{ changeState: object, changeDirectory: object }} 通过信封检查的快照；状态未知或契约不符时抛出 StateError。
 */
export function readStateSnapshot(gate, root, target, command = 'facts') {
  const result = spawnSync(process.execPath, [gate, command, target, '--repo', root], {
    cwd: root, encoding: 'utf8', timeout: FACTS_TIMEOUT, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new StateError(command === 'state' ? '门禁状态无法读取，请核对或同步本机门禁副本' : '门禁事实无法读取，请核对本机门禁副本')
  }
  let facts
  try { facts = JSON.parse(result.stdout) } catch { throw new StateError('门禁事实不是 JSON') }
  if (facts?.changeStateVersion !== STATE_VERSION) throw new StateError('门禁缺少状态契约 1，请同步副本')
  return stateSnapshot(facts)
}

export function stateReadBudget() {
  let bytes = 0
  return amount => {
    if (bytes + amount > TOTAL_LIMIT) throw new StateError('状态文件累计读取超过 4 MiB', 1)
    bytes += amount
  }
}

/** 只核对原始摘要；单文件或累计额度不足时不使用部分摘要。 */
export function verifyStateDigest(file, expected, charge) {
  let before
  const inspect = () => lstatSync(file, { bigint: true })
  checkProtectionTime()
  try { before = inspect() } catch (error) {
    if (error.code !== 'ENOENT') throw new StateError('状态文件不可读')
    if (expected !== null) throw changed(null)
    return
  }
  if (!before.isFile()) throw new StateError('状态文件不是普通文件')
  if (before.size > BigInt(FILE_LIMIT)) throw new StateError('状态文件超过 16 KiB')
  if (expected === null) throw changed(null)
  function changed(digest) {
    return new StateError(`状态文件在读取后已修改，请重试（当前摘要：${digest ?? '未核验'}）`, 1)
  }
  const same = stat => ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(key => before[key] === stat[key])
  let fd
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) } catch (error) {
    if (['ENOENT', 'ELOOP'].includes(error.code)) throw changed(null)
    throw new StateError('状态文件不可读')
  }
  try {
    if (!same(fstatSync(fd, { bigint: true }))) throw changed(null)
    const buffer = Buffer.alloc(FILE_LIMIT + 1)
    let size = 0
    while (size < buffer.length) {
      checkProtectionTime()
      const max = Math.min(buffer.length - size, Math.max(1, Number(before.size) + 1 - size))
      // 先确认最多可能读取的字节，实际计数包含探测超限时读到的字节。
      charge(max)
      const read = readSync(fd, buffer, size, max, size)
      charge(read - max)
      if (!read) break
      size += read
    }
    checkProtectionTime()
    if (size > FILE_LIMIT) throw new StateError('状态文件超过 16 KiB')
    let after
    try { after = inspect() } catch (error) {
      if (error.code === 'ENOENT') throw changed(null)
      throw new StateError('状态文件不可读')
    }
    if (!same(after) || !same(fstatSync(fd, { bigint: true })) || before.size !== BigInt(size)) throw changed(null)
    const digest = createHash('sha256').update(buffer.subarray(0, size)).digest('hex')
    if (digest !== expected) throw changed(digest)
  } catch (error) {
    // 系统 I/O 错误含本机诊断；业务竞争、时间与字节额度错误仍按各自的类别上报。
    if (typeof error.code === 'string') throw new StateError('状态文件不可读')
    throw error
  } finally {
    try { closeSync(fd) } catch { throw new StateError('状态文件无法关闭') }
  }
}

/** 绑定目录对象后，只用相对文件名读写，避免按原名字写入替代目录。 */
export function inChangeDirectory(directory, projectRoot, work) {
  const cwd = process.cwd()
  try { process.chdir(directory.path) } catch { throw new StateError('活跃变更目录已改变，请重试', 1) }
  try {
    if (!sameDirectory(directory, identityOf(directory.path, statSync('.', { bigint: true })))) {
      throw new StateError('活跃变更目录已改变，请重试', 1)
    }
    return work()
  } finally {
    try { process.chdir(cwd) } catch { process.chdir(projectRoot) }
  }
}

/** 项目保护确保符合格式的普通临时文件不是管理命令的存活写入。 */
export function clearStateTemporaries() {
  const stream = opendirSync('.')
  try {
    for (;;) {
      checkProtectionTime()
      const item = stream.readSync()
      if (!item) return
      if (!item.isFile() || !STALE_TEMP.test(item.name)) continue
      try { if (lstatSync(item.name).isFile()) unlinkSync(item.name) } catch {
        // 残留不属于状态契约；删除失败不阻止状态更新。
      }
    }
  } finally {
    stream.closeSync()
  }
}

export function stateForWrite(state, reason) {
  const text = typeof reason === 'string' ? reason.trim() : ''
  if (!text || Buffer.byteLength(text) > REASON_LIMIT || Buffer.from(text, 'utf8').toString('utf8') !== text) {
    throw new StateError('请填写非敏感原因，去除首尾空白后为 1 至 1,024 个 UTF-8 字节')
  }
  const value = { version: STATE_VERSION, state, reason: text, updatedAt: new Date().toISOString() }
  if (Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`) > FILE_LIMIT) throw new StateError('状态文件超过 16 KiB')
  return value
}
