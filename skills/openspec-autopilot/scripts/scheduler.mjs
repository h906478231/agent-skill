#!/usr/bin/env node
/**
 * 调度脚本：每轮按进度规则运行一个阶段，或处理一条已回复的决策。
 *
 * 所属：skill openspec-autopilot。调用方：launchd 定时触发，桥接脚本收到点选后也触发。
 * 用法：node scheduler.mjs --once；node scheduler.mjs --change-state-version（只读探测，输出契约版本后退出）
 * 输出：标准输出的阶段提示；日志写在托管目录的 logs/ 下。
 * 退出码：0 本轮结束（含「锁被占用，本轮不运行」）或探测成功；2 运行环境错误或参数无效。
 * 边界：只运行一个 claude 进程；对外写入只由出口动作执行（design D3、D11）。
 */

import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { alertCard, checkFailureLines, deliveryOf, exitCard, isMessageId, noticeCard, questionCard, sendCard,
  sendRecoveryCard } from './lib/card.mjs'
import { createDecision, decisionFile, decisionsDir, fingerprintOf, listDecisions, nextDecisionId,
  OPEN_STATUSES, readDecision, recordFile, scanDecisions, transition } from './lib/decisions.mjs'
import { writeJsonAtomic } from './lib/atomic-write.mjs'
import { sameObject } from './lib/bounded-json.mjs'
import { batchOf, enumerateBatches, locateBatch, readReturnHandoff, withVerifiedBatch } from './lib/batch.mjs'
import { batchKey, canonicalJson, pendingForName, readPendingTrace, replacePendingTrace,
  traceDigest, traceFits, writeRecoveryCursor } from './lib/pending-trace.mjs'
import { captureWriter, writerStatus } from './lib/writer-instance.mjs'
import { appendLog, homeDir, readConfig, writeHomeJson } from './lib/home.mjs'
import { acquireLock, currentBootTime, readLockFile, releaseLock, writeLockFile } from './lib/lock.mjs'
import { gitUserName, inside, readProgressView, realPath } from './lib/project.mjs'
import { trustedScript } from './lib/trusted-scripts.mjs'
import { checkProject } from './lib/rule-check.mjs'
import { sameDirectory, STATE_FILE, STATE_VERSION, StateError, stateReadBudget, stateSnapshot,
  verifyStateDigest } from './lib/change-state.mjs'
import { compareSignOff, compareTrace, recoveryTraceSnapshot, traceSnapshot, validTrace } from './lib/trace-check.mjs'
import {
  COMMIT_OPTIONS, EXIT_ACTIONS, PUSH_OPTIONS, checkPlan, contentHash, currentExit, executeCommitMerge, executePush,
  git, gitLine, mainSpecList, otherMainSpecs, pushList, writeExitState,
} from './lib/exit-actions.mjs'

/** 退出码：本轮结束 / 运行环境错误 / 收到 SIGTERM（128 + 信号编号 15，shell 的惯例）。 */
const EXIT = Object.freeze({ OK: 0, ERROR: 2, TERMINATED: 143 })

/** claude 运行的最长时间（design D4）：超时后向它的进程组发 SIGTERM。 */
const CLAUDE_TIMEOUT_MS = 30 * 60 * 1000

/**
 * 正在运行的 claude 进程号。claude 以新进程组启动，进程号就是进程组号；
 * 调度进程收到 SIGTERM 或出现未捕获异常时，向这个进程组发 SIGTERM（design D12）。
 */
let activeClaudePid = null

/** 本 skill 的目录：脚本在 <skill>/scripts/，上一级是 skill 根。 */
const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 进度规则对应的阶段 skill（design D3 的规则表）。 */
const RULE_SKILL = Object.freeze({
  R6: 'openspec-apply-change',
  R7: 'openspec-apply-change',
  R8: 'openspec-code-quality',
  R9: 'openspec-verify-change',
  R11: 'openspec-archive-change',
})

/** 规则 R1–R5 与 R10 表示流程停住，需要用户在会话中处理（design D3）。 */
const VOID_RULES = ['R1', 'R2', 'R3', 'R4', 'R5', 'R10']

/**
 * claude CLI 找不到要恢复的会话时输出的错误文本（design D5 结果表「报找不到会话」）。
 * 文本以 CLI 实际输出为准，上线后验收时确认（deployment.md「上线后验收」）。
 */
const SESSION_NOT_FOUND = /no conversation found|session[^\n]{0,40}not found/i

/** 核对结果文件：已通知过的启动前核对条目（按项目根）与运行环境原因，结果不变时不再发卡片（design D4）。 */
const CHECK_FILE = 'rule-check.json'
const RECOVERY_MS = 120_000
const CURSOR_RESERVE_MS = 1_000
const recoveredThisRound = new Set()
const CARD_LIMIT = 24 * 1024
const HANDOFF_SCAN_MS = 2_000
const VERSION_REASON = '比较起点的版本与当前不同'
const RECHECK_VOID = '提问因本次重新核对作废'
const EARLY_ARCHIVE_VOID = '提前归档后续查选项失效'
const READ_FAILURE_TEXT = '无法读取处理记录，无法列出修改。请先修复读取原因，再选「补充说明后继续」，托管以比较起点列出修改。选「回会话处理」后，托管不再列出这次运行的修改，请在会话中查看 agent 对 review/、evidence/、tasks.md 的修改。'
/** 每轮状态异常与发卡结果未知通知的条数与合计等待时间上限（add-change-pause design D5，评审 PERF-13）。 */
const STATE_NOTICE_LIMIT = 3
const STATE_NOTICE_MS = 60_000
/** 同一轮归档出口读取状态共用的时间（add-change-pause design D5，评审 PERF-09）。 */
const ARCHIVE_STATE_MS = 10_000
let pendingStore
let runToken
let recoveryDeadline = Infinity
/** 本轮已用的通知名额与时间、归档状态读取时间；每轮开始时重置。 */
let roundBudget = { notices: 0, noticeMs: 0, archiveStateMs: 0 }

function checkRecoveryTime() {
  const remaining = Math.floor(recoveryDeadline - performance.now())
  if (remaining <= 0) throw new Error('本轮恢复时间已用完')
  return remaining
}

/** 写一条调度日志（design D2）。 */
const log = (event, fields) => appendLog('scheduler', event, fields)

/**
 * 判断命令能否执行。只看文件是否可执行，不运行它：探测用的 --version 会被 claude 与 lark-cli 记成一次调用。
 * @param {string} command 命令路径或 PATH 中的命令名。
 * @returns {boolean} 能执行时为 true。
 */
function canRun(command) {
  if (!command) return false
  const candidates = command.includes(path.sep)
    ? [command]
    : (process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, command))
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      if (statSync(candidate).isFile()) return true
    } catch {
      // 试下一个候选路径。
    }
  }
  return false
}

/**
 * 取真实路径；取不到时用原路径。
 * @param {string} target 路径。
 * @returns {string} 真实路径。
 */
function realOf(target) {
  try {
    return realPath(target)
  } catch {
    return path.resolve(target)
  }
}

/**
 * 运行环境检查（design D4「运行环境检查」，评审 SEC-02、SEC-12、SEC-13、ARCH-01）。
 * @param {object} config 托管配置。
 * @returns {{ problems: string[], scriptSource: boolean }} problems 为不通过的原因，为空表示通过；
 *   scriptSource 为 true 时有辅助脚本或本 skill 的来源无法核验（add-change-pause design D5「辅助脚本来源核验失败」）。
 */
function checkEnvironment(config) {
  const problems = []
  if (!config.model) problems.push('配置没有 model')
  if (!config.ownerOpenId) problems.push('配置没有 ownerOpenId')
  if (!Array.isArray(config.projects) || !config.projects.length) problems.push('配置没有 projects')
  if (problems.length) return { problems, scriptSource: false }
  if (!canRun(process.execPath)) problems.push('node 不能运行')
  if (!canRun(config.claudeBin)) problems.push(`claudeBin 不能运行：${config.claudeBin}`)
  if (!canRun(config.larkBin)) problems.push(`larkBin 不能运行：${config.larkBin}`)

  // 守卫脚本不能装在被托管的仓库中：agent 改代码就能改掉守卫（design D4，评审 SEC-02）。
  const skillReal = realOf(SKILL_DIR)
  try {
    if (config.projects.some(project => inside(skillReal, realOf(project.root)))) throw new Error(`skill 目录在项目内：${skillReal}`)
    // 不能把「项目之外」当作可信依据。先核验两个脚本，再用真实路径探测门禁，后续读取沿用这两个路径。
    const progressBin = trustedScript(config, 'progressBin')
    const gateBin = trustedScript(config, 'gateBin')
    Object.assign(config, { progressBin, gateBin })
  } catch (error) {
    return { problems: [...problems, error.message], scriptSource: true }
  }
  if (!problems.length) {
    const usage = spawnSync(process.execPath, [config.gateBin], { encoding: 'utf8', timeout: 60_000 })
    if (usage.error || !/\btrace\b/.test(`${usage.stdout || ''}\n${usage.stderr || ''}`)) {
      problems.push('gateBin 不支持 trace，请同步 openspec-technical-review')
    }
  }

  // allowedCommands 只接受 Bash(<命令前缀>...) 形式（design D4，评审 SEC-12）。
  for (const project of config.projects) {
    for (const rule of project.allowedCommands || []) {
      if (!rule.startsWith('Bash(') || !rule.endsWith(')') || rule.slice(5, -1).trim() === ''
        || rule.slice(5, -1).trim().startsWith('*')) {
        problems.push(`allowedCommands 的条目不是 Bash(<命令前缀>...) 形式：${rule}`)
      }
    }
  }

  // 项目根必须是仓库根（design D4，评审 SEC-13）。
  for (const project of config.projects) {
    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: project.root, encoding: 'utf8' })
    if (top.status !== 0) {
      problems.push(`项目根不是 git 仓库：${project.root}`)
      continue
    }
    if (realOf(top.stdout.trim()) !== realOf(project.root)) {
      problems.push(`项目根不是仓库根：${project.root}`)
    }
    const changesDir = path.join(project.root, 'openspec', 'changes')
    if (!existsSync(changesDir) || !statSync(changesDir).isDirectory()) {
      problems.push(`项目根没有 openspec/changes 目录：${project.root}`)
    }
  }

  // skill 条目的实际路径不能是主目录或它的上级（design D4，评审 SEC-09）。
  const home = process.env.HOME || ''
  for (const dir of [path.join(home, '.claude', 'skills'), path.join(home, '.claude', 'skills', 'synced')]) {
    if (!existsSync(dir)) continue
    for (const item of readdirSync(dir)) {
      const real = realOf(path.join(dir, item))
      if (real === realOf(home) || real === realOf(path.dirname(home)) || real === '/') {
        problems.push(`skill 条目 ${item} 指向主目录或它的上级：${real}`)
      }
    }
  }
  return { problems, scriptSource: false }
}

/**
 * 辅助脚本来源无法核验时，只在本机报告待核对记录（add-change-pause design D5「辅助脚本来源核验失败」，R2-C03）。
 * 在已持有的全局运行锁内只读本机待核对文件，写本机日志与标准错误；不运行门禁、进度视图或飞书命令，
 * 不改写记录，也不要求先确认旧写者停止。
 */
function reportLocalPending() {
  let store
  try {
    store = readPendingTrace()
  } catch (error) {
    log('pending-trace-unreadable', { reason: error.code || error.message })
    process.stderr.write('本机待核对记录不可读，请回会话核对后再运行托管。\n')
    return
  }
  for (const entry of Object.values(store.entries)) {
    const action = entry.mode === 'version-handoff' ? '版本转交' : `${entry.stage} 阶段核对`
    log('pending-trace-local', { change: entry.name, startedAt: entry.startedAt, directory: entry.directory, action })
    process.stderr.write(`待核对：${entry.name}（批次 ${entry.startedAt}）的${action}，请回会话核对。\n`)
  }
}

/**
 * 列出 skill 目录条目及其真实路径，生成读取规则（design D4「skill 目录的读取规则」，评审 SEC-17）。
 * @param {string} home 用户主目录。
 * @returns {{ rules: string[], skipped: string[] }} 读取规则与被跳过的条目名。
 */
function skillReadRules(home) {
  const skillsDir = path.join(home, '.claude', 'skills')
  const paths = new Set()
  const skipped = []
  if (!existsSync(skillsDir)) return { rules: [], skipped }
  paths.add(realOf(skillsDir))
  if (realOf(skillsDir) !== skillsDir) paths.add(skillsDir)
  const entries = [...readdirSync(skillsDir), ...(existsSync(path.join(skillsDir, 'synced'))
    ? readdirSync(path.join(skillsDir, 'synced')).map(item => path.join('synced', item)) : [])]
  for (const item of entries) {
    const real = realOf(path.join(skillsDir, item))
    // 只为含 SKILL.md 的目录生成规则：不是 skill 的条目被整个放行时读取范围会超出已安装的 skill（评审 SEC-17）。
    if (existsSync(path.join(real, 'SKILL.md')) && statSync(path.join(real, 'SKILL.md')).isFile()) paths.add(real)
    else {
      skipped.push(item)
      log('skill-entry-skipped', { entry: item, realPath: real })
    }
  }
  const rules = []
  for (const item of paths) {
    rules.push(`Read(//${item}/**)`, `Grep(//${item}/**)`, `Glob(//${item}/**)`)
  }
  return { rules, skipped }
}

/**
 * 写出设置文件与 MCP 配置（design D4「模板与拒绝规则」）。
 * 占位符在解析后的 JSON 值上替换，两个文件都先写临时文件再 rename（评审 SEC-09）。
 * @param {object} config 托管配置。
 * @param {object} project 项目配置。
 * @param {string[]} readRules skill 目录的读取规则。
 * @returns {{ settingsFile: string, mcpFile: string, allowedTools: string[] }} 写出的文件与允许规则。
 */
function writeSettings(config, project, readRules) {
  const home = homeDir()
  const commands = project.allowedCommands || []
  const prefixes = commands.map(rule => rule.slice(5, -1)).join('、')
  const allowedTools = [...commands, ...readRules]

  const settingsFile = path.join(home, 'settings.json')
  const template = readFileSync(path.join(SKILL_DIR, 'templates', 'autopilot-settings.json'), 'utf8')
  const written = JSON.parse(template.replace(/<SKILL_DIR>/g, SKILL_DIR).replace(/<AUTOPILOT_HOME>/g, home))
  writeJsonAtomic(settingsFile, written)

  const mcpFile = path.join(home, 'mcp.json')
  const mcp = JSON.parse(readFileSync(path.join(SKILL_DIR, 'templates', 'autopilot-mcp.json'), 'utf8'))
  mcp.mcpServers.autopilot.env.AUTOPILOT_ALLOWED_COMMANDS = prefixes
  writeJsonAtomic(mcpFile, mcp)

  return { settingsFile, mcpFile, allowedTools }
}

