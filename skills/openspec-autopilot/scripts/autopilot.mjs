#!/usr/bin/env node
/**
 * 托管入口：把签字后的变更交给托管、撤回托管、查看托管状态。
 *
 * 所属：skill openspec-autopilot。调用方：/opsx:autopilot（命令镜像）与用户直接运行。
 * 输入：<变更名> 与子命令 start | cancel | status。
 * 输出：终端提示与退出码。退出码 0 成功，1 业务拒绝（规则不满足、已托管、记录状态不对），2 参数或环境错误。
 * 边界：只读进度视图与项目状态，只写变更目录中的 decisions/autopilot.json 与 decisions/D-<编号>.json；
 *   不运行 claude，不发卡片，不做 git 写入。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { readConfig, homeDir } from './lib/home.mjs'
import { decisionsDir, ensureDecisionsDir, inDecisionDirectory, recordFile, scanDecisions, transition, voidOpenDecisions } from './lib/decisions.mjs'
import { readLockFile } from './lib/lock.mjs'
import { gitUserName, readProgressView, realPath } from './lib/project.mjs'
import { batchOf, checkProtectionTime, enumerateBatches, readReturnHandoff, withProjectProtection, withVerifiedBatch } from './lib/batch.mjs'
import { batchKey, pendingForName, readPendingTrace } from './lib/pending-trace.mjs'
import { writerStatus } from './lib/writer-instance.mjs'

/** 退出码：0 成功；1 业务拒绝；2 参数或环境错误。 */
const EXIT = Object.freeze({ OK: 0, REJECTED: 1, ERROR: 2 })

/** 进度规则中可以交给托管的区间（design D1）。 */
const HANDOFF_RULES = ['R6', 'R7', 'R8', 'R9', 'R10', 'R11']

/** 优先使用当前实际检出。检出之外必须检查全部配置，再认定唯一项目。 */
function matchingProjects(config) {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  const root = top.status === 0 ? realPath(top.stdout.trim()) : null
  const projects = config.projects.map(project => ({ ...project, root: realPath(project.root) }))
  return projects.some(project => project.root === root) ? projects.filter(project => project.root === root) : projects
}

function startProject(config, name) {
  const hits = []
  for (const project of matchingProjects(config)) {
    const { view, error } = readProgressView(config, project.root)
    if (error) throw new Error(`进度视图不可读：${project.root}`)
    const entry = view.active?.find(item => item.change === name)
    if (entry) hits.push({ project, view, entry })
  }
  if (hits.length > 1) throw new Error(`多个项目存在活跃变更 ${name}：${hits.map(hit => hit.project.root).join('、')}`)
  return hits[0]
}

function managementBatch(config, name) {
  const hits = []
  for (const project of matchingProjects(config)) {
    const { candidates } = enumerateBatches(project.root, name)
    const open = candidates.filter(item => ['active', 'exiting'].includes(item.record?.status))
    const eligible = open.length ? open : candidates.filter(item => item.record?.status === 'void')
    for (const item of eligible) hits.push({ ...item, batch: batchOf(project, { change: name }, item.directory, item.record, item.location) })
  }
  if (hits.length !== 1) {
    const paths = hits.length ? `：${hits.map(hit => hit.directory).join('、')}` : ''
    throw new Error(`${name} ${hits.length ? '存在多个可选批次' : '没有可管理的托管记录'}${paths}`)
  }
  return hits[0]
}

/** 锁归属未知时不得据此停阶段或声明本批次已停止。 */
function lockFor(batch) {
  const lock = readLockFile(path.join(homeDir(), 'run.lock'))
  if (lock.stale) return { state: 'no', value: null }
  if (lock.unreadable) return { state: 'unknown', value: null }
  const value = lock.value
  if (!value || value.change !== batch.name) return { state: 'no', value: null }
  if (!value.projectRoot || !value.startedAt || !value.runId) return { state: 'unknown', value: null }
  if (value.projectRoot !== batch.root || value.startedAt !== batch.startedAt) return { state: 'no', value: null }
  return { value, state: value.writer ? writerStatus(value.writer) : value.claudePid ? 'unknown' : 'no' }
}

function savedTrace() {
  try {
    return readPendingTrace()
  } catch (error) {
    throw new Error(`未完成核对文件无法验证：${error.message}`)
  }
}

/**
 * 读取项目的当前分支。
 * @param {string} root 项目根目录。
 * @returns {string|null} 分支名；不是分支状态（游离 HEAD）时为 null。
 */
