#!/usr/bin/env node
/**
 * 进度视图：为当前项目每个活跃变更推导分级、阶段、任务勾选数、待决定条数、卡点与下一步命令；已归档变更只列名称与日期。
 *
 * 所属：skill openspec-change-progress。调用方：/opsx:progress，以及会话开始、接续变更前的 agent。
 * 数据来源（add-change-progress-view design D1、D2）：
 *   - openspec list / status --json：活跃变更、任务勾选数、规划产物是否齐全、changeRoot 与归档目录；
 *   - 门禁脚本 implementation-gate.mjs facts：分级、技术评审裁决与签字、切片证据、双轴评审、verify 报告指纹、
 *     Open Questions 条数。这些读取规则只在门禁脚本中实现，本脚本不解析变更目录的文件。
 * 推导规则见下方 RULES 常量，它是推导规则的唯一事实源，SKILL.md 只说明如何运行与阅读输出。
 *
 * 用法：node progress.mjs [--json] [--gate <path>]（在项目目录中运行）
 *   --gate 缺省为相对本脚本的 ../../openspec-technical-review/scripts/implementation-gate.mjs。
 *
 * 输出：默认 Markdown 表格，每个活跃变更一行，表格下方列出告警，最后一行写已归档变更数与最近一个；
 *   --json 输出 { root, active, archived }。
 * 退出码：0 已输出视图（单个变更读取失败也是 0，原因写入该条目的 error）；2 参数错误、openspec CLI 无法运行、
 *   找不到项目的 openspec/、找不到门禁脚本，或门禁脚本不支持 facts。
 * 只读：不写变更目录，不运行写入 git 引用、索引与工作区的命令。facts 计算实现指纹时向 git 对象库写入不可达对象，
 *   与门禁脚本的其他子命令相同，由 git gc 回收。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 退出码：已输出视图 / 参数或环境错误，与门禁脚本的 2 同义。 */
const EXIT = Object.freeze({ PASS: 0, ERROR: 2 })

/** 调用 openspec CLI 与门禁脚本的超时（design D1）：单个变更超时按该变更读取失败处理，不让整个视图卡住。 */
const TIMEOUT_MS = 60 * 1000

/** openspec CLI 每次运行都等待使用统计上报完成，断网时会卡住，因此关闭（与 evals/lib/snapshot-check.mjs 相同）。 */
const CLI_ENV = { ...process.env, OPENSPEC_TELEMETRY: '0' }

/** 门禁脚本的缺省位置（design D6）：各 agent 的 skill 安装目录都保持 <skills>/<skill 名>/ 结构。 */
const DEFAULT_GATE = fileURLToPath(new URL('../../openspec-technical-review/scripts/implementation-gate.mjs', import.meta.url))

/** 门禁脚本的用法文本中表示支持 facts 子命令的词：facts 之前的版本没有它（design D6 版本预检，评审 ARCH-02）。 */
const FACTS_COMMAND = /\bfacts\b/

/** 已归档变更的目录名：openspec archive 生成的 YYYY-MM-DD-<变更名>。 */
const ARCHIVE_DIR_NAME = /^(\d{4}-\d{2}-\d{2})-(.+)$/

/** 编码前要做技术评审的等级（gate-levels.md）；L0 豁免，MVP 命中信号时由 review 写入 review-summary.md。 */
const REVIEW_TIERS = new Set(['L1', 'L2', 'L3'])

/** 没有分级行、已有勾选任务的变更写入 notes 的说明：与门禁「历史变更不追溯」一致。 */
const HISTORICAL_NOTE = '没有分级行，按历史变更处理：不要求编码前评审'

/**
 * 是否按历史变更处理：没有分级行、已有勾选任务，与门禁「历史变更不追溯」一致。
 * R2 跳过这类变更、notes 写入 HISTORICAL_NOTE，两处共用这一个判据，阶段与说明才不会互相矛盾。
 */
const isHistorical = (tier, tasks) => tier === null && tasks.done > 0

const USAGE = '用法：node progress.mjs [--json] [--gate <path>]'

/** 参数与环境错误：只输出可读信息，退出码 2。 */
class ViewError extends Error {}

