/** 阶段写者身份与退出证明。无法核验时由调用方保留原起点。 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const defaultTimeout = () => 1_000

function probe(command, args, timeout = defaultTimeout) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: timeout(), killSignal: 'SIGKILL' })
  return result.status === 0 ? result.stdout.trim() : ''
}

export function bootIdentity(timeout) {
  try {
    if (process.platform === 'linux') return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    if (process.platform === 'darwin') return probe('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], timeout)
  } catch { /* 调用方按无法证明处理。 */ }
  return ''
}

export function processInstance(pid, timeout) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null
  if (process.platform === 'linux') {
    try {
      const line = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const fields = line.slice(line.lastIndexOf(')') + 2).split(' ')
      return { group: Number(fields[2]), instance: fields[19] }
    } catch { return null }
  }
  const value = probe('/bin/ps', ['-p', String(pid), '-o', 'pgid=', '-o', 'lstart='], timeout)
  const match = /^(\d+)\s+(.+)$/.exec(value)
  return match ? { group: Number(match[1]), instance: match[2] } : null
}

function hasMarker(pid, marker, timeout) {
  if (!marker) return true
  try {
    if (process.platform === 'linux') return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes(marker)
    return probe('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], timeout).split(/\s+/).includes(marker)
  } catch {
    return false
  }
}

export function captureWriter(pid, marker) {
  const bootId = bootIdentity()
  const info = processInstance(pid)
  if (!bootId || !info?.instance || info.group !== pid || !hasMarker(pid, marker)) return null
  return { state: 'published', pid, bootId, instance: info.instance, ...(marker ? { marker } : {}) }
}

/** 存活仅指同一个可核验的组；组长先退出时仍待整个组消失。 */
export function writerStatus(writer, timeout) {
  if (!writer || ['unreleased', 'exited'].includes(writer.state)) return 'no'
  if (writer.state !== 'published' || !Number.isSafeInteger(writer.pid) || writer.pid < 1) return 'unknown'
  // 缺开机标识或进程实例时不能证明已停止：缺 bootId 曾因与本次开机不同被当成已退出（add-change-pause design D0，评审 DB-12）。
  if (typeof writer.bootId !== 'string' || !writer.bootId || typeof writer.instance !== 'string' || !writer.instance) return 'unknown'
  const boot = bootIdentity(timeout)
  if (!boot) return 'unknown'
  if (boot !== writer.bootId) return 'no'
  try {
    process.kill(-writer.pid, 0)
  } catch (error) {
    if (error.code === 'ESRCH') return 'no'
    return 'unknown'
  }
  const current = processInstance(writer.pid, timeout)
  return current?.group === writer.pid && current.instance === writer.instance && hasMarker(writer.pid, writer.marker, timeout)
    ? 'yes' : 'unknown'
}
