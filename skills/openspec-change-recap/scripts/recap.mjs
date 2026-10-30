#!/usr/bin/env node
/**
 * 完成清单的确定性检查与跨变更总表：检查一份 recap.md 的格式与 git 忽略状态，按主题分组打印全部归档变更。
 *
 * 所属：skill openspec-change-recap。调用方：/opsx:archive 第 7 步与 /opsx:recap（check），
 * /opsx:recap 不带参数与生成完成清单的子 agent（list）。格式规则的事实源：shared/recap-format.md
 * （本脚本只做确定性判定，不重复规则说明）。
 *
 * 用法：
 *   node recap.mjs check <recapFile>            检查一份完成清单的格式与 git 忽略状态
 *   node recap.mjs list <archiveDir> [--json]   打印跨变更总表
 *
 * 输出：check 输出 JSON { verdict, blocking, warnings, gitIgnored, header }；
 *   header 的键 change、archiveDate、tier、theme、summary 依次对应标题行变更名、归档日期、分级、主题、摘要。
 *   list 默认输出 Markdown 表格，--json 输出 { total, withRecap, themes, missing }。
 * 退出码：check 为 0 通过、1 存在阻断项；list 为 0 打印完成（有变更没有完成清单时也是 0）；两者参数错误或文件、目录不存在时为 2。
 * 不调用 LLM，不访问网络，不写文件。
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

/** 退出码：通过 / 存在阻断项 / 参数或环境错误，与 change-model.mjs、ste-lint.mjs 一致。 */
const EXIT = Object.freeze({ PASS: 0, BLOCKED: 1, ERROR: 2 })

/** 完成清单的文件名，固定在变更的归档目录下。 */
const RECAP_FILE = 'recap.md'

/**
 * 完成清单没有被 git 忽略时建议加入 .gitignore 的规则。脚本与 agent 都不修改 .gitignore，只告警：
 * 变更目录会提交的项目由团队决定是否提交完成清单。
 */
const SUGGESTED_RULE = 'openspec/changes/archive/*/recap.md'

/** 标题行：`# 完成清单：<变更名>`。 */
const TITLE_LINE = /^#\s+完成清单\s*[:：]\s*(.*)$/

/** 头部字段的列表项：`- <字段>：<值>`。 */
const HEADER_LINE = /^-\s*(\S+?)\s*[:：]\s*(.*)$/

/** 二级标题：`## <标题>`。 */
const SECTION_LINE = /^##\s+(.+?)\s*$/

/** 6 个二级标题，按文件中的顺序；一类没有事项时写一行「无」。 */
const SECTIONS = Object.freeze(['新增', '修改', '删除', '修复', '没做与遗留', '落点'])

/** 变更的归档目录名：`YYYY-MM-DD-<变更名>`，由 openspec archive 生成。 */
const ARCHIVE_DIR_NAME = /^(\d{4}-\d{2}-\d{2})-(.+)$/

/** 4 个头部字段，按文件中的顺序；值为 header 输出中的键。 */
const HEADER_FIELDS = Object.freeze([
  ['归档日期', 'archiveDate'],
  ['分级', 'tier'],
  ['主题', 'theme'],
  ['摘要', 'summary'],
])

/**
 * `分级` 的取值域：等级、方案类型或「未定义」，与归档门禁 readTier 的返回值一一对应（readTier 返回 null 时写「未定义」）。
 * 不允许整句分级行：总表的分级列与归档门禁必须读到同一个值。
 */
const TIERS = Object.freeze(['L0', 'L1', 'L2', 'L3', 'MVP', '未定义'])

/** 参数与环境错误：只输出可读信息，退出码 2。 */
class RecapError extends Error {}

/** `YYYY-MM-DD` 是否为存在的日期：按 UTC 解析后格式化回同一个值才算有效，排除 2026-02-30 这类会被进位的日期。 */
function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

// ============================================================================
// 头部解析（check 与 list 共用）
// ============================================================================

