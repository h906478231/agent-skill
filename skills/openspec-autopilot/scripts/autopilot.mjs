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
import { fileURLToPath } from 'node:url'
import { readConfig, homeDir } from './lib/home.mjs'
import {
  createDecision, decisionsDir, ensureDecisionsDir, listDecisions, readRecord, recordFile, transition,
} from './lib/decisions.mjs'
import { isAlive, readLockFile } from './lib/lock.mjs'
import { gitUserName, locateChangeDir, readProgressView } from './lib/project.mjs'

/** 退出码：0 成功；1 业务拒绝；2 参数或环境错误。 */
const EXIT = Object.freeze({ OK: 0, REJECTED: 1, ERROR: 2 })

/** 进度规则中可以交给托管的区间（design D1）。 */
const HANDOFF_RULES = ['R6', 'R7', 'R8', 'R9', 'R10', 'R11']

/** 决策文件的编号格式，用于列出决策目录中的文件。 */
const DECISION_FILE = /^D-\d{4}\.json$/

/** 本脚本的目录。 */
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

/**
 * 找到配置中包含该变更的项目与它的进度视图条目。变更在 active 与 archived 中都算找到：
 * 撤回与状态查询要能定位已归档的变更（design D12「撤回」第 1 步）。
 * @param {object} config 托管配置。
 * @param {string} name 变更名。
 * @returns {{ project: object|null, view: object|null, entry: object|null, error: string|null }} 查找结果。
 */
function findProject(config, name) {
  let lastError = null
  for (const project of config.projects) {
    const { view, error } = readProgressView(config, project.root)
    if (error) {
      lastError = error
      continue
    }
    const entry = (view.active || []).find(item => item.change === name) || null
    const archived = (view.archived || []).some(item => item.name === name)
    if (entry || archived) return { project, view, entry, error: null }
  }
  return { project: null, view: null, entry: null, error: lastError }
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
  const { decisions } = listDecisions(changeDir)
  for (const decision of decisions) {
    if (decision.status !== 'pending' && decision.status !== 'answered') continue
    const file = path.join(decisionsDir(changeDir), `${decision.id}.json`)
    transition(file, ['pending', 'answered'], { status: 'void', voidReason: '上一次托管遗留' })
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
  const found = findProject(config, name)
  if (found.error) return { code: EXIT.ERROR, message: found.error }
  if (!found.project || !found.entry) {
    return { code: EXIT.ERROR, message: `进度视图中没有活跃变更 ${name}` }
  }
  const { project, view, entry } = found
  const changeDir = locateChangeDir(project, view, name)
  if (!changeDir) return { code: EXIT.ERROR, message: `找不到变更目录：${name}` }

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
  // 同一检出只实现一个变更（design D1，决策⑯）。
  const implementingOthers = view.implementing.filter(item => item !== name)
  if (implementingOthers.length) {
    return { code: EXIT.REJECTED, message: `同一检出中这些变更已开始实现：${implementingOthers.join('、')}` }
  }
  const managedOthers = otherManagedChanges(project.root, name)
  if (managedOthers.length) {
    return { code: EXIT.REJECTED, message: `同一项目中这些变更已在托管：${managedOthers.join('、')}` }
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

  // 运行锁中是本变更且锁不陈旧时拒绝重新托管：阶段还在停止（design D1，评审 CONC-07）。
  const lock = readLockFile(path.join(homeDir(), 'run.lock'))
  if (lock.value && lock.value.change === name && !lock.stale) {
    return { code: EXIT.REJECTED, message: `${name} 的阶段还在停止，停止后再托管` }
  }

  const record = readRecord(changeDir)
  if (record.error) return { code: EXIT.ERROR, message: record.error }
  const current = record.value
  if (current && (current.status === 'active' || current.status === 'exiting')) {
    return { code: EXIT.REJECTED, message: `${name} 已在托管中（状态 ${current.status}）` }
  }

  // 重新托管：先作废上一次遗留的决策，再写新的记录（design D1，评审 CONC-12）。
  const leftovers = current && current.status === 'void' ? voidLeftoverDecisions(changeDir) : []
  ensureDecisionsDir(changeDir)
  const startedAt = new Date().toISOString()
  const written = transition(recordFile(changeDir), ['void'], {
    status: 'active', startedAt, rule: entry.rule, tier: entry.tier || null,
  }, { allowMissing: true, replace: true })
  if (!written.ok) return { code: EXIT.ERROR, message: `写入托管记录失败：${written.reason}` }

  const lines = [`已托管 ${name}（规则 ${entry.rule}，开始时间 ${startedAt}）`]
  for (const item of leftovers) lines.push(`上一次托管遗留的核对失败项：${item}`)
  lines.push('托管期间不要在同一仓库中修改文件')
  return { code: EXIT.OK, message: lines.join('\n') }
}

/**
 * 向一个进程组发 SIGTERM。claude 以新进程组启动，撤回时结束整个组（design D12「撤回」第 3 步）。
 * @param {number} pid 进程组组长进程号。
 */
function terminateGroup(pid) {
  if (!pid || !isAlive(pid)) return
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    // 进程组不存在时退回单个进程。
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // 进程已退出：不用处理。
    }
  }
}