/**
 * 阶段推导规则（design D3）：按顺序判断，命中第一条就停。
 * ctx：name 变更名；tasks 为 { done, total }；complete 为规划产物是否齐全；missing 为状态不是 done 的产物 id；
 *   facts 为门禁脚本 facts 的输出。
 * archive.warnings 不参与推导，原样写入条目；Open Questions 条数只展示，不参与推导（用户 2026-10-30 决定）。
 */
const RULES = Object.freeze([
  {
    // 依据：openspec status 的 applyRequires 产物没有全部为 done 时，apply 无法开始。产物定义以 CLI 为准，openspec 支持自定义 schema。
    id: 'R1', stage: 'propose',
    when: ctx => !ctx.complete,
    blockers: ctx => [`缺少产物：${ctx.missing.join('、')}`],
    next: name => `/opsx:propose ${name}，补齐缺少的产物`,
  },
  {
    // 依据：gate-levels.md，L1–L3 编码前要做技术评审；没有分级行、也没有勾选任务的新变更按保守口径要求评审。
    // 没有分级行但已有勾选的是历史变更，不追溯；L0 与 MVP 没有 review-summary.md 时不要求评审。
    id: 'R2', stage: 'review',
    when: ({ facts, tasks }) => !facts.technicalReview.exists
      && (REVIEW_TIERS.has(facts.tier) || (facts.tier === null && !isHistorical(facts.tier, tasks))),
    blockers: () => ['未做编码前评审'],
    next: name => `/opsx:review ${name}`,
  },
  {
    // 依据：apply-gate-check.md，Gate-Verdict: BLOCKED 时即使已签字也不能 apply，未闭环 Blocker 要先回 design.md 闭环并重走门禁。
    id: 'R3', stage: 'review',
    when: ({ facts }) => facts.technicalReview.gateVerdict === 'BLOCKED',
    blockers: () => ['Gate-Verdict: BLOCKED'],
    next: name => `/opsx:update ${name}，然后 /opsx:review ${name}`,
  },
  {
    // 依据：apply-gate-check.md，缺 Gate-Verdict 行的旧版汇总要人工从门禁裁决项读裁决，脚本不猜。
    // 裁决值中没有 ASCII 词（例如「待定」）时 facts 同样给出 null：hook 不把它当作 BLOCKED，裁决是否成立也交给人工核对。
    id: 'R4', stage: 'review',
    when: ({ facts }) => facts.technicalReview.exists && facts.technicalReview.gateVerdict === null,
    blockers: () => ['没有 Gate-Verdict 行（旧格式），或裁决值无法识别'],
    next: () => '人工核对 review-summary.md 的门禁裁决项',
  },
  {
    // 依据：apply-gate-check.md，签字行空白或缺失时禁止 apply；签字只能由用户填写。
    id: 'R5', stage: 'approval',
    when: ({ facts }) => facts.technicalReview.exists && facts.technicalReview.approval !== 'signed',
    blockers: ({ facts }) => [facts.technicalReview.approval === 'missing' ? '缺少签字行' : '签字行空白'],
    next: () => '人工审阅 review/*.md 后在 review-summary.md 签字',
  },
  {
    // 依据：实现阶段以 tasks.md 的勾选数为进度，勾选数取 openspec list 的 completedTasks / totalTasks，与 openspec view 一致。
    id: 'R6', stage: 'apply',
    when: ({ tasks }) => tasks.done < tasks.total,
    blockers: ({ tasks }) => [`已勾选 ${tasks.done}/${tasks.total}`],
    next: name => `/opsx:apply ${name}`,
  },
  {
    // 依据：slice-evidence.md，证据缺失、过期或不完整的已完成切片不能归档。排在 R8 前：证据过期说明实现还在变化，
    // 双轴评审的基线取当前实现，先评审会白做。
    id: 'R7', stage: 'apply',
    when: ({ facts }) => facts.archive.evidence.issues.length > 0,
    blockers: ({ facts }) => facts.archive.evidence.issues,
    next: name => `/opsx:apply ${name}，按卡点重跑切片验证并更新证据`,
  },
  {
    // 依据：dual-axis-review.md 与门禁 reviewRequired，MVP、L2、L3 等要求双轴评审的变更，裁决不是 PASSED 时不能归档。
    id: 'R8', stage: 'quality',
    when: ({ facts }) => facts.archive.review.applicable && facts.archive.review.verdict !== 'PASSED',
    blockers: ({ facts }) => (facts.archive.review.issues.length ? facts.archive.review.issues
      : [`双轴评审裁决：${facts.archive.review.verdict}`]),
    next: name => `/opsx:quality ${name}`,
  },
  {
    // 依据：verify 报告的 Fingerprint 记录它核对的实现。facts 按 verify 写指纹的规则给出应写的指纹（声明了变更终点时为终点指纹），
    // 没有报告或指纹不一致时要重新 verify（评审 ARCH-01）。
    id: 'R9', stage: 'verify',
    when: ({ facts }) => !facts.verification.exists || facts.verification.current !== true,
    blockers: ({ facts }) => [!facts.verification.exists ? '没有 verify 报告'
      // fingerprint 为 null 既可能是没有 Fingerprint 行，也可能是值不是合法指纹（例如指纹后接说明文字），卡点写出两种原因。
      : facts.verification.fingerprint === null ? 'verify 报告没有合法的 Fingerprint（没有该行，或值不是 git-tree 指纹）'
        : 'verify 报告的指纹不是当前实现'],
    next: name => `/opsx:verify ${name}`,
  },
  {
    // 依据：archive 子命令的阻断项会让 /opsx:archive 拒绝归档。目前阻断项只来自切片证据与双轴评审（R7、R8 已处理），
    // 这条规则兜底门禁脚本以后新增的阻断项。
    id: 'R10', stage: 'verify',
    when: ({ facts }) => !facts.archive.ok,
    blockers: ({ facts }) => facts.archive.blockers,
    next: name => `处理卡点后 /opsx:verify ${name}`,
  },
  {
    // 依据：verification.md 没有固定的结论行，本脚本不判断 verify 是否通过；有 CRITICAL 时 /opsx:archive 本身会拒绝归档。
    id: 'R11', stage: 'archive',
    when: () => true,
    blockers: () => [],
    next: name => `先确认 verification.md 没有 CRITICAL，再 /opsx:archive ${name}`,
  },
])

