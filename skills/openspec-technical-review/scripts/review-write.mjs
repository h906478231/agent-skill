#!/usr/bin/env node
/** 技术评审产物的本机写入入口。只在最终复核和实际写入期间持有保护，不等待人工输入。 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, openSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { GIT_TREE_FINGERPRINT as FINGERPRINT, readVerifyFields } from './verify-report-fields.mjs'

const ROLES = ['architecture', 'concurrency', 'performance', 'database', 'security']
const ROLE_KEYS = { 架构: 'architecture', 并发: 'concurrency', 性能: 'performance', 数据库: 'database', 安全: 'security' }
const SUMMARY = 'review-summary.md'
const LOCK = '.review-write.lock'
const SYNC = 'archive-sync.md'
const MAIN_LOCK = '.main-spec-sync.lock'
const VERIFY = 'verification.md'
const GATE = fileURLToPath(new URL('./implementation-gate.mjs', import.meta.url))
const HASH = /^[0-9a-f]{64}$/
const SPEC_FILE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/spec\.md$/
const PENDING = '待完成的撤销'
const READY = 'READY_FOR_HUMAN_APPROVAL'
const BLOCKED = 'BLOCKED'
const LEDGER = 'Finding 台账'
const SEVERITIES = new Set(['Blocker', 'Major'])
const STATUSES = new Set(['open', 'closed', 'risk-accepted', 'false-positive', 'deferred'])
const HANDLED = new Set(['risk-accepted', 'false-positive', 'deferred'])
const ID = /^[A-Z]+-\d+$/
const DECISION = /^R\d+:[A-Z]+-\d+:[1-9]\d*$/
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const requireThat = (ok, reason) => { if (!ok) throw new Error(reason) }
// 项目仍支持没有 Object.hasOwn 的早期 Node 16。
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
const rolePath = role => `review/${role}.md`

/** 文件缺失是可核对的版本；链接、目录或不可读对象不是。 */
function contents(root, file) {
  const path = join(root, file)
  try {
    if (file.includes('/')) {
      const parts = file.split('/').slice(0, -1)
      let cursor = root
      for (const part of parts) {
        cursor = join(cursor, part)
        requireThat(lstatSync(cursor).isDirectory(), `不可读取目录：${file}`)
      }
    }
    requireThat(lstatSync(path).isFile(), `不是普通文件：${file}`)
    return readFileSync(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}
const text = (root, file) => contents(root, file)?.toString('utf8') ?? null
const hash = (root, file) => { const bytes = contents(root, file); return bytes === null ? null : digest(bytes) }

function identity(path) {
  const stat = lstatSync(path, { bigint: true })
  requireThat(stat.isDirectory(), `目录不存在或不是真实目录：${path}`)
  return { path, dev: String(stat.dev), ino: String(stat.ino) }
}
function active(path) {
  const isActive = target => basename(dirname(target)) === 'changes' &&
    basename(dirname(dirname(target))) === 'openspec' && basename(target) !== 'archive'
  const selected = join(realpathSync(dirname(path)), basename(path))
  requireThat(isActive(selected), '只对活跃变更操作')
  // 工作树可以链接到另一份活跃规划；保护绑定真实目录，不绑定链接本身。
  const target = realpathSync(selected)
  requireThat(isActive(target), '只对活跃变更操作')
  return identity(target)
}
function same(left, right) {
  if (left === right) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key => hasOwn(right, key) && same(left[key], right[key]))
}
function specPaths(root, rel = 'specs') {
  let entries
  try {
    requireThat(lstatSync(join(root, rel)).isDirectory(), `增量规格目录不可核对：${rel}`)
    entries = readdirSync(join(root, rel), { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  return entries.flatMap(entry => {
    const path = `${rel}/${entry.name}`
    if (entry.isDirectory()) return specPaths(root, path)
    requireThat(entry.isFile(), `增量规格不是普通文件：${path}`)
    return [path]
  }).sort()
}
/** 按评审规则排除首次实施基线及顶层勾选，不处理围栏内的示例。 */
function taskContent(text) {
  if (text === null) return null
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  let fence = null
  let heading = false
  let first = false
  return digest(lines.flatMap(line => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length) fence = null
      return [line]
    }
    if (marker) { fence = marker; return [line] }
    if (!heading && /^# [^\n]/.test(line)) { heading = true; first = true; return [line] }
    if (first && line.trim()) {
      first = false
      if (/^基线任务数：\d+（\d{4}-\d{2}-\d{2} 首次 apply）(?:\r?\n)?$/.test(line)) return []
    }
    return [line.replace(/^- \[x\] /, '- [ ] ')]
  }).join(''))
}
function snapshot(path) {
  const directory = active(path)
  const root = directory.path
  const tasks = contents(root, 'tasks.md')
  const planning = Object.fromEntries(['proposal.md', 'design.md', ...specPaths(root)].map(file => [file, hash(root, file)]))
  planning['tasks.md'] = tasks === null ? null : digest(tasks)
  const reports = Object.fromEntries([SUMMARY, ...ROLES.map(rolePath), 'verification.md'].map(file => [file, hash(root, file)]))
  return { directory, planning, reports, taskContent: taskContent(tasks?.toString('utf8') ?? null) }
}

/** 保护随目录移动时，从目标释放；不按时间或进程号接手别人的保护。 */
function underLock(path, name, action) {
  const before = identity(path)
  let root = path
  let lock = join(root, name)
  try { mkdirSync(lock, { mode: 0o700 }) } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`写入保护被占用：${lock}`)
    throw error
  }
  const owner = join(lock, 'owner')
  const token = `${process.pid} ${randomUUID()}\n`
  let fd
  try {
    fd = openSync(owner, 'wx', 0o600)
    writeFileSync(fd, token)
    closeSync(fd)
  } catch (error) {
    // 只有独占打开成功才能清理标记；清理错误不能盖住初始化的原始错误。
    const cleanup = action => {
      try { action() } catch (cleanupError) { process.stderr.write(`清理写入保护失败：${cleanupError.message}\n`) }
    }
    if (fd !== undefined) {
      cleanup(() => closeSync(fd))
      cleanup(() => unlinkSync(owner))
    }
    cleanup(() => rmdirSync(lock))
    throw error
  }
  try {
    requireThat(same(identity(path), before), '取得保护时目录实例已变化')
    return action(target => { root = target; lock = join(root, name) })
  } finally {
    requireThat(readFileSync(join(lock, 'owner'), 'utf8') === token, '无法确认当前保护的持有者')
    unlinkSync(join(lock, 'owner'))
    rmdirSync(lock)
  }
}

