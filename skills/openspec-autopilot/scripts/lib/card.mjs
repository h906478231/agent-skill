/**
 * 决策卡片与通知卡片（add-autopilot-loop design D9）。
 *
 * 所属：skill openspec-autopilot。调用方：scheduler.mjs、bridge.mjs。
 * 职责：生成 Card 2.0 的卡片内容、通过 lark-cli 发送、写出已记录与已失效卡片。
 * 边界：只生成内容与调用 lark-cli；不读决策文件、不做五项核对（那是 bridge.mjs 的职责）。
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runBounded } from './bounded-process.mjs'

/** 卡片协议版本（design D9）。 */
const SCHEMA = '2.0'

/**
 * 生成一张 Card 2.0 卡片。
 * @param {object} options 卡片内容：title 为标题，markdown 为正文，elements 为额外元素。
 * @returns {object} 卡片对象。
 */
export function buildCard({ title, markdown, elements = [] }) {
  return {
    schema: SCHEMA,
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title } },
    body: {
      elements: [
        { tag: 'markdown', content: markdown },
        ...elements,
      ],
    },
  }
}

/**
 * 生成通知卡片：写出规则与卡点，让用户在会话中处理（design D3、D9）。
 * @param {object} options title 为标题；lines 为正文行。
 * @returns {object} 卡片对象。
 */
export function noticeCard({ title, lines }) {
  return buildCard({ title, markdown: (lines || []).join('\n') })
}

/**
 * 把运行前后核对不通过的项写成卡片正文行：文件、finding 或签署字段、运行前后的值与说明（design D5，spec autopilot-scheduler 第 9 条）。
 * 用户要看到被改动的是哪一条记录，才能决定继续还是回会话处理（design 风险 R17）。
 * @param {object[]} failures 不通过项：file、finding、field、before、after、note。
 * @returns {string[]} 每项一行。
 */
export function checkFailureLines(failures) {
  return (failures || []).map(item => {
    const target = [item.file, item.finding, item.field].filter(Boolean).join(' ')
    const note = item.note ? `（${item.note}）` : ''
    return `- ${target}：${item.before} → ${item.after}${note}`
  })
}

/**
 * 把卡片内容写到临时文件，供 lark-cli 以 @文件 的方式读取。
 * @param {object} card 卡片对象。
 * @returns {string} 临时文件路径。
 */
function writeCardFile(card) {
  const dir = mkdtempSync(path.join(tmpdir(), 'autopilot-card-'))
  const file = path.join(dir, 'card.json')
  writeFileSync(file, `${JSON.stringify(card, null, 2)}\n`, { mode: 0o600 })
  return file
}

/**
 * 表单中各组件的名称。卡片与 bridge.mjs 都用这里的名称：两边各写一份时，桥接脚本按不存在的名称取值，
 * 多个问题的回复被记成同一个值（quality R1 SPEC-02）。名称只用字母、数字与下划线，按问题序号区分，
 * 不用问题文本：问题文本可能重复，也可能含飞书组件名不接受的字符。
 */
export const FORM_FIELDS = Object.freeze({
  /** 第 index 个问题（从 0 开始）的下拉选择。 */
  select: index => `q${index + 1}`,
  /** 第 index 个问题的「其他（自填）」输入框。 */
  text: index => `q${index + 1}_text`,
  /** 会话告警的说明输入框。 */
  note: 'note',
  /** 提问卡片的提交按钮。 */
  questionSubmit: 'autopilot-question',
})

/**
 * 生成回调按钮。卡片中的回调按钮都用这一种写法：按真实回调事件修正格式时只改这里（quality R2 STD-15）。
 * 回调值带决策号与变更名（design D9）。
 * @param {object} options name 为按钮名；label 为按钮文字；primary 为是否主按钮；value 为回调值。
 * @returns {object} 按钮元素。
 */
function callbackButton({ name, label, primary, value }) {
  return {
    tag: 'button',
    name,
    text: { tag: 'plain_text', content: label },
    type: primary ? 'primary' : 'default',
    behaviors: [{ type: 'callback', value }],
  }
}

/**
 * 生成表单内的提交按钮：回调按钮加 form_action_type，点按时随回调提交表单内的组件值。
 * @param {object} options 同 callbackButton。
 * @returns {object} 按钮元素。
 */