/**
 * 运行子进程。超时、无法启动或退出码不是 0 时 failure 写出原因，不抛错：单个变更的失败不能中断整个视图。
 * @returns {{ stdout: string, failure: string|null }}
 */
function exec(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8', env: CLI_ENV, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
    // Windows 上 openspec 是 .cmd 包装脚本，不经 shell 无法启动；node 用绝对路径启动，不需要 shell。
    shell: process.platform === 'win32' && command === 'openspec',
  })
  if (result.error && result.error.code === 'ETIMEDOUT') return { stdout: '', failure: `超过 ${TIMEOUT_MS / 1000} 秒没有完成` }
  if (result.error) return { stdout: '', failure: result.error.message }
  if (result.status !== 0) {
    return { stdout: result.stdout, failure: cliMessage(result.stderr.trim() || result.stdout.trim()) || `退出码 ${result.status}` }
  }
  return { stdout: result.stdout, failure: null }
}

/** openspec CLI 出错时在标准输出写 `{ status: [{ message }] }`，取出 message；其他输出原样返回。 */
function cliMessage(text) {
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed.status)) return parsed.status.map(item => item.message).join('；')
  } catch {
    // 不是 JSON：门禁脚本与 shell 的错误信息是纯文本。
  }
  return text
}

/**
 * 运行子进程并解析标准输出的 JSON。
 * @returns {{ value: object|null, error: string|null }}
 */
function execJson(command, args) {
  const { stdout, failure } = exec(command, args)
  if (failure) return { value: null, error: failure }
  try {
    return { value: JSON.parse(stdout), error: null }
  } catch {
    return { value: null, error: `输出不是 JSON：${stdout.trim().slice(0, 200)}` }
  }
}