/** 同目录原子替换；临时文件归当前进程，不产生候选快照。 */
function atomic(root, file, body) {
  const target = join(root, file)
  const tmp = `${target}.tmp.${randomUUID()}`
  try {
    writeFileSync(tmp, body, { flag: 'wx', mode: 0o600 })
    renameSync(tmp, target)
  } finally {
    try { unlinkSync(tmp) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

const numberedHeader = line => line.replace(/^##\s+(?:\d+\.\s*)?/, '').trim()
/** 只认明确的二级节，保留行而不拆分叙述正文；标题示例不能充当实际报告。 */
function section(body, matches) {
  const lines = (body || '').split('\n')
  let start = -1
  let end = lines.length
  let fence = null
  for (let i = 0; i < lines.length; i++) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(lines[i])?.[1]
    if (fence) { if (marker?.[0] === fence[0] && marker.length >= fence.length) fence = null; continue }
    if (marker) { fence = marker; continue }
    if (!/^#{1,2}\s/.test(lines[i])) continue
    if (start !== -1) { end = i; break }
    if (/^##\s/.test(lines[i]) && matches(numberedHeader(lines[i]))) start = i
  }
  return { lines, start, end, body: start === -1 ? '' : lines.slice(start + 1, end).join('\n') }
}
const cells = line => line.trim().slice(1, -1).split(/(?<!\\)\|/).map(cell => cell.trim().replace(/^`([^`]*)`$/, '$1'))
const tableRows = body => (body || '').split('\n').filter(line => /^\s*\|.*\|\s*$/.test(line)).map(line => ({ line, cells: cells(line) }))
function idRows(body, title) {
  const part = section(body, h => h === title)
  const byId = new Map()
  for (const row of tableRows(part.body)) {
    const id = row.cells[0]
    if (!ID.test(id)) continue
    requireThat(!byId.has(id), `重复 ID：${id}`)
    byId.set(id, row)
  }
  return { part, byId }
}
function roleData(body) {
  const findings = idRows(body, 'Findings')
  const ledger = idRows(body, LEDGER)
  const records = section(body, h => h === '处理记录')
  const legacyOrigins = new Map()
  // 仅从处理记录的前导区读取迁移时绑定的原标识，不读历史发现正文里的同名字段。
  for (const [, decision, id] of records.body.split(/^###\s/m, 1)[0].matchAll(/^- 旧决定标识：(R\d+:([A-Z]+-\d+):1)$/gm)) {
    requireThat(!legacyOrigins.has(id), `重复的旧决定标识：${id}`)
    legacyOrigins.set(id, decision)
  }
  const history = new Map()
  for (const found of records.body.matchAll(/^### ([A-Z]+-\d+) · (R\d+:[A-Z]+-\d+:\d+)[ \t]*\n([\s\S]*?)(?=^### |$(?![\s\S]))/gm)) {
    const [, id, decision, block] = found
    requireThat(!history.has(decision) && decision.split(':')[1] === id, `重复或不匹配的决定：${decision}`)
    const original = tableRows(block).find(row => row.cells[0] === id && row.cells.length >= 9)
    // 撤销标记不能作为继续使用旧决定的依据，只有同一记录中的三项留痕齐全才能完成恢复。
    const lines = block.split('\n')
    const withdrawalFields = ['撤销人', '撤销原因', '撤销日期'].map(key => {
      const prefix = `- ${key}：`
      return lines.filter(line => line.startsWith(prefix)).map(line => line.slice(prefix.length).trim())
    })
    const withdrawn = withdrawalFields.some(fields => fields.length > 0)
    const withdrawalComplete = withdrawalFields.every(fields => fields.length === 1 && fields[0])
    history.set(decision, { id, block, original, withdrawn, withdrawalComplete })
  }
  return { findings, ledger, records, history, legacyOrigins }
}

function checkLedger(role, before, after) {
  const old = roleData(before)
  const next = roleData(after)
  requireThat(next.ledger.part.start !== -1 && next.findings.part.start !== -1, `${role} 缺少台账或 Findings`)
  // 原标识只由写入入口在首次迁移时按旧报告生成，之后原样沿用；候选不得改号、删除或补造。
  const origins = migratedOrigins(before, old) ?? old.legacyOrigins
  requireThat(same(Object.fromEntries(origins), Object.fromEntries(next.legacyOrigins)), `${role} 候选改动了旧决定标识`)
  const oldLedger = old.ledger.part.start !== -1 ? old.ledger.byId : new Map([...old.findings.byId].filter(([, r]) => SEVERITIES.has(r.cells[1]) && (!r.cells[9] || r.cells[9] === 'open')))
  for (const [id, row] of oldLedger) {
    const updated = next.ledger.byId.get(id)
    requireThat(updated, `${role} 台账缺少旧 ID：${id}`)
    if (old.ledger.part.start !== -1) requireThat(row.cells[2] === updated.cells[2], `${role} 首次轮次变化：${id}`)
  }
  for (const [id, row] of next.ledger.byId) {
    const [, level, round, status, handledRound, basis] = row.cells
    requireThat(row.cells.length === 6 && SEVERITIES.has(level) && /^R\d+$/.test(round) && STATUSES.has(status), `${role} 台账格式不符：${id}`)
    const finding = next.findings.byId.get(id)
    if (status === 'open') requireThat(finding?.cells[1] === level && (!finding.cells[9] || finding.cells[9] === 'open'), `${role} 开放台账与 Findings 不符：${id}`)
    else requireThat(!finding && /^R\d+$/.test(handledRound) && basis, `${role} 台账处理依据缺失或仍列在 Findings：${id}`)
    const priorFinding = old.findings.byId.get(id)
    const previous = old.ledger.byId.get(id)
    const openBefore = priorFinding && (!priorFinding.cells[9] || priorFinding.cells[9] === 'open')
    const changedDecision = !previous || !same(previous.cells.slice(3), row.cells.slice(3))
    if ((status === 'closed' || HANDLED.has(status)) && (changedDecision || openBefore)) {
      // 因前提变化重开时旧决定可能未标撤销；只有本次新增的同 ID 记录能作为处理依据。
      const latest = [...next.history].filter(([, record]) => record.id === id).pop()
      const [decision, current] = latest ?? []
      const value = key => current?.block.split('\n').find(line => line.startsWith(`- ${key}：`))?.split('：').slice(1).join('：').trim()
      const narrowed = status === 'closed' && /^范围收窄 #\d+\b/u.test(basis)
      const required = ['决定人与日期', '来源', '理由', ...(status !== 'false-positive' ? ['捡起条件'] : []), ...(status === 'deferred' ? ['去向'] : [])]
      const matchesBasis = status === 'closed'
        ? narrowed ? value('处理方式') === '收窄范围' && value('闭环依据') === basis && required.every(key => value(key))
          : value('闭环依据') === basis
        : decision === basis && value('处理方式') === status && required.every(key => value(key))
      requireThat(decision && !old.history.has(decision) && !current.withdrawn && decision.startsWith(`${handledRound}:`) &&
        current.original?.cells.slice(0, 9).every(Boolean) && current.original.cells[1] === level &&
        (!openBefore || same(current.original.cells.slice(0, 9), priorFinding.cells.slice(0, 9))) &&
        matchesBasis, `${role} 缺少本次决定的完整原发现或留痕：${id}`)
    } else if (openBefore && priorFinding.cells[1] === 'Blocker' && level !== 'Blocker') {
      requireThat(false, `${role} 旧开放发现缺少完整原发现或同 ID 处理依据：${id}`)
    }
  }
  // 尚未迁移的具名决定仍是撤销依据，不能在发布时漏掉或改写。
  const legacyIds = new Set(Array.from((before ?? '').matchAll(LEGACY_HANDLING), match => match[2]))
  const retainedLegacy = new Set()
  for (const id of legacyIds) {
    const prior = legacyHandling(before, old, id)
    if (!prior) continue
    const kept = legacyHandling(after, next, id)
    requireThat(kept?.quote === prior.quote && old.findings.byId.get(id)?.line === next.findings.byId.get(id)?.line,
      `${role} 候选丢失旧处理记录或原发现：${id}`)
    if (prior.historicalRow) retainedLegacy.add(id)
  }
  for (const [id, row] of old.findings.byId) {
    // 旧闭环行只保留原文，不把它迁进新台账或当作可撤销的决定。
    if (row.cells[9] !== 'closed' || !completeFinding(row) || old.ledger.byId.has(id) ||
      [...old.history.values()].some(record => record.id === id)) continue
    requireThat(next.findings.byId.get(id)?.line === row.line && !next.ledger.byId.has(id) &&
      ![...next.history.values()].some(record => record.id === id), `${role} 候选丢失或改写旧闭环记录：${id}`)
    retainedLegacy.add(id)
  }
  for (const [id, row] of next.findings.byId) {
    // 逐条迁移时只沿用旧报告原有的已处理行，不能新增或改写。
    if (retainedLegacy.has(id)) continue
    requireThat((SEVERITIES.has(row.cells[1]) && next.ledger.byId.has(id)) || row.cells[1] === 'Minor', `${role} Findings 缺少台账：${id}`)
    requireThat(!row.cells[9] || row.cells[9] === 'open', `${role} Findings 只列开放条目：${id}`)
  }
  for (const [decision, record] of old.history) {
    const candidate = next.history.get(decision)
    requireThat(candidate?.block.trim().startsWith(record.block.trim()), `${role} 候选丢失原发现或处理记录：${record.id} ${decision}`)
  }
}

function verdict(body) {
  const line = body?.split('\n').filter(line => /^[-*>\s]*Gate-Verdict[:：]/.test(line)).pop()
  return line?.split(/Gate-Verdict[:：]/).pop()?.match(/[A-Za-z_]+/)?.[0] ?? null
}
function blockedSummary(body) {
  const existing = body || '# 技术评审汇总\n\nGate-Verdict: BLOCKED\nTechnical Review Approved: __________\n'
  const lines = existing.split('\n')
  const index = lines.reduce((last, line, i) => /^[-*>\s]*Gate-Verdict[:：]/.test(line) ? i : last, -1)
  if (index !== -1) lines[index] = 'Gate-Verdict: BLOCKED'
  else {
    const approval = lines.findIndex(line => /^[-*>\s]*Technical Review Approved:/.test(line))
    lines.splice(approval < 0 ? lines.length : approval, 0, 'Gate-Verdict: BLOCKED')
  }
  const block = section(lines.join('\n'), h => h === '门禁裁决')
  if (block.start !== -1) {
    const revised = block.body.replaceAll(READY, BLOCKED)
    block.lines.splice(block.start + 1, block.end - block.start - 1, ...revised.split('\n'))
    return block.lines.join('\n')
  }
  return lines.join('\n')
}
function pendingRows(body) {
  const part = section(body, h => h === PENDING)
  const rows = tableRows(part.body).filter(({ cells: [id] }) => id !== 'finding ID' && !/^:?-+:?$/.test(id))
  requireThat(rows.length || !part.body.trim() || /^(?:无[。.]?|(?:\|[^\n]+\|\s*)+)$/u.test(part.body.trim()), '待完成撤销记录不可核对')
  for (const { cells: [id, decision, role] } of rows) requireThat(ID.test(id) && DECISION.test(decision) && decision.split(':')[1] === id && ROLES.includes(role), '待完成撤销记录不可核对')
  return rows
}
function setPending(body, update) {
  const part = section(body, h => h === PENDING)
  const old = pendingRows(body).map(row => row.cells)
  const rows = update(old)
  const block = rows.length ? [`## ${PENDING}`, '', '| finding ID | 原决定标识 | 维度 |', '|---|---|---|', ...rows.map(row => `| ${row.join(' | ')} |`), ''] : []
  if (part.start !== -1) part.lines.splice(part.start, part.end - part.start, ...block)
  else if (block.length) {
    const approval = part.lines.findIndex(line => /^##\s.*人工确认/.test(line))
    const key = part.lines.findIndex(line => /^[-*>\s]*Gate-Verdict[:：]/.test(line))
    if (approval >= 0) part.lines.splice(approval, 0, ...block)
    else part.lines.splice(key, 0, ...block, '## 人工确认区', '')
  }
  return part.lines.join('\n')
}
function conditionSection(body) { return section(body, h => h.includes('有条件通过') && h.includes('条件清单')) }
function conditionRows(body) {
  const { body: list } = conditionSection(body)
  const rows = tableRows(list)
  const header = rows.find(row => row.cells.includes('状态'))?.cells ?? []
  // 只有完整的旧五列表头适用旧规则；新版缺少来源不得降级。
  const legacy = same(header, ['条件ID', '来源维度', '条件内容', '对应任务或行号', '状态'])
  return rows.filter(row => row.cells[0] !== '条件ID' && !/^:?-+:?$/.test(row.cells[0])).map(row => ({
    ...row, legacy: legacy && row.cells.length === 5, id: row.cells[0], finding: row.cells[header.indexOf('来源 finding ID')], role: ROLE_KEYS[row.cells[header.indexOf('来源维度')]] ?? row.cells[header.indexOf('来源维度')],
    status: row.cells[header.indexOf('状态')], location: row.cells[header.indexOf('对应任务或行号')],
    wording: row.cells[header.indexOf('条件内容')],
  }))
}
function resetConditions(body, id) {
  const part = conditionSection(body)
  const numbers = tableRows(part.body).find(row => row.cells.includes('状态'))?.cells ?? []
  if (!numbers.length) return body
  for (const row of conditionRows(body).filter(row => row.finding === id)) {
    row.cells[numbers.indexOf('状态')] = '待处理'
    row.cells[numbers.indexOf('对应任务或行号')] = ''
    const i = part.lines.indexOf(row.line, part.start)
    part.lines[i] = `| ${row.cells.join(' | ')} |`
  }
  return part.lines.join('\n')
}
function roleList(roles) {
  requireThat(Array.isArray(roles) && roles.length && new Set(roles).size === roles.length && roles.every(role => ROLES.includes(role)), '纳入维度不可核对')
  return roles
}
function publish(root, request) {
  const body = text(root, SUMMARY)
  const roles = roleList(request.roles)
  const reports = request.reports ?? {}
  const planning = request.planning ?? {}
  requireThat(Object.keys(reports).every(role => roles.includes(role)), '候选含未纳入的报告')
  requireThat(Object.keys(planning).every(file => ['proposal.md', 'design.md', 'tasks.md'].includes(file) || /^specs\/[A-Za-z0-9._-]+\/spec\.md$/.test(file) && !file.split('/').includes('..')), '候选含非规划文件')
  requireThat(Object.entries(planning).every(([file, value]) => typeof value === 'string' ||
    value === null && file.startsWith('specs/') && HASH.test(request.expected?.planning?.[file] ?? '')) &&
    Object.values(reports).every(value => typeof value === 'string'), '候选正文必须为文本，或用 null 删除已核对的增量规格')
  requireThat(typeof request.summary === 'string' && [READY, BLOCKED].includes(verdict(request.summary)), '候选裁决无效')
  if (signed(request.summary)) requireThat(approvalLine(request.summary) === approvalLine(body), '候选不能填写或修改人工签字')
  const before = pendingRows(body)
  requireThat(same(before.map(row => row.cells), pendingRows(request.summary).map(row => row.cells)), '普通写入必须保留全部待完成的撤销')
  requireThat(!before.length || verdict(request.summary) === BLOCKED, '存在待完成的撤销，不能发布可签字裁决')
  const written = {}
  try {
    for (const role of roles) {
      const previous = text(root, rolePath(role))
      let proposed = reports[role] ?? previous
      requireThat(typeof proposed === 'string', `缺少维度报告：${role}`)
      if (hasOwn(reports, role)) {
        // 旧报告首次迁入台账时，由写入入口按旧报告补写原标识；候选自带的标识仍须与之一致。
        const origins = migratedOrigins(previous, roleData(previous))
        if (origins?.size && !roleData(proposed).legacyOrigins.size) proposed = withOrigins(proposed, origins)
        written[role] = proposed
      }
      if (hasOwn(reports, role) || section(proposed, h => h === LEDGER).start !== -1) checkLedger(role, previous, proposed)
      if (verdict(request.summary) === READY) {
        const open = [...roleData(proposed).findings.byId.values()].find(row => row.cells[1] === 'Blocker' && (!row.cells[9] || row.cells[9] === 'open'))
        requireThat(!open, `${role} 有开放 Blocker：${open?.cells[0]}`)
      }
    }
  } catch (error) {
    if (verdict(body) !== BLOCKED) atomic(root, SUMMARY, blockedSummary(body))
    throw error
  }
  // 先确认阻断版本已发布；以下任一个写入失败，最后的可签字版本都不会写出。
  atomic(root, SUMMARY, blockedSummary(body))
  for (const [role, candidate] of Object.entries(written)) atomic(root, rolePath(role), candidate)
  for (const [path, candidate] of Object.entries(planning)) {
    if (candidate === null) {
      unlinkSync(join(root, path))
      continue
    }
    if (path.startsWith('specs/')) {
      const base = join(root, 'specs')
      for (const dir of [base, dirname(join(root, path))]) {
        try { mkdirSync(dir) } catch (error) { if (error.code !== 'EEXIST') throw error }
        requireThat(lstatSync(dir).isDirectory(), '规格目录不是普通目录')
      }
    }
    atomic(root, path, candidate)
  }
  if (verdict(request.summary) === READY && (/^定稿轮：R\d+\s*$/m.test(request.summary) || conditionSection(request.summary).start !== -1)) checkConditionAdmission(root, request.summary)
  atomic(root, SUMMARY, request.summary)
  return { verdict: verdict(request.summary) }
}

function reviewDimensions(body) {
  const table = section(body, h => h === '各维度结论一览表')
  if (table.start === -1) return { table, rows: [], included: null }
  const rows = tableRows(table.body).filter(row => row.cells[0] !== '维度' && !/^:?-+:?$/.test(row.cells[0])).map(row => {
    const label = /^\[([^\]]+)\]\(review\/[a-z]+\.md\)$/.exec(row.cells[0])?.[1] ?? row.cells[0]
    const role = ROLE_KEYS[label] ?? label
    requireThat(ROLES.includes(role) && row.cells.length >= 2, '纳入维度不可核对')
    return { ...row, role }
  })
  requireThat(new Set(rows.map(row => row.role)).size === rows.length, '纳入维度不可核对')
  const included = roleList(rows.filter(row => ![row.cells[1], row.cells[5]].some(cell => /^(?:不适用|未纳入)(?:$|[：:；;（(\s])/.test(cell ?? ''))).map(row => row.role))
  return { table, rows, included }
}

/** 撤销后以当前角色报告重算开放项，不沿用撤销前的计数和清单。 */
function recoverySummary(root, body, roles) {
  const { table: dimensionTable, rows: dimensions, included } = reviewDimensions(body)
  if (included) requireThat(same([...included].sort(), [...roles].sort()), '无法按全部纳入维度重算')
  const risks = []
  const impacts = new Map()
  const totals = { Blocker: 0, Major: 0, Minor: 0 }
  const returned = []
  for (const role of roles) {
    const report = text(root, rolePath(role))
    const { findings } = roleData(report)
    requireThat(report && findings.part.start !== -1, `无法重算维度：${role}`)
    const counts = { Blocker: 0, Major: 0, Minor: 0 }
    for (const row of findings.byId.values()) {
      const grade = row.cells[1]
      if (row.cells[9] && row.cells[9] !== 'open') continue
      requireThat(['Blocker', 'Major', 'Minor'].includes(grade), `无法核对严重级别：${role} ${row.cells[0]}`)
      counts[grade]++
      totals[grade]++
      risks.push(row.line)
      const feature = row.cells[2]
      const impact = impacts.get(feature) ?? { Blocker: 0, Major: 0, Minor: 0, ids: [] }
      impact[grade]++
      impact.ids.push(row.cells[0])
      impacts.set(feature, impact)
    }
    const row = dimensions.find(item => item.role === role)
    // 撤销只重算计数，不核销角色报告中的打回；历史报告缺结论时保留汇总原有的打回。
    const label = Object.keys(ROLE_KEYS).find(key => ROLE_KEYS[key] === role)
    const conclusionPart = section(report, h => [`${label}评审结论`, '评审结论'].some(title =>
      ['打回', '有条件通过', '通过'].some(value => h === `${title}：${value}` || h === `${title}: ${value}`)))
    const roleConclusion = conclusionPart.start === -1 ? row?.cells[1] : numberedHeader(conclusionPart.lines[conclusionPart.start]).split(/[:：]/).pop().trim()
    if (roleConclusion === '打回') {
      const why = conclusionPart.body.trim().split('\n').find(line => line.trim())?.trim()
      returned.push(`- ${label}维度仍为打回（见 [维度报告](${rolePath(role)})）。${why ?? ''}`)
    }
    if (row) {
      const conclusion = counts.Blocker || roleConclusion === '打回' ? '打回' : counts.Major || roleConclusion === '有条件通过' ? '有条件通过' : '通过'
      const updated = [row.cells[0], conclusion, counts.Blocker, counts.Major, counts.Minor, ...row.cells.slice(5)]
      dimensionTable.lines[dimensionTable.lines.indexOf(row.line, dimensionTable.start)] = `| ${updated.join(' | ')} |`
    }
  }
  // 开放 Major 仍须经过条件处理；清除一条撤销记录不能替代重签。
  body = dimensionTable.lines.join('\n')
  const replaceSection = (matches, contents) => {
    const part = section(body, matches)
    if (part.start !== -1) part.lines.splice(part.start + 1, part.end - part.start - 1, '', ...contents, '')
    else {
      const approval = part.lines.findIndex(line => /^##\s.*人工确认/.test(line))
      part.lines.splice(approval < 0 ? part.lines.length : approval, 0, ...contents, '')
    }
    body = part.lines.join('\n')
  }
  const reasons = []
  if (totals.Blocker) reasons.push('仍有开放 Blocker')
  if (totals.Major) reasons.push('开放 Major 待条件处理')
  if (pendingRows(body).length) reasons.push('仍有待完成的撤销')
  if (returned.length) reasons.push('仍有维度打回')
  replaceSection(h => h === '门禁裁决', [
    `**\`${BLOCKED}\`**。开放 Blocker：${totals.Blocker}；Major：${totals.Major}；Minor：${totals.Minor}。${reasons.length ? `${reasons.join('；')}。` : ''}`,
    ...(returned.length ? ['', ...returned] : []),
  ])
  if (section(body, h => h === '业务影响地图').start !== -1) {
    replaceSection(h => h === '业务影响地图', [
      '| 业务功能 | Blocker 数 | Major 数 | Minor 数 | 主要风险 |', '|---|---|---|---|---|',
      ...[...impacts].map(([feature, row]) => `| ${feature.replaceAll('|', '\\|')} | ${row.Blocker} | ${row.Major} | ${row.Minor} | ${row.ids.join('、')} |`),
    ])
  }
  const risksTitle = '已确认风险详细清单'
  const riskTable = ['| ID | 严重级别 | 影响业务功能 | 位置 | 涉及代码模块 | 一句话白话 | 触发场景 | 不修的后果 | 建议修复 | 闭环状态 |', '|---|---|---|---|---|---|---|---|---|---|', ...risks]
  replaceSection(h => h === risksTitle, [...(section(body, h => h === risksTitle).start === -1 ? [`## ${risksTitle}`, ''] : []), ...riskTable])
  return body
}

// 旧报告用引用块保存具名的接受或驳回，不含新式决定标识。
const LEGACY_HANDLING = /^>\s*\*\*(risk accepted|驳回)\*\*[:：]\s*([A-Z]+-\d+)[ \t]*\n((?:^>[^\n]*\n?)*)/gm

const completeFinding = row => row?.cells.length === 10 && row.cells.slice(0, 9).every(Boolean) &&
  (SEVERITIES.has(row.cells[1]) || row.cells[1] === 'Minor')

/** 兼容同一报告逐条迁移，只读取尚无新式处理记录的旧具名决定。 */
function legacyHandling(report, data, id) {
  if (!report || data.ledger.byId.has(id) || [...data.history.values()].some(record => record.id === id)) return null
  const matches = [...report.matchAll(LEGACY_HANDLING)]
    .filter(match => match[2] === id)
  if (matches.length !== 1) return null
  const [quote, action, , body] = matches[0]
  const status = action === '驳回' ? 'false-positive' : 'risk-accepted'
  const named = action === '驳回' ? /驳回人[:：]\s*\S[^\n]*日期[:：]\s*\d{4}-\d{2}-\d{2}/ : /接受人[:：]\s*\S[^\n]*日期[:：]\s*\d{4}-\d{2}-\d{2}/
  const row = data.findings.byId.get(id)
  if (!named.test(body) || (row && row.cells[9] !== status)) return null
  const historicalRow = completeFinding(row) ? row : null
  return { status, quote: quote.trimEnd(), historicalRow, row: historicalRow && SEVERITIES.has(row.cells[1]) ? row : null }
}

const legacyReportRound = report => /^# [^\n]*?\b(R\d+)\b/m.exec(report)?.[1]

/**
 * 旧具名决定所在二级处理节写明的轮次，是逐条可核对的原决定来源，不受一级标题后来改写的影响。
 * 返回该轮次；节标题列出多个轮次时返回 false（不可核对）；没有这类节标题时返回 null。
 */
function headingRound(report, id) {
  const found = [...report.matchAll(LEGACY_HANDLING)].filter(match => match[2] === id)
  if (found.length !== 1) return false
  let fence = null
  let heading = ''
  for (const line of report.slice(0, found[0].index).split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) { if (marker?.[0] === fence[0] && marker.length >= fence.length) fence = null; continue }
    if (marker) { fence = marker; continue }
    if (/^#{1,2}\s/.test(line)) heading = line
  }
  // 只认处理节，避免把「上轮闭环验证（R3）」这类节标题当作决定轮次。
  if (!/^##\s/.test(heading) || !/接受|驳回|误报|处理/.test(heading)) return null
  const rounds = new Set(heading.match(/\bR\d+\b/g) ?? [])
  return rounds.size === 1 ? [...rounds][0] : rounds.size ? false : null
}

/**
 * 首次迁移前（无台账、无新式决定、无原标识）为每条旧具名决定生成原标识。
 * 来源依次为所在处理节写明的轮次、首轮报告；不能核对的决定不写，也不借用其他决定的轮次。
 * 已迁移的报告返回 null，此后只沿用已写入的标识。
 */
function migratedOrigins(report, data) {
  if (!report || data.ledger.part.start !== -1 || data.history.size || data.legacyOrigins.size) return null
  const origins = new Map()
  for (const id of new Set(Array.from(report.matchAll(LEGACY_HANDLING), match => match[2]))) {
    if (!legacyHandling(report, data, id)) continue
    const heading = headingRound(report, id)
    const round = heading === null ? (legacyReportRound(report) === 'R1' ? 'R1' : null) : heading
    if (round) origins.set(id, `${round}:${id}:1`)
  }
  return origins
}

/** 把原标识写在处理记录的前导区（第一条新式决定之前）；没有该节时新建。 */
function withOrigins(report, origins) {
  const lines = [...origins.values()].map(decision => `- 旧决定标识：${decision}`)
  if (!lines.length) return report
  const records = section(report, h => h === '处理记录')
  if (records.start === -1) return `${report.trimEnd()}\n\n## 处理记录\n\n${lines.join('\n')}\n`
  records.lines.splice(records.start + 1, 0, '', ...lines)
  return records.lines.join('\n')
}

function legacyDecision(report, data, id, decision, started) {
  if (!decision.endsWith(':1')) return null
  const legacy = legacyHandling(report, data, id)
  if (!legacy || legacy.historicalRow?.cells[1] === 'Minor') return null
  const bound = data.legacyOrigins.get(id)
  if (bound) return bound === decision ? legacy : null
  // 已混合新旧格式时，不用当前报告轮次为旧决定补号。中断后可沿用已绑定的待完成记录。
  if (started) return legacy
  requireThat(data.ledger.part.start === -1 && !data.history.size, `缺少可核对的旧决定原轮次：${id}`)
  // 处理节写明的轮次优先于一级标题；两者都没有时沿用原规则，不拒绝无轮次的旧报告。
  const heading = headingRound(report, id)
  if (heading === false) return null
  const round = heading ?? legacyReportRound(report)
  return !round || round === decision.split(':')[0] ? legacy : null
}

function restoreLegacy(reportBefore, data, legacy, { id, decision, actor, reason, date }) {
  const { part, byId } = data.findings
  const original = legacy.row.cells.slice(0, 9).concat('open')
  part.lines[part.lines.indexOf(legacy.row.line, part.start)] = `| ${original.join(' | ')} |`
  const first = decision.split(':')[0]
  const ledgerRow = (key, grade) => `| ${key} | ${grade} | ${first} | open | | |`
  let report = part.lines.join('\n').trimEnd()
  if (data.ledger.part.start === -1) {
    // 旧开放项沿用首次迁移的规则；其他已处理项不在这次撤销中推定决定标识或轮次。
    const open = [...byId.values()].filter(item => SEVERITIES.has(item.cells[1]) && (!item.cells[9] || item.cells[9] === 'open'))
    report += `\n\n## ${LEDGER}\n\n| ID | 严重级别 | 首次轮次 | 状态 | 处理轮次 | 处理依据 |\n|---|---|---|---|---|---|\n` +
      [ledgerRow(id, original[1]), ...open.map(item => ledgerRow(...item.cells.slice(0, 2)))].join('\n')
  } else {
    const ledger = section(report, h => h === LEDGER)
    let last = ledger.end - 1
    while (last > ledger.start && !/^\s*\|.*\|\s*$/.test(ledger.lines[last])) last--
    requireThat(last > ledger.start, '台账缺少表格')
    ledger.lines.splice(last + 1, 0, ledgerRow(id, original[1]))
    report = ledger.lines.join('\n')
  }
  const record = `### ${id} · ${decision}\n\n- 处理方式：${legacy.status}\n\n${legacy.quote}\n\n| ${original.join(' | ')} |\n\n- 撤销人：${actor}\n- 撤销原因：${reason}\n- 撤销日期：${date}`
  // 首次迁移时为其余旧决定按各自来源写原标识，不论处理记录节是否已存在。
  const origins = new Map([...(migratedOrigins(reportBefore, data) ?? [])].filter(([key]) => key !== id))
  const records = section(report, h => h === '处理记录')
  if (records.start === -1) {
    const preface = [...origins.values()].map(key => `- 旧决定标识：${key}\n`).join('')
    return `${report.trimEnd()}\n\n## 处理记录\n\n${preface ? `${preface}\n` : ''}${record}\n`
  }
  const updated = section(withOrigins(report, origins), h => h === '处理记录')
  updated.lines.splice(updated.end, 0, '', record, '')
  return updated.lines.join('\n')
}

function withdraw(root, request, recovery = false) {
  const { role, id, decision, actor, reason, date } = request
  requireThat(ROLES.includes(role) && ID.test(id) && DECISION.test(decision) && decision.split(':')[1] === id, '撤销的维度、ID 或原决定不匹配')
  const body = text(root, SUMMARY)
  const file = rolePath(role)
  const report = text(root, file)
  requireThat(body && report, '缺少评审汇总或维度报告')
  const pending = pendingRows(body)
  const matches = row => same(row, [id, decision, role])
  const started = pending.some(row => matches(row.cells))
  const before = roleData(report)
  const original = before.history.get(decision)
  const ledger = before.ledger.byId.get(id)
  const legacy = !ledger && !recovery ? legacyDecision(report, before, id, decision, started) : null
  requireThat(ledger || legacy, `台账或可核对的旧处理记录缺少 ${id}`)
  if (recovery) {
    roleList(request.roles)
    const restored = before.findings.byId.get(id)?.cells
    requireThat(started && original?.withdrawalComplete && original.original && ledger.cells[3] === 'open' &&
      restored?.[9] === 'open' && ledger.cells[1] === restored[1] &&
      same(restored.slice(0, 9), original.original.cells.slice(0, 9)) &&
      conditionRows(body).filter(row => row.finding === id).every(row => row.status === '待处理' && !row.location), `撤销恢复依据不符：${id} ${decision}`)
    requireThat(request.roles.includes(role), '无法按全部纳入维度重算')
    const remaining = setPending(blockedSummary(body), rows => rows.filter(row => !matches(row)))
    atomic(root, SUMMARY, recoverySummary(root, remaining, request.roles))
    return { verdict: BLOCKED, recovered: id }
  }
  requireThat(started || legacy || (HANDLED.has(ledger.cells[3]) && ledger.cells[5] === decision && !original?.withdrawn), '原决定已变化或不属于当前处理')
  requireThat(!legacy || !pending.some(row => row.cells[0] === id && !matches(row.cells)), '该 finding 已在撤销另一项决定')
  requireThat([actor, reason, date].every(value => typeof value === 'string' && value.trim() && !/[\r\n]/.test(value)), '缺少撤销人、原因或日期')
  if (!started) {
    // 原批准只留作历史。清空发生在撤销，不让后续发布沿用已经失效的批准。
    const lines = blockedSummary(body).split('\n')
    const oldApproval = lines.filter(line => /^[-*>\s]*Technical Review Approved:/.test(line)).pop()
    if (oldApproval && oldApproval.trim() !== 'Technical Review Approved: __________') {
      const index = lines.lastIndexOf(oldApproval)
      lines.splice(index, 1, `旧批准（仅供追溯）：${oldApproval.trim()}`, 'Technical Review Approved: __________')
    }
    const next = setPending(resetConditions(lines.join('\n'), id), rows => [...rows, [id, decision, role]])
    atomic(root, SUMMARY, next)
  }
  if (legacy) {
    requireThat(legacy.row, `缺少完整原发现：${id} ${decision}，保留待完成撤销`)
    atomic(root, file, restoreLegacy(report, before, legacy, request))
    return { verdict: BLOCKED, pending: id }
  }
  requireThat(original?.original, `缺少完整原发现：${id} ${decision}，保留待完成撤销`)
  if (!original.withdrawn) {
    const found = section(report, h => h === 'Findings')
    requireThat(found.start !== -1, `缺少 Findings：${id}`)
    const row = original.original.cells.slice(0, 9).concat('open')
    const after = report.replace(ledger.line, `| ${[id, row[1], ledger.cells[2], 'open', '', ''].join(' | ')} |`)
    const parts = section(after, h => h === 'Findings')
    let lastRow = parts.end - 1
    while (lastRow > parts.start && !/^\s*\|.*\|\s*$/.test(parts.lines[lastRow])) lastRow--
    requireThat(lastRow > parts.start, 'Findings 缺少表格')
    parts.lines.splice(lastRow + 1, 0, `| ${row.join(' | ')} |`)
    const record = section(parts.lines.join('\n'), h => h === '处理记录')
    const index = record.lines.indexOf(`### ${id} · ${decision}`, record.start + 1)
    requireThat(index > record.start && index < record.end, '原决定没有对应的处理记录')
    let end = index + 1
    while (end < record.end && !/^###\s/.test(record.lines[end])) end++
    while (end > index + 1 && !record.lines[end - 1].trim()) end--
    record.lines.splice(end, 0, '', `- 撤销人：${actor}`, `- 撤销原因：${reason}`, `- 撤销日期：${date}`, '')
    const next = record.lines.join('\n')
    atomic(root, file, next)
  }
  return { verdict: BLOCKED, pending: id }
}

const approvalLine = body => body?.split('\n').filter(line => /^[-*>\s]*Technical Review Approved:/.test(line)).pop()
function signed(body) {
  const key = 'Technical Review Approved:'
  const last = approvalLine(body)
  const value = last?.slice(last.lastIndexOf(key) + key.length).split('签署人')[0].replace(/\s/g, '')
  return Boolean(value && !/^[_＿]+$|^(?:__|＿＿)|<签名>|＜签名＞/.test(value))
}
function currentHandling(root, row) {
  const input = row.location?.match(/^review\/([a-z]+)\.md(?::[1-9]\d*)?$/)
  if (!input || !ROLES.includes(input[1]) || row.role !== input[1] || !ID.test(row.finding)) return null
  const report = roleData(text(root, rolePath(input[1])))
  const ledger = report.ledger.byId.get(row.finding)
  const latest = [...report.history].filter(([, record]) => record.id === row.finding).pop()
  if (!latest || latest[1].withdrawn || !latest[1].original || ledger?.cells[3] !== row.status || ledger.cells[5] !== latest[0]) return null
  if (!latest[1].block.split('\n').some(line => line.trim() === `- 处理方式：${row.status}`)) return null
  return { path: rolePath(input[1]), decision: latest[0], hash: digest(latest[1].block) }
}
function writtenCondition(root, row, checked = false) {
  if (!row.location) return false
  const ref = /^((?:proposal|design|tasks)\.md|specs\/[A-Za-z0-9._-]+\/spec\.md):([1-9]\d*)$/.exec(row.location)
  if (ref && !ref[1].split('/').includes('..')) {
    const line = text(root, ref[1])?.split('\n')[Number(ref[2]) - 1]
    return Boolean(line?.trim())
  }
  const task = /^(?:任务\s*)?([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s|$)/.exec(row.location)?.[1]
  const tasks = text(root, 'tasks.md')?.split('\n') ?? []
  return Boolean(task && tasks.some(line => {
    const match = /^- \[([ x])\] ([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s|$)/.exec(line)
    return match?.[2] === task && (!checked || match[1] === 'x')
  }))
}
function checkReviewed(root, body) {
  requireThat(!pendingRows(body).length, '有待完成的撤销：' + pendingRows(body).map(row => row.cells[0]).join('、'))
  requireThat(verdict(body) === READY || (verdict(body) === null && /READY_FOR_HUMAN_APPROVAL/.test(section(body, h => h === '门禁裁决').body)), '技术评审裁决不允许进入下一阶段')
  requireThat(signed(body), '缺少有效人工签字')
}
function checkConditionAdmission(root, body) {
  const list = conditionSection(body)
  const rows = conditionRows(body)
  requireThat(rows.length || !list.body.trim() || /^无(?:[。.]|$)/u.test(list.body.trim()), '评审条件清单不可核对；先完成条件处理')
  const seen = new Set()
  for (const row of rows) {
    const hasWording = row.id && !seen.has(row.id) && row.wording?.trim() && ROLES.includes(row.role)
    const resolved = row.legacy ? legacyCondition(root, row) : ID.test(row.finding) && (row.status === '已写入' && writtenCondition(root, row) || HANDLED.has(row.status) && currentHandling(root, row))
    requireThat(hasWording && resolved, `评审条件 ${row.id} 待处理或无可核对的落点；先完成条件处理，再用 /opsx:update 写入`)
    seen.add(row.id)
  }
}
function checkAdmission(root) {
  const body = text(root, SUMMARY)
  checkReviewed(root, body)
  if (/^定稿轮：R\d+\s*$/m.test(body)) checkConditionAdmission(root, body)
  return { admitted: true }
}
function sameAdmission(before, now) {
  if (!before) return false
  if (same(before, now)) return true
  return before.taskContent !== null && before.taskContent === now.taskContent &&
    same({ ...before, planning: { ...before.planning, 'tasks.md': now.planning['tasks.md'] } }, now)
}

function gateFacts(root, repo) {
  requireThat(typeof repo === 'string' && repo.length, '须明确指定实现仓')
  try {
    const result = JSON.parse(execFileSync(process.execPath, [GATE, 'facts', root, '--repo', repo], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
    // 活跃规划已在保护内按目录实例核对；这里仅验证所选实现仓的指纹。
    requireThat(FINGERPRINT.test(result.verification?.expectedFingerprint ?? ''), '缺少所选实现仓指纹')
    return result
  } catch (error) {
    throw new Error(`无法核对验证范围或实现指纹：${error.stderr?.trim() || error.message}`)
  }
}
function legacyCondition(root, row, checked = false) {
  return ['', '待实现', '待修改', '已写入', '已闭环'].includes(row.status ?? '') && writtenCondition(root, row, checked)
}
function evaluatedConditions(root) {
  const summary = text(root, SUMMARY)
  const finalized = /^定稿轮：R\d+\s*$/m.test(summary ?? '')
  const seen = new Set()
  return conditionRows(summary).map(row => {
    requireThat(row.id && !seen.has(row.id), '条件 ID 缺失或重复')
    seen.add(row.id)
    const status = row.status ?? ''
    const handling = HANDLED.has(status) ? currentHandling(root, row) : null
    // 无定稿轮的旧五列表按已完成的落点判断；新版仍须核对来源和状态。
    const current = Boolean(row.legacy ? ROLES.includes(row.role) && row.wording?.trim() &&
        (finalized ? legacyCondition(root, row, true) : writtenCondition(root, row, true))
      : ID.test(row.finding) && ROLES.includes(row.role) && row.wording?.trim() &&
        (HANDLED.has(status) ? handling : status === '已写入' && writtenCondition(root, row, true)))
    return { id: row.id, role: row.role ?? '', finding: row.finding ?? '', wording: row.wording ?? '',
      location: row.location ?? '', status, handling, current }
  })
}
const conditionKey = 'Review-Conditions-SHA256'
const conditionDigest = conditions => digest(JSON.stringify(conditions))
function validateConditionResults(conditions, results, pass) {
  const byId = new Map()
  for (const item of results ?? []) {
    requireThat(typeof item.id === 'string' && typeof item.closed === 'boolean' && !byId.has(item.id), 'verify 条件结果不可核对')
    byId.set(item.id, item)
  }
  requireThat(byId.size === conditions.length, 'verify 条件结果不完整')
  for (const condition of conditions) {
    const item = byId.get(condition.id)
    requireThat(item && (!item.closed || condition.current) && (!condition.handling || same(item.handling, condition.handling)), `verify 条件依据不匹配：${condition.id}`)
    requireThat(!pass || item.closed, `verify 报告仍有开放条件：${condition.id}`)
  }
}
function publishVerify(root, request) {
  const { report, fingerprint } = request
  const expected = gateFacts(root, request.repo).verification.expectedFingerprint
  requireThat(typeof report === 'string', 'verify 报告必须为文本')
  const fields = readVerifyFields(report)
  requireThat(FINGERPRINT.test(fingerprint) && expected === fingerprint && fields.fingerprint === fingerprint, '实现指纹与 verify 核对版本不匹配')
  requireThat(fields.verdict && /^\d+$/.test(fields.countValue ?? '') && Number.isSafeInteger(fields.criticalCount) &&
    (fields.verdict !== 'PASS' || fields.criticalCount === 0), 'verify 报告结论字段或计数无效')
  requireThat(!report.includes(conditionKey), 'verify 报告的条件依据字段由写入入口生成')
  const conditions = evaluatedConditions(root)
  validateConditionResults(conditions, request.conditions, fields.verdict === 'PASS')
  atomic(root, VERIFY, `${report.trimEnd()}\n\n- ${conditionKey}: ${conditionDigest(conditions)}\n`)
  return { published: true }
}
function directory(path) {
  try { mkdirSync(path) } catch (error) { if (error.code !== 'EEXIST') throw error }
  identity(path)
}
function archiveTarget(root, raw) {
  const parent = join(dirname(root), 'archive')
  requireThat(typeof raw === 'string' && basename(dirname(resolve(raw))) === 'archive' && realpathSync(dirname(dirname(resolve(raw)))) === dirname(root) &&
    /^\d{4}-\d{2}-\d{2}-/.test(basename(raw)) && basename(raw).slice(11) === basename(root), '归档目标必须是当前变更对应的归档路径')
  directory(parent)
  const target = join(parent, basename(raw))
  try { lstatSync(target); throw new Error('归档目标已存在') } catch (error) { if (error.code !== 'ENOENT') throw error }
  return target
}
function deltaHashes(root) {
  return Object.fromEntries(specPaths(root).map(file => [file, hash(root, file)]))
}
function validateSync(root, sync) {
  requireThat(sync && ['sync', 'skip', 'not-needed'].includes(sync.choice), '缺本次同步选择')
  if (sync.choice === 'skip') requireThat(typeof sync.reason === 'string' && sync.reason.trim(), '跳过同步需要理由')
  if (sync.choice !== 'sync') return { choice: sync.choice, reason: sync.reason ?? '', state: sync.choice }
  requireThat(same(sync.delta, deltaHashes(root)), '已确认的增量规格版本已变化')
  validateFiles(sync.files)
  requireThat(Object.keys(sync.files).every(file => hasOwn(sync.delta, `specs/${file}`)), '同步目标不属于本次增量规格')
  return { choice: 'sync', state: 'pending', delta: sync.delta, files: sync.files }
}
function validateFiles(files) {
  requireThat(files && typeof files === 'object' && !Array.isArray(files) && Object.keys(files).length, '没有可核对的主规格修改')
  for (const [file, item] of Object.entries(files)) {
    requireThat(SPEC_FILE.test(file) && item && (item.before === null || HASH.test(item.before)) && typeof item.content === 'string' &&
      HASH.test(item.target) && digest(item.content) === item.target, `主规格版本或候选正文不可核对：${file}`)
  }
}
function writeSyncRecord(root, sync) {
  atomic(root, SYNC, '# 归档主规格同步\n\n' + `- 状态：${sync.state}\n\n` + '```json\n' + JSON.stringify(sync, null, 2) + '\n```\n')
}
function archiveChange(root, request, moved) {
  const summary = text(root, SUMMARY)
  if (summary !== null) checkReviewed(root, summary)
  requireThat(![...idRows(summary, '已确认风险详细清单').byId.values()].some(row => row.cells[1] === 'Blocker' && (!row.cells[9] || row.cells[9] === 'open')), '技术评审仍有开放 Blocker')
  // 旧汇总没有范围表时保留原核对口径；当前汇总只核对本轮纳入的报告。
  const { included } = reviewDimensions(summary)
  for (const role of included ?? ROLES) {
    const report = text(root, rolePath(role))
    if (included) requireThat(report !== null, `缺少本轮维度报告：${role}`)
    if ([...roleData(report).findings.byId.values()].some(row => row.cells[1] === 'Blocker' && (!row.cells[9] || row.cells[9] === 'open'))) {
      requireThat(false, `${role} 仍有开放 Blocker`)
    }
  }
  const report = text(root, VERIFY)
  const facts = gateFacts(root, request.repo)
  requireThat(facts.verification.fingerprint, 'verify 报告指纹缺失或无法读取；重跑 verify 和归档前置校验')
  requireThat(facts.verification.current === true, '实现指纹与 verify 报告不匹配；重跑 verify 和归档前置校验')
  requireThat(facts.verification.legacy || (facts.verification.verdict === 'PASS' && facts.verification.criticalCount === 0), 'verify 报告未通过')
  const conditions = evaluatedConditions(root)
  requireThat(conditions.every(row => row.current), '当前评审条件未闭环：' + conditions.filter(row => !row.current).map(row => row.id).join('、'))
  const saved = new RegExp(`^- ${conditionKey}: ([0-9a-f]{64})$`, 'm').exec(report)?.[1]
  requireThat((!conditions.length && !saved) || saved === conditionDigest(conditions), '当前评审条件或处理记录与 verify 报告不匹配；重跑 verify')
  const target = archiveTarget(root, request.target)
  const sync = validateSync(root, request.sync)
  if (sync.choice !== 'not-needed' || contents(root, SYNC) !== null) writeSyncRecord(root, sync)
  renameSync(root, target)
  moved(target)
  return { archived: target, sync: sync.state }
}
function archived(path) {
  const parent = realpathSync(dirname(path))
  requireThat(basename(parent) === 'archive' && basename(dirname(parent)) === 'changes' && basename(dirname(dirname(parent))) === 'openspec' &&
    /^\d{4}-\d{2}-\d{2}-.+$/.test(basename(path)), '续办只接受已归档变更目录')
  return identity(join(parent, basename(path))).path
}
function syncRecord(root) {
  const body = text(root, SYNC)
  const match = /\n```json\n([\s\S]+?)\n```\n?$/.exec(body ?? '')
  requireThat(match, '没有可核对的归档同步记录')
  const record = JSON.parse(match[1])
  requireThat(record.choice === 'sync' && ['pending', 'synced'].includes(record.state), '本次归档没有同步授权')
  return validateSync(root, record)
}
function writeMain(mainRoot, files) {
  validateFiles(files)
  const conflicts = Object.entries(files).filter(([path, item]) => ![item.before, item.target].includes(hash(mainRoot, path))).map(([path]) => path)
  requireThat(!conflicts.length, '主规格版本已变化，须重新确认：' + conflicts.join('、'))
  for (const [path, item] of Object.entries(files)) {
    const now = hash(mainRoot, path)
    if (now === item.target) continue
    requireThat(now === item.before, `主规格写入前版本已变化：${path}`)
    directory(dirname(join(mainRoot, path)))
    atomic(mainRoot, path, item.content)
    requireThat(hash(mainRoot, path) === item.target, `主规格写入结果不可核对：${path}`)
  }
  requireThat(Object.entries(files).every(([path, item]) => hash(mainRoot, path) === item.target), '主规格尚未全部达到目标版本')
}
function syncMain(path, verb, request) {
  let root
  if (verb === 'resume-sync') root = archived(path)
  else root = active(path).path
  if (verb === 'resume-sync') {
    try { lstatSync(join(root, LOCK)); throw new Error('归档写入保护尚未释放，保留待补同步') } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const changes = dirname(verb === 'resume-sync' ? dirname(root) : root)
  const mainRoot = join(dirname(changes), 'specs')
  directory(mainRoot)
  return underLock(mainRoot, MAIN_LOCK, () => {
    if (verb === 'sync') {
      requireThat(same(request.delta, deltaHashes(root)), '已确认的增量规格版本已变化')
      requireThat(request.files && Object.keys(request.files).every(file => hasOwn(request.delta ?? {}, `specs/${file}`)), '主规格不属于本次增量规格')
      writeMain(mainRoot, request.files)
      return { sync: 'synced' }
    }
    let record = syncRecord(root)
    if (request.replacement) {
      requireThat(request.expectedRecord === hash(root, SYNC), '归档同步记录版本已变化，须重新确认')
      const updated = validateSync(root, request.replacement)
      requireThat(updated.choice === 'sync', '续办须有同步确认')
      requireThat(Object.entries(updated.files).every(([file, item]) => [item.before, item.target].includes(hash(mainRoot, file))), '重新确认的主规格版本已变化')
      writeSyncRecord(root, updated)
      record = updated
    }
    writeMain(mainRoot, record.files)
    writeSyncRecord(root, { ...record, state: 'synced' })
    return { sync: 'synced' }
  })
}

function main() {
  const [verb, raw] = process.argv.slice(2)
  requireThat(raw && ['snapshot', 'publish', 'withdraw', 'recover', 'admit', 'verify', 'archive', 'sync', 'resume-sync'].includes(verb), '用法：node review-write.mjs <snapshot|publish|withdraw|recover|admit|verify|archive|sync|resume-sync> <changeRoot>（请求由 stdin 传入 JSON）')
  const path = resolve(raw)
  if (verb === 'snapshot') return snapshot(path)
  const request = JSON.parse(readFileSync(0, 'utf8'))
  if (verb === 'sync' || verb === 'resume-sync') return syncMain(path, verb, request)
  const { path: root } = active(path)
  return underLock(root, LOCK, moved => {
    const current = snapshot(path)
    requireThat(current.directory.path === root, '取得保护时规划目录链接已变化')
    const versionsMatch = verb === 'admit' ? sameAdmission(request.expected, current) : same(current, request.expected)
    requireThat(versionsMatch, '活跃目录、规划或报告版本已变化，拒绝旧候选')
    if (verb === 'admit') return checkAdmission(root)
    if (verb === 'verify') return publishVerify(root, request)
    if (verb === 'archive') return archiveChange(root, request, moved)
    if (verb === 'publish') return publish(root, request)
    return withdraw(root, request, verb === 'recover')
  })
}

try {
  process.stdout.write(`${JSON.stringify(main())}\n`)
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