/**
 * 列出变更目录中未完成的决策。
 * @param {string} changeDir 变更目录。
 * @returns {object[]} 决策列表。
 */
function openDecisions(changeDir) {
  const open = []
  const error = scanDecisions(decisionsDir(changeDir), decision => {
    if (OPEN_STATUSES.includes(decision.status)) open.push(decision)
  }, checkRecoveryTime)
  if (error) throw new Error(`未能完整读取决策：${error}`)
  return open.sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * 生成阶段提示词（design D3「阶段提示词」）。
 * @param {object} options skill 为阶段 skill 名；change 为变更名；skillDir 为已安装 skill 的目录；
 *   userName 为项目用户名；note 为补充说明。
 * @returns {string} 提示词。
 */
function stagePrompt({ skill, change, skillDir, userName, note }) {
  const lines = [
    `运行 skill ${skill} 完成变更 ${change}。`,
    `规则文件与脚本使用已安装副本的目录 ${skillDir}，不要使用项目中同名的文件。`,
    '本次运行在托管中。',
    `项目用户名为 ${userName}，只用于留痕字段（CONTEXT.md 的接受人、驳回人、决策人），不写入签署字段（签字行、变更终点区块的判定人、待环境补测登记的确认人、分镜签署行）；回复也不能代替用户写入签署字段。`,
    '需要用户决定时，单独调用 AskUserQuestion，这一轮不要调用其他工具。',
  ]
  if (note) lines.push(`用户补充说明：${note}`)
  return lines.join('\n')
}

/**
 * 把 claude 进程号写回运行锁。只写本进程持有的锁：撤回读锁中的 claudePid 向进程组发 SIGTERM（design D12）。
 * @param {number|null} pid claude 进程号；claude 结束后写 null。
 */
function writeLockClaudePid(pid, writer = null) {
  const lockFile = path.join(homeDir(), 'run.lock')
  const lock = readLockFile(lockFile)
  if (lock.value?.pid !== process.pid || lock.value?.token !== runToken) return false
  writeLockFile(lockFile, { ...lock.value, claudePid: pid, writer })
  return true
}

/** 向正在运行的 claude 进程组发 SIGTERM；没有 claude 在运行时不做任何事。 */
function terminateClaude() {
  if (!activeClaudePid) return
  try {
    process.kill(-activeClaudePid, 'SIGTERM')
  } catch {
    // 进程组已经退出。
  }
}

/**
 * 启动 claude（design D4「headless 运行参数」）。
 * @param {object} options config、project、changeRoot、prompt、resume、readRules。
 * @returns {object} 运行结果：code、stdout、stderr、sessionId、result。
 */
async function runClaude({ config, project, changeRoot, prompt, resume, readRules, draft = false, saved = null }) {
  const { settingsFile, mcpFile, allowedTools } = writeSettings(config, project, readRules)
  const args = []
  if (resume) args.push('--resume', resume)
  // 恢复会话时不带提示词：提示词会让 agent 从头开始（design D3 的恢复约定）。
  if (prompt) args.push('-p', prompt)
  args.push(
    '--model', config.model,
    '--setting-sources', 'user,project',
    '--settings', settingsFile,
    '--mcp-config', mcpFile,
    '--strict-mcp-config',
    '--permission-prompt-tool', 'mcp__autopilot__approve',
  )
  if (draft) {
    // 起草是只读的：不给写工具，也不给 Agent 与 Skill（design D11「起草」，评审 SEC-13）。
    args.push('--permission-mode', 'dontAsk')
    args.push('--disallowedTools', 'Edit Write MultiEdit NotebookEdit WebFetch WebSearch Agent Skill')
    args.push('--allowedTools', 'Bash(git status:*),Bash(git diff:*),Bash(git log:*),Bash(git show:*)')
  } else {
    args.push('--permission-mode', 'acceptEdits')
    args.push('--allowedTools', allowedTools.join(','))
    args.push('--disallowedTools', 'WebFetch WebSearch')
  }
  args.push('--max-budget-usd', String(config.maxBudgetUsd), '--output-format', 'json')
  // 环境变量只保留必要的几项：继承桌面端的 CLAUDE_CODE_* 变量会让 CLI 报未登录（design D4，实验 1）。
  const env = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    USER: process.env.USER,
    LANG: process.env.LANG,
    OPENSPEC_AUTOPILOT_HOME: homeDir(),
    OPENSPEC_AUTOPILOT_CHANGE_ROOT: changeRoot,
  }
  // 写阶段先在独立进程组等待。调度进程失联时管道关闭，阶段收不到放行指令。
  const marker = saved && `autopilot-stage-${saved.runId}`
  const child = saved
    ? spawn('/bin/sh', ['-c', 'IFS= read -r release && [ "$release" = run ] || exit 125; "$@" </dev/null & wait "$!"',
      marker, config.claudeBin, ...args], { cwd: project.root, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(config.claudeBin, args, { cwd: project.root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const finished = new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    // 命令不能启动时没有 close 事件：按退出码为空处理，与超时相同。
    child.on('error', error => resolve({ status: null, stdout, stderr: stderr || error.message }))
    child.on('close', status => resolve({ status, stdout, stderr }))
  })
  let published = null
  let released = !saved
  if (saved) child.stdin.on('error', () => { /* 进程已经退出，由 close 收尾。 */ })
  if (child.pid) {
    activeClaudePid = child.pid
    try {
      if (saved) {
        for (let attempt = 0; !published && attempt < 5; attempt += 1) {
          published = captureWriter(child.pid, marker)
          if (!published) await new Promise(resolve => setTimeout(resolve, 20))
        }
        if (!published || !writeLockClaudePid(child.pid, published)) throw new Error('无法发布阶段进程实例')
        withBatch(saved, target => {
          if (target.directory !== changeRoot || target.record.exitBlock || !['active', 'exiting'].includes(target.record.status)) {
            throw new Error('放行前托管批次已变化')
          }
          replacePendingTrace(pendingStore, batchKey(saved), { ...saved, writer: published })
          child.stdin.end('run\n')
          released = true
        })
      } else {
        writeLockClaudePid(child.pid)
      }
    } catch (error) {
      child.stdin?.end()
      terminateClaude()
      log('writer-publish-failed', { change: saved?.name, reason: error.code || error.message })
    }
  }
  const timer = setTimeout(terminateClaude, CLAUDE_TIMEOUT_MS)
  const result = await finished
  clearTimeout(timer)
  let writerStopped = !published || writerStatus(published) === 'no'
  if (saved && published && !writerStopped) {
    // close 只证明主进程退出。短暂等待同组写者退出，失败则交后续轮次核验。
    const deadline = performance.now() + 1_000
    while (!writerStopped && performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
      writerStopped = writerStatus(published) === 'no'
    }
  }
  if (child.pid && writerStopped) {
    activeClaudePid = null
    writeLockClaudePid(null)
  }
  let parsed = null
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    parsed = null
  }
  return {
    code: result.status === null ? 1 : result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    sessionId: parsed && parsed.session_id ? parsed.session_id : null,
    result: parsed,
    writerStopped,
    released,
  }
}

/**
 * 发一张通知卡片：通知不创建决策文件（design D3）。
 * @param {object} config 托管配置。
 * @param {string} change 变更名。
 * @param {string} title 卡片标题。
 * @param {string[]} lines 正文行。
 */
function sendNotice(config, change, title, lines, key = `${change}-notice-${Date.now()}`, limit = 60_000) {
  const body = Array.isArray(lines) ? lines : [String(lines)]
  const options = { larkBin: config.larkBin, ownerOpenId: config.ownerOpenId, card: noticeCard({ title, lines: body }),
    idempotencyKey: key, timeout: Math.min(60_000, limit, checkRecoveryTime()) }
  // 返回发送结果：状态异常通知只在发送成功后记录去重（add-change-pause design D5）。
  const record = sent => {
    log('notice-card', { change, title, ok: sent.ok })
    return sent
  }
  if (Number.isFinite(recoveryDeadline)) return sendRecoveryCard(options).then(record)
  return record(sendCard(options))
}

/**
 * 无决策编号的通知只在确认发送成功后记录去重（add-change-pause design D5，评审 SEC-16）：
 * 未发出或结果未知时不记录，下一轮用同一幂等键再次发送。恢复期间 sendNotice 返回 Promise，其他时候同步返回。
 * @param {object|Promise<object>} sent sendNotice 的返回值。
 * @param {Function} remember 发送成功后写去重记录。
 * @returns {object|Promise<object>} 原发送结果。
 */
function afterSent(sent, remember) {
  const settle = result => {
    if (result?.ok) remember()
    return result
  }
  return typeof sent?.then === 'function' ? sent.then(settle) : settle(sent)
}

/** 用已保存的决策重建卡片。同一编号的完整卡和摘要由保存的请求确定。 */
function cardFor(entry, decision) {
  const { kind } = decision
  return kind === 'exit' || kind === 'exit-alert'
    ? exitCard({ title: `${entry.change} 出口动作`, decision, change: entry.change })
    : kind === 'question'
    ? questionCard({
      title: `${entry.change} 需要你的决定`,
      questions: decision.request.questions || [],
      decisionId: decision.id,
      change: entry.change,
    })
    : alertCard({
      title: `${entry.change} 需要你的处理`,
      options: decision.request.options || ['回会话处理'],
      decisionId: decision.id,
      change: entry.change,
      text: decision.request.cardSummary || decision.request.text,
      checkFailures: decision.request.cardSummary ? [] : decision.request.checkFailures || [],
    })
}

/**
 * 按发送记录领取并发送决策卡片（add-change-pause design D5「决策卡片的发送记录」）。
 * 项目保护内复核批次、原决策、状态快照与发送状态，原子保存 claimed 领取记录后才在保护外调用飞书；
 * 领取记录绑定批次、决策编号、本次领取标识、幂等键、收件人与卡片内容摘要。回写时复核同一次领取：
 * 只有合法消息编号写 sent（评审 SEC-15），确认命令未启动时写 not-sent，其他结果保持 claimed，按结果未知处理。
 * @param {object|null} state 本轮的状态快照；为 null 时不复核状态（结果交接、恢复与出口沿用原规则）。
 * @returns {Promise<{preflightPassed: boolean, recorded: boolean, delivery: string|null}>}
 *   delivery 为 sent、not-sent 或 unknown；没有领取或没有调用飞书时为 null。
 * @throws {StateError} 状态快照无法在领取点复核时抛出，不保存领取。
 */
async function sendDecisionCard(config, entry, decision, batch, state = null) {
  const card = cardFor(entry, decision)
  // 摘要取发送文件的实际字节（含末尾换行），not-sent 重试时用它证明内容未变。
  const content = `${JSON.stringify(card, null, 2)}\n`
  const request = { batchStartedAt: batch.startedAt, decisionId: decision.id, key: stableCardKey(batch, decision.id),
    recipient: config.ownerOpenId, contentDigest: createHash('sha256').update(content).digest('hex') }
  const claim = withBatch(batch, target => {
    const current = readDecision(target.directory, decision.id).value
    if (!current || canonicalJson(current) !== canonicalJson(decision)) return null
    if (target.record.status === 'void') {
      transition(decisionFile(target.directory, decision.id), ['pending'], { status: 'void', voidReason: '托管已撤回' })
      return null
    }
    if (target.record.status === 'closed') return null
    if (target.record.exitBlock && (decision.kind !== 'alert' || JSON.stringify(decision.request.options) !== '["回会话处理"]')) return null
    verifyChangeState(target, state)
    const delivery = deliveryOf(current.card)
    if (delivery === 'not-sent') {
      // 确认未发出的请求只按原编号、收件人、内容和幂等键重试；任一不符时不发送，交回会话。
      const prior = current.card.claim || {}
      if (Object.keys(request).some(key => prior[key] !== request[key])) return { mismatch: true }
    } else if (delivery !== 'unclaimed') {
      return null
    }
    if (Buffer.byteLength(content, 'utf8') > CARD_LIMIT) return { oversized: true }
    const claimed = { ...request, id: randomUUID() }
    // 领取保存失败时不调用飞书。
    if (!transition(decisionFile(target.directory, decision.id), ['pending'], {
      card: { messageId: null, sendState: 'claimed', claim: claimed },
    }).ok) return null
    return claimed
  })
  if (!claim) return { preflightPassed: false, recorded: false, delivery: null }
  if (claim.oversized) {
    await diagnostic(config, batch, `${decision.id} 的决策卡片超过 24 KiB`)
    return { preflightPassed: true, recorded: false, delivery: null }
  }
  if (claim.mismatch) {
    await stateNotice(config, batch, 'mismatch', state?.changeState.digest ?? null, decision.id)
    return { preflightPassed: true, recorded: false, delivery: null }
  }
  const options = { larkBin: config.larkBin, ownerOpenId: claim.recipient, card,
    idempotencyKey: claim.key, timeout: Math.min(60_000, checkRecoveryTime()) }
  const sent = Number.isFinite(recoveryDeadline) ? await sendRecoveryCard(options) : sendCard(options)
  log('decision-card', { change: entry.change, decision: decision.id, ok: sent.ok, notSent: sent.notSent })
  checkRecoveryTime()
  // 超时、中断、非零退出、编号不合法都不能证明请求未发出：保持 claimed，下一轮按结果未知处理，不重发。
  const outcome = sent.ok && isMessageId(sent.messageId) ? 'sent' : sent.notSent ? 'not-sent' : null
  if (!outcome) return { preflightPassed: true, recorded: false, delivery: 'unknown' }
  const written = withBatch(batch, target => {
    if (target.record.status === 'void' || target.record.status === 'closed') return false
    const current = readDecision(target.directory, decision.id).value
    // 只回写同一次领取，不覆盖回复或决策终态。
    if (current?.status !== 'pending' || current.card?.sendState !== 'claimed' || current.card.claim?.id !== claim.id) return false
    return transition(decisionFile(target.directory, decision.id), ['pending'], {
      card: { messageId: outcome === 'sent' ? sent.messageId : null, sendState: outcome, claim },
    }).ok
  })
  // 结果写不进原决策时同样不能证明送达或未发出。
  return { preflightPassed: true, recorded: written && outcome === 'sent', delivery: written ? outcome : 'unknown' }
}

/**
 * 状态异常与发卡异常的固定类别（add-change-pause design D5）。通知只写这些固定文本、变更名与批次开始时间，
 * 不写原因原文、绝对路径、原始诊断或可回复操作；发卡结果未知的通知不带决策编号。
 */
const STATE_NOTICES = Object.freeze({
  paused: {
    title: '托管与推进意愿不一致',
    category: '变更已暂缓，托管记录仍为 active 或 exiting',
    // 合法的 pause 不会在托管中写入暂缓；批次仍在托管时 resume 也会被拒绝，因此提示先撤回。
    hint: '托管没有开始下一步，也没有修改推进意愿或托管记录。请回会话核对：运行 cancel 撤回托管，要继续推进时再运行 resume 与 start。',
  },
  unknown: {
    title: '托管无法核验变更状态',
    category: '变更状态无法核验',
    hint: '托管没有开始下一步。请修复变更状态文件后等待下一轮。',
  },
  contract: {
    title: '托管无法核验变更状态',
    category: '进度视图缺少变更状态契约 1',
    hint: '托管没有开始下一步。请配套同步托管、进度视图和门禁三个副本后等待下一轮。',
  },
  delivery: {
    title: '托管卡片发送结果未知',
    category: '决策卡片可能已发出，发送结果没有记录',
    hint: '托管不重发原卡片，该批次不再推进。请回会话核对，或运行 cancel 撤回托管。',
  },
  mismatch: {
    title: '托管卡片无法按原内容重发',
    category: '未发出的卡片的内容、收件人或幂等键已改变',
    hint: '托管不发送改变后的卡片，该批次不再推进。请回会话核对，或运行 cancel 撤回托管。',
  },
})

/**
 * 发一条状态异常或发卡异常的处理通知（add-change-pause design D5）。
 * 按项目、批次、状态摘要与类别去重，只在本机保存；发送成功后才记录，失败时下一轮再试。
 * 每轮最多 3 条、合计最多 60 秒，单条最多用剩余时间；超限的通知推迟到下一轮，不记录去重，阻断照旧（评审 PERF-13）。
 * @param {object} config 托管配置。
 * @param {object} batch 批次身份。
 * @param {string} kind STATE_NOTICES 的键。
 * @param {string|null} digest 状态文件摘要；缺失时用空值，不重读超限文件。
 * @param {string} [scope] 去重的附加范围（发卡异常时为决策编号），不写入通知。
 */
async function stateNotice(config, batch, kind, digest, scope = '') {
  const notice = STATE_NOTICES[kind]
  const key = stableCardKey(batch, JSON.stringify(['state-notice', kind, digest ?? '', scope]))
  if (readCheckState().stateNotices[key]) return
  const remaining = Math.floor(STATE_NOTICE_MS - roundBudget.noticeMs)
  if (roundBudget.notices >= STATE_NOTICE_LIMIT || remaining <= 0) {
    log('state-notice-deferred', { change: batch.name, startedAt: batch.startedAt, kind })
    return
  }
  roundBudget.notices += 1
  const started = performance.now()
  try {
    await afterSent(sendNotice(config, batch.name, notice.title, [
      `变更：${batch.name}`, `批次开始时间：${batch.startedAt}`, `类别：${notice.category}`, notice.hint,
    ], key, remaining), () => {
      const state = readCheckState()
      state.stateNotices[key] = { startedAt: batch.startedAt, kind }
      writeHomeJson(CHECK_FILE, state)
    })
  } finally {
    roundBudget.noticeMs += performance.now() - started
  }
}

/**
 * 按状态契约判断一个批次本轮能否领取新动作（add-change-pause design D5）。
 * @param {unknown} version 视图或门禁输出的 changeStateVersion。
 * @param {object} facts 含 changeState 与 changeDirectory 的进度条目或门禁输出。
 * @param {string} changeDir 本批次的目录。
 * @param {string} change 变更名，只写本机日志。
 * @returns {{ snapshot: object|null, kind: string|null, digest: string|null }} kind 为 null 时可以领取新动作；
 *   否则为 STATE_NOTICES 的键。
 */
function stateOf(version, facts, changeDir, change) {
  const raw = facts.changeState?.digest
  const digest = typeof raw === 'string' && /^[a-f0-9]{64}$/.test(raw) ? raw : null
  if (version !== STATE_VERSION || !('changeState' in facts)) return { snapshot: null, kind: 'contract', digest }
  let snapshot
  try {
    snapshot = stateSnapshot(facts)
  } catch (error) {
    // 原始诊断只写本机日志。
    log('change-state-unknown', { change, reason: error.message })
    return { snapshot: null, kind: 'unknown', digest }
  }
  // 快照的目录不是本批次的目录时，不能用它的状态判断本批次（定位不明时不按缺状态文件处理）。
  if (snapshot.changeDirectory.path !== changeDir) return { snapshot: null, kind: 'unknown', digest }
  return { snapshot, kind: snapshot.changeState.state === 'paused' ? 'paused' : null, digest }
}

/** 活跃变更只用本轮已读的进度视图，不另外运行门禁（评审 PERF-07）。 */
const activeState = ({ view, entry, changeDir }) => stateOf(view.changeStateVersion, entry, changeDir, entry.change)

/**
 * 归档出口在本轮的状态快照（add-change-pause design D5，评审 PERF-09）。
 * 复用本轮候选扫描已核实的归档目录，不另外定位；在保护外以该项目的真实根传 --repo，运行门禁只读的 state 子命令。
 * 同一轮的归档读取共用 10 秒，单次最多用剩余时间；超时按状态无法核验处理，并用尽本轮的读取时间。
 * @param {object} config 托管配置（gateBin 已核验来源）。
 * @param {object} candidate 归档候选。
 * @returns {{ snapshot: object|null, kind: string|null, digest: string|null }|null} 本轮读取时间已用尽时为 null。
 */
function archivedState(config, candidate) {
  const { project, entry, changeDir } = candidate
  const remaining = Math.min(Math.floor(ARCHIVE_STATE_MS - roundBudget.archiveStateMs), checkRecoveryTime())
  if (remaining <= 0) return null
  const started = performance.now()
  const result = spawnSync(process.execPath, [config.gateBin, 'state', changeDir, '--repo', project.root], {
    cwd: project.root, encoding: 'utf8', timeout: remaining, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
  })
  // 超时说明这次读取已用完剩余时间：本轮其余归档批次不再读取，避免只剩几毫秒时再按超时通知。
  roundBudget.archiveStateMs = result.error?.code === 'ETIMEDOUT' ? ARCHIVE_STATE_MS
    : roundBudget.archiveStateMs + performance.now() - started
  let facts = null
  try {
    if (!result.error && result.status === 0) facts = JSON.parse(result.stdout)
  } catch {
    facts = null
  }
  if (!facts || typeof facts !== 'object') {
    // 门禁超时、失败或输出无法解析：按状态无法核验处理，原始诊断只写本机日志。
    log('change-state-unknown', { change: entry.change, reason: result.error?.code || `门禁退出码 ${result.status}` })
    return { snapshot: null, kind: 'unknown', digest: null }
  }
  return stateOf(facts.changeStateVersion, facts, changeDir, entry.change)
}

/**
 * 领取点在项目保护内复核目录实例与状态摘要，只做 lstat 与摘要核对，不运行门禁（design D5，评审 PERF-07）。
 * @param {object} target withBatch 定位的批次。
 * @param {object|null} state 本轮快照；为 null 时不复核。
 * @throws {StateError} 目录实例或状态文件与快照不同（类别 1），或状态文件无效（类别 2）。
 */
function verifyChangeState(target, state) {
  if (!state) return
  let stat
  try {
    stat = lstatSync(target.directory, { bigint: true })
  } catch (error) {
    // 系统错误文本含绝对路径：只抛固定文本，按状态无法核验处理，不进入原文通知（评审 SEC-16）。
    // 目录在定位后消失属于快照之后的竞争（类别 1）。
    throw new StateError('变更目录无法核验', error.code === 'ENOENT' ? 1 : 2)
  }
  if (!stat.isDirectory() || !sameDirectory(state.changeDirectory, { path: target.directory, dev: String(stat.dev), ino: String(stat.ino) })) {
    throw new StateError('变更目录实例与进度快照不同', 1)
  }
  verifyStateDigest(path.join(target.directory, STATE_FILE), state.changeState.digest, stateReadBudget())
}

/**
 * 生成一个等待回复的决策对象。决策的公共字段只在这里定义：
 * 桥接脚本与 hook 按这些字段匹配回复，各处手写时漏一个字段，那类决策就匹配不上回复（quality R1 STD-01）。
 * 新决策的发送状态为 unclaimed（add-change-pause design D5）。
 * @param {string} kind 决策类型：question、alert、exit、exit-alert。
 * @param {string} stage 创建决策时的阶段。
 * @param {object} request 决策请求。
 * @returns {object} 决策对象（还没有编号）。
 */
function pendingDecision(kind, stage, request) {
  return { kind, status: 'pending', stage, request, card: { messageId: null, sendState: 'unclaimed' } }
}

/**
 * 复核出口批次后创建决策，释放项目保护再发卡。
 * 创建出口决策是出口的领取点：保护内复核本轮状态快照，不一致时抛出 StateError，不创建决策（add-change-pause design D5）。
 */
async function issueDecision(config, candidate, decision, logEvent, { fields = {} } = {}) {
  const { batch, entry } = candidate
  const created = withBatch(batch, target => {
    if (target.record.status !== 'exiting' || target.record.exitBlock
      || pendingForName(pendingStore, batch.root, batch.name)) throw new Error('本批次出口尚未获准')
    verifyChangeState(target, candidate.state)
    if (openDecisions(target.directory).length) throw new Error('已有未完成决策')
    const value = { ...decision, id: allocate(target.directory), batchStartedAt: batch.startedAt }
    createDecision(target.directory, value)
    return value
  })
  log(logEvent, { change: entry.change, decision: created.id, ...fields })
  await sendDecisionCard(config, entry, created, batch, candidate.state)
  return created
}

/**
 * 计算进展摘要（design D5「进展摘要」，评审 ARCH-04、CONC-09）。
 * 内容：进度条目的阶段、规则、任务、卡点与告警；git status 与 git diff 的输出（排除 openspec/changes）；
 * 未跟踪文件的内容哈希；变更目录中各文件的相对路径与内容哈希。
 * @param {object} project 项目配置。
 * @param {object} entry 进度条目。
 * @param {string} changeDir 变更目录。
 * @returns {string} 摘要。
 */
function progressDigest(project, entry, changeDir) {
  const parts = [entry.stage, entry.rule, JSON.stringify(entry.tasks), JSON.stringify(entry.blockers || []),
    JSON.stringify(entry.warnings || [])]
  const status = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.', ':(exclude)openspec/changes'],
    { cwd: project.root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const diff = spawnSync('git', ['diff', 'HEAD', '--', '.', ':(exclude)openspec/changes'],
    { cwd: project.root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  parts.push(status.stdout || '')
  parts.push(diff.stdout || '')
  // 未跟踪文件逐个取内容哈希：只改内容也要算进展（design D5）。
  for (const line of (status.stdout || '').split('\0').filter(Boolean)) {
    const code = line.slice(0, 2)
    const file = line.slice(3)
    if (code.startsWith('??')) {
      const hash = spawnSync('git', ['hash-object', file], { cwd: project.root, encoding: 'utf8' })
      parts.push(`${file}:${hash.status === 0 ? hash.stdout.trim() : 'null'}`)
    }
  }
  // 变更目录中各文件的相对路径与内容哈希（design D5）。
  for (const file of listFilesIn(changeDir)) {
    const full = path.join(changeDir, file)
    let hash = 'null'
    try {
      hash = createHash('sha256').update(readFileSync(full)).digest('hex')
    } catch {
      hash = 'null'
    }
    parts.push(`${file}:${hash}`)
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex')
}

/**
 * 递归列出一个目录下的文件，相对路径。
 * @param {string} dir 目录。
 * @param {string} prefix 相对前缀。
 * @returns {string[]} 相对路径。
 */
function listFilesIn(dir, prefix = '') {
  if (!existsSync(dir)) return []
  const files = []
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, item.name)
    const rel = prefix ? `${prefix}/${item.name}` : item.name
    if (item.isDirectory()) files.push(...listFilesIn(child, rel))
    else files.push(rel)
  }
  return files
}

/**
 * 判断一个已回复的决策里是否有「回会话处理」的回答（design D5 结果表第 3 行）。
 * @param {object} decision 决策对象。
 * @returns {boolean} 有该回答时为 true。
 */
function hasReturnToSession(decision) {
  const answers = (decision.answer && decision.answer.answers) || {}
  return Object.values(answers).some(value => value === '回会话处理')
}

/**
 * 取「回会话处理」对应的问题标题。
 * @param {object} decision 决策对象。
 * @returns {string} 问题标题。
 */
function returnToSessionQuestion(decision) {
  const answers = (decision.answer && decision.answer.answers) || {}
  const key = Object.keys(answers).find(item => answers[item] === '回会话处理')
  return key || ''
}

/** 按运行前身份重新定位。复核与写入之间只运行本机操作。 */
function withBatch(batch, work) {
  return withVerifiedBatch(batch, work, checkRecoveryTime)
}

const storeEntry = entry => replacePendingTrace(pendingStore, batchKey(entry), entry)
const removeEntry = entry => replacePendingTrace(pendingStore, batchKey(entry), null)
const stableCardKey = (batch, id) => createHash('sha256').update(JSON.stringify([batchKey(batch), id])).digest('hex')

/** 核对未完成通知。发送成功后才记录去重，未发出或结果未知时下一轮用同一幂等键再发（评审 SEC-16）。 */
function diagnostic(config, batch, reason) {
  log('pending-trace-blocked', { change: batch.name, directory: batch.directory, startedAt: batch.startedAt, reason })
  const key = stableCardKey(batch, reason)
  if (readCheckState().traceErrors[key]) return
  return afterSent(sendNotice(config, batch.name, '托管核对未完成', [
    `${batch.name}（${batch.startedAt}）：${batch.directory}`,
    reason,
    `请排除读取或写入失败后重试，或运行 autopilot.mjs cancel ${batch.name} 并回会话查看未核对的修改。`,
  ], key), () => {
    const state = readCheckState()
    state.traceErrors[key] = { startedAt: batch.startedAt, reason }
    writeHomeJson(CHECK_FILE, state)
  })
}

/**
 * 处理候选或恢复时的异常通知（add-change-pause design D5，评审 SEC-16）。
 * 状态核对的错误只发固定类别的处理通知，不把原因原文、绝对路径或原始诊断写进核对未完成通知；
 * 快照之后的竞争（类别 1）只写本机日志，下一轮重新取快照。其他异常沿用核对未完成通知。
 * @param {object} config 托管配置。
 * @param {object} batch 批次身份。
 * @param {Error} error 异常。
 * @param {string|null} [digest] 本轮状态快照的摘要，用于去重。
 */
async function reportFailure(config, batch, error, digest = null) {
  if (!(error instanceof StateError)) {
    await diagnostic(config, batch, error.code || error.message)
    return
  }
  log('change-state-blocked', { change: batch.name, startedAt: batch.startedAt, reason: error.message })
  if (error.code === 2) await stateNotice(config, batch, 'unknown', digest)
}

function allocate(directory, after) {
  const id = nextDecisionId(directory, after, checkRecoveryTime)
  if (!id) throw new Error('四位决策编号已用尽')
  checkRecoveryTime()
  return id
}

function prepareStage(config, candidate, stage, traceBefore, decision) {
  const batch = candidate.batch
  try {
    return withBatch(batch, target => {
      if (target.record.status !== candidate.record.status || target.record.exitBlock || target.directory !== candidate.changeDir) {
        throw new Error('托管状态或目录已变化')
      }
      // 保存核对起点就是领取：快照之后状态文件或目录实例变化时不保存起点，不启动或恢复会话（add-change-pause design D5）。
      verifyChangeState(target, candidate.state)
      if (decision) {
        const current = readDecision(target.directory, decision.id).value
        if (!current || current.status !== 'answered' || canonicalJson(current) !== canonicalJson(decision)) {
          throw new Error(`${decision.id} 的恢复决策已变化`)
        }
      }
      allocate(target.directory)
      if (pendingForName(pendingStore, batch.root, batch.name)) throw new Error('核对起点尚未交接')
      const saved = { ...batch, mode: 'stage', stage, runId: candidate.runId, traceBefore, writer: { state: 'unreleased' } }
      if (decision) saved.consumedDecisionId = decision.id
      storeEntry(saved)
      return saved
    })
  } catch (error) {
    // 状态复核失败交给 handleCandidate 按固定类别处理，不把原始诊断发到飞书。
    if (error instanceof StateError) throw error
    diagnostic(config, batch, error.code || error.message)
    return null
  }
}

function comparison(config, snapshot, saved, target) {
  const considered = []
  for (const id of saved.traceBefore.resumedDecisionIds) {
    checkRecoveryTime()
    const read = readDecision(target.directory, id)
    if (read.error || !read.value) throw new Error(`${id} 的核对回复无法读取`)
    if (!read.value.batchStartedAt || read.value.batchStartedAt === saved.startedAt) considered.push(read.value)
  }
  const failures = compareTrace({ before: saved.traceBefore, after: snapshot, decisions: considered, ownerOpenId: config.ownerOpenId })
    .concat(compareSignOff({ before: saved.traceBefore, after: snapshot }))
  if (target.recreated) failures.push({ file: target.directory, field: '原位置出现同名目录', before: saved.directory, after: target.recreated })
  checkRecoveryTime()
  return failures
}

function earlyArchive(saved, target) {
  return target.record.exitBlock || (saved.mode === 'stage' && saved.location === 'active' && target.location === 'archived'
    && saved.stage !== 'archive' ? { reason: 'early-archive', stage: saved.stage } : null)
}

function guardEarlyArchive(saved, target, block) {
  if (!block) return
  if (!target.record.exitBlock) {
    const marked = transition(recordFile(target.directory), [target.record.status], { exitBlock: block }, { startedAt: saved.startedAt })
    if (!marked.ok) throw new Error('无法保存提前归档的出口阻断')
  }
  for (const item of openDecisions(target.directory)) {
    if (!['exit', 'exit-alert'].includes(item.kind)) continue
    const result = transition(decisionFile(target.directory, item.id), OPEN_STATUSES, { status: 'void', voidReason: '提前归档' })
    if (!result.ok) throw new Error(`${item.id} 的出口决策无法作废`)
  }
}

function alertRequest({ saved, snapshot, failures, error, block, recovery = false }) {
  const request = {
    text: block ? `本批次在 ${block.stage} 阶段归档，缺少完成 quality、verify 的运行证据。请回会话处理。`
      : error ? READ_FAILURE_TEXT : recovery ? '运行结果未交接，已按原起点重新核对。请处理本次运行。'
        : '运行前后的记录不一致，请确认这些项。',
    options: ['回会话处理'], checkFailures: failures,
    traceBefore: saved.traceBefore, comparisonState: error ? 'unread' : 'listed',
    ...(snapshot ? { comparisonBoundary: snapshot } : {}),
    ...(saved.deferredToolUseId ? { deferredToolUseId: saved.deferredToolUseId } : {}),
  }
  if (!block && saved.sessionId && !saved.unavailable) request.sessionId = saved.sessionId
  return request
}

function limitAlert(batch, decision, id) {
  const request = decision.request
  if (!request || decision.kind !== 'alert') return
  const boundary = request.comparisonState === 'unread' ? request.traceBefore : request.comparisonBoundary
  if (request.sessionId && boundary && traceFits({ ...boundary, resumedDecisionIds: [...new Set([
    ...(request.comparisonState === 'unread' ? boundary.resumedDecisionIds || [] : []), id,
  ])] })) {
    request.options = ['补充说明后继续', '回会话处理']
  } else {
    delete request.sessionId
  }
  const card = cardFor({ change: batch.name }, { ...decision, id })
  if (Buffer.byteLength(JSON.stringify(card, null, 2), 'utf8') + 1 > CARD_LIMIT && request.checkFailures) {
    request.cardSummary = `核对项 ${request.checkFailures.length} 条。批次 ${batch.startedAt}，本地详情：decisions/${id}.json。`
    request.options = ['回会话处理']
    delete request.sessionId
  }
}

function reserveDecision(saved, target, decision, snapshot, kind) {
  if (openDecisions(target.directory).length) throw new Error('同批次还有其他未完成决策')
  const id = allocate(target.directory, saved.resultDecisionId)
  limitAlert(saved, decision, id)
  const reserved = { ...saved, resultDecisionId: id, resultKind: kind }
  if (kind === 'question') reserved.traceAfter = snapshot
  if (decision.request.comparisonBoundary) reserved.boundaryDigest = traceDigest(decision.request.comparisonBoundary)
  storeEntry(reserved)
  const request = { ...decision.request, pendingTraceKey: batchKey(saved) }
  if (kind === 'question') request.pendingTraceDigest = traceDigest(saved.traceBefore)
  else request.traceBefore = saved.traceBefore
  createDecision(target.directory, { ...decision, id, batchStartedAt: saved.startedAt, request })
  return id
}

function verifyTransfer(saved, decision, id) {
  if (decision.id !== id || decision.batchStartedAt !== saved.startedAt
    || decision.request?.pendingTraceKey !== batchKey(saved)) throw new Error(`${id} 的转交归属不符`)
  if (saved.resultKind === 'question') {
    if (decision.kind !== 'question' || decision.request.traceBefore !== undefined
      || canonicalJson(decision.request.pendingTraceDigest) !== canonicalJson(traceDigest(saved.traceBefore))) {
      throw new Error(`${id} 的提问转交摘要不符`)
    }
  } else {
    if (decision.kind !== 'alert' || canonicalJson(decision.request.traceBefore) !== canonicalJson(saved.traceBefore)) {
      throw new Error(`${id} 的告警转交起点不符`)
    }
    if (saved.boundaryDigest && (!decision.request.comparisonBoundary
      || canonicalJson(traceDigest(decision.request.comparisonBoundary)) !== canonicalJson(saved.boundaryDigest))) {
      throw new Error(`${id} 的续查边界不符`)
    }
    if (saved.resultKind === 'check-alert' && !['listed', 'unread'].includes(decision.request.comparisonState)) {
      throw new Error(`${id} 的核对状态无效`)
    }
    if (saved.mode === 'version-handoff' || saved.resultKind === 'early-archive-alert') {
      if (JSON.stringify(decision.request.options) !== '["回会话处理"]') throw new Error(`${id} 的告警选项无效`)
    }
  }
}

/**
 * 核验后只尝试发送一次结束通知。完成依据允许新批次替换已结束记录。
 * state 为正常候选本轮的状态快照：消费回复前在保护内复核（add-change-pause design D5）；已作废的批次只补完交接。
 */
async function finishReturnHandoff(config, batch, id, state = null) {
  const shouldNotify = withBatch(batch, target => {
    const { directory, record } = target
    if (record.status !== 'void') {
      verifyChangeState(target, state)
      const { value } = readDecision(directory, id)
      if (value?.status !== 'answered' || value.kind !== 'alert' || value.answer?.choice !== '回会话处理'
        || value.answer.operatorId !== config.ownerOpenId || (value.batchStartedAt && value.batchStartedAt !== batch.startedAt)) {
        throw new Error(`${id} 的回会话选择无法核验`)
      }
      const written = transition(recordFile(directory), [record.status], {
        status: 'void', voidReason: '用户选择回会话处理', returnHandoff: id,
      }, { startedAt: batch.startedAt })
      if (!written.ok) throw new Error('回会话托管记录写入失败')
    }
    const latest = locateBatch(batch, checkRecoveryTime)
    const handoff = readReturnHandoff(latest.directory, latest.record, config.ownerOpenId)
    if (!handoff || handoff.id !== id || handoff.completed) return false
    if (handoff.status === 'answered'
      && !transition(decisionFile(latest.directory, id), ['answered'], { status: 'used' }).ok) {
      throw new Error(`${id} 的回会话告警更新失败`)
    }
    const after = locateBatch(batch, checkRecoveryTime)
    if (readReturnHandoff(after.directory, after.record, config.ownerOpenId)?.status !== 'used') {
      throw new Error('回会话终态无法核验')
    }
    const completed = transition(recordFile(after.directory), ['void'], {
      returnHandoffCompleted: { id, startedAt: batch.startedAt },
    }, { startedAt: batch.startedAt })
    if (!completed.ok) throw new Error('回会话完成依据写入失败')
    return true
  })
  if (shouldNotify) await sendNotice(config, batch.name, '托管已作废', [
    '用户在卡片上选择回会话处理，请在会话中继续处理。',
  ], stableCardKey(batch, `return-${id}`))
}

function recoverVersionHandoff(config, saved, target) {
  const directory = target.directory
  const source = readDecision(directory, saved.sourceDecisionId)
  if (source.error || source.value?.kind !== 'alert' || source.value.answer?.choice !== '补充说明后继续'
    || source.value.answer.operatorId !== config.ownerOpenId
    || (source.value.batchStartedAt && source.value.batchStartedAt !== saved.startedAt)
    || canonicalJson(source.value.request?.traceBefore) !== canonicalJson(saved.traceBefore)) {
    throw new Error(`${saved.sourceDecisionId} 的版本转交来源无法核验`)
  }
  const prior = readDecision(directory, saved.alertId)
  if (prior.error) throw new Error(`${saved.alertId} 的替代告警无法读取`)
  if (prior.value) verifyTransfer(saved, prior.value, saved.alertId)
  if (source.value.status === 'answered') {
    if (!transition(decisionFile(directory, saved.sourceDecisionId), ['answered'], {
      status: 'used', result: { reason: VERSION_REASON, replacement: saved.alertId },
    }).ok) throw new Error('版本转交无法结束原告警')
  } else if (source.value.status !== 'used' || source.value.result?.reason !== VERSION_REASON
    || source.value.result.replacement !== saved.alertId) throw new Error('版本转交原告警状态不符')
  if (!prior.value) {
    const decision = pendingDecision('alert', source.value.stage, {
      text: `${VERSION_REASON}。请回会话处理。`, options: ['回会话处理'], comparisonState: 'unread',
      traceBefore: saved.traceBefore, pendingTraceKey: batchKey(saved),
    })
    createDecision(directory, { ...decision, id: saved.alertId, batchStartedAt: saved.startedAt })
  }
  return saved.alertId
}

async function versionHandoff(config, candidate, decision) {
  const { batch } = candidate
  try {
    const saved = withBatch(batch, target => {
      if (!['active', 'exiting'].includes(target.record.status)) throw new Error('托管状态已变化')
      // 版本转交会消费原告警：领取前复核状态（add-change-pause design D5）。
      verifyChangeState(target, candidate.state)
      const source = readDecision(target.directory, decision.id).value
      if (source?.status !== 'answered' || source.kind !== 'alert' || source.answer?.choice !== '补充说明后继续'
        || source.answer.operatorId !== config.ownerOpenId || !source.request?.traceBefore
        || (source.batchStartedAt && source.batchStartedAt !== batch.startedAt)) throw new Error('原告警无法核验')
      const entry = { ...batch, mode: 'version-handoff', sourceDecisionId: source.id,
        alertId: allocate(target.directory, source.id), traceBefore: source.request.traceBefore }
      if (pendingForName(pendingStore, batch.root, batch.name)) throw new Error('核对起点尚未交接')
      storeEntry(entry)
      return entry
    })
    await recoverOne(config, saved)
  } catch (error) {
    if (error instanceof StateError) throw error
    diagnostic(config, batch, error.code || error.message)
  }
  return 'done'
}

/** 跨轮重发普通提问时没有上轮快照；只在原批次仍待领取时、保护外读取本轮事实。 */
function pendingQuestionState(config, saved, target) {
  const project = config.projects.find(item => item.root === saved.root)
  if (!project) throw new StateError('原批次项目无法核验')
  if (target.location === 'archived') return archivedState(config, { project, changeDir: target.directory, entry: { change: saved.name } })
  const { view } = readProgressView(config, project.root, checkRecoveryTime())
  const matches = view?.active.filter(item => item?.change === saved.name)
  if (matches?.length !== 1 || matches[0].error) throw new StateError('原批次进度条目无法核验')
  return activeState({ view, entry: matches[0], changeDir: target.directory })
}

async function finishTransfer(config, saved, id, state = null) {
  const delivery = withBatch(saved, target => {
    const current = readDecision(target.directory, id)
    if (!current.value || current.error) throw new Error(`${id} 的转交决策无法读回`)
    verifyTransfer(saved, current.value, id)
    if (target.record.status === 'void') {
      if (OPEN_STATUSES.includes(current.value.status)
        && !transition(decisionFile(target.directory, id), OPEN_STATUSES, { status: 'void', voidReason: '托管已撤回' }).ok) {
        throw new Error(`${id} 的撤回写入失败`)
      }
      return null
    }
    if (!OPEN_STATUSES.includes(current.value.status)) throw new Error(`${id} 的转交状态无效`)
    if (target.record.exitBlock && JSON.stringify(current.value.request?.options) !== '["回会话处理"]') {
      throw new Error(`${id} 的告警违反提前归档限制`)
    }
    return { decision: current.value, directory: target.directory, location: target.location }
  })
  // 只发送尚未领取或已确认未发出的卡片；结果未知的不重发（add-change-pause design D5）。
  if (delivery && delivery.decision.status === 'pending') {
    const { decision } = delivery
    let sendState = deliveryOf(decision.card)
    if (['unclaimed', 'not-sent'].includes(sendState)) {
      // 普通提问是新动作；回会话告警则是已开始的核对责任，不能因暂缓而中断。
      const question = decision.kind === 'question'
      if (question && !state) {
        const current = pendingQuestionState(config, saved, delivery)
        if (!current) return // 本轮归档读取时间用尽，保留原决策与核对起点。
        if (current.kind) {
          await stateNotice(config, saved, current.kind, current.digest)
          return
        }
        state = current.snapshot
      }
      const { preflightPassed, recorded, delivery: outcome } = await sendDecisionCard(config, { change: saved.name }, decision, saved, question ? state : null)
      // DB-13：原告警已结束。替代告警未通过末次复核时，预留仍是同批次的阻断依据。
      if (saved.mode === 'version-handoff' && !preflightPassed) throw new Error(`${id} 的替代告警发卡前复核失败`)
      if (outcome === 'not-sent' && decision.request.cardSummary) {
        await diagnostic(config, saved, `${id} 的核对摘要暂未送达，本地完整证据已保留`)
        return
      }
      sendState = recorded ? 'sent' : outcome ?? 'not-sent'
    }
    // 原卡片可能已发出：保留原决策、预留与核对起点，不重发，只发不带决策编号的通知（任务 3.3）。
    if (sendState === 'unknown') {
      log('card-delivery-unknown', { change: saved.name, startedAt: saved.startedAt, decision: id })
      await stateNotice(config, saved, 'delivery', null, id)
      return
    }
    // 领取未保存或确认未发出：核对起点仍是本批次的阻断依据，下一轮按原发送记录重试。
    if (sendState !== 'sent') return
  }
  checkRecoveryTime()
  removeEntry(saved)
}

/** 转交采用已保存的编号，只在确认缺失或同次重核作废后替换预留。 */
async function recoverOne(config, stored) {
  if (stored.mode === 'stage' && writerStatus(stored.writer) !== 'no') throw new Error('旧阶段尚未证实停止')
  checkRecoveryTime()
  const target = locateBatch(stored, checkRecoveryTime)
  if (target.superseded || target.record.status === 'void') {
    log('pending-trace-released', { change: stored.name, startedAt: stored.startedAt, reason: target.superseded ? '重新托管' : '撤回' })
    removeEntry(stored)
    return
  }
  if (target.record.status === 'closed') throw new Error('原批次已结束，仍有未交接核对')
  const block = earlyArchive(stored, target)
  if (block) withBatch(stored, latest => guardEarlyArchive(stored, latest, block))
  if (stored.mode === 'version-handoff') {
    const id = withBatch(stored, latest => recoverVersionHandoff(config, stored, latest))
    await finishTransfer(config, stored, id)
    return
  }
  let saved = stored
  let after = null
  let replacedId = null
  if (saved.resultDecisionId || saved.alertId) {
    const id = saved.resultDecisionId || saved.alertId
    const prior = readDecision(target.directory, id)
    if (prior.error) throw new Error(`${id} 的已预留决策无法读取`)
    if (prior.value) {
      verifyTransfer(saved, prior.value, id)
      // 原决策的卡片可能已发出（领取后未回写、旧记录缺发送状态或编号不合法）：不读比较结果，
      // 不作废或替换原决策，保留预留与核对起点，只发不带决策编号的通知（任务 3.3，评审 SEC-15）。
      // 提前归档的出口阻断已在上面保存。
      if (prior.value.status === 'pending' && deliveryOf(prior.value.card) === 'unknown') {
        log('card-delivery-unknown', { change: saved.name, startedAt: saved.startedAt, decision: id })
        await stateNotice(config, saved, 'delivery', null, id)
        return
      }
      const rechecked = prior.value.status === 'void' && prior.value.voidReason === RECHECK_VOID
        && prior.value.result?.pendingTraceKey === batchKey(saved) && saved.resultKind === 'question'
      const restricted = block && prior.value.kind === 'alert'
        && JSON.stringify(prior.value.request.options) !== '["回会话处理"]'
      const blockedByArchive = restricted && prior.value.status === 'void' && prior.value.voidReason === EARLY_ARCHIVE_VOID
        && prior.value.result?.pendingTraceKey === batchKey(saved)
      if (prior.value.status === 'void' && !rechecked && !blockedByArchive) throw new Error(`${id} 的作废原因与本次核对无关`)
      if (restricted && !blockedByArchive) {
        if (prior.value.status === 'answered' && prior.value.answer?.choice === '回会话处理') {
          await finishReturnHandoff(config, stored, id)
          removeEntry(stored)
          return
        }
        // D5 的持久阻断优先。原告警内容可能已发送，替代项必须使用不同的编号。
        withBatch(saved, latest => {
          const reread = readDecision(latest.directory, id).value
          if (!latest.record.exitBlock || !reread || canonicalJson(reread) !== canonicalJson(prior.value)) {
            throw new Error(`${id} 的原告警或提前归档标记已变化`)
          }
          if (!transition(decisionFile(latest.directory, id), OPEN_STATUSES, {
            status: 'void', voidReason: EARLY_ARCHIVE_VOID, result: { pendingTraceKey: batchKey(saved) },
          }).ok) throw new Error(`${id} 的原告警不能作废`)
        })
      }
      if (restricted) replacedId = id
      if (!rechecked && !restricted) {
        if (saved.resultKind === 'question') {
          const read = await recoveryTraceSnapshot(config.gateBin, target.directory, checkRecoveryTime())
          checkRecoveryTime()
          if (read.error) throw new Error(read.error)
          after = read.value
          if (canonicalJson(after) === canonicalJson(saved.traceAfter) && !block) {
            await finishTransfer(config, saved, id)
            return
          }
          withBatch(saved, latest => {
            const reread = readDecision(latest.directory, id).value
            if (!reread || canonicalJson(reread) !== canonicalJson(prior.value)) throw new Error(`${id} 的原提问已改变`)
            const written = transition(decisionFile(latest.directory, id), OPEN_STATUSES, {
              status: 'void', voidReason: RECHECK_VOID, result: { pendingTraceKey: batchKey(saved) },
            })
            if (!written.ok) throw new Error(`${id} 的原提问不能作废`)
          })
        } else {
          await finishTransfer(config, saved, id)
          return
        }
      }
    }
  }
  const error = !validTrace(saved.traceBefore) ? VERSION_REASON : null
  if (!error && !after) {
    const read = await recoveryTraceSnapshot(config.gateBin, target.directory, checkRecoveryTime())
    checkRecoveryTime()
    if (read.error && !block) throw new Error(read.error)
    after = read.value
  }
  const failures = after ? comparison(config, after, saved, target) : []
  const id = withBatch(saved, latest => {
    if (!sameObject(latest.identity, target.identity) || latest.record.status !== target.record.status) {
      throw new Error('恢复核对期间批次已变化')
    }
    if (saved.consumedDecisionId) {
      const consumed = readDecision(latest.directory, saved.consumedDecisionId)
      if (consumed.error || !consumed.value || (consumed.value.batchStartedAt && consumed.value.batchStartedAt !== saved.startedAt)) {
        throw new Error(`${saved.consumedDecisionId} 的原决策无法核验`)
      }
      if (consumed.value.status === 'answered'
        && !transition(decisionFile(latest.directory, consumed.value.id), ['answered'], { status: 'used' }).ok) {
        throw new Error(`${consumed.value.id} 的原决策更新失败`)
      }
      if (!['answered', 'used', 'void'].includes(consumed.value.status)) throw new Error('原决策未结束')
    }
    if (openDecisions(latest.directory).length) throw new Error('同批次还有其他未完成决策')
    if (!saved.alertId || replacedId) {
      const { resultDecisionId, resultKind, traceAfter, boundaryDigest, ...rest } = saved
      saved = { ...rest, alertId: allocate(latest.directory, replacedId || resultDecisionId) }
      storeEntry(saved)
    }
    const request = alertRequest({ saved: error ? { ...saved, unavailable: true } : saved,
      snapshot: after, failures, error: !after, block, recovery: true })
    if (error) request.text = `${error}。请回会话处理。`
    const decision = pendingDecision('alert', saved.stage, { ...request, pendingTraceKey: batchKey(saved) })
    limitAlert(saved, decision, saved.alertId)
    if (request.comparisonBoundary) {
      saved = { ...saved, boundaryDigest: traceDigest(request.comparisonBoundary) }
      storeEntry(saved)
    }
    createDecision(latest.directory, { ...decision, id: saved.alertId, batchStartedAt: saved.startedAt })
    return saved.alertId
  })
  await finishTransfer(config, saved, id)
}

/** 终态交接有独立短预算，跨轮从上次尝试的严格后继继续。 */
async function recoverTerminalHandoffs(config, handoffs) {
  if (!handoffs.length) return
  const state = readCheckState()
  const sorted = handoffs.sort((left, right) => (batchKey(left.batch) > batchKey(right.batch) ? 1 : -1))
  const split = sorted.findIndex(item => batchKey(item.batch) > (state.handoffCursor || ''))
  const next = split < 0 ? sorted : [...sorted.slice(split), ...sorted.slice(0, split)]
  recoveryDeadline = performance.now() + HANDOFF_SCAN_MS
  let attempted = null
  try {
    for (const handoff of next) {
      if (performance.now() >= recoveryDeadline) break
      attempted = batchKey(handoff.batch)
      try {
        await finishReturnHandoff(config, handoff.batch, handoff.id)
      } catch (error) {
        log('return-handoff-blocked', { change: handoff.batch.name, startedAt: handoff.batch.startedAt,
          directory: handoff.batch.directory, decision: handoff.id, reason: error.code || error.message })
      }
    }
  } finally {
    recoveryDeadline = Infinity
  }
  if (attempted) {
    try { writeHomeJson(CHECK_FILE, { ...readCheckState(), handoffCursor: attempted }) } catch (error) {
      log('return-handoff-cursor-failed', { reason: error.code || error.message })
    }
  }
}

async function recoverPending(config) {
  const deadline = performance.now() + RECOVERY_MS
  recoveryDeadline = deadline - CURSOR_RESERVE_MS
  try {
    pendingStore = readPendingTrace()
    const keys = Object.keys(pendingStore.entries).sort()
    const split = keys.findIndex(key => key > (pendingStore.cursor || ''))
    const ordered = split < 0 ? keys : [...keys.slice(split), ...keys.slice(0, split)]
    let attempted = null
    for (const key of ordered) {
      if (performance.now() >= recoveryDeadline) break
      const saved = pendingStore.entries[key]
      attempted = key
      recoveredThisRound.add(key)
      try {
        await recoverOne(config, saved)
      } catch (error) {
        if (performance.now() < recoveryDeadline) {
          try { await reportFailure(config, saved, error) } catch { /* 起点仍在，后续轮次重试。 */ }
        }
      }
    }
    if (attempted && performance.now() < deadline) {
      try { writeRecoveryCursor(pendingStore, attempted) } catch (error) {
        log('recovery-cursor-failed', { reason: error.code || error.message })
      }
    }
  } finally {
    recoveryDeadline = Infinity
  }
}

/** 读启动前快照。只有同一批次和原因都未变化时才抑制通知；发送成功后才记录（评审 SEC-16）。 */
function readBeforeTrace(config, { entry, changeDir, record, batch }) {
  const { value, error } = traceSnapshot(config.gateBin, changeDir)
  const state = readCheckState()
  const previous = state.traceErrors[changeDir]
  if (error) {
    log('trace-error-before-run', { change: entry.change, reason: error })
    if (previous?.startedAt !== record.startedAt || previous?.reason !== error) {
      afterSent(sendNotice(config, entry.change, '托管无法读取运行前的处理记录', [
        error,
        '修复读取原因后等待下一轮。',
        `也可运行 autopilot.mjs cancel ${entry.change} 后回会话处理。撤回后托管不再比较告警中保存的起点，请在会话中查看 agent 对 review/、evidence/、tasks.md 的修改。`,
      ], stableCardKey(batch, JSON.stringify(['trace-before', error]))), () => {
        const latest = readCheckState()
        latest.traceErrors[changeDir] = { startedAt: record.startedAt, reason: error }
        writeHomeJson(CHECK_FILE, latest)
      })
    }
  } else if (previous) {
    delete state.traceErrors[changeDir]
    writeHomeJson(CHECK_FILE, state)
  }
  return value
}

/**
 * 生成出口动作的起草提示词（design D11「起草」）。
 * @param {object} options root 项目根；changeDir 变更目录；action 动作名；project 项目配置；
 *   previousBranch 上一次的分支名（重试时带上）。
 * @returns {string} 提示词。
 */
function exitDraftPrompt({ root, changeDir, action, project, previousBranch }) {
  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all'])
  const mainSpecs = mainSpecList(root, changeDir)
  const lines = [
    `起草 OpenSpec 变更的出口动作 ${action}。只读操作，不写任何文件。`,
    '当前 git status 的输出：',
    '```',
    status.out.trim(),
    '```',
    '本变更的主规格清单（每个都要列入提交文件）：',
    ...(mainSpecs.length ? mainSpecs.map(item => `- ${item}`) : ['（无）']),
    '不要列入 openspec/specs/ 下清单以外的文件，也不要列入本变更 decisions/ 下的文件。',
    `分支名以 ${project.branchPrefix} 开头，按项目的提交规则写提交说明。`,
  ]
  if (previousBranch) lines.push(`上一次的分支名是 ${previousBranch}，可以复用。`)
  lines.push('返回 JSON：{"branch": "...", "files": ["..."], "message": "..."}。')
  return lines.join('\n')
}

/**
 * 起草出口动作（design D11「起草」）：只读运行，读回计划。
 * @param {object} options config、project、changeDir、action、readRules、previousBranch。
 * @returns {{ ok: boolean, plan: object|null, error: string|null }} 起草结果。
 */
async function draftExitAction({ config, project, changeDir, action, readRules, previousBranch }) {
  const before = progressDigest(project, { stage: action, rule: action, tasks: {}, blockers: [], warnings: [] }, changeDir)
  const prompt = exitDraftPrompt({
    root: project.root, changeDir, action, project, previousBranch,
  })
  const run = await runClaude({
    config,
    project,
    changeRoot: changeDir,
    prompt,
    resume: null,
    readRules,
    draft: true,
  })
  const after = progressDigest(project, { stage: action, rule: action, tasks: {}, blockers: [], warnings: [] }, changeDir)
  if (before !== after) return { ok: false, plan: null, error: '起草修改了文件，不创建出口决策' }
  const result = run.result
  const plan = result ? planOf(result.result) : null
  if (!plan) {
    return { ok: false, plan: null, error: `起草结果不是期望的 JSON：${String(result && result.result).slice(0, 200)}` }
  }
  return { ok: true, plan, error: null }
}

/**
 * 从起草结果的 result 中读出提交计划（spec autopilot-exit-actions 第 2 条）。
 * claude -p --output-format json 的 result 是最终回复的文本：取其中第一个代码块的内容，没有代码块时取整段文本，
 * 再按 JSON 解析（quality R1 SPEC-07）。result 已是对象时照常使用。真实输出形状在上线后验收时确认。
 * @param {unknown} value result 字段。
 * @returns {object|null} 含 branch、files、message 的计划；读不出时为 null。
 */
function planOf(value) {
  let plan = value
  if (typeof value === 'string') {
    const fenced = /```(?:json)?\s*\n([\s\S]*?)\n?```/.exec(value)
    try {
      plan = JSON.parse((fenced ? fenced[1] : value).trim())
    } catch {
      return null
    }
  }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return null
  if (typeof plan.branch !== 'string' || !Array.isArray(plan.files) || typeof plan.message !== 'string') return null
  return plan
}

/**
 * 处理出口动作（design D11 的顺序与检查顺序第 4、5 步）。
 * @param {object} config 托管配置。
 * @param {object} candidate 候选变更。
 * @param {string[]} readRules 读取规则。
 * @returns {string} ran 表示本轮做了动作。
 */
async function handleExitActions(config, candidate, readRules) {
  const { project, entry, changeDir } = candidate
  candidate.updateExit = work => withBatch(candidate.batch, target => {
    if (target.directory !== changeDir || target.record.status !== 'exiting' || target.record.exitBlock
      || pendingForName(pendingStore, candidate.batch.root, candidate.batch.name)) return false
    return work(target.record)
  })
  // 起草与执行出口步骤之前认领：推送期间撤回要等本轮结束（spec autopilot-exit-actions「Cancel during the push」）。
  const record = claimChange(candidate)
  if (!record) return 'done'
  // 发现候选后，前一个批次的处理可能已结束。出口检查使用认领时复核的记录。
  candidate.record = record
  // 检查顺序第 1–4 步：等待回复的决策与归档阶段留下的已回复告警先处理（quality R1 SPEC-05）。
  const handled = await handleOpenDecisions(config, candidate, readRules, { skipKinds: ['exit', 'exit-alert'] })
  if (handled || record.exitBlock) return handled || 'done'
  // 出口阶段的变更已在归档目录中；托管记录改为 exiting（design D11）。
  if (record.status === 'active') {
    const written = withBatch(candidate.batch, target => transition(recordFile(target.directory), ['active'],
      { status: 'exiting' }, { startedAt: record.startedAt }))
    if (!written.ok) return 'done'
    record.status = 'exiting'
  }
  const decisions = listDecisions(changeDir).decisions
  // 检查顺序第 4 步：有已回复的出口告警时按选择处理。消费回复前在保护内复核状态（add-change-pause design D5）。
  const alert = decisions.find(item => item.status === 'answered' && item.kind === 'exit-alert')
  if (alert) {
    const choice = (alert.answer && alert.answer.choice) || ''
    if (choice === '重试本项') allocate(changeDir)
    if (!changeDecision(candidate, alert, { status: 'used' }, candidate.state)) return 'done'
    if (choice === '暂不处理') {
      closeExit(config, candidate, '全部出口动作已跳过')
      return 'done'
    }
    if (choice === '回会话处理') {
      transition(recordFile(changeDir), ['exiting'], { status: 'void', voidReason: '用户选择回会话处理' },
        { startedAt: record.startedAt })
      sendNotice(config, entry.change, '托管已作废', ['用户在卡片上选择回会话处理，请在会话中继续处理。'])
      return 'done'
    }
    // 重试本项：下一轮按托管记录的 exit.commit-merge.commit 决定重新起草还是只合并（design D11「执行失败」）。
    return 'done'
  }
  // 检查顺序第 5 步：有已回复的出口决策时执行动作。开始前复核状态与原回复；
  // 已开始的提交与合并、推送内部不复核状态，之后的变化从下一次领取生效（add-change-pause design D5，评审 ARCH-16）。
  const exit = decisions.find(item => item.status === 'answered' && item.kind === 'exit')
  if (exit) {
    if (!exitClaimed(candidate, exit)) return 'done'
    await runExitAction(config, candidate, exit)
    return 'ran'
  }
  // 没有未完成的出口决策：起草下一项动作。
  const exitNow = currentExit(candidate)
  const done = EXIT_ACTIONS.filter(item => (exitNow[item] || {}).ok)
  const next = EXIT_ACTIONS.find(item => !done.includes(item))
  if (!next) {
    closeExit(config, candidate, '全部出口动作已完成')
    return 'done'
  }
  allocate(changeDir)
  if (exitNow[next]?.noAlert) return 'done'
  if (next === 'commit-merge') {
    const previous = decisions.filter(item => item.kind === 'exit' && item.request && item.request.action === next).pop()
    const previousBranch = (exitNow[next] || {}).branch || (previous && previous.request ? previous.request.branch : null)
    // 重试时提交已在分支上：不起草、不按 git status 核对计划，沿用上一个出口决策的计划与内容摘要，
    // 执行从回读开始，只合并（design D11「执行失败」重试本项，评审 CONC-04）。
    if ((exitNow[next] || {}).commit && previous) {
      await issueDecision(config, candidate, pendingDecision('exit', 'exit', {
        ...previous.request, commitOnBranch: (exitNow[next] || {}).commit, options: COMMIT_OPTIONS,
      }), 'exit-decision', { fields: { action: next, retry: 'merge-only' } })
      return 'ran'
    }
    // 起草也会启动 claude：先做启动前核对（spec autopilot-scheduler 第 3 条，quality R1 SPEC-08）。
    // 状态复核通过才起草（add-change-pause design D5）。
    if (!projectCheckPassed(config, entry, project) || !exitClaimed(candidate)) return 'done'
    const drafted = await draftExitAction({
      config, project, changeDir, action: next, readRules, previousBranch,
    })
    if (!drafted.ok) {
      await failExitAction(config, candidate, next, null, drafted.error)
      return 'ran'
    }
    const checked = checkPlan({
      root: project.root,
      changeDir,
      plan: drafted.plan,
      baseBranch: project.baseBranch,
      branchPrefix: project.branchPrefix,
      snapshot: record.implSnapshot,
      previousBranch: (exitNow[next] || {}).branch || null,
    })
    if (!checked.ok) {
      await failExitAction(config, candidate, next, null, checked.error)
      return 'ran'
    }
    await issueDecision(config, candidate, pendingDecision('exit', 'exit', {
      action: next,
      branch: drafted.plan.branch,
      files: checked.files,
      message: drafted.plan.message,
      mainSpecs: checked.mainSpecs,
      ignored: checked.ignored,
      deleted: checked.deleted,
      removed: checked.removed,
      otherMainSpecs: otherMainSpecs(project.root, checked.mainSpecs),
      contentDigest: Object.fromEntries(checked.files.map(file => [file, contentHash(project.root, file)])),
      options: COMMIT_OPTIONS,
    }), 'exit-decision', { fields: { action: next } })
    return 'ran'
  }
  // 推送：先算出将推送的提交，再创建出口决策（design D11「推送」，评审 SEC-14）。
  const commitState = exitNow['commit-merge'] || {}
  // 推送的是合并提交；选了只提交到分支时推送分支提交（design D11 表格第 2 行）。
  const commit = commitState.mergeCommit || commitState.commit || null
  if (!commit) {
    closeExit(config, candidate, '提交与合并未完成，跳过推送')
    return 'done'
  }
  // 状态复核通过才生成推送清单；清单在项目写保护外生成（add-change-pause design D5）。
  if (!exitClaimed(candidate)) return 'done'
  const list = pushList(project.root, { baseBranch: project.baseBranch, commit })
  if (!list.ok) {
    await failExitAction(config, candidate, next, null, list.error)
    return 'ran'
  }
  await issueDecision(config, candidate, pendingDecision('exit', 'exit', {
    action: next,
    branch: commitState.branch || null,
    commits: list.commits,
    options: PUSH_OPTIONS,
  }), 'exit-decision', { fields: { action: next } })
  return 'ran'
}

/**
 * 在保护内复核出口批次与原回复后改写出口决策。
 * @param {object|null} [state] 消费回复时传本轮状态快照，在保护内复核；动作开始后的结果回写不传（评审 ARCH-16）。
 */
function changeDecision(candidate, decision, patch, state = null) {
  return withBatch(candidate.batch, target => {
    if (target.record.status !== 'exiting' || target.record.exitBlock) return false
    verifyChangeState(target, state)
    const current = readDecision(target.directory, decision.id).value
    if (!current || canonicalJson(current) !== canonicalJson(decision)) return false
    return transition(decisionFile(target.directory, decision.id), ['answered'], patch).ok
  })
}

/**
 * 出口动作的领取点（add-change-pause design D5）：起草出口、生成推送清单和执行已回复的出口决策之前，
 * 在项目保护内复核批次、出口阻断、未完成核对与本轮状态快照；传入决策时还复核原回复未变。
 * @param {object} candidate 归档候选。
 * @param {object|null} [decision] 将要执行的已回复出口决策。
 * @returns {boolean} 可以开始动作时为 true。
 * @throws {StateError} 状态快照无法复核时抛出，由候选处理按固定类别通知。
 */
function exitClaimed(candidate, decision = null) {
  return withBatch(candidate.batch, target => {
    if (target.directory !== candidate.changeDir || target.record.status !== 'exiting' || target.record.exitBlock
      || pendingForName(pendingStore, candidate.batch.root, candidate.batch.name)) return false
    verifyChangeState(target, candidate.state)
    if (!decision) return true
    const current = readDecision(target.directory, decision.id).value
    return !!current && canonicalJson(current) === canonicalJson(decision)
  })
}

/**
 * 执行一个已回复的出口决策（design D11「执行与回读」）。
 * @param {object} config 托管配置。
 * @param {object} candidate 候选变更。
 * @param {object} decision 出口决策。
 */
async function runExitAction(config, candidate, decision) {
  const request = decision.request || {}
  const choice = (decision.answer && decision.answer.choice) || ''
  if (choice === '暂不处理') {
    if (!changeDecision(candidate, decision, { status: 'used', result: { ok: true, steps: ['skipped'] } }, candidate.state)) return
    closeExit(config, candidate, '出口动作已跳过')
    return
  }
  if (request.action === 'commit-merge') {
    const result = executeCommitMerge(candidate, decision, { draftsDir: path.join(homeDir(), 'drafts'), log })
    if (!result.ok) {
      await failExitAction(config, candidate, request.action, decision, result.error, result.steps)
      return
    }
    changeDecision(candidate, decision, { status: 'used', result: { ok: true, steps: result.steps } })
    return
  }
  if (request.action === 'push') {
    const result = executePush(candidate, decision, { log })
    if (!result.ok) {
      await failExitAction(config, candidate, request.action, decision, result.error, result.steps)
      return
    }
    changeDecision(candidate, decision, { status: 'used', result: { ok: true, steps: result.steps } })
    return
  }
  await failExitAction(config, candidate, request.action, decision, `未知出口动作：${request.action}`)
}

/**
 * 出口动作失败时的处理（design D11「执行失败」，评审 CONC-04）。
 * @param {object} config 托管配置。
 * @param {object} candidate 候选变更。
 * @param {string} action 动作名。
 * @param {object} decision 出口决策（可为 null）。
 * @param {string} error 失败原因。
 * @param {string[]} steps 已完成的步骤。
 */
async function failExitAction(config, candidate, action, decision, error, steps = []) {
  const { project, entry, changeDir } = candidate
  // 失败前没有提交且当前在计划分支上时，先切回主分支（design D11「执行失败」，评审 CONC-11）。
  const exitState = currentExit(candidate)['commit-merge'] || {}
  if (!exitState.commit && exitState.branch) {
    const current = gitLine(project.root, ['symbolic-ref', '--short', 'HEAD'])
    if (current === exitState.branch
      && gitLine(project.root, ['rev-parse', exitState.branch]) === gitLine(project.root, ['rev-parse', project.baseBranch])) {
      git(project.root, ['switch', project.baseBranch])
    }
  }
  if (decision) {
    if (!changeDecision(candidate, decision, { status: 'used', result: { ok: false, error, steps } })) return
  }
  // 托管记录已撤回时不再创建出口告警（评审 CONC-06）。
  const noAlert = !nextDecisionId(changeDir)
  if (!writeExitState(candidate, action, { ok: false, failed: true, steps, ...(noAlert ? { noAlert: true } : {}) }, log)) return
  if (noAlert) {
    diagnostic(config, candidate.batch, '四位决策编号已用尽，已保存出口失败与完成步骤')
    return
  }
  await issueDecision(config, candidate, pendingDecision('exit-alert', 'exit', {
    exitAction: action, text: error, options: ['重试本项', '暂不处理', '回会话处理'],
  }), 'exit-alert', { fields: { action, error } })
}

/**
 * 结束托管并发结束通知卡片（design D11「出口动作」）。
 * @param {object} config 托管配置。
 * @param {object} candidate 候选变更。
 * @param {string} note 说明。
 */
function closeExit(config, candidate, note) {
  const { entry, changeDir, record } = candidate
  const exit = currentExit(candidate)
  for (const action of EXIT_ACTIONS) {
    if (!exit[action]) exit[action] = { ok: false, skipped: true }
  }
  const closed = candidate.updateExit(() => transition(recordFile(changeDir), ['exiting'], { status: 'closed', exit }, { startedAt: record.startedAt }).ok)
  if (!closed) return
  const done = EXIT_ACTIONS.filter(item => exit[item] && exit[item].ok)
  const skipped = EXIT_ACTIONS.filter(item => !done.includes(item))
  const lines = [note,
    ...done.map(item => `已完成：${item}`),
    ...skipped.map(item => `已跳过：${item}`)]
  const commit = exit['commit-merge']
  if (commit?.mode === 'branch-only') lines.push(`当前分支为 ${commit.branch}。再次托管前请切回 ${candidate.project.baseBranch}。`)
  // 本变更 decisions/ 下的文件没有提交，其中有 operator_id（design D11「执行与回读」）。
  lines.push('本变更 decisions/ 下的文件没有提交，其中含有 operator_id，由你在会话中决定是否提交。')
  // 云舟任务：变更关联云舟任务时写出任务号（design D11「云舟任务」）。
  const proposalFile = path.join(changeDir, 'proposal.md')
  const proposal = existsSync(proposalFile) ? readFileSync(proposalFile, 'utf8') : ''
  const taskMatch = /^云舟任务：\s*(\S+)/m.exec(proposal)
  const taskId = taskMatch ? taskMatch[1] : (entry.change.startsWith('yunzhou-') ? entry.change.slice('yunzhou-'.length) : null)
  if (taskId) lines.push(`云舟任务 ${taskId}：请在会话中完成任务。`)
  sendNotice(config, entry.change, '托管已结束', lines)
}

/**
 * 一轮调度：取锁、检查环境、按规则选动作、运行一个阶段。
 * @param {object} config 托管配置。
 * @returns {number} 退出码。
 */
async function runOnce(config) {
  const lockFile = path.join(homeDir(), 'run.lock')
  runToken = randomUUID()
  roundBudget = { notices: 0, noticeMs: 0, archiveStateMs: 0 }
  const lock = acquireLock(lockFile, { pid: process.pid, bootTime: currentBootTime(), change: null, claudePid: null, token: runToken })
  if (!lock.ok) {
    log('lock-busy', { reason: lock.reason })
    return EXIT.OK
  }
  // 调度进程被停止或出现未捕获异常时，先停 claude 的进程组再释放锁（design D12，quality R1 SPEC-01）。
  const onTerm = () => {
    terminateClaude()
    releaseLock(lockFile, runToken)
    log('scheduler-terminated')
    process.exit(EXIT.TERMINATED)
  }
  const onCrash = error => {
    terminateClaude()
    releaseLock(lockFile, runToken)
    log('scheduler-crashed', { error: String(error && error.message || error).slice(0, 200) })
    process.exit(EXIT.ERROR)
  }
  process.on('SIGTERM', onTerm)
  process.on('uncaughtException', onCrash)
  process.on('unhandledRejection', onCrash)
  try {
    const { problems, scriptSource } = checkEnvironment(config)
    if (problems.length) {
      log('environment-error', { problems })
      for (const problem of problems) log('environment-problem', { problem })
      // 来源无法核验的一轮不运行脚本或通知命令：只在本机报告待核对记录，原记录保持不变。
      if (scriptSource) reportLocalPending()
      else notifyEnvironment(config, problems)
      return EXIT.ERROR
    }
    config.projects = config.projects.map(project => ({ ...project, root: realPath(project.root) }))
    const home = process.env.HOME || ''
    const { rules: readRules } = skillReadRules(home)

    try {
      await recoverPending(config)
      clearEnvironmentState()
    } catch (error) {
      notifyEnvironment(config, [`未完成核对文件无法读取：${error.code || error.message}`])
      return EXIT.ERROR
    }
    const candidates = []
    const handoffs = []
    for (const project of config.projects) {
      const { view, error } = readProgressView(config, project.root)
      if (error) {
        log('progress-error', { project: project.root, error })
        continue
      }
      const entries = new Map((view.active || []).map(entry => [entry.change, entry]))
      const archives = new Map((view.archived || []).map(entry => [entry.name, entry]))
      for (const name of new Set([...entries.keys(), ...archives.keys()])) {
        try {
          const { root, candidates: batches } = enumerateBatches(project.root, name)
          if (pendingForName(pendingStore, root, name)) continue
          for (const { directory, location, record } of batches) {
            if (!record) continue
            const entry = location === 'active' ? entries.get(name) : { ...archives.get(name), change: name }
            const batch = batchOf(project, { change: name }, directory, record, location)
            if (recoveredThisRound.has(batchKey(batch))) continue
            if (record.status === 'void' && record.returnHandoff && !record.returnHandoffCompleted) {
              handoffs.push({ batch, id: record.returnHandoff })
            }
            if (!entry || (location === 'archived' && !archives.has(name)) || !['active', 'exiting'].includes(record.status)) continue
            const matching = batches.filter(item => item.record?.startedAt === record.startedAt)
            if (matching.length !== 1) throw new Error(`托管批次不唯一：${matching.map(item => item.directory).join('、')}`)
            candidates.push({ project, view, entry, changeDir: directory, record, batch })
          }
        } catch (error) {
          log('candidate-invalid', { project: project.root, change: name, reason: error.code || error.message })
        }
      }
    }
    await recoverTerminalHandoffs(config, handoffs)
    candidates.sort((a, b) => a.record.startedAt.localeCompare(b.record.startedAt))
    for (const candidate of candidates) {
      try {
        const handled = candidate.batch.location === 'archived'
          ? await handleArchivedCandidate(config, candidate, readRules) : await handleCandidate(config, candidate, readRules)
        if (handled === 'ran') return EXIT.OK
      } catch (error) {
        await reportFailure(config, candidate.batch, error)
      }
    }
    return EXIT.OK
  } finally {
    process.off('SIGTERM', onTerm)
    process.off('uncaughtException', onCrash)
    process.off('unhandledRejection', onCrash)
    releaseLock(lockFile, runToken)
  }
}

/**
 * 检查顺序第 1–4 步：处理未完成的决策（design D3）。未归档与已归档的变更都先走这一步：
 * 已归档变更跳过时，出口决策等待回复期间每轮重新起草，归档阶段留下的会话告警也不被处理（quality R1 SPEC-05）。
 * @param {object} config 托管配置。
 * @param {object} candidate 候选变更。
 * @param {string[]} readRules skill 目录的读取规则。
 * @param {object} [options] skipKinds 为第 3、4 步不处理的决策类型：出口决策与出口告警由 handleExitActions 处理。
 * @returns {Promise<string|null>} 本轮已处理时为 ran 或 done；没有要处理的决策时为 null。
 */
async function handleOpenDecisions(config, candidate, readRules, { skipKinds = [] } = {}) {
  const { project, entry, changeDir, record } = candidate
  const open = openDecisions(changeDir)

  // 第 1、2 步：有等待回复的决策时，本轮不运行阶段，也不起草出口动作。
  const pending = open.find(item => item.status === 'pending')
  if (record.exitBlock && pending && (pending.kind !== 'alert' || JSON.stringify(pending.request?.options) !== '["回会话处理"]')) return 'done'
  if (pending) {
    // 只缺消息编号不足以重发（add-change-pause design D5）：按发送记录决定。待回复的原决策始终阻断本批次。
    const delivery = deliveryOf(pending.card)
    const digest = candidate.state?.changeState.digest ?? null
    if (delivery === 'sent') {
      log('pending-decision', { change: entry.change, decision: pending.id })
    } else if (delivery === 'unknown') {
      // 原卡片可能已发出：不重发，不分配替代决策，只发去重的无决策编号通知。
      log('card-delivery-unknown', { change: entry.change, decision: pending.id })
      await stateNotice(config, candidate.batch, 'delivery', digest, pending.id)
    } else {
      // 重发原决策卡片：通知卡片没有表单，发了也不能回复（quality R1 SPEC-06、STD-04）。幂等键沿用同一批次与决策号。
      log('resend-card', { change: entry.change, decision: pending.id })
      const sent = await sendDecisionCard(config, entry, pending, candidate.batch, candidate.state)
      if (sent.delivery === 'unknown') await stateNotice(config, candidate.batch, 'delivery', digest, pending.id)
    }
    return 'done'
  }

  // 第 3、4 步：恢复会话或按「回会话处理」作废托管。
  const answered = open.find(item => item.status === 'answered' && !skipKinds.includes(item.kind))
  if (!answered) return null
  if (answered.batchStartedAt && answered.batchStartedAt !== candidate.batch.startedAt) {
    throw new Error(`${answered.id} 的回复不属于当前批次`)
  }
  if (record.exitBlock && (answered.kind !== 'alert' || answered.answer?.choice !== '回会话处理')) return 'done'
  if (answered.kind === 'alert' && answered.answer && answered.answer.choice === '回会话处理') {
    await finishReturnHandoff(config, candidate.batch, answered.id, candidate.state)
    return 'done'
  }
  // 恢复会话之前也做启动前核对：等待卡片期间加入的允许规则或 hook 会在恢复时生效（quality R1 SPEC-08）。
  if (!projectCheckPassed(config, entry, project)) return 'done'
  return resumeSession(config, candidate, answered, readRules)
}

/**
 * 处理一个活跃候选：先在执行边界核对推进意愿，再按检查顺序与进度规则决定动作（add-change-pause design D5）。
 * 暂缓与 active/exiting 并存、状态未知或契约缺失时不领取新动作、不消费决策，也不作废托管或修改推进意愿，
 * 只发固定类别的通知。该检查先于 reviewStale 与 R1–R5、R10 的作废规则。
 * 快照之后的变化由各领取点在保护内复核；复核失败时只写本机日志，状态文件无效时发固定类别通知。
 * @param {object} config 托管配置。
 * @param {object} candidate 候选变更。
 * @param {string[]} readRules skill 目录的读取规则。
 * @returns {string} ran 表示本轮运行了阶段，done 表示本轮结束。
 */
async function handleCandidate(config, candidate, readRules) {
  return withChangeState(config, candidate, activeState(candidate), () => advanceCandidate(config, candidate, readRules))
}

/**
 * 处理一个归档后仍在托管的批次：先读取原归档目录的状态，再按出口规则处理（add-change-pause design D5）。
 * 本轮归档读取时间用尽时不启动出口，不改任何记录，下一轮重新读取（评审 PERF-09）。
 * @param {object} config 托管配置。
 * @param {object} candidate 归档候选。
 * @param {string[]} readRules skill 目录的读取规则。
 * @returns {string} ran 表示本轮做了出口动作，done 表示本轮结束。
 */
async function handleArchivedCandidate(config, candidate, readRules) {
  const state = archivedState(config, candidate)
  if (!state) {
    log('change-state-deferred', { change: candidate.entry.change, startedAt: candidate.batch.startedAt })
    return 'done'
  }
  return withChangeState(config, candidate, state, () => handleExitActions(config, candidate, readRules))
}

/**
 * 按本轮的状态快照决定是否领取新动作（add-change-pause design D5）。
 * 状态异常时只发固定类别的通知；通过时把快照交给各领取点复核，领取点抛出的状态错误也只按固定类别处理。
 * @param {object} config 托管配置。
 * @param {object} candidate 候选变更。
 * @param {{ snapshot: object|null, kind: string|null, digest: string|null }} state 本轮快照。
 * @param {Function} work 状态通过后的处理。
 * @returns {Promise<string>} work 的结果；状态异常时为 done。
 */
async function withChangeState(config, candidate, state, work) {
  if (state.kind) {
    log('change-state-blocked', { change: candidate.entry.change, startedAt: candidate.batch.startedAt, kind: state.kind })
    await stateNotice(config, candidate.batch, state.kind, state.digest)
    return 'done'
  }
  candidate.state = state.snapshot
  try {
    return await work()
  } catch (error) {
    if (!(error instanceof StateError)) throw error
    await reportFailure(config, candidate.batch, error, state.digest)
    return 'done'
  }
}

/**
 * 按检查顺序与进度规则决定动作（design D3 的两张表）。
 * @param {object} config 托管配置。
 * @param {object} candidate 已通过状态核对的候选变更。
 * @param {string[]} readRules skill 目录的读取规则。
 * @returns {string} ran 表示本轮运行了阶段，done 表示本轮结束。
 */
async function advanceCandidate(config, candidate, readRules) {
  const { project, entry, changeDir, record } = candidate
  const handled = await handleOpenDecisions(config, candidate, readRules)
  if (handled) return handled

  // 门禁副本没有 reviewStale 时作废托管：不知道评审是否过期时不放行（design D3，评审 ARCH-18）。
  if (!('reviewStale' in entry) || entry.reviewStale === null) {
    transition(recordFile(changeDir), ['active', 'exiting'], {
      status: 'void',
      voidReason: '门禁脚本副本没有 archive.review.stale，请一起同步 openspec-change-progress 与 openspec-technical-review 两个副本',
    }, { startedAt: record.startedAt })
    sendNotice(config, entry.change, '托管已作废', ['门禁脚本副本没有 archive.review.stale，请一起同步 openspec-change-progress 与 openspec-technical-review 两个副本。'])
    return 'done'
  }

  // 规则 R1–R5 与 R10：流程停住，在会话中处理（design D3）。
  if (VOID_RULES.includes(entry.rule)) {
    const blockers = (entry.blockers || []).join('、')
    transition(recordFile(changeDir), ['active', 'exiting'], {
      status: 'void', voidReason: `${entry.rule}${blockers ? `：${blockers}` : ''}`,
    }, { startedAt: record.startedAt })
    sendNotice(config, entry.change, '托管已作废', [
      `进度规则 ${entry.rule}，请在会话中处理后重新托管。`,
      ...(entry.blockers || []).map(item => `- ${item}`),
    ])
    return 'done'
  }

  // 启动前核对：不通过时本轮不运行该项目的变更（design D4）。
  if (!projectCheckPassed(config, entry, project)) return 'done'

  // 选定变更：认领后才清除 rerunStage、写实现快照与启动阶段（spec autopilot-scheduler 第 1 条）。
  if (!claimChange(candidate)) return 'done'

  const traceBefore = readBeforeTrace(config, candidate)
  if (!traceBefore) return 'done'

  // rerunStage 为 quality 时改走 quality，且不写实现快照（design D3，评审 ARCH-19）。
  let rule = entry.rule
  const rerun = record.rerunStage === 'quality' && (rule === 'R9' || rule === 'R11')
  if (rerun) rule = 'R8'
  const skill = RULE_SKILL[rule]
  if (!skill) {
    log('no-skill-for-rule', { rule, change: entry.change })
    return 'done'
  }
  const stage = { R6: 'apply', R7: 'apply', R8: 'quality', R9: 'verify', R11: 'archive' }[rule]
  const saved = prepareStage(config, candidate, stage, { ...traceBefore, resumedDecisionIds: [] })
  if (!saved) return 'done'
  const ready = withBatch(saved, target => {
    if (target.record.status !== record.status) return false
    if (record.rerunStage && !transition(recordFile(changeDir), ['active', 'exiting'], { rerunStage: null }, { startedAt: record.startedAt }).ok) return false
    return rule !== 'R11' || writeImplSnapshot(project, changeDir, record)
  })
  if (!ready) return 'ran'

  const prompt = stagePrompt({
    skill,
    change: entry.change,
    skillDir: path.join(process.env.HOME || '', '.claude', 'skills', skill),
    userName: gitUserName(project.root),
  })
  return startStage(config, candidate, prompt, readRules, saved)
}

/**
 * 记录实现快照：archive 前的工作区就是 verify 核对过的代码（design D11「实现快照」）。
 * @param {object} project 项目配置。
 * @param {string} changeDir 变更目录。
 * @param {object} record 托管记录。
 * @returns {boolean} 写入成功时为 true；托管记录已变化时为 false。
 */
function writeImplSnapshot(project, changeDir, record) {
  const result = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.', ':(exclude)openspec'],
    { cwd: project.root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const snapshot = {}
  for (const line of (result.stdout || '').split('\0').filter(Boolean)) {
    const file = line.slice(3)
    const hash = spawnSync('git', ['hash-object', file], { cwd: project.root, encoding: 'utf8' })
    snapshot[file] = hash.status === 0 ? hash.stdout.trim() : null
  }
  return transition(recordFile(changeDir), ['active', 'exiting'], { implSnapshot: snapshot }, { startedAt: record.startedAt }).ok
}

/**
 * 读取核对结果文件。文件不存在或是旧格式（纯文本）时按没有通知过处理。
 * @returns {{ projects: object, environment: string[] }} 各项目已通知的核对条目与已通知的运行环境原因。
 */
function readCheckState() {
  try {
    const value = JSON.parse(readFileSync(path.join(homeDir(), CHECK_FILE), 'utf8'))
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return {
        projects: value.projects && typeof value.projects === 'object' ? value.projects : {},
        environment: Array.isArray(value.environment) ? value.environment : [],
        handoffCursor: typeof value.handoffCursor === 'string' ? value.handoffCursor : null,
        traceErrors: value.traceErrors && typeof value.traceErrors === 'object' && !Array.isArray(value.traceErrors)
          ? value.traceErrors : {},
        // 已成功发出的状态异常与发卡异常通知（add-change-pause design D5）：键含项目、批次、状态摘要与类别。
        stateNotices: value.stateNotices && typeof value.stateNotices === 'object' && !Array.isArray(value.stateNotices)
          ? value.stateNotices : {},
      }
    }
  } catch {
    // 文件不存在或不是 JSON：按没有通知过处理。
  }
  return { projects: {}, environment: [], traceErrors: {}, stateNotices: {} }
}

/**
 * 启动前核对（design D4）。不通过时本轮不运行该项目的变更；条目清单与上次通知的不同时才发通知卡片。
 * 通过时清除该项目的记录：之后再出现同样的条目会重新通知。
 * 启动阶段、恢复会话与出口起草之前都调用（spec autopilot-scheduler 第 3 条，quality R1 SPEC-08）。
 * @param {object} config 托管配置。
 * @param {object} entry 进度条目（取变更名）。
 * @param {object} project 项目配置。
 * @returns {boolean} 通过时为 true。
 */
function projectCheckPassed(config, entry, project) {
  const issues = checkProject(process.env.HOME || '', project.root, project.allowedCommands || [])
  const state = readCheckState()
  const previous = state.projects[project.root] || []
  if (!issues.length) {
    if (previous.length) {
      delete state.projects[project.root]
      writeHomeJson(CHECK_FILE, state)
    }
    return true
  }
  if (JSON.stringify(previous) !== JSON.stringify(issues)) {
    // 发送成功后才记录；幂等键只由项目与条目清单决定，未送达时下一轮用同一键重发（评审 SEC-16）。
    const key = createHash('sha256').update(JSON.stringify(['rule-check', project.root, issues])).digest('hex')
    afterSent(sendNotice(config, entry.change, '托管启动前核对不通过', issues, key), () => {
      const latest = readCheckState()
      latest.projects[project.root] = issues
      writeHomeJson(CHECK_FILE, latest)
    })
  }
  log('rule-check-failed', { project: project.root, issues })
  return false
}

/**
 * 运行环境检查不通过时发通知卡片（spec autopilot-scheduler 第 4 条，quality R1 SPEC-08）：
 * larkBin 能运行且有 ownerOpenId 时，每个新原因发一张；已通知的原因记在核对结果文件中，不再重发。
 * 发不了卡片或发送结果不能确认时不记录该原因，下一轮用同一幂等键再发（add-change-pause 评审 SEC-16）。
 * @param {object} config 托管配置。
 * @param {string[]} problems 不通过的原因。
 */
function notifyEnvironment(config, problems) {
  if (!config.ownerOpenId || !canRun(config.larkBin)) return
  const state = readCheckState()
  const delivered = problems.filter(problem => state.environment.includes(problem))
  problems.filter(problem => !state.environment.includes(problem)).forEach((problem, index) => {
    // 每个原因一张卡片；幂等键只由原因决定，变更名位置的序号只用于日志。
    const key = createHash('sha256').update(JSON.stringify(['environment', problem])).digest('hex')
    afterSent(sendNotice(config, `environment-${index + 1}`, '托管运行环境检查不通过', [problem], key), () => delivered.push(problem))
  })
  // 只保留本次仍存在且已送达的原因：消失的原因再出现时重新通知。
  state.environment = problems.filter(problem => delivered.includes(problem))
  writeHomeJson(CHECK_FILE, state)
}

/** 运行环境检查通过时清除已通知的原因：之后再出现同一原因会重新通知。 */
function clearEnvironmentState() {
  const state = readCheckState()
  if (!state.environment.length) return
  state.environment = []
  writeHomeJson(CHECK_FILE, state)
}

/**
 * 认领一个变更：先把变更名写进运行锁，再复核托管记录（design D3 第 6 步，spec autopilot-scheduler 第 1 条）。
 * 启动或恢复 claude、起草或执行出口步骤之前都调用：撤回读锁中的 change，锁中不是本变更时会立即返回，
 * 认领之后撤回才会等本轮结束（评审 CONC-06，quality R1 SPEC-04）。
 * @param {object} candidate 候选变更。
 * @returns {object|null} 批次身份、目录与状态仍匹配时返回最新托管记录。
 */
function claimChange(candidate) {
  const { entry, record, batch } = candidate
  const lockFile = path.join(homeDir(), 'run.lock')
  const lock = readLockFile(lockFile)
  if (lock.value?.token !== runToken || lock.value.pid !== process.pid) return null
  const runId = randomUUID()
  writeLockFile(lockFile, { ...lock.value, change: entry.change, projectRoot: batch.root, startedAt: batch.startedAt, runId })
  const current = locateBatch(batch)
  if (current.superseded || current.record.status !== record.status || current.directory !== candidate.changeDir) {
    log('record-changed-before-start', { change: entry.change })
    return null
  }
  candidate.runId = runId
  return current.record
}

/**
 * 启动一个阶段并处理结果。
 * @param {object} config 托管配置。
 * @param {object} candidate 候选变更。
 * @param {string} prompt 提示词。
 * @param {string[]} readRules 读取规则。
 * @param {object} saved 持久化的核对条目。
 * @param {object|null} resumed 要恢复的已答决策。
 * @returns {string} ran 表示本轮占用阶段运行名额。
 */
async function startStage(config, candidate, prompt, readRules, saved, resumed = null) {
  const { project, entry, changeDir } = candidate
  const beforeDigest = progressDigest(project, entry, changeDir)
  const run = await runClaude({ config, project, changeRoot: changeDir, prompt,
    resume: resumed?.request?.sessionId || null, readRules, saved })
  if (!run.writerStopped || !run.released) {
    diagnostic(config, saved, run.released ? '旧阶段尚未证实停止' : '阶段握手未完成')
    return 'ran'
  }
  const result = run.result
  const unavailable = (resumed && SESSION_NOT_FOUND.test(`${run.stdout}\n${run.stderr}`))
    || result?.stop_reason === 'tool_deferred_unavailable'
  const deferred = result?.stop_reason === 'tool_deferred' && result.deferred_tool_use?.name === 'AskUserQuestion'
    ? result.deferred_tool_use : null
  const finished = { ...saved, writer: { state: 'exited' }, unavailable: Boolean(unavailable) }
  // 可选字段写不下时仍保留原起点和必需恢复元数据。
  for (const [key, value] of [['sessionId', run.sessionId], ['deferredToolUseId', deferred?.id]]) {
    if (typeof value === 'string' && Buffer.byteLength(value) <= 1024) finished[key] = value
  }
  try {
    storeEntry(finished)
    await handleResult(config, candidate, finished, run, resumed, beforeDigest, deferred)
  } catch (error) {
    await reportFailure(config, finished, error, candidate.state?.changeState.digest)
  }
  return 'ran'
}

/** 恢复会话前核对已展示的边界及实际使用的授权编号。 */
async function resumeSession(config, candidate, decision, readRules) {
  const { batch } = candidate
  if (!claimChange(candidate)) return 'done'
  const sessionId = decision.request?.sessionId
  if (!sessionId) {
    withBatch(batch, target => {
      // 作废也是消费原回复：领取前复核状态（add-change-pause design D5）。
      verifyChangeState(target, candidate.state)
      return transition(decisionFile(target.directory, decision.id), ['answered'], { status: 'void', voidReason: '会话无法恢复' })
    })
    return 'done'
  }
  const fresh = readBeforeTrace(config, candidate)
  if (!fresh) return 'done'
  const { traceBefore, comparisonBoundary, comparisonState } = decision.request
  const boundary = comparisonState === 'listed' || comparisonState === 'stage' ? comparisonBoundary : traceBefore ?? comparisonBoundary
  if ((traceBefore && traceBefore.traceVersion !== fresh.traceVersion) || (boundary && boundary.traceVersion !== fresh.traceVersion)) {
    return versionHandoff(config, candidate, decision)
  }
  if ((traceBefore && !validTrace(traceBefore)) || (boundary && !validTrace(boundary))
    || (['listed', 'stage'].includes(comparisonState) && !comparisonBoundary) || (comparisonState === 'unread' && !traceBefore)) {
    diagnostic(config, batch, '原起点或续查边界无法核验')
    return 'done'
  }
  const priorIds = boundary && boundary === traceBefore ? traceBefore.resumedDecisionIds || [] : []
  const beforeSnapshot = { ...(boundary || fresh), resumedDecisionIds: [...new Set([...priorIds, decision.id])] }
  if (!traceFits(beforeSnapshot)) {
    diagnostic(config, batch, '合入当前决策后续查起点超过 4 MiB')
    return 'done'
  }
  const stage = decision.stage || 'unknown'
  const saved = prepareStage(config, candidate, stage, beforeSnapshot, decision)
  if (!saved) return 'done'
  const note = typeof decision.answer?.text === 'string' ? decision.answer.text : ''
  return startStage(config, candidate, note ? `用户补充说明：${note}` : '', readRules, saved, decision)
}

/** 写入结果前后分别核验同一批次。无法完成任一步时保留起点。 */
async function handleResult(config, candidate, saved, run, resumed, beforeDigest, deferred) {
  const { entry, project } = candidate
  const { view, error: viewError } = readProgressView(config, project.root)
  const afterEntry = view?.active?.find(item => item.change === entry.change)
  const archivedEntry = view?.archived?.find(item => item.name === entry.change)
  if (viewError) log('progress-error-after-run', { change: entry.change })
  const missingFromView = view && !afterEntry && !archivedEntry
  let target
  try {
    target = locateBatch(saved)
  } catch (error) {
    if (!missingFromView) throw error
    log('post-run-batch-unresolved', { change: entry.change, reason: error.code || error.message })
  }
  if (target?.superseded || target?.record.status === 'void') {
    log('pending-trace-released', { change: saved.name, startedAt: saved.startedAt, reason: target.superseded ? '重新托管' : '撤回' })
    removeEntry(saved)
    return
  }
  if (missingFromView) {
    sendNotice(config, entry.change, '托管不再处理此变更', [`进度视图不再列出 ${entry.change}，本次核对起点仍保留。`])
    return
  }
  if (target.record.status !== candidate.record.status) throw new Error('运行后托管状态已变化')
  const block = earlyArchive(saved, target)
  if (block) withBatch(saved, latest => guardEarlyArchive(saved, latest, block))
  const { value: snapshot, error } = traceSnapshot(config.gateBin, target.directory)
  const failures = snapshot ? comparison(config, snapshot, saved, target)
    : [{ file: '门禁核对', field: '处理记录', before: '已保存起点', after: error }]
  if (error && target.recreated) failures.push({ file: target.directory, field: '原位置出现同名目录', before: saved.directory, after: target.recreated })
  const moved = saved.location === 'active' && target.location === 'archived'
  const progressEntry = target.location === 'archived' ? archivedEntry : afterEntry
  const noProgress = !moved && progressEntry && beforeDigest === progressDigest(project, progressEntry, target.directory)
  const result = run.result
  const returned = resumed && hasReturnToSession(resumed) && !block
  const outcome = withBatch(saved, latest => {
    if (latest.directory !== target.directory || !sameObject(latest.identity, target.identity)
      || latest.record.status !== target.record.status) throw new Error('结果的批次已变化')
    if (resumed) {
      const original = readDecision(latest.directory, resumed.id).value
      if (!original || canonicalJson(original) !== canonicalJson(resumed)) throw new Error('已恢复的原决策已变化')
      let patch = { status: 'used' }
      if (saved.unavailable && !returned) {
        if (saved.stage === 'quality' && !transition(recordFile(latest.directory), ['active', 'exiting'], {
          rerunStage: 'quality',
        }, { startedAt: saved.startedAt }).ok) throw new Error('质量重跑标记写入失败')
        patch = { status: 'void', voidReason: '会话无法恢复' }
      } else if (deferred && deferred.id === resumed.request?.toolUseId && !returned) {
        patch = { status: 'void', voidReason: '提问已变化' }
      }
      if (!transition(decisionFile(latest.directory, resumed.id), ['answered'], patch).ok) throw new Error('原决策终态写入失败')
    }
    if (returned) {
      const question = returnToSessionQuestion(resumed)
      if (!transition(recordFile(latest.directory), ['active', 'exiting'], {
        status: 'void', voidReason: `用户选择回会话处理：${question}`,
      }, { startedAt: saved.startedAt }).ok) throw new Error('回会话状态写入失败')
      return { notice: '托管已作废', lines: [`用户在卡片上选择回会话处理（${question}）。`, ...checkFailureLines(failures)] }
    }
    let decision
    let kind
    if (block || failures.length) {
      kind = block ? 'early-archive-alert' : 'check-alert'
      const request = alertRequest({ saved, snapshot, failures, error, block })
      decision = pendingDecision('alert', saved.stage, request)
    } else if (saved.unavailable) {
      return { notice: '托管阶段将重跑', lines: [`决策 ${resumed?.id || ''} 的会话无法恢复，下一轮按进度规则重跑。`] }
    } else if (deferred && saved.sessionId) {
      kind = 'question'
      decision = pendingDecision('question', saved.stage, { sessionId: saved.sessionId,
        toolUseId: deferred.id, fingerprint: fingerprintOf(deferred.input || {}), questions: deferred.input?.questions || [] })
    } else if (!saved.sessionId || result?.is_error || String(result?.subtype || '').startsWith('error') || noProgress) {
      kind = 'stage-alert'
      const text = String(result?.result || result?.subtype || run.stdout || '').slice(0, 500)
      const request = { text, options: ['回会话处理'] }
      if (saved.sessionId) Object.assign(request, { sessionId: saved.sessionId, comparisonBoundary: snapshot, comparisonState: 'stage' })
      decision = pendingDecision('alert', saved.stage, request)
    }
    if (!decision) return {}
    return { id: reserveDecision(saved, latest, decision, snapshot, kind) }
  })
  if (outcome.id) {
    await finishTransfer(config, pendingStore.entries[batchKey(saved)], outcome.id, candidate.state)
  } else {
    withBatch(saved, latest => {
      if (!latest.record || latest.record.startedAt !== saved.startedAt) throw new Error('结果交接前批次已变化')
      removeEntry(saved)
    })
    if (outcome.notice) sendNotice(config, saved.name, outcome.notice, outcome.lines)
  }
}

/** 命令行入口。 */
async function main(argv) {
  // 只读探测：仅当它是唯一参数时，在读配置、取锁和写日志之前输出契约版本；与其他参数混用时拒绝，不运行本轮。
  if (argv.includes('--change-state-version')) {
    if (argv.length !== 1) {
      process.stderr.write('用法：--change-state-version 只能单独使用\n')
      return EXIT.ERROR
    }
    // 输出本副本读取 change-state.json 的契约版本，托管准入据此确认已加载的调度能识别暂缓（add-change-pause design D4）。
    process.stdout.write(`${JSON.stringify({ changeStateVersion: STATE_VERSION })}\n`)
    return EXIT.OK
  }
  if (!argv.includes('--once')) {
    process.stderr.write('用法：node scheduler.mjs --once\n')
    return EXIT.ERROR
  }
  let config
  try {
    config = readConfig()
  } catch (error) {
    log('config-error', { error: error.message })
    process.stderr.write(`${error.message}\n`)
    return EXIT.ERROR
  }
  return runOnce(config)
}

process.exitCode = await main(process.argv.slice(2))