/** 解析命令行参数，不认识的参数按参数错误处理，不静默忽略。 */
function parseArgs(argv) {
  const options = { json: false, gate: DEFAULT_GATE }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') options.json = true
    else if (argv[i] === '--gate' && i + 1 < argv.length) options.gate = path.resolve(argv[++i])
    else throw new ViewError(`不支持的参数：${argv[i]}\n${USAGE}`)
  }
  return options
}

/**
 * 确认门禁脚本存在并支持 facts（design D6）。已安装的 skill 是各自独立的副本，只同步了本 skill 时，旧门禁脚本没有 facts，
 * 逐个变更调用只会得到用法文本；在这里收敛为一个环境错误。
 * 不带参数运行一次门禁脚本：它以退出码 2 结束，并在标准错误输出用法文本。
 * @throws {ViewError} 找不到门禁脚本，或用法文本中没有 facts。
 */
function checkGate(gate) {
  if (!existsSync(gate) || !statSync(gate).isFile()) {
    throw new ViewError(`找不到门禁脚本：${gate}。用 Glob 搜 **/openspec-technical-review/scripts/implementation-gate.mjs，再用 --gate 传入`)
  }
  const result = spawnSync(process.execPath, [gate], { encoding: 'utf8', timeout: TIMEOUT_MS })
  if (!FACTS_COMMAND.test(`${result.stdout || ''}${result.stderr || ''}`)) {
    throw new ViewError(`门禁脚本 ${gate} 不支持 facts 子命令，请同步 openspec-technical-review`)
  }
}

/**
 * 读取当前项目的活跃变更与项目根（design D1）。
 * openspec list 在没有 openspec/ 的目录中也以退出码 0 返回空列表，所以由本函数检查项目根下的 openspec/ 目录。
 * @returns {{ root: string, changes: { name: string, completedTasks: number, totalTasks: number }[] }}
 * @throws {ViewError} openspec CLI 无法运行，或找不到项目的 openspec/。
 */
function readProject() {
  const listed = execJson('openspec', ['list', '--json'])
  if (listed.error) throw new ViewError(`openspec CLI 无法运行（openspec list --json）：${listed.error}`)
  const root = listed.value.root && listed.value.root.path
  if (!root || !existsSync(path.join(root, 'openspec'))) {
    throw new ViewError(`找不到项目的 openspec/ 目录（openspec list 给出的项目根：${root || '无'}），请在项目目录中运行`)
  }
  return { root, changes: listed.value.changes || [] }
}

/**
 * 推导一个活跃变更的条目。openspec status 或 facts 失败时，阶段与下一步为 null，error 写出原因（design D3）。
 * @param {string} name 变更名。
 * @param {{ done: number, total: number }} tasks 任务勾选数。
 * @param {string} gate 门禁脚本路径；facts 沿用本进程的工作目录、不传 --repo（design D5，评审 ARCH-03）。
 * @returns {{ entry: object, changesDir: string|null }} changesDir 为 openspec status 给出的规划目录，用于定位已归档变更。
 */
function inspect(name, tasks, gate) {
  const entry = { change: name, tier: null, stage: null, tasks, openQuestions: null, rule: null,
    blockers: [], warnings: [], notes: [], next: null, error: null }
  const status = execJson('openspec', ['status', '--change', name, '--json'])
  if (status.error) return { entry: { ...entry, error: `openspec status 失败：${status.error}` }, changesDir: null }
  const changesDir = (status.value.planningHome && status.value.planningHome.changesDir) || null
  const facts = execJson(process.execPath, [gate, 'facts', status.value.changeRoot])
  if (facts.error) return { entry: { ...entry, error: `facts 失败：${facts.error}` }, changesDir }

  const artifacts = status.value.artifacts || []
  const done = id => artifacts.some(artifact => artifact.id === id && artifact.status === 'done')
  const ctx = {
    name, tasks, facts: facts.value,
    complete: (status.value.applyRequires || []).every(done),
    missing: artifacts.filter(artifact => artifact.status !== 'done').map(artifact => artifact.id),
  }
  const rule = RULES.find(item => item.when(ctx))
  const historical = isHistorical(facts.value.tier, tasks) ? [HISTORICAL_NOTE] : []
  return {
    entry: { ...entry, tier: facts.value.tier, stage: rule.stage, openQuestions: facts.value.openQuestions, rule: rule.id,
      blockers: rule.blockers(ctx), warnings: facts.value.archive.warnings, notes: [...historical, ...facts.value.archive.notes],
      next: rule.next(name) },
    changesDir,
  }
}

