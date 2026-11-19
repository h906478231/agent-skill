/**
 * 运行前后核对：比较处理记录与签署字段（add-autopilot-loop design D5「运行前后核对」）。
 *
 * 所属：skill openspec-autopilot。调用方：scheduler.mjs。
 * 职责：拍快照、比较两次快照、给出不通过的项（文件、finding ID 或字段、运行前后的值）。
 * 边界：只读变更目录；不改任何文件，也不代替用户决定（评审 SEC-15、SEC-16）。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

/** 台账与 Findings 表的列名。 */
const LEDGER_STATUS = '状态'
const FINDINGS_STATUS = '闭环状态'
const FINDINGS_SEVERITY = '严重级别'

/** 视为「已接受」的闭环状态：新变成这些值时必须有对应的用户回复（design D5）。 */
const ACCEPTED_STATUS = new Set(['risk-accepted', 'false-positive'])

/** 视为「已接受」的 Sonar 处理值。 */
const ACCEPTED_SONAR = new Set(['误报', '接受'])

/** 严重级别的排序：降低时是不通过项（design D5）。 */
const SEVERITY_ORDER = ['Blocker', 'Major', 'Minor', 'Info']

/**
 * 读一个变更目录中的 Markdown 文件内容。
 * @param {string} file 文件路径。
 * @returns {string} 内容；文件不存在时为空串。
 */
function read(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 解析 Markdown 表格：返回每个表格的行（数组）与表头。
 * @param {string} text 文本。
 * @returns {{ header: string[], rows: string[][] }[]} 表格列表。
 */
export function parseTables(text) {
  const tables = []
  const lines = text.split('\n')
  let header = null
  let rows = []
  const flush = () => {
    if (header && rows.length) tables.push({ header, rows })
    header = null
    rows = []
  }
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) {
      flush()
      continue
    }
    const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
    if (cells.every(cell => /^:?-{2,}:?$/.test(cell))) continue
    if (!header) {
      header = cells
      continue
    }
    rows.push(cells)
  }
  flush()
  return tables
}

/**
 * 取一个区块的正文：从标题行到下一个同级或更高级标题。
 * @param {string} text 文本。
 * @param {string} title 标题文字。
 * @returns {string} 区块正文。
 */
function section(text, title) {
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.trim() === title)
  if (start < 0) return ''
  const body = []
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break
    body.push(line)
  }
  return body.join('\n')
}

/**
 * 拍处理记录快照（design D5「处理记录快照」，评审 ARCH-16、SEC-15）。
 * @param {string} changeDir 变更目录。
 * @returns {object} finding 状态映射与 Sonar 行映射。
 */
