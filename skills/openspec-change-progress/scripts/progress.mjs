#!/usr/bin/env node
/**
 * 进度视图：为当前项目每个活跃变更推导分级、阶段、任务勾选数、待决定条数、卡点与下一步命令；已归档变更只列名称与日期。
 *
 * 所属：skill openspec-change-progress。调用方：/opsx:progress，以及会话开始、接续变更前的 agent。
 * 数据来源（add-change-progress-view design D1、D2）：
 *   - openspec list / status --json：活跃变更、任务勾选数、规划产物是否齐全、changeRoot 与归档目录；
 *   - 门禁脚本 implementation-gate.mjs facts：分级、技术评审裁决与签字、切片证据、双轴评审、verify 报告的指纹与结论字段、
 *     Open Questions 条数。这些读取规则只在门禁脚本中实现，本脚本不解析变更目录的文件。
 * 推导规则见下方 RULES 常量，它是推导规则的唯一事实源，SKILL.md 只说明如何运行与阅读输出。
 *
 * 用法：node progress.mjs [--json] [--gate <path>]（在项目目录中运行）
 *   --gate 缺省为相对本脚本的 ../../openspec-technical-review/scripts/implementation-gate.mjs。--gate 只选择候选，不授予信任：
 *   门禁的真实路径须为可信安装根下的约定位置（统一安装根 ~/.tigger/skills，或本机托管配置 trustedSkillRoots 登记的根），
 *   且不在项目检出中（add-change-pause design D2，评审 SEC-12）。
 *
 * 输出：默认 Markdown 表格，每个活跃变更一行，表格下方列出告警与变更状态备注，两个以上变更已开始实现且未暂缓时输出提示，
 *   最后一行写已归档变更数与最近一个；--json 输出 { root, active, implementing, archived, changeStateVersion }。
 * 退出码：0 已输出视图（单个变更读取失败也是 0，原因写入该条目的 error）；2 参数错误、openspec CLI 无法运行、
 *   找不到项目的 openspec/、找不到门禁脚本、门禁来源无法核验、本机托管配置无法解析，或门禁脚本不支持 facts。
 * 只读：不写变更目录，不运行写入 git 引用、索引与工作区的命令。facts 计算实现指纹时向 git 对象库写入不可达对象，
 *   与门禁脚本的其他子命令相同，由 git gc 回收。
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
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

/** 门禁在可信安装根下的约定位置。 */
const GATE_RELATIVE = path.join('openspec-technical-review', 'scripts', 'implementation-gate.mjs')

/** 本机统一安装根（ADR-0013）：按操作系统的用户主目录定位，不按本脚本的位置推导（add-change-pause design D2，评审 SEC-12）。 */
const UNIFIED_SKILLS = ['.tigger', 'skills']

/** 本机托管目录的缺省名与环境变量，与 openspec-autopilot 的 lib/home.mjs 相同；独立查询只读其中的 config.json。 */
const AUTOPILOT_HOME_NAME = '.openspec-autopilot'

/** 门禁来源无法核验时的处理提示。 */
const TRUST_HINT = '请把 skill 同步到 ~/.tigger/skills，或在本机托管配置（OPENSPEC_AUTOPILOT_HOME 或 ~/.openspec-autopilot 下的 config.json）的 trustedSkillRoots 中登记安装根'

/** 变更状态契约版本，与门禁 facts 的 changeStateVersion 相同（add-change-pause design D2）。 */
const CHANGE_STATE_VERSION = 1

/** facts.changeState 必须包含的字段；进度视图只核对信封并复制，不解析状态文件。 */
const CHANGE_STATE_KEYS = ['state', 'reason', 'updatedAt', 'error', 'digest']

/** 门禁副本早于状态契约时条目的状态错误：两个副本只同步一个时，暂缓不能被识别。 */
const STATE_CONTRACT_MISSING = '门禁脚本副本没有变更状态契约，同步 openspec-technical-review 副本'

