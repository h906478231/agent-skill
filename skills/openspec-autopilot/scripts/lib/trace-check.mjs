/**
 * 托管运行前后核对（fix-autopilot-minor-findings D2、D3）。
 * 门禁负责读取规划产物。调度脚本通过本模块比较两份快照并定位需要用户处理的差异。
 */

import { spawnSync } from 'node:child_process'
import { runBounded } from './bounded-process.mjs'

export const TRACE_VERSION = 1
const TRACE_TIMEOUT_MS = 60_000
const TRACE_MAX_BUFFER = 64 * 1024 * 1024
const ACCEPTED_OPTION = new Map([
  ['risk-accepted', 'risk accepted'], ['false-positive', '误报'], ['接受', '接受'], ['误报', '误报'],
])
const SEVERITY = ['', 'Minor', 'Major', 'Blocker']
const REVIEW_FILES = ['review/standards.md', 'review/spec-fidelity.md']
const SIGN_OFF_KEYS = ['approval', 'storyboard', 'changeHead', 'pendingEnvironment']

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isString = value => typeof value === 'string'
const stringList = value => Array.isArray(value) && value.every(isString)
const stringMap = value => isObject(value) && Object.values(value).every(isString)
const isCount = value => Number.isSafeInteger(value) && value >= 0
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

/** 校验门禁输出的版本与字段。已保存的当前版本快照沿用同一个读法。 */
export function validTrace(value) {
  if (!isObject(value) || value.traceVersion !== TRACE_VERSION) return false
  if (value.resumedDecisionIds !== undefined && !stringList(value.resumedDecisionIds)) return false
  const { findings, sonar, slices, rulesVersion, signOff } = value
  if (!Array.isArray(findings) || !findings.every(row => isObject(row) && REVIEW_FILES.includes(row.file)
    && isString(row.id) && isString(row.status) && (row.source === 'ledger'
      || (row.source === 'findings' && isString(row.severity) && typeof row.openBlocker === 'boolean')))) return false
  if (!Array.isArray(sonar) || !sonar.every(row => isObject(row)
    && [row.table, row.key, row.location, row.handling].every(isString))) return false
  if (!Array.isArray(slices) || !slices.every(row => isObject(row)
    && isString(row.id) && isString(row.environment) && isCount(row.done) && isCount(row.total)
    && (row.deferred === undefined || (isObject(row.deferred) && isString(row.evidence)
      && typeof row.deferred.confirmed === 'boolean' && typeof row.deferred.unconfirmed === 'boolean')))) return false
  return isObject(rulesVersion) && REVIEW_FILES.every(file => rulesVersion[file] === null || isString(rulesVersion[file]))
    && isObject(signOff) && SIGN_OFF_KEYS.every(key => hasOwn(signOff, key))
    && stringMap(signOff.approval) && stringMap(signOff.storyboard)
    && (signOff.changeHead === null || isString(signOff.changeHead))
    && isObject(signOff.pendingEnvironment) && Object.values(signOff.pendingEnvironment).every(groups =>
      isObject(groups) && Object.values(groups).every(stringList))
}

/**
 * 调用门禁并返回核对快照或可发通知的失败类别。
 * @param {string} gateBin 已校验的门禁路径。
 * @param {string} changeDir 本次托管的变更目录。
 * @param {number} [timeout] 外部等待的剩余预算。
 * @returns {{ value: object|null, error: string|null }} 快照及失败类别。
 */
export function traceSnapshot(gateBin, changeDir, timeout = TRACE_TIMEOUT_MS) {
  return parseTrace(spawnSync(process.execPath, [gateBin, 'trace', changeDir], {
    encoding: 'utf8', timeout: Math.min(TRACE_TIMEOUT_MS, timeout), maxBuffer: TRACE_MAX_BUFFER, killSignal: 'SIGKILL',
  }))
}

/** 恢复必须在预算到期时交还调度，不等待门禁退出。 */
export async function recoveryTraceSnapshot(gateBin, changeDir, timeout) {
  return parseTrace(await runBounded(process.execPath, [gateBin, 'trace', changeDir], {
    timeout: Math.min(TRACE_TIMEOUT_MS, timeout), maxBuffer: TRACE_MAX_BUFFER,
  }))
}

function parseTrace(result) {
  const fail = error => ({ value: null, error })
  // 只报告失败类别。门禁子进程的输出可能包含未能核验归属的资料。
  if (result.error) return fail(result.error.code === 'ETIMEDOUT' ? '门禁读取超时' : '门禁无法运行或输出超限')
  if (result.status !== 0) {
    const diagnostic = /^trace：(任务|评审报告|切片证据|签署资料|变更目录)：(读取失败|对象已改变|类型无效|类型或链接无效|目录类型无效|读取失败或对象已改变|链接无效|类型或归属无效|切片引用无效)$/.exec(result.stderr.trim())
    return fail(diagnostic ? `${diagnostic[1]}：${diagnostic[2]}` : `门禁读取失败（退出码 ${result.status ?? '未知'}）`)
  }
  let value
  try {
    value = JSON.parse(result.stdout)
  } catch {
    return fail('门禁输出不是 JSON')
  }
  if (value?.traceVersion !== TRACE_VERSION) return fail('门禁核对快照版本不匹配')
  if (!validTrace(value)) return fail('门禁核对快照字段无效')
  return { value, error: null }
}

