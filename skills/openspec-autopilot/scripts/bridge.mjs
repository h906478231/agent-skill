#!/usr/bin/env node
/**
 * 桥接脚本：接收飞书卡片点选，核对通过后写入回复并启动调度一轮。
 *
 * 所属：skill openspec-autopilot。调用方：launchd 常驻运行。
 * 输入：lark-cli 的事件输出（标准输出逐行 JSON）。输出：回复写入变更目录的决策文件，日志写在托管目录。
 * 退出码：0 正常退出；1 事件流停止或锁被占用；2 lark-cli 不能运行（design D10）。
 * 边界：只认用户本人的 operator_id；核对通过才写回复（design D10 的五项核对）。
 */

import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FORM_FIELDS, expiredCard, isMessageId, recordedCard } from './lib/card.mjs'
import { decisionFile, decisionsDir, readDecision, scanDecisions, transition } from './lib/decisions.mjs'
import { batchOf, enumerateBatches, withVerifiedBatch } from './lib/batch.mjs'
import { canonicalJson } from './lib/pending-trace.mjs'
import { appendLog, ensureHomeDir, homeDir, readConfig } from './lib/home.mjs'
import { acquireLock, currentBootTime, releaseLock } from './lib/lock.mjs'

/** 退出码：正常结束 / 事件流停止或锁被占用 / 命令不能运行。 */
const EXIT = Object.freeze({ OK: 0, STOPPED: 1, ERROR: 2 })

/** 本 skill 的目录。 */
const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 事件流停止标记：lark-cli 输出的就绪行。 */
const READY_MARKER = '[event] ready'

/** 写一条桥接日志。日志字段固定，不写回调 token 与表单值（design D2）。 */
const log = (event, fields) => appendLog('bridge', event, fields)

/**
 * 读出已处理的事件编号。
 * @returns {Set<string>} 事件编号集合。
 */
function processedEvents() {
  const file = path.join(homeDir(), 'events.jsonl')
  if (!existsSync(file)) return new Set()
  return new Set(readFileSync(file, 'utf8').split('\n').filter(Boolean))
}

/**
 * 记录一个已处理的事件编号。
 * @param {string} eventId 事件编号。
 */
function markEvent(eventId) {
  appendFileSync(path.join(ensureHomeDir(), 'events.jsonl'), `${eventId}\n`, { mode: 0o600 })
}

/**
 * 找出与 message_id 对应的待回复决策。
 * @param {object} config 托管配置。
 * @param {string} messageId 卡片消息号。
 * @returns {{ decision: object, changeDir: string }|null} 决策与变更目录。
 */
function findDecision(config, messageId) {
  // 与调度和恢复共用合法编号判据：不合法的编号不能证明卡片已送达，不按它对应回复（add-change-pause 评审 SEC-15）。
  if (!isMessageId(messageId)) return null
  let found = null
  for (const project of config.projects) {
    const changesDir = path.join(project.root, 'openspec', 'changes')
    const names = new Set(readdirSync(changesDir, { withFileTypes: true })
      .filter(item => item.name !== 'archive' && (item.isDirectory() || item.isSymbolicLink())).map(item => item.name))
    const archive = path.join(changesDir, 'archive')
    if (existsSync(archive)) {
      for (const item of readdirSync(archive)) {
        if (/^\d{4}-\d{2}-\d{2}-.+/.test(item)) names.add(item.slice(11))
      }
    }
    for (const name of names) {
      const { candidates } = enumerateBatches(project.root, name)
      for (const { directory, record, location } of candidates) {
        if (!record) continue
        const error = scanDecisions(decisionsDir(directory), decision => {
          if (decision.card?.messageId !== messageId) return
          if (found || (decision.batchStartedAt && decision.batchStartedAt !== record.startedAt)) {
            throw new Error('卡片决策归属不唯一或无法核验')
          }
          found = { decision, batch: batchOf(project, { change: name }, directory, record, location) }
        })
        if (error) throw new Error('无法完成卡片决策归属扫描')
      }
    }
  }
  return found
}

/**
 * 取事件的选择：回调值中的 choice（会话告警、出口与出口告警的按钮都带它），没有时取按钮名 action_name。
 * 先读回调值：按钮名要符合飞书组件名的规则，回调值原样带选项标签（quality R1 SPEC-02）。
 * @param {object} event 事件。
 * @returns {string} 选项标签。
 */
function selectionOf(event) {
  try {
    const parsed = JSON.parse(event.action_value || '{}')
    if (parsed.choice) return parsed.choice
  } catch {
    // 回调值不是 JSON：按按钮名取。
  }
  return event.action_name || ''
}

/**
 * 取表单中一个组件的值。多选下拉的值是数组，按 AskUserQuestion 多选回复的写法用「, 」连接。
 * @param {object} event 事件。
 * @param {string} name 组件名（card.mjs 的 FORM_FIELDS）。
 * @returns {string} 值；没有时为空串。
 */