/** 暂缓条目的下一步（design D4）：先恢复推进；<AUTOPILOT> 表示已安装托管脚本的目录。 */
const resumeCommand = name => `node <AUTOPILOT>/autopilot.mjs resume ${name}`

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

/**
 * 实现阶段：apply 到 archive 之间（phases.md「同一检出只实现一个变更」）。实现指纹按整个工作区计算、只排除规划目录，
 * 两个变更同时改代码时，各自的切片证据过期，双轴评审与 verify 的 diff 也含对方的代码。
 */
const IMPLEMENTATION_STAGES = new Set(['apply', 'quality', 'verify', 'archive'])

/** 同一检出中同一时间允许已开始实现的变更数，超过时视图输出提示，不阻断任何命令。 */
const MAX_IMPLEMENTING = 1

/**
 * 是否已开始实现：阶段在实现阶段中，并且已有勾选任务或阶段在 apply 之后。
 * 阶段为 apply、没有勾选任务的变更不计入：L0 与 MVP 变更 propose 后直接进入 apply 阶段，计入后 propose 就不能并行。
 * 代价是已开始改代码、还没勾选任务的变更看不出来。读取失败的条目阶段为 null，不计入。
 */
const isImplementing = entry => IMPLEMENTATION_STAGES.has(entry.stage) && (entry.tasks.done > 0 || entry.stage !== 'apply')

/** 门禁副本没有 archive.review.stale 时 R8 的卡点（add-autopilot-loop 评审 ARCH-18）：两个副本只同步一个时，R8 的新条件会静默失效。 */
const STALE_MISSING_BLOCKER = '门禁脚本副本没有 archive.review.stale，同步 openspec-technical-review 副本'

/**
 * 条目的 reviewStale（add-autopilot-loop 评审 ARCH-18）：双轴评审适用时取门禁的 archive.review.stale；不适用时为 false；
 * 适用而门禁没有给出布尔值（门禁副本早于该字段）时为 null。托管读这个字段判断两个副本是否同步，null 时拒绝运行。
 */
const reviewStaleOf = review => (!review.applicable ? false : typeof review.stale === 'boolean' ? review.stale : null)

const USAGE = '用法：node progress.mjs [--json] [--gate <path>]'

/** 参数与环境错误：只输出可读信息，退出码 2。 */
class ViewError extends Error {}