/**
 * 等待运行锁释放，并停止本变更的阶段（design D12「撤回」第 3 步）。
 * @param {string} name 变更名。
 * @param {object} config 托管配置。
 * @returns {{ stopped: boolean, message: string }} stopped 为 false 时表示等待超时。
 */
function stopRunningStage(name, config) {
  const lockFile = path.join(homeDir(), 'run.lock')
  const waitMs = Math.max(1, Number(config.cancelWaitSeconds || 30)) * 1000
  const deadline = Date.now() + waitMs
  let sentTo = null
  while (Date.now() < deadline) {
    const lock = readLockFile(lockFile)
    if (!lock.value || lock.stale || lock.value.change !== name) return { stopped: true, message: '' }
    // claudePid 存活时先发信号；为 null 时不发，只等调度进程释放锁（design D12）。
    if (lock.value.claudePid && isAlive(lock.value.claudePid) && sentTo !== lock.value.claudePid) {
      terminateGroup(lock.value.claudePid)
      sentTo = lock.value.claudePid
    }
    // 等待期间每 200 毫秒重读锁：claudePid 从 null 变成活进程时补发一次 SIGTERM（design D12，评审 CONC-12）。
    sleep(200)
  }
  const lock = readLockFile(lockFile)
  if (!lock.value || lock.stale || lock.value.change !== name) return { stopped: true, message: '' }
  if (lock.value.claudePid && isAlive(lock.value.claudePid) && sentTo !== lock.value.claudePid) {
    terminateGroup(lock.value.claudePid)
  }
  return { stopped: false, message: '托管已撤回，阶段仍在停止，确认停止后再修改仓库' }
}

/**
 * 同步等待一段时间。用 Atomics.wait 阻塞当前线程，不起子进程（等待期间要能马上读到锁的变化）。
 * @param {number} ms 毫秒数。
 */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 撤回托管：作废托管记录与未完成的决策，并停止正在运行的阶段。
 * @param {string} name 变更名。
 * @param {object} config 托管配置。
 * @returns {{ code: number, message: string }} 退出码与输出。
 */