/**
 * 列出已归档变更（design D1）：只读目录名，不运行门禁。归档后的提交会让切片证据过期，在已归档变更上运行门禁只会得到假阻断项。
 * @param {string} changesDir 规划目录的 changes/，归档目录为其下的 archive/。
 * @returns {{ name: string, date: string|null }[]} 目录名不是 YYYY-MM-DD-<名称> 时 name 为目录名、date 为 null。
 */
function listArchived(changesDir) {
  const dir = path.join(changesDir, 'archive')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()
    .map(name => {
      const match = ARCHIVE_DIR_NAME.exec(name)
      return match ? { name: match[2], date: match[1] } : { name, date: null }
    })
}

/** 表格单元格：合并换行与连续空白，转义竖线，保证每个变更只占一行。 */
const cell = value => String(value).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()

/** 卡点列只写一条，多于一条时附总数；读取失败时写失败原因。 */
function blockerCell(item) {
  if (item.error) return `读取失败：${item.error}`
  if (!item.blockers.length) return '无'
  return item.blockers.length === 1 ? item.blockers[0] : `${item.blockers[0]}（共 ${item.blockers.length} 条）`
}

/**
 * 渲染 Markdown 表格（design D5）：列为变更、分级、阶段、任务、待决定、卡点、下一步；表格下方列出告警，
 * 最后一行写已归档变更数与最近一个。
 */
function renderTable(view) {
  const lines = []
  if (view.active.length) {
    lines.push('| 变更 | 分级 | 阶段 | 任务 | 待决定 | 卡点 | 下一步 |', '|---|---|---|---|---|---|---|')
    for (const item of view.active) {
      const row = [item.change, item.tier || '—', item.stage || '—', `${item.tasks.done}/${item.tasks.total}`,
        item.openQuestions ? item.openQuestions.pending : '—', blockerCell(item), item.next || '—']
      lines.push(`| ${row.map(cell).join(' | ')} |`)
    }
  } else {
    lines.push('没有活跃变更。')
  }
  const warnings = view.active.flatMap(item => item.warnings.map(text => `- ${item.change}：${cell(text)}`))
  if (warnings.length) lines.push('', '告警：', ...warnings)
  const latest = view.archived.filter(item => item.date).reduce((last, item) => (!last || item.date >= last.date ? item : last), null)
  lines.push('', `已归档 ${view.archived.length} 个${latest ? `（最近：${latest.date} ${latest.name}）` : ''}`)
  return `${lines.join('\n')}\n`
}

/**
 * 生成进度视图。
 * @param {string[]} argv 命令行参数（不含 node 与脚本路径）。
 * @returns {string} 标准输出内容。
 */
function main(argv) {
  const options = parseArgs(argv)
  // 先预检门禁脚本：版本不匹配时不输出任何条目（design D6）。
  checkGate(options.gate)
  const { root, changes } = readProject()
  let changesDir = null
  const active = changes.map(item => {
    const result = inspect(item.name, { done: item.completedTasks, total: item.totalTasks }, options.gate)
    changesDir = changesDir || result.changesDir
    return result.entry
  })
  // 归档目录取 openspec status 的 planningHome.changesDir，与 openspec-archive-change 相同；没有活跃变更时退回项目根下的默认位置（评审 ARCH-03）。
  const view = { root, active, archived: listArchived(changesDir || path.join(root, 'openspec', 'changes')) }
  return options.json ? `${JSON.stringify(view, null, 2)}\n` : renderTable(view)
}

try {
  process.stdout.write(main(process.argv.slice(2)))
} catch (error) {
  // 参数与环境错误只输出可读信息；非预期异常保留堆栈，便于定位脚本缺陷。
  process.stderr.write(`${error instanceof ViewError ? error.message : error.stack}\n`)
  process.exitCode = EXIT.ERROR
}