function currentBranch(root) {
  const result = spawnSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) return null
  return result.stdout.trim()
}

/**
 * 列出同一项目中其他已在托管的变更（design D1：同一检出只实现一个变更）。
 * @param {string} root 项目根目录。
 * @param {string} current 本次要托管的变更名。
 * @returns {string[]} 其他在托管中的变更名。
 */
function otherManagedChanges(root, current) {
  const changesDir = path.join(root, 'openspec', 'changes')
  if (!existsSync(changesDir)) return []
  const names = []
  for (const item of readdirSync(changesDir)) {
    if (item === current || item === 'archive') continue
    const file = path.join(changesDir, item, 'decisions', 'autopilot.json')
    if (!existsSync(file)) continue
    try {
      const record = JSON.parse(readFileSync(file, 'utf8'))
      if (record.status === 'active' || record.status === 'exiting') names.push(item)
    } catch {
      // 记录损坏时按没有托管处理：读取失败不阻断交接，问题由门禁脚本在归档时发现。
    }
  }
  return names
}

/**
 * 作废上一次托管遗留的决策，并列出遗留会话告警中的核对失败项（design D1，评审 CONC-12、SEC-19）。
 * @param {string} changeDir 变更目录。
 * @returns {string[]} 核对失败项的说明行。
 */
function voidLeftoverDecisions(changeDir) {
  const lines = []
  const cleanup = voidOpenDecisions(changeDir, '上一次托管遗留')
  if (cleanup.error) throw new Error(`遗留决策清单不完整：${cleanup.error}`)
  if (cleanup.failed.length) throw new Error(`遗留决策写入失败：${cleanup.failed.map(item => item.id).join('、')}`)
  for (const decision of cleanup.open) {
    const failures = (decision.request && decision.request.checkFailures) || []
    for (const failure of failures) {
      const id = failure.finding || failure.id || failure.field || ''
      const where = failure.file || ''
      const values = failure.before !== undefined || failure.after !== undefined
        ? `（${failure.before ?? '（无）'} → ${failure.after ?? '（无）'}）` : ''
      lines.push(`${id}${where ? ` ${where}` : ''}${values}`)
    }
  }
  return lines
}

/**
 * 交接托管：写入托管记录。
 * @param {string} name 变更名。
 * @param {object} config 托管配置。
 * @returns {{ code: number, message: string }} 退出码与输出。
 */
