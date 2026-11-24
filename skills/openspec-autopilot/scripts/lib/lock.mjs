/**
 * 运行锁与桥接锁（add-autopilot-loop design D12，评审 CONC-01、CONC-08）。
 *
 * 所属：skill openspec-autopilot。调用方：scheduler.mjs、bridge.mjs、autopilot.mjs。
 * 职责：用 link 取锁、判断锁是否陈旧、替换陈旧锁、写回锁内容、只释放自己的锁。
 * 边界：锁文件在托管目录中；取锁失败时调用方按「本轮退出」处理。
 */

import { existsSync, linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeJsonAtomic } from './atomic-write.mjs'

/**
 * 开机时间与当前时间相差超过这个秒数时，锁按上次开机留下的处理（design D12）。
 * 托管准入用同一容差判断已撤回的批次是否在写为 void 之后重启过（add-change-pause design D4「未决出口」）。
 */
export const BOOT_TIME_TOLERANCE = 60

/** 锁文件读不出内容时，按修改时间判断：不超过这个秒数按存活处理（design D12，评审 CONC-08）。 */
const UNREADABLE_TOLERANCE = 60

/**
 * 本机的开机时间（秒）。锁中的 bootTime 与它比较，用来识别上次开机留下的锁（design D12）。
 * @returns {number} 开机时间。
 */
export function currentBootTime() {
  return Math.round(Date.now() / 1000 - os.uptime())
}

/**
 * 判断一个进程号是否存活。EPERM 算存活：进程存在但本用户没有权限发信号。
 * @param {number|null} pid 进程号。
 * @returns {boolean} 存活时为 true。
 */
export function isAlive(pid) {
  if (!pid || typeof pid !== 'number') return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/**
 * 写一个锁文件的内容：先写临时文件，再用 rename 覆盖，读者只读到完整内容（design D12）。
 * @param {string} file 锁文件路径。
 * @param {object} value 锁内容。
 */
export function writeLockFile(file, value) {
  writeJsonAtomic(file, value, { indent: 0 })
}

/**
 * 读取锁的内容。读不出内容时按修改时间判断存活（design D12，评审 CONC-08）。
 * @param {string} file 锁文件路径。
 * @returns {{ value: object|null, unreadable: boolean, stale: boolean }} 锁内容与判定。
 */
export function readLockFile(file) {
  const missing = { value: null, unreadable: false, stale: false }
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return missing
    raw = ''
  }
  let value = null
  try {
    value = JSON.parse(raw)
  } catch {
    value = null
  }
  if (value && typeof value === 'object') return { value, unreadable: false, stale: isStale(value) }
  // 读不出内容：修改时间不超过 60 秒按存活处理，超过按陈旧处理（design D12）。
  try {
    const age = (Date.now() - statSync(file).mtimeMs) / 1000
    return { value: null, unreadable: true, stale: age > UNREADABLE_TOLERANCE }
  } catch (error) {
    if (error.code === 'ENOENT') return missing
    return { value: null, unreadable: true, stale: false }
  }
}

/**
 * 判断锁是否陈旧：开机时间相差超过 60 秒，或 pid 与 claudePid 都不存活（design D12）。
 * @param {object} lock 锁内容。
 * @returns {boolean} 陈旧时为 true。
 */
export function isStale(lock) {
  if (!lock) return true
  if (typeof lock.bootTime === 'number'
    && Math.abs(currentBootTime() - lock.bootTime) > BOOT_TIME_TOLERANCE) return true
  return !isAlive(lock.pid) && !isAlive(lock.claudePid)
}

/**
 * 用 link 取锁：先把完整 JSON 写入临时文件，再 link 成锁文件（design D12）。
 * link 在锁文件已存在时失败，由内核保证同一路径只有一个进程创建成功。
 * @param {string} file 锁文件路径。
 * @param {object} value 锁内容。
 * @returns {{ ok: boolean, reason: string|null }} ok 为 false 时 reason 说明原因。
 */
export function takeLock(file, value) {
  const tmp = `${file}.tmp.${process.pid}`
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  try {
    linkSync(tmp, file)
    return { ok: true, reason: null }
  } catch (error) {
    return { ok: false, reason: error.code === 'EEXIST' ? '锁已被占用' : `取锁失败：${error.message}` }
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp)
  }
}

/**
 * 取得运行锁：锁被占用且不陈旧时返回失败；陈旧时通过接手权文件替换（design D12）。
 * @param {string} file 锁文件路径。
 * @param {object} value 锁内容。
 * @returns {{ ok: boolean, reason: string|null }} 取锁结果。
 */
export function acquireLock(file, value) {
  const first = takeLock(file, value)
  if (first.ok) return first
  const current = readLockFile(file)
  if (!current.stale) return { ok: false, reason: '锁被占用' }
  // 接手权文件让陈旧锁只有一个接手者（design D12）。
  const takeover = `${file}.takeover`
  const got = takeLock(takeover, { pid: process.pid, bootTime: currentBootTime() })
  if (!got.ok) {
    // 残留的接手权文件超过 60 秒时删除后重试一次（design D12）。
    const age = existsSync(takeover) ? (Date.now() - statSync(takeover).mtimeMs) / 1000 : Infinity
    if (age > UNREADABLE_TOLERANCE) {
      unlinkSync(takeover)
      const retry = takeLock(takeover, { pid: process.pid, bootTime: currentBootTime() })
      if (!retry.ok) return { ok: false, reason: '另一个进程正在接手陈旧锁' }
    } else {
      return { ok: false, reason: '另一个进程正在接手陈旧锁' }
    }
  }
  try {
    // 取得接手权后重新读锁：仍是陈旧锁才删除它（design D12）。
    const again = readLockFile(file)
    if (again.stale) unlinkSync(file)
  } finally {
    if (existsSync(takeover)) unlinkSync(takeover)
  }
  return takeLock(file, value)
}

/**
 * 释放锁：只有锁中的 pid 是本进程时才删除（design D12）。
 * @param {string} file 锁文件路径。
 */
export function releaseLock(file, token) {
  const current = readLockFile(file)
  if (!current.value || current.value.pid !== process.pid || (token && current.value.token !== token)) return
  if (existsSync(file)) unlinkSync(file)
}