export function traceSnapshot(changeDir) {
  const findings = {}
  for (const file of ['review/standards.md', 'review/spec-fidelity.md']) {
    const text = read(path.join(changeDir, file))
    // 台账的状态与 Findings 表的闭环状态、严重级别都要记录：只看台账时 agent 改 Findings 表就能关掉一条 Blocker。
    for (const table of parseTables(section(text, '## Finding 台账'))) {
      const idAt = table.header.indexOf('ID')
      const statusAt = table.header.indexOf(LEDGER_STATUS)
      if (idAt < 0 || statusAt < 0) continue
      for (const row of table.rows) {
        const id = row[idAt]
        if (!id || !/^[A-Z]+-\d+$/.test(id)) continue
        findings[id] = { ...(findings[id] || {}), file, ledgerStatus: row[statusAt] }
      }
    }
    for (const table of parseTables(section(text, '## Findings'))) {
      const idAt = table.header.indexOf('ID')
      const statusAt = table.header.indexOf(FINDINGS_STATUS)
      const severityAt = table.header.indexOf(FINDINGS_SEVERITY)
      if (idAt < 0) continue
      for (const row of table.rows) {
        const id = row[idAt]
        if (!id || !/^[A-Z]+-\d+$/.test(id)) continue
        findings[id] = {
          ...(findings[id] || {}), file,
          findingsStatus: statusAt >= 0 ? row[statusAt] : null,
          severity: severityAt >= 0 ? row[severityAt] : null,
        }
      }
    }
  }
  const sonar = {}
  const sonarText = read(path.join(changeDir, 'review', 'sonar.md'))
  for (const [title, key] of [['## 本次修改行上的问题', 'rule'], ['## 质量门', 'condition']]) {
    for (const table of parseTables(section(sonarText, title))) {
      const keyAt = table.header.indexOf(key === 'rule' ? '规则' : '条件')
      const handleAt = table.header.indexOf('处理')
      const locationAt = table.header.indexOf('位置')
      if (keyAt < 0) continue
      for (const row of table.rows) {
        const name = row[keyAt]
        if (!name) continue
        // 问题行按「规则 + 位置」作键：只按规则作键时，同一规则的多行互相覆盖，共用一个回复（quality R1 SPEC-09）。
        const location = locationAt >= 0 ? row[locationAt] || '' : ''
        sonar[`${title}:${name}${location ? `@${location}` : ''}`] = {
          file: 'review/sonar.md',
          key: name,
          location,
          handling: handleAt >= 0 ? row[handleAt] : null,
        }
      }
    }
  }
  return { findings, sonar }
}

/**
 * 拍签署字段快照（design D5「签署字段快照」，评审 ARCH-17、SEC-16）。
 * @param {string} changeDir 变更目录。
 * @returns {object} 签字行、分镜签署行、变更终点区块与待环境补测确认人。
 */
export function signOffSnapshot(changeDir) {
  const signatures = {}
  const stories = {}
  const files = listMarkdown(changeDir)
  for (const rel of files) {
    const text = read(path.join(changeDir, rel))
    const lines = text.split('\n')
    for (const line of lines) {
      if (/^[-*>\s]*Technical Review Approved:/.test(line)) signatures[rel] = line.trim()
      if (/^[-*>\s]*Storyboard Approved:/.test(line)) stories[rel] = line.trim()
    }
  }
  const tasks = read(path.join(changeDir, 'tasks.md'))
  const changeHead = section(tasks, '## 变更终点')
  const confirmations = {}
  for (const rel of files.filter(item => item.startsWith('evidence/'))) {
    const text = read(path.join(changeDir, rel))
    for (const table of parseTables(section(text, '## 待环境补测'))) {
      const fingerprintAt = table.header.indexOf('登记指纹')
      const confirmerAt = table.header.indexOf('确认人')
      if (fingerprintAt < 0 || confirmerAt < 0) continue
      for (const row of table.rows) {
        const fingerprint = row[fingerprintAt]
        if (!fingerprint || !fingerprint.trim()) continue
        confirmations[`${rel}:${fingerprint}`] = { file: rel, fingerprint, confirmer: row[confirmerAt] }
      }
    }
  }
  return { signatures, stories, changeHead, confirmations }
}

/**
 * 列出变更目录中的 Markdown 文件（相对路径）。
 * @param {string} dir 目录。
 * @param {string} prefix 相对前缀。
 * @returns {string[]} 相对路径。
 */
function listMarkdown(dir, prefix = '') {
  if (!existsSync(dir)) return []
  const files = []
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, item.name)
    const rel = prefix ? `${prefix}/${item.name}` : item.name
    if (item.isDirectory()) files.push(...listMarkdown(child, rel))
    else if (item.name.endsWith('.md')) files.push(rel)
  }
  return files
}

/**
 * 找出与某个 finding 或 Sonar 行对应的提问决策回复（design D5「对上提问决策」，评审 SEC-18）。
 * @param {object} before 运行前的快照。
 * @param {object} decisions 决策列表。
 * @param {string} ownerOpenId 本人标识。
 * @param {string} key finding ID 或 Sonar 行名。
 * @param {string} option 对应的选项标签。
 * @param {string} [location] Sonar 问题行的位置（`文件:行号`）；给出时问题文本必须写出这个位置（quality R1 SPEC-09）。
 * @returns {{ matched: boolean, freeText: string|null }} 匹配结果与自填文本。
 */