/** 以规范元组分组，避免文件或规则键中出现分隔字符时误合并。 */
function groupsOf(rows, keyOf, valueOf) {
  const groups = new Map()
  for (const row of rows) {
    const key = keyOf(row)
    if (!groups.has(key)) groups.set(key, { row, values: [], openBlockers: 0, severity: 0 })
    const group = groups.get(key)
    group.values.push(valueOf(row))
    if (row.openBlocker) group.openBlockers += 1
    group.severity = Math.max(group.severity, SEVERITY.indexOf(row.severity))
  }
  for (const group of groups.values()) group.values.sort()
  return groups
}

const findingKey = ({ file, id, source }) => JSON.stringify([file, id, source])
const sonarKey = ({ table, key, location }) => JSON.stringify([table, key, location])
const valuesOf = group => group?.values ?? []
const equal = (before, after) => JSON.stringify(before) === JSON.stringify(after)
const statuses = group => [...new Set((group?.values ?? ['open']).map(value => value || 'open'))].sort()

/** 从本次比较已恢复的决策中取最近对应该问题的回复。 */
function matchedAnswer(decisions, ownerOpenId, key, option, location = '') {
  const decision = decisions.find(item => item.kind === 'question'
    && ['answered', 'used'].includes(item.status) && item.answer?.operatorId === ownerOpenId
    && Array.isArray(item.request?.questions) && item.request.questions.some(question => question?.header === key
      && (!location || String(question.question || '').includes(location))))
  const freeText = decision?.answer?.text?.[key] || null
  return { matched: !freeText && Boolean(option) && decision?.answer?.selected?.[key] === option,
    freeText, answeredAt: decision?.answer?.answeredAt }
}

/** 核对接受状态的数量和授权。一个选项只覆盖它对应的接受状态。 */
function acceptedChange(old, current, decisions, owner, key, location) {
  const before = valuesOf(old)
  const after = current.values
  const added = [...ACCEPTED_OPTION.keys()].map(status => ({
    status, count: after.filter(value => value === status).length - before.filter(value => value === status).length,
  })).filter(item => item.count > 0)
  const accepted = [...new Set(after.filter(value => ACCEPTED_OPTION.has(value)))]
  const option = ACCEPTED_OPTION.get(added.length === 1 ? added[0].status : accepted.length === 1 ? accepted[0] : '')
  return { ...matchedAnswer(decisions, owner, key, option, location),
    required: accepted.length > 0 && !equal(before, after),
    added: added.length === 1 ? added[0].count : 0 }
}