/**
 * 阶段推导规则（design D3）：按顺序判断，命中第一条就停。
 * ctx：name 变更名；tasks 为 { done, total }；complete 为规划产物是否齐全；missing 为状态不是 done 的产物 id；
 *   facts 为门禁脚本 facts 的输出。next 的参数为 (name, ctx)。
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
    // 裁决为 PASSED 后实现又有变化（门禁 archive.review.stale 为 true）时同样回到 quality：quality 询问后用户选「修复」，
    // apply 改了代码，修复的代码要经过两轴评审（add-autopilot-loop 评审 ARCH-12）。stale 只有注释差异或只登记为仅测试时为 false，
    // 不会在 quality 与 apply 之间循环。stale 不是 false（门禁副本早于该字段，值为 undefined）时也成立：不知道评审是否过期时不放行，
    // 与 R11 对 verification.legacy 的处理同一原则（评审 ARCH-18）。
    id: 'R8', stage: 'quality',
    when: ({ facts }) => facts.archive.review.applicable
      && (facts.archive.review.verdict !== 'PASSED' || facts.archive.review.stale !== false),
    blockers: ({ facts }) => {
      const { issues, verdict, stale } = facts.archive.review
      const reasons = issues.length ? issues
        : verdict !== 'PASSED' ? [`双轴评审裁决：${verdict}`]
          : stale === true ? ['双轴评审裁决为 PASSED，评审后实现有变化'] : []
      return typeof stale === 'boolean' ? reasons : [...reasons, STALE_MISSING_BLOCKER]
    },
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
    // 依据：archive 子命令的阻断项会让 /opsx:archive 拒绝归档。切片证据与双轴评审的阻断项由 R7、R8 先处理，
    // 到这里的阻断项来自 verify 结论（`verify 报告：` 开头，add-verify-verdict design D6），以及门禁脚本以后新增的阻断项。
    id: 'R10', stage: 'verify',
    when: ({ facts }) => !facts.archive.ok,
    blockers: ({ facts }) => facts.archive.blockers,
    next: name => `处理卡点后 /opsx:verify ${name}`,
  },
  {
    // 依据：报告有结论字段时（facts.verification.legacy 为 false），到这里说明结论为 PASS 且没有 CRITICAL，可以直接归档
    // （add-verify-verdict design D6）。没有结论字段的旧报告仍要先确认没有 CRITICAL；旧门禁脚本的 facts 没有 legacy 字段，
    // 值为 undefined，同样按旧报告处理，不会误放行（design 风险 R3）。有 CRITICAL 时 /opsx:archive 本身会拒绝归档。
    id: 'R11', stage: 'archive',
    when: () => true,
    blockers: () => [],
    next: (name, { facts }) => (facts.verification.legacy === false ? `/opsx:archive ${name}`
      : `先确认 verification.md 没有 CRITICAL，再 /opsx:archive ${name}`),
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
 * 读取本机托管配置中的可信安装根与项目检出。独立查询不要求配置项目或运行调度：配置文件不存在时两项都为空。
 * @returns {{ trustedSkillRoots: string[], projects: string[] }}
 * @throws {ViewError} 配置存在但不能读取、不是 JSON，或 trustedSkillRoots、projects 的格式无效。
 */
function autopilotConfig() {
  const fromEnv = process.env.OPENSPEC_AUTOPILOT_HOME
  const home = fromEnv && fromEnv.trim() ? path.resolve(fromEnv.trim()) : path.join(homedir(), AUTOPILOT_HOME_NAME)
  const file = path.join(home, 'config.json')
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { trustedSkillRoots: [], projects: [] }
    throw new ViewError(`本机托管配置无法读取：${file}（${error.code || error.message}）`)
  }
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new ViewError(`本机托管配置不是合法 JSON：${file}`)
  }
  const roots = value?.trustedSkillRoots ?? []
  const projects = value?.projects ?? []
  if (!value || typeof value !== 'object' || !Array.isArray(roots) || roots.some(root => typeof root !== 'string' || !path.isAbsolute(root))
      || !Array.isArray(projects) || projects.some(project => typeof project?.root !== 'string')) {
    throw new ViewError(`本机托管配置的 trustedSkillRoots 或 projects 无效：${file}`)
  }
  return { trustedSkillRoots: roots, projects: projects.map(project => project.root) }
}

/** 解析真实路径；路径不存在时为 null（不存在的根或检出不能包含门禁）。 */
function realOrNull(target) {
  try {
    return realpathSync.native(target)
  } catch {
    return null
  }
}