function matchedAnswer(before, decisions, ownerOpenId, key, option, location = '') {
  for (const decision of decisions) {
    if (decision.status !== 'answered' && decision.status !== 'used') continue
    const answer = decision.answer || {}
    if (answer.operatorId !== ownerOpenId) continue
    const questions = (decision.request && decision.request.questions) || []
    for (const question of questions) {
      if (question.header !== key) continue
      if (location && !String(question.question || '').includes(location)) continue
      const selected = (answer.selected || {})[question.header]
      if (selected === option) return { matched: true, freeText: null }
      const text = (answer.text || {})[question.header]
      if (!selected && text) return { matched: false, freeText: text }
    }
  }
  return { matched: false, freeText: null }
}

/**
 * 比较处理记录的两次快照，给出不通过的项（design D5「处理记录快照」，评审 ARCH-16、SEC-15）。
 * @param {object} options before 与 after 的处理记录快照、decisions 决策列表、ownerOpenId 本人标识。
 * @returns {object[]} 不通过项。
 */
export function compareTrace({ before, after, decisions = [], ownerOpenId = '' }) {
  const failures = []

  // 新变成接受或误报时必须有对应的用户回复（design D5 情况 1）。
  for (const [id, item] of Object.entries(after.findings)) {
    const old = before.findings[id] || { file: item.file }
    const becameAccepted = (ACCEPTED_STATUS.has(item.ledgerStatus) && !ACCEPTED_STATUS.has(old.ledgerStatus))
      || (ACCEPTED_STATUS.has(item.findingsStatus) && !ACCEPTED_STATUS.has(old.findingsStatus))
    if (becameAccepted) {
      const matched = matchedAnswer(before, decisions, ownerOpenId, id, 'risk accepted')
      const matchedFp = matchedAnswer(before, decisions, ownerOpenId, id, '误报')
      if (!matched.matched && !matchedFp.matched) {
        failures.push({
          file: item.file,
          finding: id,
          field: LEDGER_STATUS,
          before: old.ledgerStatus || old.findingsStatus || 'open',
          after: item.ledgerStatus || item.findingsStatus,
          note: matched.freeText ? `只有自填文本：${matched.freeText}` : '没有对应的用户回复',
        })
      }
    }
    // 台账状态与 Findings 表闭环状态不同（design D5 情况 2）。
    if (item.ledgerStatus && item.findingsStatus && item.ledgerStatus !== item.findingsStatus) {
      failures.push({
        file: item.file,
        finding: id,
        field: '台账状态与闭环状态',
        before: old.ledgerStatus || '（无）',
        after: `${item.ledgerStatus} / ${item.findingsStatus}`,
      })
    }
    // 严重级别降低（design D5 情况 3）。
    if (item.severity && old.severity && old.severity !== item.severity) {
      const beforeAt = SEVERITY_ORDER.indexOf(old.severity)
      const afterAt = SEVERITY_ORDER.indexOf(item.severity)
      if (beforeAt >= 0 && afterAt > beforeAt) {
        failures.push({ file: item.file, finding: id, field: FINDINGS_SEVERITY, before: old.severity, after: item.severity })
      }
    }
  }
  // 运行前存在的 finding 消失（design D5 情况 4）：遍历运行前快照。被整行删除的 finding 不在运行后快照中，
  // 写在遍历运行后快照的循环里时这条判断永远不成立（quality R1 SPEC-09、STD-05）。
  for (const [id, old] of Object.entries(before.findings)) {
    const item = after.findings[id]
    if (!item || (!item.findingsStatus && !item.ledgerStatus)) {
      failures.push({ file: old.file, finding: id, field: 'finding', before: '存在', after: '消失' })
    }
  }

  // Sonar 行：新变成误报或接受时必须有对应的用户回复。
  for (const [key, item] of Object.entries(after.sonar)) {
    const old = before.sonar[key] || {}
    if (ACCEPTED_SONAR.has(item.handling) && !ACCEPTED_SONAR.has(old.handling)) {
      const matched = matchedAnswer(before, decisions, ownerOpenId, item.key, '接受', item.location)
      const matchedFp = matchedAnswer(before, decisions, ownerOpenId, item.key, '误报', item.location)
      if (!matched.matched && !matchedFp.matched) {
        failures.push({
          file: item.file,
          finding: sonarLabel(item),
          field: '处理',
          before: old.handling || '（无）',
          after: item.handling,
          note: matched.freeText ? `只有自填文本：${matched.freeText}` : '没有对应的用户回复',
        })
      }
    }
  }
  // 运行前存在的 Sonar 行消失：同样遍历运行前快照。
  for (const [key, old] of Object.entries(before.sonar)) {
    if (!after.sonar[key]) {
      failures.push({ file: old.file, finding: sonarLabel(old), field: 'Sonar 行', before: '存在', after: '消失' })
    }
  }
  return failures
}