function formValue(event, name) {
  const value = (event.form_value || {})[name]
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string').join(', ')
  return typeof value === 'string' ? value : ''
}

/**
 * 写决策的回复：按问题保存选中选项与自填文本（design D9、D10，评审 SEC-18）。
 * @param {object} decision 决策。
 * @param {object} event 事件。
 * @returns {{ ok: boolean, reason: string|null, answer: object|null }} 核对结果。
 */
function buildAnswer(decision, event) {
  const request = decision.request || {}
  const selection = selectionOf(event)
  if (decision.kind === 'alert') {
    const options = request.options || []
    if (!options.includes(selection)) return { ok: false, reason: `选择 ${selection} 不在选项中`, answer: null }
    const text = formValue(event, FORM_FIELDS.note)
    // 选择「补充说明后继续」时说明不能为空（design D10，评审 ARCH-14）。
    if (selection === '补充说明后继续' && !text.trim()) return { ok: false, reason: '补充说明后继续需要填写说明', answer: null }
    return {
      ok: true,
      reason: null,
      answer: { operatorId: event.operator_id, eventId: event.event_id, answeredAt: new Date().toISOString(), choice: selection, text },
    }
  }
  if (decision.kind === 'exit' || decision.kind === 'exit-alert') {
    const options = request.options || []
    if (!options.includes(selection)) return { ok: false, reason: `选择 ${selection} 不在选项中`, answer: null }
    return {
      ok: true,
      reason: null,
      answer: { operatorId: event.operator_id, eventId: event.event_id, answeredAt: new Date().toISOString(), choice: selection, text: '' },
    }
  }
  // 提问决策：每个问题要么有选项标签，要么有非空自填文本（design D10 第 5 项）。
  // 按问题序号读 card.mjs 生成的组件，每个问题只读自己的下拉选择与自填文本（quality R1 SPEC-02）。
  // answers 按问题原文作键：hook 原样填回 AskUserQuestion 的 answers；selected 与 text 按 header 作键：
  // 运行前后核对按 header 与 finding ID 完全相等匹配（design D5、D9）。
  const questions = request.questions || []
  const answers = {}
  const selected = {}
  const texts = {}
  let notes = ''
  for (const [index, question] of questions.entries()) {
    const header = question.header || question.question
    const key = question.question || header
    const options = (question.options || []).map(option => option.label)
    const chosen = formValue(event, FORM_FIELDS.select(index))
    const free = formValue(event, FORM_FIELDS.text(index))
    // 「回会话处理」是所有问题的通用选项：它表示用户在会话中处理（design D5）。
    const labels = chosen ? chosen.split(', ') : []
    if (labels.some(label => !options.includes(label) && label !== '回会话处理')) {
      return { ok: false, reason: `问题 ${header} 的选择不在选项中`, answer: null }
    }
    // 选了「回会话处理」时回复取该选项，自填文本只作说明（design D9）。
    if (chosen === '回会话处理') {
      answers[key] = chosen
      selected[header] = chosen
      if (free.trim()) {
        texts[header] = free
        if (!notes) notes = free
      }
      continue
    }
    // 自填文本不为空时它是该问题的回复（design D9），选中的选项仍保存在 selected 中。
    if (free.trim()) {
      answers[key] = free
      if (chosen) selected[header] = chosen
      texts[header] = free
      continue
    }
    if (chosen) {
      answers[key] = chosen
      selected[header] = chosen
      continue
    }
    return { ok: false, reason: `问题 ${header} 没有选择也没有自填文本`, answer: null }
  }
  const answer = {
    operatorId: event.operator_id, eventId: event.event_id, answeredAt: new Date().toISOString(),
    answers, selected, text: texts,
  }
  if (notes) answer.notes = notes
  return { ok: true, reason: null, answer }
}

/**
 * 用回调 token 把卡片更新为已记录或已失效（design D9、D10）。
 * 卡片内容只由 card.mjs 生成：这里写出 { title, lines } 时，飞书收到的不是卡片结构（quality R1 STD-03）。
 * @param {object} config 托管配置。
 * @param {string} token 回调 token。
 * @param {object} card card.mjs 的 recordedCard 或 expiredCard 生成的卡片。
 */
function updateCard(config, token, card) {
  if (!token) return
  const file = path.join(homeDir(), 'logs', 'card-update.json')
  mkdirSync(path.join(homeDir(), 'logs'), { recursive: true, mode: 0o700 })
  writeFileSync(file, `${JSON.stringify(card, null, 2)}\n`, { mode: 0o600 })
  spawnSync(config.larkBin, ['card', 'update', '--token', token, '--content', `@${file}`], { encoding: 'utf8' })
}