/** 比较门禁看到的处理记录。门禁对未关闭 Blocker 的判断按原值使用。 */
export function compareTrace({ before, after, decisions = [], ownerOpenId = '' }) {
  const failures = []
  const ids = new Set(before.resumedDecisionIds || [])
  const resumed = decisions.filter(item => ids.has(item.id)).sort((a, b) => b.id.localeCompare(a.id))
  const oldFindings = groupsOf(before.findings, findingKey, row => row.status)
  const newFindings = groupsOf(after.findings, findingKey, row => row.status)
  const oldSonar = groupsOf(before.sonar, sonarKey, row => row.handling)
  const newSonar = groupsOf(after.sonar, sonarKey, row => row.handling)
  const acceptance = new Map()
  for (const [previous, current, isSonar] of [[oldFindings, newFindings, false], [oldSonar, newSonar, true]]) {
    for (const [key, group] of current) {
      const { file, id, source, key: rule, location } = group.row
      const old = previous.get(key)
      const result = acceptedChange(old, group, resumed, ownerOpenId, isSonar ? rule : id, location)
      if (!isSonar) acceptance.set(key, result)
      if (result.required && !result.matched) {
        failures.push({ file: file || 'review/sonar.md', finding: isSonar && location ? `${rule} ${location}` : id || rule,
          field: isSonar ? '处理' : source === 'ledger' ? '状态' : '闭环状态',
          before: valuesOf(old).join(' / ') || 'open', after: group.values.join(' / '),
          ...(result.answeredAt ? { answeredAt: result.answeredAt } : {}),
          note: result.freeText ? `用户自填文本：${result.freeText}` : '没有对应的用户回复' })
      }
      if (source === 'findings') {
        const ledgerKey = findingKey({ file, id, source: 'ledger' })
        const ledger = newFindings.get(ledgerKey)
        if (ledger && !equal(statuses(group), statuses(ledger))
          && (!equal(group.values, old?.values ?? ['open'])
            || !equal(ledger.values, oldFindings.get(ledgerKey)?.values ?? ['open']))) {
          failures.push({ file, finding: id, field: '台账状态与闭环状态',
            before: `${statuses(oldFindings.get(ledgerKey)).join(' / ')}；${statuses(old).join(' / ')}`,
            after: `${statuses(ledger).join(' / ')}；${statuses(group).join(' / ')}` })
        }
        if (old?.severity >= SEVERITY.indexOf('Major') && group.severity < old.severity) {
          failures.push({ file, finding: id, field: '严重级别', before: SEVERITY[old.severity], after: SEVERITY[group.severity] || '其他' })
        }
      }
    }
  }
  for (const [key, old] of oldFindings) {
    const { file, id, source } = old.row
    const current = newFindings.get(key)
    const decrease = old.openBlockers - (current?.openBlockers ?? 0)
    if (current && decrease <= 0) continue
    if (source === 'findings') {
      const ledgerKey = findingKey({ file, id, source: 'ledger' })
      const ledger = newFindings.get(ledgerKey)
      const reply = acceptance.get(current ? key : ledgerKey)
      // 正常关闭可移出 Findings。接受状态的新增仍须有这次核对的授权。
      if (ledger?.values.every(value => value === 'closed')
        || (reply?.matched && reply.added >= Math.max(decrease, 1))
        || (!current && !statuses(old).includes('open') && ledger
          && equal(ledger.values, oldFindings.get(ledgerKey)?.values))) continue
    }
    failures.push({ file, finding: id, field: current ? '未关闭 Blocker 行数' : source,
      before: current ? String(old.openBlockers) : '存在', after: current ? String(current.openBlockers) : '消失' })
  }
  for (const [key, { row }] of oldSonar) {
    if (!newSonar.has(key)) failures.push({ file: 'review/sonar.md', finding: [row.key, row.location].filter(Boolean).join(' '),
      field: 'Sonar 行', before: '存在', after: '消失' })
  }
  for (const [file, version] of Object.entries(before.rulesVersion)) {
    if (version !== null && version !== after.rulesVersion[file]) {
      failures.push({ file, field: 'Rules Version', before: version, after: after.rulesVersion[file] ?? '（已删除）' })
    }
  }
  return failures
}

/** 比较签署字段与待环境补测的切片状态。 */
export function compareSignOff({ before, after }) {
  const failures = []
  for (const [key, field] of [['approval', 'Technical Review Approved'], ['storyboard', 'Storyboard Approved']]) {
    const old = before.signOff[key]
    const current = after.signOff[key]
    for (const file of new Set([...Object.keys(old), ...Object.keys(current)])) {
      if (old[file] !== current[file]) failures.push({ file, field, before: old[file] ?? '（无）', after: current[file] ?? '（已删除）' })
    }
  }
  if (before.signOff.changeHead !== after.signOff.changeHead) {
    failures.push({ file: 'tasks.md', field: '变更终点', before: '（原内容）', after: '（已变化）' })
  }
  const oldRows = before.signOff.pendingEnvironment
  const newRows = after.signOff.pendingEnvironment
  for (const file of new Set([...Object.keys(oldRows), ...Object.keys(newRows)])) {
    const old = oldRows[file] || {}
    const current = newRows[file] || {}
    for (const finding of new Set([...Object.keys(old), ...Object.keys(current)])) {
      const previous = [...new Set(hasOwn(old, finding) ? old[finding].filter(Boolean) : [])].sort()
      const next = [...new Set(hasOwn(current, finding) ? current[finding].filter(Boolean) : [])].sort()
      if (!equal(previous, next) || !hasOwn(current, finding)) {
        failures.push({ file, finding, field: '确认人', before: previous.join(' / ') || '（空）',
          after: hasOwn(current, finding) ? next.join(' / ') || '（空）' : '（登记已删除）' })
      }
    }
  }
  const newSlices = new Map(after.slices.map(slice => [slice.id, slice]))
  for (const old of before.slices) {
    if (!old.environment) continue
    const current = newSlices.get(old.id)
    if (!current || current.environment !== old.environment || current.total < old.total
      || (old.done > 0 && current.done === 0) || (old.total > 0 && old.done === old.total && current.done < current.total)) {
      failures.push({ file: 'tasks.md', finding: old.id, field: '待环境补测切片',
        before: `${old.environment} ${old.done}/${old.total}`,
        after: current ? `${current.environment || '（无环境）'} ${current.done}/${current.total}` : '消失' })
    }
    if (old.deferred?.unconfirmed && !current?.deferred?.unconfirmed && !current?.deferred?.confirmed) {
      failures.push({ file: current?.evidence || old.evidence, finding: old.id, field: '待环境补测登记',
        before: old.fingerprint, after: current?.fingerprint || '（登记已删除）' })
    }
  }
  return failures
}