function cancel(name, config) {
  const found = findProject(config, name)
  if (found.error) return { code: EXIT.ERROR, message: found.error }
  if (!found.project) return { code: EXIT.ERROR, message: `进度视图中没有变更 ${name}` }
  const changeDir = locateChangeDir(found.project, found.view, name)
  if (!changeDir) return { code: EXIT.ERROR, message: `找不到变更目录：${name}` }

  const record = readRecord(changeDir)
  if (record.error) return { code: EXIT.ERROR, message: record.error }
  const current = record.value
  if (!current) return { code: EXIT.REJECTED, message: `${name} 没有托管记录` }
  if (current.status !== 'active' && current.status !== 'exiting' && current.status !== 'void') {
    return { code: EXIT.REJECTED, message: `${name} 的托管记录状态是 ${current.status}，不能撤回` }
  }
  const startedAt = current.startedAt
  // 记录已是 void 时不写文件：让用户能再次停止仍在运行的阶段（design D12，评审 CONC-12）。
  if (current.status !== 'void') {
    const written = transition(recordFile(changeDir), ['active', 'exiting'], {
      status: 'void', voidReason: '用户撤回',
    }, { startedAt })
    if (!written.ok) return { code: EXIT.ERROR, message: `作废托管记录失败：${written.reason}` }
    const { decisions } = listDecisions(changeDir)
    for (const decision of decisions) {
      if (decision.status !== 'pending' && decision.status !== 'answered') continue
      transition(path.join(decisionsDir(changeDir), `${decision.id}.json`), ['pending', 'answered'], {
        status: 'void', voidReason: '用户撤回',
      })
    }
  }
  // 第 3 步：读运行锁，等锁释放并停止本变更的阶段（design D12）。
  const stop = stopRunningStage(name, config)
  if (!stop.stopped) return { code: EXIT.REJECTED, message: stop.message }
  // 第 4 步：锁释放后复核托管记录，调度脚本写回时再作废一次（design D12，评审 CONC-16）。
  const again = readRecord(changeDir)
  if (!again.error && again.value && again.value.startedAt === startedAt && again.value.status !== 'void') {
    transition(recordFile(changeDir), ['active', 'exiting'], { status: 'void', voidReason: '用户撤回' }, { startedAt })
    const { decisions } = listDecisions(changeDir)
    for (const decision of decisions) {
      if (decision.status !== 'pending' && decision.status !== 'answered') continue
      transition(path.join(decisionsDir(changeDir), `${decision.id}.json`), ['pending', 'answered'], {
        status: 'void', voidReason: '用户撤回',
      })
    }
  }
  return { code: EXIT.OK, message: `已撤回 ${name} 的托管` }
}

/**
 * 打印托管状态：记录、各状态的决策数与本变更是否有阶段在运行。
 * @param {string} name 变更名。
 * @param {object} config 托管配置。
 * @returns {{ code: number, message: string }} 退出码与输出。
 */
function status(name, config) {
  const found = findProject(config, name)
  if (found.error) return { code: EXIT.ERROR, message: found.error }
  if (!found.project) return { code: EXIT.ERROR, message: `进度视图中没有变更 ${name}` }
  const changeDir = locateChangeDir(found.project, found.view, name)
  if (!changeDir) return { code: EXIT.ERROR, message: `找不到变更目录：${name}` }
  const record = readRecord(changeDir)
  if (record.error) return { code: EXIT.ERROR, message: record.error }
  if (!record.value) return { code: EXIT.REJECTED, message: `${name} 没有托管记录` }
  const counts = {}
  const { decisions } = listDecisions(changeDir)
  for (const decision of decisions) counts[decision.status] = (counts[decision.status] || 0) + 1
  const lines = [`变更：${name}`, `托管记录：${JSON.stringify(record.value)}`]
  for (const [key, count] of Object.entries(counts).sort()) lines.push(`决策 ${key}: ${count}`)
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
  if (command === 'start') return start(name, config)
  if (command === 'cancel') return cancel(name, config)
  if (command === 'status') return status(name, config)
  return { code: EXIT.ERROR, message: `不支持的子命令：${command}（start | cancel | status）` }
}

const result = main(process.argv.slice(2))
if (result.code === EXIT.OK) process.stdout.write(`${result.message}\n`)
else process.stderr.write(`${result.message}\n`)
process.exitCode = result.code