/**
 * 处理一个事件：五项核对通过后写入回复并启动调度（design D10）。
 * @param {object} config 托管配置。
 * @param {object} event 事件。
 * @param {Set<string>} processed 已处理的事件编号。
 */
function processEvent(config, event, processed) {
  const eventId = event.event_id
  if (typeof eventId !== 'string' || !eventId || /[\r\n]/.test(eventId)) throw new Error('事件编号无效')
  if (processed.has(eventId)) {
    log('event-repeated', { eventId })
    return false
  }
  if (event.operator_id !== config.ownerOpenId) {
    log('event-other-operator', { eventId })
    return true
  }
  const found = findDecision(config, event.message_id)
  if (!found) {
    log('event-unknown-decision', { eventId })
    return true
  }
  const { decision, batch } = found
  let callback = {}
  try { callback = JSON.parse(event.action_value || '{}') } catch { /* 继续按表单字段核对。 */ }
  if ((callback?.d && callback.d !== decision.id) || (callback?.change && callback.change !== batch.name)) {
    log('event-decision-mismatch', { eventId, decision: decision.id })
    return true
  }
  const disposition = withVerifiedBatch(batch, target => {
    const read = readDecision(target.directory, decision.id)
    if (!read.value || canonicalJson(decision) !== canonicalJson(read.value)) throw new Error('卡片决策已变化')
    if (decision.status === 'void') return { card: expiredCard({ title: '已失效' }) }
    if (['answered', 'used'].includes(decision.status)) {
      return { card: recordedCard({ title: '已记录', lines: ['这条决策已经记录。'] }) }
    }
    if (!['active', 'exiting'].includes(target.record.status)) {
      log('event-inactive-change', { eventId, decision: decision.id })
      return {}
    }
    const answer = buildAnswer(decision, event)
    if (!answer.ok) {
      log('event-invalid-selection', { eventId, decision: decision.id, reason: answer.reason })
      return {}
    }
    const written = transition(decisionFile(target.directory, decision.id), ['pending'], {
      status: 'answered', answer: answer.answer, batchStartedAt: batch.startedAt,
    })
    if (!written.ok) throw new Error('卡片回复写入失败')
    return { directory: target.directory, card: recordedCard({ title: '已记录',
      lines: [`选择：${answer.answer.choice || Object.values(answer.answer.answers || {}).join('、')}`] }) }
  })
  if (disposition.card) updateCard(config, event.token, disposition.card)
  if (disposition.directory) {
    log('event-recorded', { eventId, decision: decision.id })
    spawn(process.execPath, [path.join(SKILL_DIR, 'scripts', 'scheduler.mjs'), '--once'], {
      cwd: disposition.directory, detached: true, stdio: 'ignore',
    }).unref()
  }
  return true
}

function handleEvent(config, event, processed) {
  if (processEvent(config, event, processed)) {
    markEvent(event.event_id)
    processed.add(event.event_id)
  }
}

/** 主流程：取锁、启动事件消费、逐条处理事件。 */
function main() {
  let config
  try {
    config = readConfig()
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return EXIT.ERROR
  }
  // larkBin 不能执行时写日志并退出码 2（design D10）。
  const probe = spawnSync(config.larkBin, ['--version'], { encoding: 'utf8', timeout: 10000 })
  if (probe.error || probe.status === null) {
    log('lark-bin-missing', { larkBin: config.larkBin })
    process.stderr.write(`lark-cli 不能运行：${config.larkBin}\n`)
    return EXIT.ERROR
  }
  // 单实例：取不到锁时退出码 1，不启动 lark-cli（design D10，评审 CONC-01）。
  const lockFile = path.join(homeDir(), 'bridge.lock')
  const lock = acquireLock(lockFile, { pid: process.pid, bootTime: currentBootTime(), change: null, claudePid: null })
  if (!lock.ok) {
    log('bridge-lock-busy', { reason: lock.reason })
    return EXIT.STOPPED
  }
  const processed = processedEvents()
  const child = spawn(config.larkBin, ['event', 'consume', 'card.action.trigger', '--as', 'bot'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  // 保持标准输入打开：lark-cli 在标准输入关闭时退出（design D10）。
  child.stdin.on('error', () => {})
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line && line !== READY_MARKER) {
        try {
          handleEvent(config, JSON.parse(line), processed)
        } catch (error) {
          log('event-error', { error: error.message })
        }
      }
      index = buffer.indexOf('\n')
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => {
    for (const line of String(chunk).split('\n').filter(Boolean)) log('lark-stderr', { line: line.slice(0, 200) })
  })
  // lark-cli 退出时释放锁并以退出码 1 退出，由 launchd 重新启动（design D10）。
  child.on('exit', () => {
    releaseLock(lockFile)
    log('event-stream-stopped')
    process.exit(EXIT.STOPPED)
  })
  return null

}

const code = main()
if (code !== null) process.exitCode = code