function start(name, config) {
  const found = startProject(config, name)
  if (!found) return { code: EXIT.ERROR, message: `进度视图中没有活跃变更 ${name}` }
  const { project, view, entry } = found

  // 进度视图的 implementing 数组缺失时退出码 2：不能把「不知道」当作「没有」（design D1，评审 ARCH-10）。
  if (!Array.isArray(view.implementing)) {
    return { code: EXIT.ERROR, message: '进度视图没有 implementing 数组，请同步 openspec-change-progress 副本' }
  }
  // 规则 R1–R5 表示产物不全、未评审、评审 BLOCKED 或签字空白，这些在会话中处理（design D1）。
  if (!HANDOFF_RULES.includes(entry.rule)) {
    const blockers = (entry.blockers || []).join('、')
    return { code: EXIT.REJECTED, message: `进度规则 ${entry.rule}${blockers ? `：${blockers}` : ''}，只在 R6–R11 时托管` }
  }
  // 门禁副本没有 reviewStale 时退出码 2：两个副本只同步一个时 R8 的新条件静默失效（design D1，评审 ARCH-18）。
  if (!('reviewStale' in entry) || entry.reviewStale === null) {
    return {
      code: EXIT.ERROR,
      message: '进度条目没有 reviewStale，请一起同步 openspec-change-progress 与 openspec-technical-review 两个副本',
    }
  }
  // 当前分支必须是项目的主分支：实现、测试与提交要基于同一个起点（design D1，评审 ARCH-07）。
  const branch = currentBranch(project.root)
  if (branch !== project.baseBranch) {
    return { code: EXIT.REJECTED, message: `当前分支是 ${branch || '（游离 HEAD）'}，项目的 baseBranch 是 ${project.baseBranch}` }
  }
  // quality 按回复写入的接受人、驳回人与决策人取这个用户名（design D1）。
  const userName = gitUserName(project.root)
  if (!userName) {
    return { code: EXIT.REJECTED, message: '项目没有 git config user.name，先设置用户名再托管' }
  }

  const result = withProjectProtection(project.root, () => {
    const scan = enumerateBatches(project.root, name)
    const active = scan.candidates.find(item => item.location === 'active')
    if (!active) return { code: EXIT.ERROR, message: `找不到变更目录：${name}` }
    const store = savedTrace()
    if (pendingForName(store, scan.root, name)) return { code: EXIT.REJECTED, message: `${name} 仍有未完成核对` }
    for (const item of scan.candidates) {
      if (['active', 'exiting'].includes(item.record?.status)) {
        return { code: EXIT.REJECTED, message: `${name} 已在托管中：${item.directory}（${item.record.startedAt}）` }
      }
      checkProtectionTime()
      if (item.record?.returnHandoff && readReturnHandoff(item.directory, item.record, config.ownerOpenId)?.status !== 'used') {
        return { code: EXIT.REJECTED, message: `${item.directory} 的回会话交接尚未完成` }
      }
    }
    const current = active.record
    const lock = lockFor({ root: scan.root, name, startedAt: current?.startedAt })
    if (lock.state !== 'no' || lock.value) return { code: EXIT.REJECTED, message: `${name} 的阶段仍在停止或无法核验` }
    // 同一检出只实现一个变更（design D1，决策⑯）。
    const implementingOthers = view.implementing.filter(item => item !== name)
    if (implementingOthers.length) {
      return { code: EXIT.REJECTED, message: `同一检出中这些变更已开始实现：${implementingOthers.join('、')}` }
    }
    const managedOthers = otherManagedChanges(project.root, name)
    if (managedOthers.length) {
      return { code: EXIT.REJECTED, message: `同一项目中这些变更已在托管：${managedOthers.join('、')}` }
    }
    ensureDecisionsDir(active.directory)
    const verified = enumerateBatches(project.root, name).candidates.find(item => item.location === 'active')
    if (!verified || verified.identity.ino !== active.identity.ino || verified.identity.dev !== active.identity.dev
      || verified.record?.startedAt !== current?.startedAt) throw new Error('活跃目录或托管批次已改变')
    return inDecisionDirectory(verified, project.root, () => {
      const leftovers = current?.status === 'void' ? voidLeftoverDecisions(active.directory) : []
      const startedAt = new Date().toISOString()
      const written = transition(recordFile(active.directory), ['void', 'closed'], {
        status: 'active', startedAt, rule: entry.rule, tier: entry.tier || null,
      }, { allowMissing: !current, replace: true, ...(current ? { startedAt: current.startedAt } : {}) })
      if (!written.ok) return { code: EXIT.ERROR, message: `写入托管记录失败：${written.reason}` }
      return { startedAt, leftovers }
    }, checkProtectionTime)
  })
  if (result.code !== undefined) return result
  const { startedAt, leftovers } = result
  const lines = [`已托管 ${name}（规则 ${entry.rule}，开始时间 ${startedAt}）`]
  for (const item of leftovers) lines.push(`上一次托管遗留的核对失败项：${item}`)
  lines.push('托管期间不要在同一仓库中修改文件')
  return { code: EXIT.OK, message: lines.join('\n') }
}

/** 按最新锁实例停止已经核验的组。没有锁时还须核对持久保存的写者。 */
function stopRunningStage(batch, config) {
  const waitMs = Math.max(1, Number(config.cancelWaitSeconds || 30)) * 1000
  const deadline = Date.now() + waitMs
  const signaled = new Set()
  const waitCell = new Int32Array(new SharedArrayBuffer(4))
  let unknownLock = false
  do {
    const lock = lockFor(batch)
    const stored = savedTrace().entries[batchKey(batch)]
    const savedState = writerStatus(stored?.writer)
    // 未能归属的存活锁消失不是退出证明，不在同一次撤回中报告成功。
    if (!lock.value && lock.state === 'unknown' && !stored) unknownLock = true
    if (!lock.value && lock.state === 'no' && savedState === 'no' && !unknownLock) return { stopped: true }
    if (lock.state === 'yes' && !signaled.has(lock.value.runId)) {
      const current = lockFor(batch)
      if (current.state === 'yes' && current.value.runId === lock.value.runId && current.value.token === lock.value.token) {
        const writer = current.value.writer
        try {
          process.kill(-writer.pid, 'SIGTERM')
        } catch (error) {
          if (error.code !== 'ESRCH') throw new Error('无法停止已核验的阶段进程组')
        }
        signaled.add(current.value.runId)
      }
    }
    const remaining = deadline - Date.now()
    if (remaining > 0) Atomics.wait(waitCell, 0, 0, Math.min(200, remaining))
  } while (Date.now() < deadline)
  return { stopped: false, message: '托管已撤回，阶段仍在停止，确认停止后再修改仓库' }
}