/**
 * 按文件顺序收集出现的固定项（头部字段或二级标题）。同一项写了两次时只取第一次，与 list 读到的值相同。
 * @param {string[]} lines 全文行。
 * @param {number} from 起始行下标（含）。
 * @param {number} to 结束行下标（不含）。
 * @param {RegExp} pattern 行匹配，第 1 组为项名，第 2 组为值（可选）。
 * @param {string[]} names 固定项名称，按规定顺序。
 * @returns {{ order: number, line: number, value: string }[]} order 为规定顺序中的下标，line 为 1 起的行号。
 */
function collect(lines, from, to, pattern, names) {
  const found = []
  for (let index = from; index < to; index += 1) {
    const match = lines[index].match(pattern)
    const order = match ? names.indexOf(match[1]) : -1
    if (order === -1 || found.some(entry => entry.order === order)) continue
    found.push({ order, line: index + 1, value: (match[2] || '').trim() })
  }
  return found
}

/**
 * 检查固定项的顺序与缺失：按文件顺序比较，排在后一项之后的项算顺序错误，其余项不重复报告。
 * @param {{ order: number, line: number }[]} found collect 的结果。
 * @param {string[]} labels 阻断项中写出的项名，按规定顺序。
 * @param {number} missingLine 缺失项报告的行号。
 * @param {Function} block 写入阻断项。
 */
function checkSequence(found, labels, missingLine, block) {
  let latest = null
  for (const entry of found) {
    if (latest && entry.order < latest.order) block(entry.line, labels[entry.order], `应写在「${labels[latest.order]}」之前`)
    if (!latest || entry.order > latest.order) latest = entry
  }
  for (const [order, label] of labels.entries()) {
    if (!found.some(entry => entry.order === order)) block(missingLine, label, `缺少「${label}」`)
  }
}

/**
 * 解析一份完成清单，返回头部字段与格式阻断项。check 与 list 只通过本函数判定格式，两者结论相同。
 * @param {string} text 完成清单全文。
 * @param {string} dirName 变更的归档目录名（`YYYY-MM-DD-<变更名>`）。
 * @param {{ headerOnly?: boolean }} options headerOnly 为 true 时只检查标题行与头部字段（list 只读头部）。
 * @returns {{ header: object, blocking: { line: number, field: string, detail: string }[] }}
 */
function parseRecap(text, dirName, { headerOnly = false } = {}) {
  const lines = text.split(/\r?\n/)
  const blocking = []
  const block = (line, field, detail) => blocking.push({ line, field, detail })
  const header = { change: null, archiveDate: null, tier: null, theme: null, summary: null }
  // 归档日期与变更名都能从目录名得到：两者与文件内容比较，发现手改或复制错误。
  const archived = dirName.match(ARCHIVE_DIR_NAME)
  if (!archived) block(1, '归档目录', `目录名不是 YYYY-MM-DD-<变更名>：${dirName}；完成清单只用于已归档的变更`)
  const title = lines[0].match(TITLE_LINE)
  if (title) header.change = title[1].trim()
  if (!title) block(1, '标题行', `第一行应为「# 完成清单：${archived ? archived[2] : '<变更名>'}」`)
  else if (archived && header.change !== archived[2]) block(1, '标题行', `变更名应为 ${archived[2]}（归档目录名去掉日期前缀）`)

  // 头部只到第一个二级标题为止：正文事项也是列表项，不能当作头部字段。
  const firstHeading = lines.findIndex(line => SECTION_LINE.test(line))
  const headerEnd = firstHeading === -1 ? lines.length : firstHeading
  const fieldNames = HEADER_FIELDS.map(([name]) => name)
  const fields = collect(lines, 1, headerEnd, HEADER_LINE, fieldNames)
  for (const entry of fields) {
    const [name, key] = HEADER_FIELDS[entry.order]
    header[key] = entry.value
    if (!entry.value) block(entry.line, name, '值为空')
    else if (key === 'archiveDate' && !isValidDate(entry.value)) block(entry.line, name, `不是有效日期 YYYY-MM-DD：${entry.value}`)
    else if (key === 'archiveDate' && archived && entry.value !== archived[1]) block(entry.line, name, `应为 ${archived[1]}（归档目录名的日期前缀）`)
    else if (key === 'tier' && !TIERS.includes(entry.value)) block(entry.line, name, `取值应为 ${TIERS.join('、')} 之一：${entry.value}`)
  }
  checkSequence(fields, fieldNames, headerEnd, block)
  if (!headerOnly) checkSequence(collect(lines, headerEnd, lines.length, SECTION_LINE, SECTIONS), SECTIONS.map(name => `## ${name}`), lines.length, block)
  return { header, blocking }
}

