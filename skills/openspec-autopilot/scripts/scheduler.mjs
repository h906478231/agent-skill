#!/usr/bin/env node
/**
 * 调度脚本：每轮按进度规则运行一个阶段，或处理一条已回复的决策。
 *
 * 所属：skill openspec-autopilot。调用方：launchd 定时触发，桥接脚本收到点选后也触发。
 * 用法：node scheduler.mjs --once
 * 输出：标准输出的阶段提示；日志写在托管目录的 logs/ 下。
 * 退出码：0 本轮结束（含「锁被占用，本轮不运行」）；2 运行环境错误。
 * 边界：只运行一个 claude 进程；对外写入只由出口动作执行（design D3、D11）。
 */

import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { alertCard, checkFailureLines, exitCard, noticeCard, questionCard, sendCard } from './lib/card.mjs'
import { createDecision, decisionsDir, fingerprintOf, listDecisions, readRecord, recordFile, transition } from './lib/decisions.mjs'
import { appendLog, homeDir, readConfig, writeHomeJson } from './lib/home.mjs'
import { acquireLock, currentBootTime, readLockFile, releaseLock, writeLockFile } from './lib/lock.mjs'
import { gitUserName, inside, locateChangeDir, readProgressView } from './lib/project.mjs'
import { checkProject } from './lib/rule-check.mjs'
import { compareSignOff, compareTrace, signOffSnapshot, traceSnapshot } from './lib/trace-check.mjs'
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
    return realpathSync(target)
  } catch {
    return path.resolve(target)
  }
}

/**
 * 运行环境检查（design D4「运行环境检查」，评审 SEC-02、SEC-12、SEC-13、ARCH-01）。
 * @param {object} config 托管配置。
 * @returns {string[]} 不通过的原因；为空表示通过。
 */