/** 目标是否在目录之内（含目录本身）。 */
function inside(target, dir) {
  const relative = path.relative(dir, target)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/**
 * 在探测用法或执行 facts 之前核验门禁候选的来源（add-change-pause design D2，评审 SEC-12）。
 * 进度脚本自身的位置不是信任依据：缺省门禁与本脚本同在未登记的副本中时，候选不在可信根下，同样拒绝。
 * @param {string} gate 候选路径（缺省门禁或 --gate）。
 * @param {string} root openspec list 给出的项目根；它与它所在 git 检出的根都不能包含门禁。
 * @returns {string} 门禁的真实路径；之后只运行这个路径，不回退到其他门禁。
 * @throws {ViewError} 找不到候选、候选不是普通文件、位于项目检出中，或不在可信根的约定位置。
 */
function verifyGateSource(gate, root) {
  const actual = realOrNull(gate)
  if (!actual || !statSync(actual).isFile()) {
    throw new ViewError(`找不到门禁脚本：${gate}。用 Glob 搜 **/openspec-technical-review/scripts/implementation-gate.mjs，再用 --gate 传入`)
  }
  const config = autopilotConfig()
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', timeout: TIMEOUT_MS })
  const checkouts = [root, top.status === 0 ? top.stdout.trim() : null, ...config.projects].filter(Boolean).map(realOrNull).filter(Boolean)
  const roots = [path.join(homedir(), ...UNIFIED_SKILLS), ...config.trustedSkillRoots].map(realOrNull).filter(Boolean)
  const reason = checkouts.some(checkout => inside(actual, checkout)) ? '位于项目检出中'
    : roots.some(trusted => actual === path.join(trusted, GATE_RELATIVE)) ? null : '不在可信安装根的约定位置'
  if (reason) throw new ViewError(`门禁脚本 ${gate} 的安装来源无法核验（${reason}）。${TRUST_HINT}`)
  return actual
}

/**
 * 确认门禁脚本存在并支持 facts（design D6）。已安装的 skill 是各自独立的副本，只同步了本 skill 时，旧门禁脚本没有 facts，
 * 逐个变更调用只会得到用法文本；在这里收敛为一个环境错误。
 * 不带参数运行一次门禁脚本：它以退出码 2 结束，并在标准错误输出用法文本。调用前已由 verifyGateSource 核验来源。
 * @throws {ViewError} 用法文本中没有 facts。
 */
function checkGate(gate) {
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

/** 状态不可读时的状态值：字段与门禁的 changeState 相同。 */
const unknownState = error => ({ state: 'unknown', reason: null, updatedAt: null, error, digest: null })

/**
 * 从 facts 复制变更状态与目录身份，只核对跨进程信封，不解析状态文件（add-change-pause design D2、D4）。
 * 契约字段缺失或格式不符时按未知状态处理；明确的 changeDirectory: null 表示目录无法核实，不是缺字段。
 * @param {object} facts 门禁 facts 的输出。
 * @returns {{ contract: boolean, changeState: object, changeDirectory: object|null }} contract 为门禁是否提供了契约 1。
 */
function stateOf(facts) {
  const state = facts.changeState
  const directory = facts.changeDirectory
  const directoryOk = directory === null || (!!directory && typeof directory === 'object'
    && ['path', 'dev', 'ino'].every(key => typeof directory[key] === 'string'))
  const contract = facts.changeStateVersion === CHANGE_STATE_VERSION && !!state && typeof state === 'object'
    && CHANGE_STATE_KEYS.every(key => Object.prototype.hasOwnProperty.call(state, key))
    && ['enabled', 'paused', 'unknown'].includes(state.state) && Object.prototype.hasOwnProperty.call(facts, 'changeDirectory') && directoryOk
    // 门禁只在目录实例核实后给出 enabled 或 paused；没有目录身份的可用状态不符合契约。
    && (state.state === 'unknown' || directory !== null)
  if (!contract) return { contract: false, changeState: unknownState(STATE_CONTRACT_MISSING), changeDirectory: null }
  return { contract: true, changeState: state, changeDirectory: directory }
}

/**
 * 暂缓与未知状态只覆盖显示的下一步，不改变阶段、规则、任务与卡点（add-change-pause design D4）。
 * @returns {string} 条目最终的 next。
 */
function nextFor(name, changeState, ruleNext) {
  if (changeState.state === 'paused') return resumeCommand(name)
  if (changeState.state !== 'unknown') return ruleNext
  // 状态未知时不推荐 apply 或托管：先修复状态，或同步早于契约的门禁副本。
  return changeState.error === STATE_CONTRACT_MISSING ? '同步 openspec-technical-review 副本后重新运行进度视图'
    : '修复变更状态（见状态备注）后重新运行进度视图'
}

/**
 * 推导一个活跃变更的条目。openspec status 或 facts 失败时，阶段与下一步为 null，error 写出原因（design D3）。
 * @param {string} name 变更名。
 * @param {{ done: number, total: number }} tasks 任务勾选数。
 * @param {string} gate 已核验来源的门禁脚本真实路径。
 * @param {string} root openspec list 给出的项目根，显式传给 facts 的 --repo，不由变更目录推导（add-change-pause 评审 SEC-13）。
 * @returns {{ entry: object, changesDir: string|null, contract: boolean|null }} changesDir 为 openspec status 给出的规划目录，
 *   用于定位已归档变更；contract 为门禁是否提供状态契约 1，facts 读取失败时为 null。
 */
function inspect(name, tasks, gate, root) {
  // 门禁读取失败的条目没有可用的状态与目录身份，两项为 null（design D4）。
  const entry = { change: name, tier: null, stage: null, tasks, openQuestions: null, rule: null,
    blockers: [], warnings: [], notes: [], reviewStale: null, next: null, error: null, changeState: null, changeDirectory: null }
  const status = execJson('openspec', ['status', '--change', name, '--json'])
  if (status.error) return { entry: { ...entry, error: `openspec status 失败：${status.error}` }, changesDir: null, contract: null }
  const changesDir = (status.value.planningHome && status.value.planningHome.changesDir) || null
  const facts = execJson(process.execPath, [gate, 'facts', status.value.changeRoot, '--repo', root])
  if (facts.error) return { entry: { ...entry, error: `facts 失败：${facts.error}` }, changesDir, contract: null }

  const artifacts = status.value.artifacts || []
  const done = id => artifacts.some(artifact => artifact.id === id && artifact.status === 'done')
  const ctx = {
    name, tasks, facts: facts.value,
    complete: (status.value.applyRequires || []).every(done),
    missing: artifacts.filter(artifact => artifact.status !== 'done').map(artifact => artifact.id),
  }
  const rule = RULES.find(item => item.when(ctx))
  const historical = isHistorical(facts.value.tier, tasks) ? [HISTORICAL_NOTE] : []
  const { contract, changeState, changeDirectory } = stateOf(facts.value)
  return {
    entry: { ...entry, tier: facts.value.tier, stage: rule.stage, openQuestions: facts.value.openQuestions, rule: rule.id,
      blockers: rule.blockers(ctx), warnings: facts.value.archive.warnings, notes: [...historical, ...facts.value.archive.notes],
      reviewStale: reviewStaleOf(facts.value.archive.review), next: nextFor(name, changeState, rule.next(name, ctx)),
      changeState, changeDirectory },
    changesDir,
    contract,
  }
}

/** 多变更提示只统计未暂缓的已实现条目；implementing 数组本身保留全部历史名称（design D4）。 */
const occupying = view => view.implementing.filter(name => view.active.find(item => item.change === name)?.changeState?.state !== 'paused')

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

/** 普通文本显示时的转义：原因与状态错误不能改变表格结构，也不能伪造出新行（add-change-pause design D1「原因的可见范围」）。 */
const PLAIN_ESCAPES = { '\\': '\\\\', '|': '\\|', '\n': '\\n', '\r': '\\r', '\t': '\\t' }

/** 转义反斜杠、换行、控制字符、行分隔符与表格分隔符，原因按普通文本显示，不作为指令。 */
const plainText = text => String(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029|\\]/gu,
  char => PLAIN_ESCAPES[char] ?? `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}`)

/** 变更状态备注：暂缓写原因与时间，状态未知写错误；继续推进与读取失败的条目不写。 */
function stateNote(item) {
  const state = item.changeState
  if (!state || state.state === 'enabled') return null
  if (state.state === 'paused') return `- ${item.change}：暂缓。原因：${plainText(state.reason)}；时间：${plainText(state.updatedAt)}`
  return `- ${item.change}：状态无法核验。${plainText(state.error || '没有错误说明')}`
}

/** 卡点列只写一条，多于一条时附总数；读取失败时写失败原因。 */
function blockerCell(item) {
  if (item.error) return `读取失败：${item.error}`
  if (!item.blockers.length) return '无'
  return item.blockers.length === 1 ? item.blockers[0] : `${item.blockers[0]}（共 ${item.blockers.length} 条）`
}

/**
 * 渲染 Markdown 表格（design D5）：列为变更、分级、变更状态、阶段、任务、待决定、卡点、下一步；表格下方列出告警与变更状态备注，
 * 未暂缓的已实现变更超过 MAX_IMPLEMENTING 时输出提示（add-change-pause design D4），最后一行写已归档变更数与最近一个。
 */
function renderTable(view) {
  const lines = []
  if (view.active.length) {
    lines.push('| 变更 | 分级 | 变更状态 | 阶段 | 任务 | 待决定 | 卡点 | 下一步 |', '|---|---|---|---|---|---|---|---|')
    for (const item of view.active) {
      const row = [item.change, item.tier || '—', item.changeState?.state || '—', item.stage || '—', `${item.tasks.done}/${item.tasks.total}`,
        item.openQuestions ? item.openQuestions.pending : '—', blockerCell(item), item.next || '—']
      lines.push(`| ${row.map(cell).join(' | ')} |`)
    }
  } else {
    lines.push('没有活跃变更。')
  }
  const warnings = view.active.flatMap(item => item.warnings.map(text => `- ${item.change}：${cell(text)}`))
  if (warnings.length) lines.push('', '告警：', ...warnings)
  const notes = view.active.map(stateNote).filter(Boolean)
  if (notes.length) lines.push('', '变更状态：', ...notes)
  const busy = occupying(view)
  if (busy.length > MAX_IMPLEMENTING) {
    lines.push('', `提示：${busy.length} 个变更已开始实现（${busy.join('、')}）。同一检出同一时间只实现一个变更：`
      + '另一个变更修改代码会让本变更的切片证据过期，评审的 diff 也含对方的代码。先把一个变更做到归档，再继续另一个'
      + '（phases.md「同一检出只实现一个变更」）。')
  }
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
  // openspec list 不运行门禁；先取项目根，才能确认门禁不在项目检出中（add-change-pause design D2）。
  const { root, changes } = readProject()
  // 先核验来源，再预检门禁脚本：来源或版本不符时不运行候选、不输出任何条目（design D6，评审 SEC-12）。
  const gate = verifyGateSource(options.gate, root)
  checkGate(gate)
  let changesDir = null
  const reads = []
  const active = changes.map(item => {
    const result = inspect(item.name, { done: item.completedTasks, total: item.totalTasks }, gate, root)
    changesDir = changesDir || result.changesDir
    if (result.contract !== null) reads.push(result.contract)
    return result.entry
  })
  // 归档目录取 openspec status 的 planningHome.changesDir，与 openspec-archive-change 相同；没有活跃变更时退回项目根下的默认位置（评审 ARCH-03）。
  // 只有每次成功读取的门禁都提供契约 1 时才声明顶层版本；没有成功读取时不能证明门禁副本支持契约（design D4）。
  const view = { root, active, implementing: active.filter(isImplementing).map(item => item.change),
    archived: listArchived(changesDir || path.join(root, 'openspec', 'changes')),
    changeStateVersion: reads.length && reads.every(Boolean) ? CHANGE_STATE_VERSION : null }
  return options.json ? `${JSON.stringify(view, null, 2)}\n` : renderTable(view)
}

try {
  process.stdout.write(main(process.argv.slice(2)))
} catch (error) {
  // 参数与环境错误只输出可读信息；非预期异常保留堆栈，便于定位脚本缺陷。
  process.stderr.write(`${error instanceof ViewError ? error.message : error.stack}\n`)
  process.exitCode = EXIT.ERROR
}