// ============================================================================
// check
// ============================================================================

/**
 * 运行一条 git 命令，返回退出码与标准输出。参数用数组传入，不经过 shell。
 * @param {string} cwd 运行目录。
 * @param {string[]} args git 参数。
 * @returns {{ status: number|null, stdout: string }} 没有安装 git（ENOENT）或被信号终止时 status 为 null。
 */
function git(cwd, args) {
  try {
    return { status: 0, stdout: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) }
  } catch (error) {
    return { status: typeof error.status === 'number' ? error.status : null, stdout: '' }
  }
}

/**
 * 完成清单是否被 git 忽略。两条 git 命令都在完成清单所在目录运行：git 按这个目录判定所属仓库，结果与进程 cwd 无关。
 * @param {string} recapFile 完成清单的真实路径（已 realpath）。
 * @returns {boolean|null} true 已忽略；false 没有被忽略；null 不在 git 工作区、没有安装 git 或 git 报错。异常不映射为 true。
 */
function gitIgnored(recapFile) {
  const cwd = path.dirname(recapFile)
  const inside = git(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return null
  // `--` 之后的参数一律是路径：以 `-` 开头的文件名不会被当作选项。
  const { status } = git(cwd, ['check-ignore', '-q', '--', path.basename(recapFile)])
  if (status === 0) return true
  if (status === 1) return false
  return null
}

/**
 * check：检查一份完成清单的格式。
 * @param {string} file 完成清单路径。
 * @returns {{ code: number, output: string }}
 * @throws {RecapError} 文件不存在时抛出。
 */
function check(file) {
  const given = path.resolve(file)
  if (!existsSync(given) || !statSync(given).isFile()) throw new RecapError(`完成清单不存在：${given}`)
  // 先解析符号链接：归档目录名与 git 所属仓库都按完成清单的真实位置判定。
  const recapFile = realpathSync(given)
  const { header, blocking } = parseRecap(readFileSync(recapFile, 'utf8'), path.basename(path.dirname(recapFile)))
  const ignored = gitIgnored(recapFile)
  // 告警不改变退出码：是否提交完成清单由项目决定。
  const warnings = ignored === false
    ? [{ field: 'gitignore', detail: `完成清单没有被 git 忽略；不修改 .gitignore，需要忽略时由用户加入一行：${SUGGESTED_RULE}`, suggestedRule: SUGGESTED_RULE }]
    : []
  const report = { verdict: blocking.length ? 'BLOCKED' : 'PASS', blocking, warnings, gitIgnored: ignored, header }
  return { code: blocking.length ? EXIT.BLOCKED : EXIT.PASS, output: `${JSON.stringify(report, null, 2)}\n` }
}

// ============================================================================
// list
// ============================================================================

/** 按码点比较字符串：排序结果不依赖运行环境的区域设置，总表每次相同。 */
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/** Markdown 表格单元格：转义 `|`，避免摘要中的竖线增加列。 */
const cell = value => String(value).replace(/\|/g, '\\|')

/**
 * 读取归档目录中每个变更的完成清单头部，按主题分组。
 * @param {string} archiveDir 归档目录。
 * @returns {{ total: number, withRecap: number, themes: object[], missing: object[] }}
 */
function collectRecaps(archiveDir) {
  const dirs = readdirSync(archiveDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
  const groups = new Map()
  const missing = []
  for (const dir of dirs) {
    const file = path.join(archiveDir, dir, RECAP_FILE)
    if (!existsSync(file)) {
      missing.push({ dir, reason: `没有 ${RECAP_FILE}` })
      continue
    }
    // 头部不合格的完成清单不进入总表：分组与排序依赖的字段可能缺失或取值错误，列入「没有完成清单」并写出原因。
    const { header, blocking } = parseRecap(readFileSync(file, 'utf8'), dir, { headerOnly: true })
    if (blocking.length) {
      missing.push({ dir, reason: `头部检查不通过：${blocking.map(item => `${item.field}（第 ${item.line} 行）${item.detail}`).join('；')}` })
      continue
    }
    const row = { dir, change: header.change, archiveDate: header.archiveDate, tier: header.tier, summary: header.summary }
    if (!groups.has(header.theme)) groups.set(header.theme, [])
    groups.get(header.theme).push(row)
  }
  const themes = [...groups.entries()]
    .map(([theme, changes]) => ({
      theme,
      count: changes.length,
      changes: changes.sort((a, b) => compareText(b.archiveDate, a.archiveDate) || compareText(a.dir, b.dir)),
    }))
    .sort((a, b) => b.count - a.count || compareText(a.theme, b.theme))
  const withRecap = themes.reduce((sum, group) => sum + group.count, 0)
  return { total: dirs.length, withRecap, themes, missing: missing.sort((a, b) => compareText(a.dir, b.dir)) }
}

/**
 * 把总表渲染为 Markdown：每个主题一节，最后是「没有完成清单」。
 * @param {{ total: number, withRecap: number, themes: object[], missing: object[] }} table collectRecaps 的结果。
 * @returns {string} Markdown 文本。
 */
function renderTable(table) {
  const lines = ['# 跨变更总表', '', `共 ${table.total} 个归档变更，${table.withRecap} 个有完成清单。`, '']
  for (const group of table.themes) {
    lines.push(`## ${group.theme}（${group.count}）`, '', '| 归档日期 | 变更 | 分级 | 摘要 |', '|---|---|---|---|')
    lines.push(...group.changes.map(row => `| ${[row.archiveDate, row.change, row.tier, row.summary].map(cell).join(' | ')} |`), '')
  }
  lines.push(`## 没有完成清单（${table.missing.length}）`, '')
  if (table.missing.length) lines.push('| 目录 | 原因 |', '|---|---|', ...table.missing.map(item => `| ${cell(item.dir)} | ${cell(item.reason)} |`))
  else lines.push('无')
  lines.push('')
  return `${lines.join('\n')}\n`
}

/**
 * list：打印跨变更总表。只读取完成清单，不写文件，不调用 LLM，不访问网络。
 * @param {string} dir 归档目录。
 * @param {boolean} json 是否输出 JSON。
 * @returns {{ code: number, output: string }}
 * @throws {RecapError} 归档目录不存在时抛出。
 */
function list(dir, json) {
  const archiveDir = path.resolve(dir)
  if (!existsSync(archiveDir) || !statSync(archiveDir).isDirectory()) throw new RecapError(`归档目录不存在：${archiveDir}`)
  const table = collectRecaps(archiveDir)
  return { code: EXIT.PASS, output: json ? `${JSON.stringify(table, null, 2)}\n` : renderTable(table) }
}

// ============================================================================
// 命令入口
// ============================================================================

const USAGE = [
  '用法：node recap.mjs check <recapFile>',
  '      node recap.mjs list <archiveDir> [--json]',
].join('\n')

/**
 * 执行子命令。
 * @param {string[]} argv 命令行参数（不含 node 与脚本路径）。
 * @returns {{ code: number, output: string }} 退出码与标准输出内容。
 * @throws {RecapError} 参数错误或文件不存在时抛出。
 */
function run(argv) {
  const [command, ...rest] = argv
  if (command === 'check' && rest.length === 1) return check(rest[0])
  if (command === 'list' && rest.length === 2 && rest[1] === '--json') return list(rest[0], true)
  if (command === 'list' && rest.length === 1) return list(rest[0], false)
  throw new RecapError(USAGE)
}

try {
  const { code, output } = run(process.argv.slice(2))
  process.stdout.write(output)
  process.exitCode = code
} catch (error) {
  // 参数与环境错误只输出可读信息；非预期异常保留堆栈，便于定位脚本缺陷。
  process.stderr.write(`${error instanceof RecapError ? error.message : error.stack}\n`)
  process.exitCode = EXIT.ERROR
}