/**
 * Sonar 行在不通过项中的名称：规则与位置，让用户能分出同一规则的多行。
 * @param {object} item Sonar 行快照。
 * @returns {string} 名称。
 */
function sonarLabel(item) {
  return item.location ? `${item.key} ${item.location}` : item.key
}

/**
 * 比较签署字段的两次快照，给出不通过的项（design D5「签署字段快照」，评审 ARCH-17、SEC-16）。
 * @param {object} options before 与 after 的签署字段快照。
 * @returns {object[]} 不通过项。
 */
export function compareSignOff({ before, after }) {
  const failures = []
  // 签字行、分镜签署行与变更终点区块变化时都不通过（design D5）。比较两侧键的并集：
  // 只遍历运行后快照时，被删除的签字行查不出来（quality R1 SPEC-09）。
  for (const [map, field] of [['signatures', 'Technical Review Approved'], ['stories', 'Storyboard Approved']]) {
    const beforeLines = before[map] || {}
    const afterLines = after[map] || {}
    for (const file of new Set([...Object.keys(beforeLines), ...Object.keys(afterLines)])) {
      if (beforeLines[file] !== afterLines[file]) {
        failures.push({ file, field, before: beforeLines[file] || '（无）', after: afterLines[file] || '（已删除）' })
      }
    }
  }
  if ((before.changeHead || '') !== (after.changeHead || '')) {
    failures.push({ file: 'tasks.md', field: '变更终点', before: '（原内容）', after: '（已变化）' })
  }
  // 待环境补测：确认人由空变成有值、已有值被修改、行被删除，或新增的行填了确认人时不通过；
  // 新增空确认人的行通过（design D5，quality R1 SPEC-09）。确认人是签署字段，只能由用户写。
  for (const [key, item] of Object.entries(after.confirmations || {})) {
    const old = (before.confirmations || {})[key]
    if (!old) {
      if ((item.confirmer || '').trim()) {
        failures.push({ file: item.file, finding: item.fingerprint, field: '确认人', before: '（新增行）', after: item.confirmer })
      }
      continue
    }
    if ((old.confirmer || '') !== (item.confirmer || '')) {
      failures.push({
        file: item.file, finding: item.fingerprint, field: '确认人',
        before: old.confirmer || '（空）', after: item.confirmer || '（空）',
      })
    }
  }
  for (const [key, item] of Object.entries(before.confirmations || {})) {
    if (!(after.confirmations || {})[key] && (item.confirmer || '').trim()) {
      failures.push({
        file: item.file, finding: item.fingerprint, field: '确认人', before: item.confirmer, after: '（行被删除）',
      })
    }
  }
  return failures
}
