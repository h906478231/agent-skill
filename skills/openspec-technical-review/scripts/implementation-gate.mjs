#!/usr/bin/env node
/**
 * 实现阶段门禁的确定性校验：实现指纹、双轴评审完整性、切片新鲜证据与归档前置阻断。
 *
 * 所属：skill openspec-technical-review（门禁口径中枢）。调用方：/opsx:apply（写证据前取指纹）、
 * /opsx:quality（生成固定基线、校验双轴报告）、/opsx:verify 与 /opsx:archive（证据与评审闭环校验），
 * 以及对应的 openspec-* skill。规则事实源（本脚本只做确定性判定，不重复规则说明）：
 *   - 双轴评审：openspec-code-quality/shared/dual-axis-review.md
 *   - 切片证据：openspec-apply-change/shared/slice-evidence.md
 *   - verify / archive 如何解读输出：openspec-technical-review/shared/implementation-gate-check.md
 *
 * 用法：
 *   node implementation-gate.mjs fingerprint <changeRoot> [--repo <dir>]
 *   node implementation-gate.mjs baseline    <changeRoot> [--base <rev>] [--repo <dir>]
 *   node implementation-gate.mjs review      <changeRoot> [--repo <dir>]
 *   node implementation-gate.mjs evidence    <changeRoot> [--repo <dir>]
 *   node implementation-gate.mjs archive     <changeRoot> [--repo <dir>]
 *
 * 输出：fingerprint 输出一行指纹；baseline 输出 Markdown 基线区块；其余输出 JSON。
 * 退出码：0 通过；1 存在阻断项；2 参数或环境错误（非 git 仓库、变更目录不存在等）。
 *
 * 实现指纹：在临时 index 中以 HEAD 为种子写入工作区全部改动（含未跟踪文件，遵守 .gitignore），
 * 移除规划目录（changeRoot 的上两级，通常为 openspec/）后取 git tree 哈希，记为 `git-tree:<sha>`。
 *   - 不改用户的 index、不提交；唯一副作用是向对象库写入不可达对象，由 git gc 按默认策略回收。
 *   - 排除规划目录，保证写证据、勾选 tasks.md、写评审报告不会改变指纹。
 *   - 对象写入对象库后，两个指纹之间可用 git diff-tree 求出变化文件，供过期判定与豁免核实。
 */

import { existsSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** 退出码：通过 / 存在阻断项 / 参数或环境错误。 */
const EXIT = Object.freeze({ PASS: 0, BLOCKED: 1, ERROR: 2 })

/** 指纹前缀，标明生成算法；将来换算法时新旧证据可按前缀区分，不会被误判为同一版本。 */
const FINGERPRINT_PREFIX = 'git-tree:'

/** 可用 git diff-tree 核实的指纹格式；非此格式（含可能被 git 当作选项的值）一律不传给 git。 */
const GIT_TREE_FINGERPRINT = /^git-tree:([0-9a-f]{40}|[0-9a-f]{64})$/

/** 评审基线身份字段：三份评审报告必须逐项一致；记录时间只供追溯，不参与比较。 */
const BASELINE_KEYS = ['Change', 'Base Commit', 'Fingerprint', 'Review Scope']

/** 双轴原始报告定义：报告路径（相对 changeRoot）、finding 前缀与结论行标题。 */
const AXES = [
  { name: 'Standards Review', file: 'review/standards.md', prefix: 'STD' },
  { name: 'Spec Fidelity Review', file: 'review/spec-fidelity.md', prefix: 'SPEC' },
]

/** 双轴汇总报告路径（相对 changeRoot）。 */
const SUMMARY_FILE = 'review/code-review-summary.md'

/** 不计入裁决的闭环状态（取值见 finding-format.md）；其余取值与缺省一律视为 open。 */
const CLOSED_STATUSES = ['closed', 'risk-accepted', 'false-positive']

/** 「位置」可定位的判据：出现 `文件:行号`（可带区间）。 */
const LOCATION = /[^\s`:：|]+:\d+/

/** 参数或环境错误：以退出码 2 结束，与「校验不通过」区分。 */
class GateError extends Error {}

// ============================================================================
// git 与文件读取
// ============================================================================

/**
 * 执行 git 命令并返回 stdout。
 * @param {string} cwd 工作目录。
 * @param {string[]} args git 参数。
 * @param {object} [env] 环境变量（临时 index 通过 GIT_INDEX_FILE 传入）。
 * @returns {string} 标准输出。
 * @throws {GateError} git 不可用或命令失败时抛出，携带 stderr 便于定位。
 */
function git(cwd, args, env = process.env) {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error) throw new GateError(`无法执行 git：${result.error.message}`)
  if (result.status !== 0) throw new GateError(`git ${args.join(' ')} 失败：${result.stderr.trim()}`)
  return result.stdout
}

/** 执行预期可能失败的 git 查询（如解析不存在的提交），失败返回 null 而不是抛错。 */
function tryGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

/** 解析仓库根目录（realpath，避免 /tmp 等符号链接导致相对路径计算错误）。 */
function resolveRepo(dir) {
  const top = tryGit(path.resolve(dir), ['rev-parse', '--show-toplevel'])
  if (!top) throw new GateError(`不是 git 仓库：${path.resolve(dir)}`)
  return realpathSync(top)
}

/** 读取 changeRoot 下的文本文件，不存在返回 null。 */
function readText(changeRoot, rel) {
  const file = path.join(changeRoot, rel)
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

// ============================================================================
// 实现指纹与评审基线
// ============================================================================

/**
 * 规划目录相对仓库根的路径（changeRoot 的上两级）。
 * 规划目录在仓库外（store 模式）或恰为仓库根时返回 null，此时不做排除。
 */
function planningDir(repo, changeRoot) {
  const rel = path.relative(repo, path.dirname(path.dirname(changeRoot)))
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.split(path.sep).join('/')
}

/**
 * 计算当前实现指纹（算法见文件头）。
 * @param {string} repo 仓库根目录。
 * @param {string} changeRoot 变更目录，用于确定需要排除的规划目录。
 * @returns {string} `git-tree:<sha>`。
 */
function computeFingerprint(repo, changeRoot) {
  const index = path.join(tmpdir(), `implementation-gate-${process.pid}-${randomBytes(6).toString('hex')}.index`)
  const env = { ...process.env, GIT_INDEX_FILE: index }
  try {
    // 以 HEAD 为种子，保留「已跟踪但命中 .gitignore」的文件；尚无提交的仓库从空 index 开始。
    if (tryGit(repo, ['rev-parse', '--verify', '-q', 'HEAD'])) git(repo, ['read-tree', 'HEAD'], env)
    git(repo, ['add', '-A', '--', '.'], env)
    const planning = planningDir(repo, changeRoot)
    if (planning) git(repo, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', planning], env)
    return FINGERPRINT_PREFIX + git(repo, ['write-tree'], env).trim()
  } finally {
    rmSync(index, { force: true })
  }
}

/**
 * 两个指纹之间实际变化的文件。
 * @returns {string[]|null} 变化文件列表；指纹不是 git-tree 格式或对象已被回收、无法核实时返回 null。
 */
function changedFiles(repo, from, to) {
  const a = GIT_TREE_FINGERPRINT.exec(from)
  const b = GIT_TREE_FINGERPRINT.exec(to)
  if (!a || !b) return null
  const out = tryGit(repo, ['-c', 'core.quotePath=false', 'diff-tree', '-r', '--name-only', a[1], b[1]])
  return out === null ? null : out.split('\n').filter(Boolean)
}

/**
 * 生成评审基线区块：两轴原始报告与汇总报告原样粘贴同一块。
 * @param {string} baseRev 变更起点（省略取 HEAD）。
 * @throws {GateError} 起点提交无法解析时抛出。
 */
function renderBaseline(repo, changeRoot, baseRev) {
  const rev = baseRev || 'HEAD'
  const base = tryGit(repo, ['rev-parse', '--verify', '-q', `${rev}^{commit}`])
  if (!base) throw new GateError(`无法解析基线提交：${rev}（尚无提交时请先提交或用 --base 指定）`)
  const planning = planningDir(repo, changeRoot)
  return [
    '## 评审基线',
    '',
    `- Change: ${path.basename(changeRoot)}`,
    `- Base Commit: ${base}`,
    `- Fingerprint: ${computeFingerprint(repo, changeRoot)}`,
    `- Review Scope: ${base.slice(0, 12)}..工作区（含已暂存 / 未暂存 / 未跟踪文件，${planning ? `排除 ${planning}` : '无排除目录'}）`,
    `- Baseline Recorded At: ${new Date().toISOString()}`,
    '',
  ].join('\n')
}

// ============================================================================
// Markdown 解析（只识别规则文件约定的骨架，不做通用 Markdown 解析）
// ============================================================================

/** 去掉值两端的反引号与加粗标记。 */
const clean = value => value.trim().replace(/^[`*]+|[`*]+$/g, '').trim()

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 读取 `Key: value` 或 `- Key: value` 字段（首个匹配），兼容全角冒号。 */
function readField(text, key) {
  const match = text.match(new RegExp(`^\\s*(?:[-*]\\s+)?\\**${escapeRegExp(key)}\\**\\s*[:：]\\s*(.*)$`, 'm'))
  return match ? clean(match[1]) : ''
}

/** 取 `## 标题` 区块正文（标题按包含匹配），到下一个一、二级标题为止；不存在返回空串。 */
function section(text, title) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex(line => /^##\s/.test(line) && line.includes(title))
  if (start < 0) return ''
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => /^#{1,2}\s/.test(line))
  return (end < 0 ? rest : rest.slice(0, end)).join('\n')
}

const isTableRow = line => /^\s*\|.*\|\s*$/.test(line)

/** 拆分表格行；`\|` 视为单元格内的竖线而非分隔符。 */
const tableCells = line => line.trim().replace(/^\||\|$/g, '').replace(/\\\|/g, '\u0000')
  .split('|').map(cell => clean(cell.replace(/\u0000/g, '|')))

/** 解析文本中的全部 Markdown 表格，返回以表头为键的行对象数组。 */
function parseTables(text) {
  const rows = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i + 1 < lines.length; i += 1) {
    if (!isTableRow(lines[i]) || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) continue
    const header = tableCells(lines[i])
    let j = i + 2
    for (; j < lines.length && isTableRow(lines[j]); j += 1) {
      const values = tableCells(lines[j])
      rows.push(Object.fromEntries(header.map((key, k) => [key, values[k] || ''])))
    }
    i = j - 1
  }
  return rows
}

/** 读取「## 评审基线」区块中的身份字段。 */
function readBaseline(text) {
  const block = section(text, '评审基线')
  return Object.fromEntries(BASELINE_KEYS.map(key => [key, readField(block, key)]))
}

/** 未闭环 Blocker 判据：严重级别为 Blocker 且闭环状态为 open 或缺省。 */
const isOpenBlocker = row => clean(row['严重级别'] || '') === 'Blocker'
  && !CLOSED_STATUSES.includes(clean(row['闭环状态'] || '').toLowerCase())

/** 读取原始报告的结论行（取最后一个单值结论行，模板中的「通过 / 有条件通过 / 打回」不会被误识别）。 */
function readAxisVerdict(text) {
  const matches = [...text.matchAll(/结论\s*[:：]\s*\**\s*(有条件通过|通过|打回)\s*\**\s*$/gm)]
  return matches.length ? matches[matches.length - 1][1] : ''
}

/** 读取 tasks.md 文本（不存在返回空串）。 */
const readTasks = changeRoot => readText(changeRoot, 'tasks.md') || ''

/** tasks.md 是否声明了切片证据引用：即按新规则创建的变更，双轴评审产物必需。 */
const declaresEvidence = tasks => /^\s*Evidence\s*[:：]/m.test(tasks)

// ============================================================================
// 双轴评审校验
// ============================================================================

/**
 * 校验双轴评审产物并重新计算裁决（不采信汇总自述）。
 * @param {string} changeRoot 变更目录。
 * @param {object} options required：是否必须存在评审产物；currentFingerprint：用于评审基线陈旧提醒。
 * @returns {object} applicable、verdict（PASSED / BLOCKED / INCOMPLETE）、axes、issues、warnings 等。
 */
function checkReview(changeRoot, { required = false, currentFingerprint = null } = {}) {
  const files = [...AXES.map(axis => axis.file), SUMMARY_FILE]
  if (!required && !files.some(file => existsSync(path.join(changeRoot, file)))) {
    return { applicable: false, reason: '不适用：未生成双轴评审产物（L0 豁免，或未启用本能力的历史变更）', verdict: null,
      axes: [], issues: [], warnings: [] }
  }
  const issues = []
  const warnings = []
  const baselines = []

  const axes = AXES.map(axis => {
    const text = readText(changeRoot, axis.file)
    if (text === null) {
      issues.push(`缺少原始报告 ${axis.file}`)
      return { axis: axis.name, file: axis.file, exists: false, verdict: '', findings: 0, openBlockers: [] }
    }
    baselines.push([axis.file, readBaseline(text)])
    const findings = parseTables(text).filter(row => /^[A-Z]+-\d+$/.test(row.ID || ''))
    for (const row of findings) {
      if (!row.ID.startsWith(`${axis.prefix}-`)) issues.push(`${axis.file} 的 finding ${row.ID} 前缀与评审轴不符，应为 ${axis.prefix}-`)
      if (!LOCATION.test(row['位置'] || '')) issues.push(`${axis.file} 的 finding ${row.ID} 位置无法定位，须写成 文件:行号`)
    }
    const openBlockers = findings.filter(isOpenBlocker).map(row => row.ID)
    const verdict = readAxisVerdict(text)
    if (!verdict) {
      issues.push(`${axis.file} 缺少结论行（${axis.name} 结论：通过 / 有条件通过 / 打回）`)
    } else if (openBlockers.length && verdict !== '打回') {
      issues.push(`${axis.file} 存在未闭环 Blocker（${openBlockers.join(', ')}）但结论为「${verdict}」，应为「打回」`)
    }
    return { axis: axis.name, file: axis.file, exists: true, verdict, findings: findings.length, openBlockers }
  })

  // 汇总只做索引与裁决：必须引用两份原始报告，自述裁决必须与重新计算的结果一致。
  const blocked = axes.some(axis => axis.openBlockers.length)
  const summary = readText(changeRoot, SUMMARY_FILE)
  let declaredVerdict = ''
  if (summary === null) {
    issues.push(`缺少汇总报告 ${SUMMARY_FILE}`)
  } else {
    baselines.push([SUMMARY_FILE, readBaseline(summary)])
    for (const axis of AXES) {
      if (!summary.includes(axis.file)) issues.push(`汇总报告未引用原始报告 ${axis.file}`)
    }
    const match = summary.match(/^\s*\**Code Review Verdict\**\s*[:：]\s*\**\s*(PASSED|BLOCKED)\b/m)
    declaredVerdict = match ? match[1] : ''
    if (!declaredVerdict) {
      issues.push(`汇总报告缺少裁决行（Code Review Verdict: PASSED / BLOCKED）`)
    } else if (declaredVerdict !== (blocked ? 'BLOCKED' : 'PASSED')) {
      issues.push(`汇总报告自述裁决 ${declaredVerdict} 与原始报告重新计算的 ${blocked ? 'BLOCKED' : 'PASSED'} 不一致`)
    }
  }

  // 固定基线：以第一份存在的报告为参照，逐项比较身份字段。
  const [referenceFile, reference] = baselines[0] || []
  for (const [file, values] of baselines) {
    for (const key of BASELINE_KEYS) {
      if (!values[key]) issues.push(`${file} 的评审基线缺少 ${key}`)
      else if (reference[key] && values[key] !== reference[key]) issues.push(`${file} 的评审基线 ${key} 与 ${referenceFile} 不一致`)
    }
  }
  const baseline = reference || null
  if (currentFingerprint && baseline && baseline.Fingerprint && baseline.Fingerprint !== currentFingerprint) {
    warnings.push(`评审基线 Fingerprint ${baseline.Fingerprint} 与当前实现 ${currentFingerprint} 不一致：评审后实现有变化，需判断是否重跑双轴评审`)
  }

  const verdict = blocked ? 'BLOCKED' : issues.length ? 'INCOMPLETE' : 'PASSED'
  return { applicable: true, verdict, declaredVerdict, baseline, axes, issues, warnings }
}

// ============================================================================
// 切片证据校验
// ============================================================================

/**
 * 解析 tasks.md 的切片：编号、Seam、Evidence 引用与勾选进度。
 * 只识别 `## Slice <id>: 标题` 结构；遇到其他一、二级标题即结束当前切片。
 */
function readSlices(tasks) {
  const slices = []
  let current = null
  for (const line of tasks.split(/\r?\n/)) {
    const heading = line.match(/^##\s+Slice\s+([\w.-]+)\s*[:：]\s*(.*)$/i)
    if (heading) {
      current = { id: heading[1], title: heading[2].trim(), seam: '', evidenceRef: '', done: 0, total: 0 }
      slices.push(current)
      continue
    }
    if (/^#{1,2}\s/.test(line)) current = null
    if (!current) continue
    const declared = line.match(/^\s*(Seam|Evidence)\s*[:：]\s*(.*)$/)
    if (declared) {
      current[declared[1] === 'Seam' ? 'seam' : 'evidenceRef'] = clean(declared[2])
      continue
    }
    // checkbox 仍是唯一进度事实源，格式与 openspec CLI 的解析口径一致。
    const box = line.match(/^\s*[-*]\s+\[([ xX])\]/)
    if (box) {
      current.total += 1
      if (box[1] !== ' ') current.done += 1
    }
  }
  return slices
}

/** 证据必填的 `- Key: value` 字段（模板见 slice-evidence.md）。 */
const EVIDENCE_FIELDS = ['Slice', 'Behavior', 'Seam', 'Recorded At', 'Fingerprint', 'Fingerprint Source', 'Result']

/** 证据必填区块：每块至少一个列表项或表格数据行；验证命令必须是含「结果」列的表格。 */
const EVIDENCE_SECTIONS = ['变更文件', '验证命令', '覆盖的验收行为', '剩余风险']

/** 统计区块中的列表项与表格数据行。 */
const countEntries = body => (body.match(/^\s*(?:[-*]|\d+\.)\s+\S/gm) || []).length + parseTables(body).length

/**
 * 检查一份证据的字段完整性与验证结果。
 * @returns {{ fields: object, missing: string[], failures: string[] }} missing 为缺失 / 非法项，failures 为失败的验证结果。
 */
function inspectEvidence(text, sliceId) {
  // 字段只在首个二级标题之前读取，避免与豁免记录表等正文混淆。
  const head = text.split(/^##\s/m)[0]
  const fields = Object.fromEntries(EVIDENCE_FIELDS.map(key => [key, readField(head, key)]))
  const missing = EVIDENCE_FIELDS.filter(key => !fields[key])
  if (fields.Slice && fields.Slice !== sliceId) missing.push(`Slice（记录为 ${fields.Slice}，应为 ${sliceId}）`)
  for (const title of EVIDENCE_SECTIONS) {
    if (!countEntries(section(text, title))) missing.push(title)
  }

  const failures = []
  const result = fields.Result.toUpperCase()
  if (fields.Result && !['PASS', 'FAIL'].includes(result)) missing.push('Result（只能是 PASS / FAIL）')
  if (result === 'FAIL') failures.push('Result 为 FAIL')
  for (const row of parseTables(section(text, '验证命令'))) {
    const outcome = (row['结果'] || '').toUpperCase()
    if (!['PASS', 'FAIL'].includes(outcome)) missing.push('验证命令结果（每行只能是 PASS / FAIL）')
    else if (outcome === 'FAIL') failures.push(`验证命令失败：${row['命令'] || '(未写命令)'}`)
  }
  return { fields, missing: [...new Set(missing)], failures }
}

/** 豁免记录必填列（格式见 slice-evidence.md「豁免记录格式」）。 */
const EXEMPTION_COLUMNS = ['变化文件', '不影响本切片行为的理由', '判定人', '日期']

/** 拆分豁免记录的「变化文件」单元格（逗号、顿号、分号、空白或 <br> 分隔）。 */
const splitFiles = cell => cell.split(/<br\s*\/?>|[,，、;；\s]+/).map(clean).filter(Boolean)

/**
 * 沿豁免链从证据指纹走到当前指纹；每一段都必须字段齐全，且「变化文件」列全两指纹间的实际变化。
 * @returns {{ ok: boolean, reason: string }} ok 为 false 时 reason 说明链在哪一段失效（无记录时为空串）。
 */
function followExemptions(repo, rows, recorded, current) {
  const visited = new Set()
  let cursor = recorded
  while (cursor !== current) {
    if (visited.has(cursor)) return { ok: false, reason: '豁免记录出现循环' }
    visited.add(cursor)
    const row = rows.find(item => clean(item['From Fingerprint'] || '') === cursor)
    if (!row) return { ok: false, reason: '' }
    const to = clean(row['To Fingerprint'] || '')
    const empty = EXEMPTION_COLUMNS.filter(column => !clean(row[column] || ''))
    if (empty.length) return { ok: false, reason: `豁免记录 ${cursor} → ${to} 缺少 ${empty.join('、')}` }
    // 无法核实变化范围就无法证明不影响切片行为，按过期处理（规则：无法判断即过期）。
    const actual = changedFiles(repo, cursor, to)
    if (actual === null) return { ok: false, reason: `无法核实豁免记录 ${cursor} → ${to} 的变化范围（非 git-tree 指纹或对象已被回收）` }
    const listed = new Set(splitFiles(row['变化文件']))
    const omitted = actual.filter(file => !listed.has(file))
    if (omitted.length) return { ok: false, reason: `豁免记录 ${cursor} → ${to} 漏列变化文件 ${omitted.join('、')}` }
    cursor = to
  }
  return { ok: true, reason: '' }
}

/** 从 `Evidence:` 行取证据路径（兼容 Markdown 链接写法）。 */
const evidencePath = ref => (ref.match(/[^\s()[\]`'"<>]+\.md/) || [''])[0]

/**
 * 校验单个切片的证据。已全部勾选的切片问题记 CRITICAL；部分勾选时只有缺证据文件记 CRITICAL，其余记 warning。
 * @returns {{ slice: object, issues: string[], warnings: string[] }}
 */
function checkSlice(repo, changeRoot, slice, currentFingerprint) {
  const expected = `evidence/slice-${slice.id}.md`
  const label = `Slice ${slice.id}`
  const view = { id: slice.id, title: slice.title, seam: slice.seam, evidence: expected,
    tasks: { done: slice.done, total: slice.total }, status: 'pending' }
  const ref = evidencePath(slice.evidenceRef)
  if (!ref || ref !== expected) {
    view.status = 'no-reference'
    return { slice: view, warnings: [], issues: [ref
      ? `${label} 的 Evidence 引用 ${ref} 不规范，应为 Evidence: ${expected}`
      : `${label} 未声明 Evidence 引用，应为 Evidence: ${expected}`] }
  }
  if (!slice.done) return { slice: view, issues: [], warnings: [] }

  const text = readText(changeRoot, ref)
  if (text === null) {
    view.status = 'missing'
    return { slice: view, warnings: [], issues: [`${label} 已勾选 ${slice.done}/${slice.total} 项但缺少证据 ${ref}：证据必须先于勾选生成`] }
  }

  const { fields, missing, failures } = inspectEvidence(text, slice.id)
  view.fingerprint = fields.Fingerprint
  const problems = []
  if (missing.length) {
    view.status = 'incomplete'
    problems.push(`${label} 证据不完整：缺少 ${missing.join('、')}`)
  } else if (failures.length) {
    view.status = 'failed'
    problems.push(`${label} 证据未通过：${failures.join('；')}`)
  } else if (fields.Fingerprint === currentFingerprint) {
    view.status = 'fresh'
  } else {
    const chain = followExemptions(repo, parseTables(section(text, '豁免记录')), fields.Fingerprint, currentFingerprint)
    if (chain.ok) {
      view.status = 'exempted'
    } else {
      view.status = 'stale'
      // 列出自证据以来的变化文件，供 Verify 判断重跑范围或登记豁免；无法计算时为 null。
      view.changedSinceEvidence = changedFiles(repo, fields.Fingerprint, currentFingerprint)
      problems.push(`${label} 证据过期：记录指纹 ${fields.Fingerprint} ≠ 当前实现 ${currentFingerprint}`
        + `${chain.reason ? `；${chain.reason}` : ''}，需重跑该切片验证并更新证据`)
    }
  }
  const complete = slice.done === slice.total
  return { slice: view, issues: complete ? problems : [], warnings: complete ? [] : problems.map(item => `${item}（切片未全部勾选，暂记 warning）`) }
}

/**
 * 校验变更的切片证据。
 * @returns {object} applicable、reason（不适用理由）、currentFingerprint、slices、issues（CRITICAL）、warnings。
 */
function checkEvidence(repo, changeRoot, currentFingerprint) {
  const tasks = readText(changeRoot, 'tasks.md')
  const slices = tasks === null ? [] : readSlices(tasks)
  const enabled = slices.some(slice => slice.evidenceRef) || existsSync(path.join(changeRoot, 'evidence'))
  const notApplicable = reason => ({ applicable: false, reason, currentFingerprint, slices: [], issues: [], warnings: [] })
  // 不适用必须带理由返回，由 Verify 写进报告，不能静默当作通过。
  if (tasks === null) return notApplicable('不适用：变更没有 tasks.md')
  if (!slices.length) return notApplicable('不适用：tasks.md 无垂直切片（## Slice 标题），不强制切片证据')
  if (!enabled) return notApplicable('不适用：切片未声明 Evidence 引用，视为未启用切片证据的历史变更（不追溯）')

  const results = slices.map(slice => checkSlice(repo, changeRoot, slice, currentFingerprint))
  return { applicable: true, currentFingerprint, slices: results.map(item => item.slice),
    issues: results.flatMap(item => item.issues), warnings: results.flatMap(item => item.warnings) }
}

// ============================================================================
// 归档前置校验
// ============================================================================

/**
 * 合并双轴评审与切片证据的阻断项；不适用的部分以理由写入 notes，不静默当作通过。
 * Verify 的其他 CRITICAL（未完成任务、需求未实现等）不在本脚本判定范围，由 archive 流程另行确认。
 * @returns {object} ok、blockers、notes、warnings，以及 review / evidence 明细。
 */
function checkArchive(repo, changeRoot, currentFingerprint) {
  const review = checkReview(changeRoot, { required: declaresEvidence(readTasks(changeRoot)), currentFingerprint })
  const evidence = checkEvidence(repo, changeRoot, currentFingerprint)
  const blockers = []
  const notes = []
  if (review.applicable) {
    blockers.push(...review.issues.map(issue => `双轴评审：${issue}`))
    const open = review.axes.flatMap(axis => axis.openBlockers)
    if (review.verdict === 'BLOCKED') blockers.push(`双轴评审裁决 BLOCKED，未闭环 Blocker：${open.join(', ')}`)
  } else {
    notes.push(review.reason)
  }
  if (evidence.applicable) blockers.push(...evidence.issues.map(issue => `切片证据：${issue}`))
  else notes.push(evidence.reason)
  return { ok: blockers.length === 0, blockers, notes, warnings: [...review.warnings, ...evidence.warnings], review, evidence }
}

// ============================================================================
// 命令入口
// ============================================================================

/** 解析 `--key value` 形式的可选参数。 */
function parseOptions(args) {
  const options = {}
  for (let i = 0; i < args.length; i += 1) {
    const match = /^--(base|repo)$/.exec(args[i])
    if (!match || i + 1 >= args.length) throw new GateError(`无法识别的参数：${args[i]}`)
    options[match[1]] = args[i + 1]
    i += 1
  }
  return options
}

const USAGE = '用法：node implementation-gate.mjs <fingerprint|baseline|review|evidence|archive> <changeRoot> [--base <rev>] [--repo <dir>]'

/**
 * 执行子命令。
 * @param {string[]} argv 命令行参数（不含 node 与脚本路径）。
 * @returns {{ code: number, output: string }} 退出码与标准输出内容。
 */
function run(argv) {
  const [command, changeRootArg, ...rest] = argv
  if (!['fingerprint', 'baseline', 'review', 'evidence', 'archive'].includes(command) || !changeRootArg) throw new GateError(USAGE)
  const options = parseOptions(rest)
  const target = path.resolve(changeRootArg)
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new GateError(`变更目录不存在：${target}`)
  const changeRoot = realpathSync(target)
  const repo = resolveRepo(options.repo || process.cwd())

  if (command === 'fingerprint') return { code: EXIT.PASS, output: `${computeFingerprint(repo, changeRoot)}\n` }
  if (command === 'baseline') return { code: EXIT.PASS, output: renderBaseline(repo, changeRoot, options.base) }

  const currentFingerprint = computeFingerprint(repo, changeRoot)
  let report
  let ok
  if (command === 'review') {
    report = checkReview(changeRoot, { required: declaresEvidence(readTasks(changeRoot)), currentFingerprint })
    ok = !report.applicable || report.verdict === 'PASSED'
  } else if (command === 'evidence') {
    report = checkEvidence(repo, changeRoot, currentFingerprint)
    ok = report.issues.length === 0
  } else {
    report = checkArchive(repo, changeRoot, currentFingerprint)
    ok = report.ok
  }
  return { code: ok ? EXIT.PASS : EXIT.BLOCKED,
    output: `${JSON.stringify({ command, change: path.basename(changeRoot), ok, ...report }, null, 2)}\n` }
}

try {
  const { code, output } = run(process.argv.slice(2))
  process.stdout.write(output)
  process.exitCode = code
} catch (error) {
  // 参数与环境错误只输出可读信息；非预期异常保留堆栈，便于定位脚本缺陷。
  process.stderr.write(`${error instanceof GateError ? error.message : error.stack}\n`)
  process.exitCode = EXIT.ERROR
}