function checkEnvironment(config) {
  const problems = []
  if (!config.model) problems.push('配置没有 model')
  if (!config.ownerOpenId) problems.push('配置没有 ownerOpenId')
  if (!Array.isArray(config.projects) || !config.projects.length) problems.push('配置没有 projects')
  if (problems.length) return problems
  if (!canRun(process.execPath)) problems.push('node 不能运行')
  if (!canRun(config.claudeBin)) problems.push(`claudeBin 不能运行：${config.claudeBin}`)
  if (!canRun(config.larkBin)) problems.push(`larkBin 不能运行：${config.larkBin}`)

  // 守卫脚本不能装在被托管的仓库中：agent 改代码就能改掉守卫（design D4，评审 SEC-02）。
  const skillReal = realOf(SKILL_DIR)
  const progressReal = realOf(config.progressBin)
  for (const project of config.projects) {
    const rootReal = realOf(project.root)
    if (inside(skillReal, rootReal)) problems.push(`skill 目录在项目内：${skillReal}`)
    if (inside(progressReal, rootReal)) problems.push(`progressBin 在项目内：${progressReal}`)
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
  return problems
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
  const tmp = `${settingsFile}.tmp.${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(written, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, settingsFile)

  const mcpFile = path.join(home, 'mcp.json')
  const mcp = JSON.parse(readFileSync(path.join(SKILL_DIR, 'templates', 'autopilot-mcp.json'), 'utf8'))
  mcp.mcpServers.autopilot.env.AUTOPILOT_ALLOWED_COMMANDS = prefixes
  const mcpTmp = `${mcpFile}.tmp.${process.pid}`
  writeFileSync(mcpTmp, `${JSON.stringify(mcp, null, 2)}\n`, { mode: 0o600 })
  renameSync(mcpTmp, mcpFile)

  return { settingsFile, mcpFile, allowedTools }
}

/**
 * 列出变更目录中未完成的决策。
 * @param {string} changeDir 变更目录。
 * @returns {object[]} 决策列表。
 */
function openDecisions(changeDir) {
  return listDecisions(changeDir).decisions
    .filter(item => item.status === 'pending' || item.status === 'answered')
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
function writeLockClaudePid(pid) {
  const lockFile = path.join(homeDir(), 'run.lock')
  const lock = readLockFile(lockFile)
  if (lock.value && lock.value.pid === process.pid) writeLockFile(lockFile, { ...lock.value, claudePid: pid })
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
async function runClaude({ config, project, changeRoot, prompt, resume, readRules, draft = false }) {
  const { settingsFile, mcpFile, allowedTools } = writeSettings(config, project, readRules, draft)
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
  // 新进程组启动并写回 claudePid：撤回要能停下运行中的阶段（design D12，quality R1 SPEC-01）。
  const child = spawn(config.claudeBin, args, { cwd: project.root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  if (child.pid) {
    activeClaudePid = child.pid
    writeLockClaudePid(child.pid)
  }
  const timer = setTimeout(terminateClaude, CLAUDE_TIMEOUT_MS)
  const result = await new Promise(resolve => {
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
  clearTimeout(timer)
  if (child.pid) {
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
  }
}

/**
 * 发一张通知卡片：通知不创建决策文件（design D3）。
 * @param {object} config 托管配置。
 * @param {string} change 变更名。
 * @param {string} title 卡片标题。
 * @param {string[]} lines 正文行。
 */
function sendNotice(config, change, title, lines) {
  const body = Array.isArray(lines) ? lines : [String(lines)]
  const key = `${change}-notice-${Date.now()}`
  const sent = sendCard({
    larkBin: config.larkBin,
    ownerOpenId: config.ownerOpenId,
    card: noticeCard({ title, lines: body }),
    idempotencyKey: key,
    home: homeDir(),
  })
  log('notice-card', { change, title, ok: sent.ok })
}

/**
 * 发一张决策卡片，并把返回的 message id 写回决策文件（design D9）。
 * 发送失败时 card.messageId 保持 null，下一轮重新发送（design D3 检查顺序第 1 步）。
 * @param {object} config 托管配置。
 * @param {object} entry 进度条目。
 * @param {object} decision 决策对象。
 * @param {string} kind 决策类型：question 或 alert。
 * @param {string} changeDir 变更目录。
 */
function sendDecisionCard(config, entry, decision, kind, changeDir) {
  const file = path.join(decisionsDir(changeDir), `${decision.id}.json`)
  const card = kind === 'exit' || kind === 'exit-alert'
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
      text: decision.request.text,
      checkFailures: decision.request.checkFailures || [],
    })
  const sent = sendCard({
    larkBin: config.larkBin,
    ownerOpenId: config.ownerOpenId,
    card,
    idempotencyKey: `${entry.change}-${decision.id}`,
    home: homeDir(),
  })
  log('decision-card', { change: entry.change, decision: decision.id, ok: sent.ok })
  if (sent.ok && sent.messageId) {
    transition(file, ['pending'], { card: { messageId: sent.messageId } })
  }
}

/**
 * 生成一个等待回复的决策对象。决策的公共字段只在这里定义：
 * 桥接脚本与 hook 按这些字段匹配回复，各处手写时漏一个字段，那类决策就匹配不上回复（quality R1 STD-01）。
 * @param {string} kind 决策类型：question、alert、exit、exit-alert。
 * @param {string} stage 创建决策时的阶段。
 * @param {object} request 决策请求。
 * @returns {object} 决策对象（还没有编号）。
 */
function pendingDecision(kind, stage, request) {
  return { kind, status: 'pending', stage, request, card: { messageId: null } }
}

/**
 * 创建决策、写日志并发卡片（design D9）。
 * @param {object} config 托管配置。
 * @param {object} entry 进度条目（取变更名）。
 * @param {string} changeDir 变更目录。
 * @param {object} decision pendingDecision 生成的决策对象。
 * @param {string} logEvent 日志事件名。
 * @param {object} [options] fields 为日志的其他字段；confirm(created) 在发卡片前调用，
 *   返回发卡片时使用的变更目录，返回 null 时不发卡片（运行后再读托管记录的检查，design D5 第 5 步）。
 * @returns {object} 创建的决策（含 id 与 file）。
 */
function issueDecision(config, entry, changeDir, decision, logEvent, { fields = {}, confirm } = {}) {
  const created = { ...decision, ...createDecision(changeDir, decision) }
  log(logEvent, { change: entry.change, decision: created.id, ...fields })
  const target = confirm ? confirm(created) : changeDir
  if (target) sendDecisionCard(config, entry, created, created.kind, target)
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

/**
 * 拍一次核对快照（design D5「运行前后核对」）。
 * @param {string} changeDir 变更目录。
 * @returns {object} 处理记录与签署字段的快照。
 */
function snapshotOf(changeDir) {
  return { trace: traceSnapshot(changeDir), signOff: signOffSnapshot(changeDir) }
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
  const { project, entry, changeDir, record } = candidate
  // 起草与执行出口步骤之前认领：推送期间撤回要等本轮结束（spec autopilot-exit-actions「Cancel during the push」）。
  if (!claimChange(candidate)) return 'done'
  // 检查顺序第 1–4 步：等待回复的决策与归档阶段留下的已回复告警先处理（quality R1 SPEC-05）。
  const handled = await handleOpenDecisions(config, candidate, readRules, { skipKinds: ['exit', 'exit-alert'] })
  if (handled) return handled
  // 出口阶段的变更已在归档目录中；托管记录改为 exiting（design D11）。
  if (record.status === 'active') {
    const written = transition(recordFile(changeDir), ['active'], { status: 'exiting' }, { startedAt: record.startedAt })
    if (!written.ok) return 'done'
    record.status = 'exiting'
  }
  const decisions = listDecisions(changeDir).decisions
  // 检查顺序第 4 步：有已回复的出口告警时按选择处理。
  const alert = decisions.find(item => item.status === 'answered' && item.kind === 'exit-alert')
  if (alert) {
    const choice = (alert.answer && alert.answer.choice) || ''
    transition(path.join(decisionsDir(changeDir), `${alert.id}.json`), ['answered'], { status: 'used' })
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
    // 重试本项：下一轮按 result.steps 决定重新起草还是只合并（design D11「执行失败」）。
    return 'done'
  }
  // 检查顺序第 5 步：有已回复的出口决策时执行动作。
  const exit = decisions.find(item => item.status === 'answered' && item.kind === 'exit')
  if (exit) {
    runExitAction(config, candidate, exit, readRules)
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
  if (next === 'commit-merge') {
    const previous = decisions.filter(item => item.kind === 'exit' && item.request && item.request.action === next).pop()
    const previousBranch = (exitNow[next] || {}).branch || (previous && previous.request ? previous.request.branch : null)
    // 重试时提交已在分支上：不起草、不按 git status 核对计划，沿用上一个出口决策的计划与内容摘要，
    // 执行从回读开始，只合并（design D11「执行失败」重试本项，评审 CONC-04）。
    if ((exitNow[next] || {}).commit && previous) {
      issueDecision(config, entry, changeDir, pendingDecision('exit', 'exit', {
        ...previous.request, commitOnBranch: (exitNow[next] || {}).commit, options: COMMIT_OPTIONS,
      }), 'exit-decision', { fields: { action: next, retry: 'merge-only' } })
      return 'ran'
    }
    // 起草也会启动 claude：先做启动前核对（spec autopilot-scheduler 第 3 条，quality R1 SPEC-08）。
    if (!projectCheckPassed(config, entry, project)) return 'done'
    const drafted = await draftExitAction({
      config, project, changeDir, action: next, readRules, previousBranch,
    })
    if (!drafted.ok) {
      failExitAction(config, candidate, next, null, drafted.error)
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
      failExitAction(config, candidate, next, null, checked.error)
      return 'ran'
    }
    issueDecision(config, entry, changeDir, pendingDecision('exit', 'exit', {
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
  const list = pushList(project.root, { baseBranch: project.baseBranch, commit })
  if (!list.ok) {
    failExitAction(config, candidate, next, null, list.error)
    return 'ran'
  }
  issueDecision(config, entry, changeDir, pendingDecision('exit', 'exit', {
    action: next,
    branch: commitState.branch || null,
    commits: list.commits,
    options: PUSH_OPTIONS,
  }), 'exit-decision', { fields: { action: next } })
  return 'ran'
}

/**
 * 执行一个已回复的出口决策（design D11「执行与回读」）。
 * @param {object} config 托管配置。
 * @param {object} candidate 候选变更。
 * @param {object} decision 出口决策。
 * @param {string[]} readRules 读取规则。
 */
function runExitAction(config, candidate, decision, readRules) {
  const { project, entry, changeDir, record } = candidate
  const request = decision.request || {}
  const choice = (decision.answer && decision.answer.choice) || ''
  if (choice === '暂不处理') {
    transition(path.join(decisionsDir(changeDir), `${decision.id}.json`), ['answered'], {
      status: 'used', result: { ok: true, steps: ['skipped'] },
    })
    closeExit(config, candidate, '出口动作已跳过')
    return
  }
  if (request.action === 'commit-merge') {
    const result = executeCommitMerge(candidate, decision, { draftsDir: path.join(homeDir(), 'drafts'), log })
    if (!result.ok) {
      failExitAction(config, candidate, request.action, decision, result.error, result.steps)
      return
    }
    transition(path.join(decisionsDir(changeDir), `${decision.id}.json`), ['answered'], {
      status: 'used', result: { ok: true, steps: result.steps },
    })
    return
  }
  if (request.action === 'push') {
    const result = executePush(candidate, decision, { log })
    if (!result.ok) {
      failExitAction(config, candidate, request.action, decision, result.error, result.steps)
      return
    }
    transition(path.join(decisionsDir(changeDir), `${decision.id}.json`), ['answered'], {
      status: 'used', result: { ok: true, steps: result.steps },
    })
    return
  }
  failExitAction(config, candidate, request.action, decision, `未知出口动作：${request.action}`)
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
function failExitAction(config, candidate, action, decision, error, steps = []) {
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
    transition(path.join(decisionsDir(changeDir), `${decision.id}.json`), ['answered'], {
      status: 'used', result: { ok: false, error, steps },
    })
  }
  // 托管记录已撤回时不再创建出口告警（评审 CONC-06）。
  if (!writeExitState(candidate, action, { ok: false, failed: true }, log)) return
  issueDecision(config, entry, changeDir, pendingDecision('exit-alert', 'exit', {
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
  transition(recordFile(changeDir), ['exiting'], { status: 'closed', exit }, { startedAt: record.startedAt })
  const done = EXIT_ACTIONS.filter(item => exit[item] && exit[item].ok)
  const skipped = EXIT_ACTIONS.filter(item => !done.includes(item))
  const lines = [note,
    ...done.map(item => `已完成：${item}`),
    ...skipped.map(item => `已跳过：${item}`)]
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
  const lock = acquireLock(lockFile, { pid: process.pid, bootTime: currentBootTime(), change: null, claudePid: null })
  if (!lock.ok) {
    log('lock-busy', { reason: lock.reason })
    return EXIT.OK
  }
  // 调度进程被停止或出现未捕获异常时，先停 claude 的进程组再释放锁（design D12，quality R1 SPEC-01）。
  const onTerm = () => {
    terminateClaude()
    releaseLock(lockFile)
    log('scheduler-terminated')
    process.exit(EXIT.TERMINATED)
  }
  const onCrash = error => {
    terminateClaude()
    releaseLock(lockFile)
    log('scheduler-crashed', { error: String(error && error.message || error).slice(0, 200) })
    process.exit(EXIT.ERROR)
  }
  process.on('SIGTERM', onTerm)
  process.on('uncaughtException', onCrash)
  process.on('unhandledRejection', onCrash)
  try {
    const problems = checkEnvironment(config)
    if (problems.length) {
      log('environment-error', { problems })
      for (const problem of problems) log('environment-problem', { problem })
      notifyEnvironment(config, problems)
      return EXIT.ERROR
    }
    clearEnvironmentState()
    const home = process.env.HOME || ''
    const { rules: readRules } = skillReadRules(home)

    // 按 startedAt 排序处理变更：最早的先处理（design D12「并发」）。
    const candidates = []
    for (const project of config.projects) {
      const { view, error } = readProgressView(config, project.root)
      if (error) {
        log('progress-error', { project: project.root, error })
        continue
      }
      for (const entry of view.active || []) {
        const changeDir = locateChangeDir(project, view, entry.change)
        if (!changeDir) continue
        const record = readRecord(changeDir)
        if (record.error || !record.value) continue
        if (record.value.status !== 'active' && record.value.status !== 'exiting') continue
        candidates.push({ project, view, entry, changeDir, record: record.value })
      }
    }
    candidates.sort((a, b) => String(a.record.startedAt).localeCompare(String(b.record.startedAt)))

    for (const candidate of candidates) {
      const handled = await handleCandidate(config, candidate, readRules)
      if (handled === 'ran') return EXIT.OK
    }
    // 已归档的变更：执行出口动作（design D11 的顺序）。
    for (const project of config.projects) {
      const { view, error } = readProgressView(config, project.root)
      if (error || !view) continue
      for (const item of view.archived || []) {
        const changeDir = locateChangeDir(project, view, item.name)
        if (!changeDir) continue
        const record = readRecord(changeDir)
        if (record.error || !record.value) continue
        if (record.value.status !== 'active' && record.value.status !== 'exiting') continue
        const handled = await handleExitActions(config, {
          project, entry: { change: item.name, ...item }, changeDir, record: record.value,
        }, readRules)
        if (handled === 'ran') return EXIT.OK
      }
    }
    return EXIT.OK
  } finally {
    process.off('SIGTERM', onTerm)
    process.off('uncaughtException', onCrash)
    process.off('unhandledRejection', onCrash)
    releaseLock(lockFile)
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
  if (pending) {
    if (!pending.card || !pending.card.messageId) {
      // 重发原决策卡片并写回 messageId：通知卡片没有表单，发了也不能回复，决策会一直停在 pending
      // （spec autopilot-scheduler 检查顺序第 1 步，quality R1 SPEC-06、STD-04）。幂等键沿用 <变更名>-<决策号>。
      log('resend-card', { change: entry.change, decision: pending.id })
      sendDecisionCard(config, entry, pending, pending.kind, changeDir)
    } else {
      log('pending-decision', { change: entry.change, decision: pending.id })
    }
    return 'done'
  }

  // 第 3、4 步：恢复会话或按「回会话处理」作废托管。
  const answered = open.find(item => item.status === 'answered' && !skipKinds.includes(item.kind))
  if (!answered) return null
  if (answered.kind === 'alert' && answered.answer && answered.answer.choice === '回会话处理') {
    transition(path.join(decisionsDir(changeDir), `${answered.id}.json`), ['answered'], { status: 'used' })
    transition(recordFile(changeDir), ['active', 'exiting'], { status: 'void', voidReason: '用户选择回会话处理' },
      { startedAt: record.startedAt })
    sendNotice(config, entry.change, '托管已作废', ['用户在卡片上选择回会话处理，请在会话中继续处理。'])
    return 'done'
  }
  // 恢复会话之前也做启动前核对：等待卡片期间加入的允许规则或 hook 会在恢复时生效（quality R1 SPEC-08）。
  if (!projectCheckPassed(config, entry, project)) return 'done'
  return resumeSession(config, candidate, answered, readRules)
}

/**
 * 处理一个候选变更：按检查顺序与进度规则决定动作（design D3 的两张表）。
 * @param {object} config 托管配置。
 * @param {object} candidate 候选变更。
 * @param {string[]} readRules skill 目录的读取规则。
 * @returns {string} ran 表示本轮运行了阶段，done 表示本轮结束。
 */
async function handleCandidate(config, candidate, readRules) {
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

  // rerunStage 为 quality 时改走 quality，且不写实现快照（design D3，评审 ARCH-19）。
  let rule = entry.rule
  const rerun = record.rerunStage === 'quality' && (rule === 'R9' || rule === 'R11')
  if (rerun) rule = 'R8'
  // 启动阶段或作废托管之前清除 rerunStage（design D3）。
  if (record.rerunStage) {
    transition(recordFile(changeDir), ['active', 'exiting'], { rerunStage: null }, { startedAt: record.startedAt })
  }

  const skill = RULE_SKILL[rule]
  if (!skill) {
    log('no-skill-for-rule', { rule, change: entry.change })
    return 'done'
  }
  // R11 之前记录实现快照（design D11「实现快照」）。复核之后的 transition 返回 false 时结束本轮，不启动 claude。
  if (rule === 'R11' && !rerun && !writeImplSnapshot(project, changeDir, record)) {
    log('record-changed-before-start', { change: entry.change })
    return 'done'
  }

  const prompt = stagePrompt({
    skill,
    change: entry.change,
    skillDir: path.join(process.env.HOME || '', '.claude', 'skills', skill),
    userName: gitUserName(project.root),
  })
  return startStage(config, candidate, prompt, readRules)
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
      }
    }
  } catch {
    // 文件不存在或不是 JSON：按没有通知过处理。
  }
  return { projects: {}, environment: [] }
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
    state.projects[project.root] = issues
    writeHomeJson(CHECK_FILE, state)
    sendNotice(config, entry.change, '托管启动前核对不通过', issues)
  }
  log('rule-check-failed', { project: project.root, issues })
  return false
}

/**
 * 运行环境检查不通过时发通知卡片（spec autopilot-scheduler 第 4 条，quality R1 SPEC-08）：
 * larkBin 能运行且有 ownerOpenId 时，每个新原因发一张；已通知的原因记在核对结果文件中，不再重发。
 * 发不了卡片时不记录：之后 larkBin 能运行了，这些原因仍会通知。
 * @param {object} config 托管配置。
 * @param {string[]} problems 不通过的原因。
 */
function notifyEnvironment(config, problems) {
  if (!config.ownerOpenId || !canRun(config.larkBin)) return
  const state = readCheckState()
  const fresh = problems.filter(problem => !state.environment.includes(problem))
  // 每个原因一张卡片；变更名位置写序号，让同一毫秒内发出的卡片幂等键不同。
  fresh.forEach((problem, index) => sendNotice(config, `environment-${index + 1}`, '托管运行环境检查不通过', [problem]))
  state.environment = problems
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
 * @returns {boolean} 托管记录的 status 与 startedAt 与选定时相同时为 true。
 */
function claimChange(candidate) {
  const { entry, changeDir, record } = candidate
  const lockFile = path.join(homeDir(), 'run.lock')
  const lock = readLockFile(lockFile)
  if (lock.value && lock.value.pid === process.pid) writeLockFile(lockFile, { ...lock.value, change: entry.change })
  const again = readRecord(changeDir)
  if (again.error || !again.value || again.value.status !== record.status
    || again.value.startedAt !== record.startedAt) {
    log('record-changed-before-start', { change: entry.change })
    return false
  }
  return true
}

/**
 * 启动一个阶段并处理结果。
 * @param {object} config 托管配置。
 * @param {object} candidate 候选变更。
 * @param {string} prompt 提示词。
 * @param {string[]} readRules 读取规则。
 * @returns {string} ran 表示本轮运行了阶段。
 */
async function startStage(config, candidate, prompt, readRules) {
  const { project, entry, changeDir } = candidate
  // 认领与实现快照已在 handleCandidate 中完成。
  const before = progressDigest(project, entry, changeDir)
  const beforeSnapshot = snapshotOf(changeDir)
  const run = await runClaude({ config, project, changeRoot: changeDir, prompt, resume: null, readRules })
  log('stage-finished', { change: entry.change, code: run.code, sessionId: run.sessionId })
  const after = progressDigest(project, entry, changeDir)
  handleResult(config, candidate, run, null, before === after, beforeSnapshot)
  return 'ran'
}

/**
 * 恢复一个会话并处理结果（design D5「处理顺序」）。
 * @param {object} config 托管配置。
 * @param {object} candidate 候选变更。
 * @param {object} decision 已回复的决策。
 * @param {string[]} readRules 读取规则。
 * @returns {string} ran 表示本轮运行了阶段。
 */
async function resumeSession(config, candidate, decision, readRules) {
  const { project, entry, changeDir } = candidate
  if (!claimChange(candidate)) return 'done'
  const sessionId = decision.request && decision.request.sessionId
  if (!sessionId) {
    transition(path.join(decisionsDir(changeDir), `${decision.id}.json`), ['answered'], {
      status: 'void', voidReason: '会话无法恢复',
    })
    return 'done'
  }
  // 会话告警回复「补充说明后继续」时，说明就是恢复会话的提示词（design D5）。
  const note = typeof (decision.answer && decision.answer.text) === 'string' ? decision.answer.text : ''
  const prompt = note ? `用户补充说明：${note}` : ''
  const before = progressDigest(project, entry, changeDir)
  const beforeSnapshot = snapshotOf(changeDir)
  const run = await runClaude({ config, project, changeRoot: changeDir, prompt, resume: sessionId, readRules })
  log('resume-finished', { change: entry.change, decision: decision.id, code: run.code })
  const after = progressDigest(project, entry, changeDir)
  handleResult(config, candidate, run, decision, before === after, beforeSnapshot)
  return 'ran'
}

/**
 * 处理一次运行的结果（design D5「处理顺序」）。
 * 顺序：重新定位并读托管记录 → 被恢复的决策迁移到终态 → 最多创建一个新决策 → 再读托管记录。
 * @param {object} config 托管配置。
 * @param {object} candidate 候选变更。
 * @param {object} run 运行结果。
 * @param {object} [resumed] 被恢复的决策。
 * @param {boolean} [noProgress] 运行前后进展摘要相同时为 true。
 * @param {object} [beforeSnapshot] 运行前的核对快照。
 */
function handleResult(config, candidate, run, resumed = null, noProgress = false, beforeSnapshot = null) {
  const { entry, record } = candidate
  // 第 1 步：运行后重新定位变更并读托管记录（design D5「运行后重新定位」）。
  const view = readProgressView(config, candidate.project.root)
  const located = view.view ? locateChangeDir(candidate.project, view.view, entry.change) : null
  if (!located) {
    log('change-not-found-after-run', { change: entry.change })
    return
  }
  const current = readRecord(located)
  if (current.error || !current.value || current.value.status !== record.status
    || current.value.startedAt !== record.startedAt) {
    log('record-changed-after-run', { change: entry.change })
    return
  }
  const result = run.result
  // 第 2 步：运行前后核对（design D5）。不通过时发会话告警，不按运行结果创建其他决策。
  let checkFailures = []
  if (beforeSnapshot) {
    const afterSnapshot = snapshotOf(located)
    const decisions = listDecisions(located).decisions
    checkFailures = compareTrace({
      before: beforeSnapshot.trace, after: afterSnapshot.trace, decisions, ownerOpenId: config.ownerOpenId,
    }).concat(compareSignOff({
      before: beforeSnapshot.signOff, after: afterSnapshot.signOff,
    }))
  }
  const deferred = result && result.stop_reason === 'tool_deferred' ? result.deferred_tool_use : null
  // 恢复的会话找不到时 CLI 报错，输出可能不是 JSON：与 tool_deferred_unavailable 同样按会话无法恢复处理
  // （spec autopilot-scheduler 第 6 条，quality R1 SPEC-10）。
  const sessionMissing = Boolean(resumed) && SESSION_NOT_FOUND.test(`${run.stdout}\n${run.stderr}`)
  const unavailable = sessionMissing || Boolean(result && result.stop_reason === 'tool_deferred_unavailable')
  const isError = result && (result.is_error === true || String(result.subtype || '').startsWith('error'))
  // 回复含「回会话处理」时不论结果如何都先按它处理（spec 第 6 条的第 1 项）。
  const returnToSession = Boolean(resumed) && hasReturnToSession(resumed)

  // 第 3 步：把被恢复的决策迁移到终态（design D5）。
  if (resumed && !returnToSession) {
    const file = path.join(decisionsDir(located), `${resumed.id}.json`)
    if (unavailable) {
      // 会话无法恢复：quality 的决策先写 rerunStage，成功后再作废（design D3，评审 ARCH-19、CONC-15）。
      if (resumed.stage === 'quality') {
        const marked = transition(recordFile(located), ['active', 'exiting'], { rerunStage: 'quality' },
          { startedAt: record.startedAt })
        if (!marked.ok) {
          // 写不进 rerunStage 时不作废决策：作废后下一轮可能直接进入 verify（评审 ARCH-19）。
          log('rerun-stage-failed', { change: entry.change, reason: marked.reason })
          return
        }
      }
      transition(file, ['answered'], { status: 'void', voidReason: '会话无法恢复' })
      // 不为本次结果创建决策：下一轮按进度规则重跑阶段（spec 第 6 条）。
      sendNotice(config, entry.change, '托管阶段将重跑', [
        `决策 ${resumed.id} 的会话无法恢复，下一轮按进度规则重跑${resumed.stage ? ` ${resumed.stage}` : ''}阶段。`,
      ])
      return
    } else if (deferred && deferred.name === 'AskUserQuestion' && resumed.request
      && deferred.id === resumed.request.toolUseId) {
      // 再次停在同一个提问调用号上：原决策作废（design D5）。
      transition(file, ['answered'], { status: 'void', voidReason: '提问已变化' })
    } else {
      transition(file, ['answered'], { status: 'used' })
    }
  }

  // 第 4 步：最多创建一个新决策（design D5）。
  // 回复含「回会话处理」时：原决策改为 used，托管作废，不为结果创建决策（design D5 结果表第 3 行）。
  if (returnToSession) {
    const file = path.join(decisionsDir(located), `${resumed.id}.json`)
    transition(file, ['answered', 'used'], { status: 'used' })
    const question = returnToSessionQuestion(resumed)
    transition(recordFile(located), ['active', 'exiting'],
      { status: 'void', voidReason: `用户选择回会话处理：${question}` }, { startedAt: record.startedAt })
    // 通知卡片附上第 2 步核对不通过的项：用户回会话后要知道哪些记录被改动（spec 第 6 条，quality R1 SPEC-10）。
    sendNotice(config, entry.change, '托管已作废', [
      `用户在卡片上选择回会话处理（${question}），请在会话中继续处理。`,
      ...(checkFailures.length ? ['运行前后核对不通过的项：', ...checkFailureLines(checkFailures)] : []),
    ])
    return
  }

  // 各分支只算出决策与日志事件，第 5 步统一创建与发卡片（quality R1 STD-01）。
  let decision = null
  let logEvent = null
  if (checkFailures.length) {
    // 核对不通过：创建会话告警并列出每一项，不按运行结果创建提问决策或其他告警（design D5）。
    decision = pendingDecision('alert', entry.stage, {
      sessionId: result && result.session_id ? result.session_id : null,
      text: '运行前后的记录不一致，请确认这些项。',
      options: ['补充说明后继续', '回会话处理'],
      checkFailures,
      ...(deferred && deferred.name === 'AskUserQuestion' ? { deferredToolUseId: deferred.id } : {}),
    })
    logEvent = 'check-failures'
  } else if (deferred && deferred.name === 'AskUserQuestion') {
    const input = deferred.input || {}
    decision = pendingDecision('question', entry.stage, {
      sessionId: result.session_id || null,
      toolUseId: deferred.id,
      fingerprint: fingerprintOf(input),
      questions: input.questions || [],
    })
    logEvent = 'question-decision'
  } else if (isError) {
    decision = pendingDecision('alert', entry.stage, {
      sessionId: result.session_id || null,
      text: String(result.result || result.subtype || '').slice(0, 500),
      options: ['补充说明后继续', '回会话处理'],
    })
    logEvent = 'alert-decision'
  } else if (!result || !result.session_id) {
    // 输出不是 JSON 或没有 session_id：没有会话可以恢复，只有「回会话处理」（design D5 结果表，评审 CONC-17）。
    decision = pendingDecision('alert', entry.stage, {
      sessionId: null,
      text: (run.stdout || '').slice(0, 500),
      options: ['回会话处理'],
    })
    logEvent = 'alert-decision'
  } else if (noProgress && !unavailable) {
    // 正常结束但没有进展：发会话告警，不重跑同一阶段（design D5 结果表）。
    // 会话无法恢复（unavailable）按上一行处理：它已经有专门的作废逻辑。
    decision = pendingDecision('alert', entry.stage, {
      sessionId: result.session_id || null,
      text: String(result.result || '').slice(0, 500),
      options: ['补充说明后继续', '回会话处理'],
    })
    logEvent = 'alert-decision'
  }
  if (!decision) return

  // 第 5 步：创建决策之后再定位一次并读托管记录，变化时把新决策作废、不发卡片（design D5，评审 CONC-12）。
  issueDecision(config, entry, located, decision, logEvent, {
    fields: logEvent === 'check-failures' ? { count: checkFailures.length } : {},
    confirm: created => {
      const afterView = readProgressView(config, candidate.project.root)
      const afterDir = afterView.view ? locateChangeDir(candidate.project, afterView.view, entry.change) : null
      const target = afterDir || located
      const after = readRecord(target)
      if (!after.error && after.value && (after.value.status !== record.status
        || after.value.startedAt !== record.startedAt)) {
        transition(path.join(decisionsDir(target), `${created.id}.json`), ['pending'], {
          status: 'void', voidReason: '托管已撤回',
        })
        return null
      }
      return target
    },
  })
}

/** 命令行入口。 */
async function main(argv) {
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