/** 锁前后共用同一批次扫描和作废规则。 */
function withdraw(batch, config) {
  return withVerifiedBatch(batch, target => {
    if (!['active', 'exiting', 'void'].includes(target.record.status)) throw new Error('原批次已变化')
    const handoff = readReturnHandoff(target.directory, target.record, config.ownerOpenId)
    if (target.record.status !== 'void') {
      const result = transition(recordFile(target.directory), [target.record.status], {
        status: 'void', voidReason: '用户撤回',
      }, { startedAt: batch.startedAt })
      if (!result.ok) throw new Error('作废托管记录失败')
    }
    const preserved = handoff?.status === 'answered' ? handoff.id : null
    const cleanup = voidOpenDecisions(target.directory, '用户撤回', { preserve: preserved })
    if (cleanup.error) throw new Error(`决策清单不完整：${cleanup.error}`)
    if (cleanup.failed.length) throw new Error(`决策作废写入失败：${cleanup.failed.map(item => item.id).join('、')}`)
    return preserved
  })
}

function cancel(name, config) {
  const { batch } = managementBatch(config, name)
  const before = withdraw(batch, config)
  const stop = stopRunningStage(batch, config)
  if (!stop.stopped) return { code: EXIT.REJECTED, message: stop.message }
  const after = withdraw(batch, config)
  const lines = [`已撤回 ${name} 的托管`]
  if (after || before) lines.push(`回会话告警 ${after || before} 仍待核验交接`)
  if (savedTrace().entries[batchKey(batch)]) lines.push('未完成核对仍保留，请在会话中查看本次运行的修改。')
  return { code: EXIT.OK, message: lines.join('\n') }
}

function status(name, config) {
  const pending = savedTrace()
  let target
  try { target = managementBatch(config, name) } catch (error) {
    const paths = Object.values(pending.entries).filter(item => item.name === name)
      .map(item => `${item.startedAt} ${item.directory}`)
    return { code: EXIT.REJECTED, message: [error.message, ...paths].join('\n') }
  }
  const { directory, record, batch } = target
  const counts = new Map()
  const error = scanDecisions(decisionsDir(directory), decision => counts.set(decision.status, (counts.get(decision.status) || 0) + 1))
  if (error) return { code: EXIT.ERROR, message: `${record.startedAt} ${directory}：决策清单不完整（${error}）` }
  const saved = pending.entries[batchKey(batch)]
  const lock = lockFor(batch)
  const savedState = writerStatus(saved?.writer)
  const running = lock.state === 'yes' || savedState === 'yes' ? '是'
    : lock.state === 'unknown' || savedState === 'unknown' ? '无法确定' : '否'
  const lines = [`变更：${name}`, `目录：${directory}`, `批次：${record.startedAt}`, `托管记录：${JSON.stringify(record)}`, `阶段运行中：${running}`]
  if (saved) lines.push(`未完成核对：${saved.mode} ${saved.stage || ''}（${saved.directory}）`)
  if (record.returnHandoff && !readReturnHandoff(directory, record, config.ownerOpenId)?.completed) lines.push('回会话交接待确认')
  for (const [key, count] of [...counts].sort()) lines.push(`决策 ${key}: ${count}`)
  return { code: EXIT.OK, message: lines.join('\n') }
}

/** 命令行入口。 */
function main(argv) {
  const [command, name] = argv
  if (!command || !name) {
    return { code: EXIT.ERROR, message: '用法：node autopilot.mjs <start|cancel|status> <变更名>' }
  }
  let config
  try {
    config = readConfig()
  } catch (error) {
    return { code: EXIT.ERROR, message: error.message }
  }
  try {
    if (command === 'start') return start(name, config)
    if (command === 'cancel') return cancel(name, config)
    if (command === 'status') return status(name, config)
  } catch (error) {
    return { code: EXIT.REJECTED, message: error.message }
  }
  return { code: EXIT.ERROR, message: `不支持的子命令：${command}（start | cancel | status）` }
}

const result = main(process.argv.slice(2))
if (result.code === EXIT.OK) process.stdout.write(`${result.message}\n`)
else process.stderr.write(`${result.message}\n`)
process.exitCode = result.code