function submitButton(options) {
  return { ...callbackButton(options), form_action_type: 'submit' }
}

/**
 * 生成提问卡片：一律用一个表单，每个问题一个下拉选择与一个「其他（自填）」输入框（design D9）。
 * 问题文本与选项标签原样复制，不改写、不翻译。
 * @param {object} options title 为标题；questions 为提问数组；decisionId 为决策号；change 为变更名。
 * @returns {object} 卡片对象。
 */
export function questionCard({ title, questions, decisionId, change }) {
  const fields = []
  questions.forEach((question, index) => {
    const label = question.header || question.question || `问题 ${index + 1}`
    fields.push({
      tag: 'markdown',
      content: `**${label}**\n${question.question || ''}`,
    })
    fields.push({
      tag: question.multiSelect ? 'multi_select_static' : 'select_static',
      name: FORM_FIELDS.select(index),
      placeholder: { tag: 'plain_text', content: '请选择' },
      options: (question.options || []).map(option => ({
        text: { tag: 'plain_text', content: option.label },
        value: option.label,
      })),
    })
    fields.push({
      tag: 'input',
      name: FORM_FIELDS.text(index),
      placeholder: { tag: 'plain_text', content: '其他（自填）' },
    })
  })
  fields.push(submitButton({
    name: FORM_FIELDS.questionSubmit, label: '提交', primary: true, value: { d: decisionId, change },
  }))
  return {
    schema: SCHEMA,
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title } },
    // 表单容器：只有表单内的组件会随提交按钮回调 form_value（spec autopilot-decisions 第 4 条「one form」）。
    body: { elements: [{ tag: 'form', name: 'autopilot_form', elements: fields }] },
  }
}

/**
 * 生成会话告警卡片：一个输入框与两个提交按钮（design D9、D10，评审 ARCH-14）。
 * 运行前后核对不通过时列出每一项：用户看过被改动的记录才能决定继续还是回会话处理（spec autopilot-scheduler 第 9 条，quality R1 SPEC-03）。
 * @param {object} options title 为标题；options 为按钮标签；decisionId 为决策号；change 为变更名；
 *   text 为说明；checkFailures 为核对不通过的项。
 * @returns {object} 卡片对象。
 */
export function alertCard({ title, options: labels, decisionId, change, text, checkFailures = [] }) {
  const elements = []
  if (text) elements.push({ tag: 'markdown', content: text })
  if (checkFailures.length) elements.push({ tag: 'markdown', content: checkFailureLines(checkFailures).join('\n') })
  const fields = [{ tag: 'input', name: FORM_FIELDS.note, placeholder: { tag: 'plain_text', content: '补充说明' } }]
  // 两个按钮的名称不同，回调值也带 choice：两个按钮同名时桥接脚本分不出选择，回复永远记录不了（quality R1 SPEC-02）。
  for (const label of labels) {
    fields.push(submitButton({
      name: label, label, primary: label === '补充说明后继续', value: { d: decisionId, change, choice: label },
    }))
  }
  elements.push({ tag: 'form', name: 'autopilot_form', elements: fields })
  return {
    schema: SCHEMA,
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title } },
    body: { elements },
  }
}

/**
 * 列表区块：标题与每项一行；没有项目时不输出。
 * @param {string} title 区块标题。
 * @param {string[]} items 项目。
 * @returns {string[]} Markdown 行。
 */
function listSection(title, items) {
  return items && items.length ? [`**${title}**`, ...items.map(item => `- ${item}`)] : []
}

/**
 * 生成出口卡片（design D9、D11，任务 7.2）。出口与出口告警的按钮不放在表单里，回调值带 d 与 change（design D9）。
 * 提交与合并：写出分支、完整提交说明与文件清单；被忽略的文件、删除的文件、本变更 decisions/ 下的文件、
 * 不属于本变更的主规格各自单列（评审 CONC-10、ARCH-11）。推送：列出将推送的全部提交（评审 SEC-14）。
 * 出口告警：写出失败原因与三个选项（design D11「执行失败」）。
 * @param {object} options title 为标题；decision 为出口决策或出口告警；change 为变更名。
 * @returns {object} 卡片对象。
 */
