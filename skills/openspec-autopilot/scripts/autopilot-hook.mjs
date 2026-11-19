#!/usr/bin/env node
/**
 * 提问 hook：把 agent 的提问停住，等回复记录后填回；同时拒绝 agent 写托管文件。
 *
 * 所属：skill openspec-autopilot。调用方：Claude Code 的 PreToolUse hook（templates/autopilot-settings.json 注册）。
 * 输入：标准输入的 hook 事件 JSON（tool_name、tool_input、tool_use_id）。输出：标准输出的决策 JSON。
 * 边界：只读变更目录的 decisions/ 与托管配置；不写任何文件（design D7）。
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { DECISIONS_DIR, fingerprintOf, listDecisionsIn } from './lib/decisions.mjs'
import { homeDir, readConfig } from './lib/home.mjs'
import { archivedDirNames, inside } from './lib/project.mjs'


/** 写入类工具名：这些工具的目标路径受写入保护（design D7）。 */
const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

/**
 * 读出托管配置中的本人标识。读不到时返回空串：此时没有人被认作决策人，回复不会被填回。
 * @returns {string} ownerOpenId。
 */
function ownerOpenId() {
  try {
    return readConfig().ownerOpenId || ''
  } catch {
    return ''
  }
}

/**
 * 列出可能存放决策的目录：变更目录下的 decisions/，以及归档目录回退查找的结果（design D7）。
 * 目录不存在时也返回，写入保护要按路径拦截，不等目录被创建。
 * @param {string} changeRoot 变更目录。
 * @returns {string[]} 候选决策目录。
 */
function candidateDirs(changeRoot) {
  // 回退查找：归档目录名按 YYYY-MM-DD-<变更名> 完整匹配（规则在 lib/project.mjs 中只实现一次）。
  const archiveRoot = path.join(path.dirname(changeRoot), 'archive')
  return [path.join(changeRoot, DECISIONS_DIR),
    ...archivedDirNames(archiveRoot, path.basename(changeRoot)).map(item => path.join(archiveRoot, item, DECISIONS_DIR))]
}

/**
 * 找出可以读取的决策目录：优先用变更目录下的 decisions/，不存在时回退查找归档目录（design D7）。
 * @param {string} changeRoot 变更目录。
 * @returns {string|null} 决策目录路径；找不到时为 null。
 */
function decisionsDirOf(changeRoot) {
  return candidateDirs(changeRoot).find(dir => existsSync(dir) && statSync(dir).isDirectory()) || null
}

/**
 * 归一化写入目标路径：先 resolve，再把父目录用 realpath 解析（design D7，评审 SEC-06）。
 * @param {string} target 目标路径。
 * @returns {string|null} 归一化后的绝对路径；输入为空时为 null。
 */
function normalizeTarget(target) {
  if (!target) return null
  const resolved = path.resolve(target)
  const parent = path.dirname(resolved)
  try {
    return path.join(realpathSync(parent), path.basename(resolved))
  } catch {
    // 父目录不存在时按解析后的路径比较：新建文件也要受写入保护。
    return resolved
  }
}

/**
 * 处理 AskUserQuestion：找到对应调用号的决策，条件全成立时填回答案，否则 defer（design D7）。
 * @param {object} input hook 输入。
 * @param {string} dir 决策目录。
 * @returns {object} 决策 JSON。
 */
function answerQuestion(input, dir) {
  const { decisions } = listDecisionsIn(dir)
  const toolUseId = input.tool_use_id
  const owner = ownerOpenId()
  // 例外先于普通匹配：会话告警的说明经 deny 送回模型，保证用户说明一定到达 agent（design D7，评审 CONC-14）。
  const alert = decisions.find(item => item.kind === 'alert' && item.request
    && item.request.deferredToolUseId === toolUseId && item.status === 'answered')
  if (alert) {
    const alertAnswer = alert.answer || {}
    if (alertAnswer.operatorId === owner && alertAnswer.choice === '补充说明后继续') {
      return {
        permissionDecision: 'deny',
        permissionDecisionReason: `用户说明：${alertAnswer.text || ''}。按说明处理后重新调用 AskUserQuestion。`,
      }
    }
    return { permissionDecision: 'defer' }
  }
  const decision = decisions.find(item => item.request && item.request.toolUseId === toolUseId)
  if (!decision || decision.status !== 'answered') return { permissionDecision: 'defer' }
  const answer = decision.answer || {}
  // 回复人必须是本人（design D7）。
  if (answer.operatorId !== owner) return { permissionDecision: 'defer' }
  // 指纹绑定提问原文：问题变化时旧回复不能填回（design D5）。
  if (decision.request.fingerprint !== fingerprintOf(input.tool_input)) return { permissionDecision: 'defer' }
  return {
    permissionDecision: 'allow',
    updatedInput: { ...input.tool_input, answers: answer.answers || {} },
  }
}

/**
 * 处理写入类工具：目标在决策目录或托管目录中时拒绝（design D7，评审 SEC-06）。
 * @param {object} input hook 输入。
 * @param {string[]} dirs 候选决策目录。
 * @returns {object|null} 拒绝决策；放行时为 null（不输出任何内容）。
 */
function denyWrites(input, dirs) {
  const target = normalizeTarget(input.tool_input && (input.tool_input.file_path || input.tool_input.notebook_path))
  if (!target) return null
  if (dirs.some(dir => inside(target, dir)) || inside(target, homeDir())) {
    return { permissionDecision: 'deny', permissionDecisionReason: `托管不允许写入托管文件：${target}` }
  }
  return null
}

/** 主流程：按工具名分派。 */
function main() {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  if (input.tool_name === 'AskUserQuestion') {
    const changeRoot = process.env.OPENSPEC_AUTOPILOT_CHANGE_ROOT
    if (!changeRoot) {
      process.stdout.write(`${JSON.stringify({
        permissionDecision: 'deny',
        permissionDecisionReason: '托管没有设置 OPENSPEC_AUTOPILOT_CHANGE_ROOT，无法查找决策记录',
      })}\n`)
      return
    }
    const dir = decisionsDirOf(changeRoot)
    if (!dir) {
      process.stdout.write(`${JSON.stringify({ permissionDecision: 'defer' })}\n`)
      return
    }
    process.stdout.write(`${JSON.stringify(answerQuestion(input, dir))}\n`)
    return
  }
  if (WRITE_TOOLS.includes(input.tool_name)) {
    const changeRoot = process.env.OPENSPEC_AUTOPILOT_CHANGE_ROOT
    const dirs = changeRoot ? candidateDirs(changeRoot) : []
    const denied = denyWrites(input, dirs)
    if (denied) process.stdout.write(`${JSON.stringify(denied)}\n`)
  }
  // 其他工具不在本 hook 的范围：不输出任何内容，交回默认流程。
}

try {
  main()
} catch (error) {
  // hook 失败时 onFailure 为 block（design D7）：写明原因，让 agent 停住而不是在没有回复时继续。
  process.stdout.write(`${JSON.stringify({
    permissionDecision: 'deny',
    permissionDecisionReason: `托管 hook 失败：${error.message}`,
  })}\n`)
}