export function exitCard({ title, decision, change }) {
  const request = decision.request || {}
  const lines = []
  if (decision.kind === 'exit-alert') {
    lines.push(`出口动作 ${request.exitAction} 执行失败：`, request.text || '')
  } else if (request.action === 'push') {
    lines.push(`分支：${request.branch || '（无）'}`, '远端：origin')
    lines.push(...listSection('将推送的提交', (request.commits || []).map(item => `${item.id} ${item.subject}`)))
  } else {
    if (request.commitOnBranch) lines.push(`提交已在分支上（${String(request.commitOnBranch).slice(0, 12)}），本次只合并。`)
    lines.push(`分支：${request.branch}`, '**提交说明**', '```', request.message || '', '```')
    const ignored = request.ignored || []
    const deleted = request.deleted || []
    const normal = (request.files || []).filter(file => !ignored.includes(file) && !deleted.includes(file))
    lines.push(...listSection('提交的文件', normal))
    lines.push(...listSection('被 git 忽略的文件（用 git add -f 加入）', ignored))
    lines.push(...listSection('删除的文件', deleted))
    lines.push(...listSection('托管结束后由用户提交', request.removed || []))
    lines.push(...listSection('不属于本变更，未列入', request.otherMainSpecs || []))
  }
  // 按钮名按序号命名：飞书组件名只接受字母、数字与下划线，选项标签放在回调值的 choice 中（quality R2 STD-15）。
  const buttons = (request.options || []).map((label, index) => callbackButton({
    name: `exit_${index + 1}`,
    label,
    primary: label !== '暂不处理' && label !== '回会话处理',
    value: { d: decision.id, change, choice: label },
  }))
  return buildCard({ title, markdown: lines.join('\n'), elements: buttons })
}

/**
 * 生成已记录卡片：显示用户的选择（design D9、D10）。
 * @param {object} options title 为标题；lines 为说明行。
 * @returns {object} 卡片对象。
 */
export function recordedCard({ title, lines }) {
  return buildCard({ title, markdown: [`已记录。`, ...(lines || [])].join('\n') })
}

/**
 * 生成已失效卡片：决策已作废（design D9、D10）。
 * @param {object} options title 为标题；text 为说明。
 * @returns {object} 卡片对象。
 */
export function expiredCard({ title, text }) {
  return buildCard({ title, markdown: text || '这条决策已失效。' })
}

/**
 * 通过 lark-cli 发送一张卡片。
 * @param {object} options larkBin 为 lark-cli 路径；ownerOpenId 为收卡人；card 为卡片对象；
 *   idempotencyKey 为幂等键；home 为托管目录（草稿文件写在那里）。
 * @returns {{ ok: boolean, messageId: string|null, reason: string|null }} 发送结果。
 */
function sendArguments({ ownerOpenId, idempotencyKey }, file) {
  return ['im', '+messages-send', '--as', 'bot', '--user-id', ownerOpenId,
    '--msg-type', 'interactive', '--content', `@${file}`, '--idempotency-key', idempotencyKey]
}

function sendResult(result) {
  if (result.status !== 0) return { ok: false, messageId: null, reason: result.error?.code || `lark-cli 退出码 ${result.status}` }
  let parsed
  try { parsed = JSON.parse(result.stdout) } catch { parsed = null }
  return { ok: true, messageId: parsed?.message_id || parsed?.data?.message_id || null, reason: null }
}

export function sendCard(options) {
  const { larkBin, card, timeout = 60_000 } = options
  const file = writeCardFile(card)
  try {
    return sendResult(spawnSync(larkBin, sendArguments(options, file), { encoding: 'utf8', timeout, killSignal: 'SIGKILL' }))
  } finally {
    rmSync(path.dirname(file), { recursive: true, force: true })
  }
}

/** 恢复时不等待超时的发送进程退出。调用方在预算到期后不写 messageId。 */
export async function sendRecoveryCard(options) {
  const { larkBin, card, timeout = 60_000 } = options
  const file = writeCardFile(card)
  try {
    return sendResult(await runBounded(larkBin, sendArguments(options, file), { timeout, maxBuffer: 1024 * 1024 }))
  } finally {
    rmSync(path.dirname(file), { recursive: true, force: true })
  }
}
