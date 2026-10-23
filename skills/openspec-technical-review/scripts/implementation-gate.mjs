#!/usr/bin/env node
/**
 * 实现阶段门禁的确定性校验：实现指纹、双轴评审完整性、切片新鲜证据与归档前置阻断。
 *
 * 所属：skill openspec-technical-review（门禁口径中枢）。调用方：/opsx:apply（写证据前取指纹）、
 * /opsx:quality（生成固定基线、校验双轴报告）、/opsx:verify 与 /opsx:archive（证据与评审闭环校验），
 * 以及对应的 openspec-* skill。规则事实源（本脚本只做确定性判定，不重复规则说明）：
 *   - 双轴评审：openspec-code-quality/shared/dual-axis-review.md（是否必需按分级：L2/L3 必需，L0/L1 只推荐，见 reviewRequired）
 *   - 切片证据：openspec-apply-change/shared/slice-evidence.md
 *   - 实现后修改登记：openspec-apply-change/shared/post-implementation-changes.md
 *   - verify / archive 如何解读输出：openspec-technical-review/shared/implementation-gate-check.md
 *
 * 用法：
 *   node implementation-gate.mjs fingerprint <changeRoot> [--repo <dir>]
 *   node implementation-gate.mjs baseline    <changeRoot> [--base <rev>] [--since <fingerprint>] [--repo <dir>]
 *   node implementation-gate.mjs classify    <changeRoot> --from <fingerprint> [--to <fingerprint>] [--repo <dir>]
 *   node implementation-gate.mjs review      <changeRoot> [--repo <dir>]
 *   node implementation-gate.mjs evidence    <changeRoot> [--repo <dir>]
 *   node implementation-gate.mjs archive     <changeRoot> [--repo <dir>]
 *   node implementation-gate.mjs hygiene     <changeRoot>
 *   node implementation-gate.mjs regress     --baseline <file> --actual <file>
 *
 * 输出：fingerprint 输出一行指纹；baseline 输出 Markdown 基线区块（--since 给出时追加增量范围）；其余输出 JSON。
 * classify 比较两个指纹（--to 默认取当前指纹），列出只有注释与空白差异的文件（commentOnly）与其他文件（other），
 * other 中未在 tasks.md「## 实现后修改登记」表登记的文件（unregistered）不为空时退出码 1；tree 对象不存在时退出码 2。
 * regress 比较实际失败清单与已知基线失败清单，只有本次引入的失败（introduced）影响退出码。
 * hygiene 列出变更目录中允许清单外的产物，只给 warning，退出码恒为 0（参数错误除外）。
 * 退出码：0 通过；1 存在阻断项；2 参数或环境错误（非 git 仓库、变更目录不存在等）。
 *
 * 实现指纹：在临时 index 中以 HEAD 为种子写入工作区全部改动（含未跟踪文件，遵守 .gitignore），
 * 移除规划目录（changeRoot 的上两级，通常为 openspec/）后取 git tree 哈希，记为 `git-tree:<sha>`。
 *   - 不改用户的 index、不提交；唯一副作用是向对象库写入不可达对象，由 git gc 按默认策略回收。
 *   - 排除规划目录，保证写证据、勾选 tasks.md、写评审报告不会改变指纹。
 *   - 对象写入对象库后，两个指纹之间可用 git diff-tree 求出变化文件，供过期判定与豁免核实。
 */

import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
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

/**
 * 评审规则版本：baseline 输出 `Rules Version: 2`，带该行的报告启用 Blocker 判据前缀与 Finding 台账检查。
 * 没有该行的旧报告按旧规则检查。
 */
const RULES_VERSION = '2'

/**
 * 可缺省的基线身份字段：旧报告或首轮评审没有这些行时不报缺失，但三份报告取值（含缺省）必须一致。
 * Delta Since 只在第 2 轮起的增量基线中出现。
 */
const OPTIONAL_BASELINE_KEYS = ['Rules Version', 'Delta Since']

/** 实现后 Blocker 判据编号（B1–B5，判据表见 dual-axis-review.md）：触发场景必须以其开头。 */
const BLOCKER_CRITERION = /^\[B[1-5]\]/

/** 累计台账区块标题。 */
const LEDGER_TITLE = 'Finding 台账'

/** tasks.md 中实现后修改登记表的区块标题（格式见 openspec-apply-change/shared/post-implementation-changes.md）。 */
const CHANGE_LEDGER_TITLE = '实现后修改登记'

/** 修改档位，按风险从低到高排列：同一文件登记多行时取最高档位。 */
const CHANGE_TIERS = ['非行为', '等价', '行为']

/**
 * 三个档位的具名常量，与 CHANGE_TIERS 的顺序一一对应。CHANGE_TIERS 的字面量写法不变：文档一致性测试按字面量读取档位。
 *   - NON_BEHAVIOR_TIER：只有注释差异；classify 判为 other 的文件登记为该档位属于错登。
 *   - EQUIVALENT_TIER：行为不变的修改；唯一可以沿用 Spec Fidelity 的档位。
 *   - BEHAVIOR_TIER：行为修改；两轴都要重跑。
 */
const [NON_BEHAVIOR_TIER, EQUIVALENT_TIER, BEHAVIOR_TIER] = CHANGE_TIERS

/** 没有任何有效登记行列出该文件时的原因：只列入 unregistered，不另写 issues。 */
const NOT_REGISTERED = '未登记'

/** 沿用轮在汇总报告中写的字段名（格式见 dual-axis-review.md「修复与重跑」）。 */
const CARRIED_AXIS_KEY = 'Carried Axis'

/** 唯一可以沿用的评审轴：等价修改正是 Standards 要审查的内容，因此只有 Spec Fidelity 可以沿用。 */
const CARRIABLE_AXIS = Object.freeze({ value: 'spec-fidelity', file: 'review/spec-fidelity.md' })

/** 重跑时的上轮闭环验证区块标题（格式见 closed-loop-verification.md）。 */
const CLOSURE_TITLE = '上轮闭环验证'

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

/** finding ID 格式（如 `STD-01`）：Findings 表与 Finding 台账共用。 */
const FINDING_ID = /^[A-Z]+-\d+$/

/**
 * 测试名形式的闭环依据：`类名.方法名` 或 `类名#方法名`（如 `OrderTest.createsOrder`）。
 * 排除源文件与文档扩展名：`OrderService.java`、`README.md` 是文件名，没有指到具体行。
 */
const TEST_NAME = /\b[A-Z][\w$]*[.#](?!(?:java|kt|kts|groovy|scala|js|mjs|cjs|jsx|ts|tsx|vue|py|go|rb|php|cs|swift|rs|c|cc|cpp|h|hpp|sql|sh|md|txt|json|ya?ml|xml|html|css|properties|gradle)\b)[a-z_$][\w$]*\b/

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
 * 读取两个指纹之间每个变化文件的 diff-tree 记录。changedFiles 与 classifyChanges 共用，两处列出的文件名一致。
 * -z 输出不转义路径：含双引号、制表符的文件名按原样返回。不做改名检测：改名的文件按删除加新增处理。
 * @returns {{ file: string, modeA: string, modeB: string, blobA: string, blobB: string, status: string }[]|null}
 *   指纹不是 git-tree 格式或 tree 对象不存在（可能已被 git gc 回收）时返回 null。
 */
function diffTreeEntries(repo, from, to) {
  const a = GIT_TREE_FINGERPRINT.exec(from)
  const b = GIT_TREE_FINGERPRINT.exec(to)
  if (!a || !b) return null
  if (![a[1], b[1]].every(sha => tryGit(repo, ['cat-file', '-e', `${sha}^{tree}`]) !== null)) return null
  const fields = git(repo, ['diff-tree', '-r', '-z', '--no-renames', a[1], b[1]]).split('\0')
  const entries = []
  for (let k = 0; k + 1 < fields.length; k += 2) {
    const [modeA, modeB, blobA, blobB, status] = fields[k].replace(/^:/, '').split(' ')
    entries.push({ file: fields[k + 1], modeA, modeB, blobA, blobB, status })
  }
  return entries
}

/**
 * 两个指纹之间实际变化的文件。
 * @returns {string[]|null} 变化文件列表；指纹不是 git-tree 格式或对象已被回收、无法核实时返回 null。
 */
function changedFiles(repo, from, to) {
  const entries = diffTreeEntries(repo, from, to)
  return entries && entries.map(entry => entry.file)
}

/**
 * 生成评审基线区块：两轴原始报告与汇总报告原样粘贴同一块。
 * @param {string} baseRev 变更起点（省略取 HEAD）。
 * @param {string} [since] 上一轮基线指纹；给出时追加 `Delta Since` 与变化文件列表，第 2 轮起只审查该增量。
 * @returns {{ output: string, warnings: string[] }} warnings 写到 stderr，不进入基线区块。
 * @throws {GateError} 起点提交无法解析，或 since 不是 git-tree 指纹时抛出。
 */
function renderBaseline(repo, changeRoot, baseRev, since) {
  const rev = baseRev || 'HEAD'
  const base = tryGit(repo, ['rev-parse', '--verify', '-q', `${rev}^{commit}`])
  if (!base) throw new GateError(`无法解析基线提交：${rev}（尚无提交时请先提交或用 --base 指定）`)
  if (since && !GIT_TREE_FINGERPRINT.test(since)) throw new GateError(`--since 不是 git-tree 指纹：${since}`)
  const planning = planningDir(repo, changeRoot)
  const fingerprint = computeFingerprint(repo, changeRoot)
  const warnings = []
  const delta = []
  if (since) {
    const files = changedFiles(repo, since, fingerprint)
    if (files === null) {
      warnings.push(`warning: 上一轮指纹 ${since} 的 tree 对象不存在（可能已被 git gc 回收），本轮回退为全量审查`)
    } else {
      delta.push(`- Delta Since: ${since}`, '- Delta Files:', ...(files.length ? files : ['（无变化）']).map(file => `  - ${file}`))
    }
  }
  const output = [
    '## 评审基线',
    '',
    `- Change: ${path.basename(changeRoot)}`,
    `- Base Commit: ${base}`,
    `- Fingerprint: ${fingerprint}`,
    `- Review Scope: ${base.slice(0, 12)}..工作区（含已暂存 / 未暂存 / 未跟踪文件，${planning ? `排除 ${planning}` : '无排除目录'}）`,
    `- Rules Version: ${RULES_VERSION}`,
    ...delta,
    `- Baseline Recorded At: ${new Date().toISOString()}`,
    '',
  ].join('\n')
  return { output, warnings }
}

// ============================================================================
// 注释差异识别（classify；规则见 design D2，不支持的文件类型与原因见 ADR-0006）
// ============================================================================
//
// 安全方向：把注释误判为代码只会多登记一次；把代码误判为注释会让行为修改绕过验证。
// 因此方言或写法有歧义、扫描无法闭合时，整份文件一律按代码处理（规范化函数返回 null）。

/** 字面量在代码文本中的占位符：含 NUL 的文件已按二进制排除，占位符不会与原文冲突。 */
const LITERAL_PLACEHOLDER = '\u0000'

/** 行注释在这里结束（不含换行符）。 */
const LINE_BREAK = /[\n\r]/g

/** 行注释的结束位置：下一个换行符，没有时为文件结尾。 */
function lineEnd(text, i) {
  LINE_BREAK.lastIndex = i
  const found = LINE_BREAK.exec(text)
  return found ? found.index : text.length
}

/** 从 from 起查找结束符 close，返回到结束符之后的记号；未闭合返回 null。 */
function closeAfter(text, from, close, kind) {
  const end = text.indexOf(close, from)
  return end < 0 ? null : { kind, end: end + close.length }
}

/**
 * 扫描引号字面量。
 * @param {object} options escape：反斜杠转义下一个字符；rejectBackslash：出现反斜杠即无法判定；
 *   multiline：允许跨行；doubled：连写两个引号表示一个引号。
 * @returns {{ kind: 'literal', end: number }|null} 未闭合或无法判定时返回 null。
 */
function quoted(text, i, quote, { escape = false, rejectBackslash = false, multiline = false, doubled = false } = {}) {
  for (let j = i + quote.length; j < text.length; j += 1) {
    const ch = text[j]
    if (ch === '\\' && rejectBackslash) return null
    if (ch === '\\' && escape) {
      j += 1
      continue
    }
    if (!multiline && (ch === '\n' || ch === '\r')) return null
    if (text.startsWith(quote, j)) {
      if (doubled && text.startsWith(quote, j + quote.length)) {
        j += quote.length * 2 - 1
        continue
      }
      return { kind: 'literal', end: j + quote.length }
    }
  }
  return null
}

/**
 * 通用扫描循环：starts 找到记号起点后交给 token 判定记号类型与结束位置。
 * 注释替换为一个空格；字面量在代码文本中只留占位符，原文另存，空白规范化不会改动字面量。
 * @param {RegExp} starts 记号起点（带 g 标志）。
 * @param {Function} token (text, i) => { kind: 'comment' | 'literal' | 'code', end } 或 null（无法可靠扫描）。
 * @returns {{ code: string, literals: string[] }|null}
 */
function scanTokens(text, starts, token) {
  const parts = []
  const literals = []
  let i = 0
  while (i < text.length) {
    starts.lastIndex = i
    const next = starts.exec(text)
    const at = next ? next.index : text.length
    if (at > i) parts.push(text.slice(i, at))
    if (!next) break
    const found = token(text, at)
    if (!found) return null
    if (found.kind === 'comment') {
      parts.push(' ')
    } else if (found.kind === 'literal') {
      parts.push(LITERAL_PLACEHOLDER)
      literals.push(text.slice(at, found.end))
    } else {
      parts.push(text.slice(at, found.end))
    }
    i = found.end
  }
  return { code: parts.join(''), literals }
}

/** 连续空白折叠为一个空格（Java、SQL、XML）。空白字符显式列出：按 latin1 解码后 0xA0、0x85 不是空白。 */
function collapseBlank(scanned) {
  if (!scanned) return null
  return { code: scanned.code.replace(/[ \t\f\n\r]+/g, ' ').replace(/^ | $/g, ''), literals: scanned.literals }
}

/** Java 编译器在词法分析之前展开的 Unicode 转义（JLS 3.3）：前面的反斜杠个数为偶数时成立，可以写多个 u。 */
const JAVA_UNICODE_ESCAPE = /(?<!\\)(?:\\\\)*\\u+([0-9a-fA-F]{4})/g

/** 展开后会改变注释或字面量边界的字符：引号、反斜杠、斜杠、星号与换行。 */
const JAVA_STRUCTURAL = new Set(['"', '\'', '\\', '/', '*', '\n', '\r'])

const JAVA_STARTS = /\/[/*]|["']/g

function javaToken(text, i) {
  if (text.startsWith('//', i)) return { kind: 'comment', end: lineEnd(text, i) }
  if (text.startsWith('/*', i)) return closeAfter(text, i + 2, '*/', 'comment')
  if (text.startsWith('"""', i)) return quoted(text, i, '"""', { escape: true, multiline: true })
  return quoted(text, i, text[i], { escape: true })
}

/**
 * Java：删除 `//`、`/* *\/`，字符串、字符字面量与文本块保留原文，连续空白折叠为一个空格。
 * 出现会改变注释或字面量边界的 Unicode 转义（如注释中的 \u000a）时整份文件按代码处理：
 * 编译器先展开转义，注释后面的文字会变成代码。
 */
function normalizeJava(text) {
  for (const match of text.matchAll(JAVA_UNICODE_ESCAPE)) {
    if (JAVA_STRUCTURAL.has(String.fromCharCode(parseInt(match[1], 16)))) return null
  }
  return collapseBlank(scanTokens(text, JAVA_STARTS, javaToken))
}

const KOTLIN_STARTS = /\/[/*]|["'`]/g

/** Kotlin 块注释可以嵌套，到最外层的 `*\/` 结束。 */
function nestedComment(text, i) {
  let depth = 0
  for (let j = i; j < text.length;) {
    if (text.startsWith('/*', j)) {
      depth += 1
      j += 2
    } else if (text.startsWith('*/', j)) {
      depth -= 1
      j += 2
      if (!depth) return { kind: 'comment', end: j }
    } else {
      j += 1
    }
  }
  return null
}

/** 字符串模板 `${...}` 的结束位置（j 指向 `${` 之后）：模板内是代码，可以再含字符串与注释。未闭合返回 -1。 */
function kotlinTemplateEnd(text, j) {
  let depth = 1
  while (j < text.length) {
    const ch = text[j]
    if ('/"\'`'.includes(ch)) {
      const found = kotlinToken(text, j)
      if (!found) return -1
      j = found.end
      continue
    }
    if (ch === '{') depth += 1
    if (ch === '}' && --depth === 0) return j + 1
    j += 1
  }
  return -1
}

/** Kotlin 字符串：普通字符串有转义、不能跨行；原始字符串 `"""` 没有转义。两者都可以含模板，整体保留原文。 */
function kotlinString(text, i, raw) {
  const quote = raw ? '"""' : '"'
  for (let j = i + quote.length; j < text.length;) {
    if (!raw && text[j] === '\\') {
      j += 2
      continue
    }
    if (!raw && (text[j] === '\n' || text[j] === '\r')) return null
    if (text.startsWith('${', j)) {
      j = kotlinTemplateEnd(text, j + 2)
      if (j < 0) return null
      continue
    }
    if (text.startsWith(quote, j)) {
      let end = j + quote.length
      // 原始字符串结尾的多余引号属于内容：`""""` 表示内容以一个引号结尾。
      while (raw && text[end] === '"') end += 1
      return { kind: 'literal', end }
    }
    j += 1
  }
  return null
}

function kotlinToken(text, i) {
  if (text.startsWith('//', i)) return { kind: 'comment', end: lineEnd(text, i) }
  if (text.startsWith('/*', i)) return nestedComment(text, i)
  if (text[i] === '"') return kotlinString(text, i, text.startsWith('"""', i))
  if (text[i] === '\'') return quoted(text, i, '\'', { escape: true })
  if (text[i] === '`') return quoted(text, i, '`')
  return { kind: 'code', end: i + 1 }
}

/**
 * Kotlin：删除 `//` 与可以嵌套的 `/* *\/`，字符串、原始字符串、字符字面量与反引号标识符保留原文。
 * 换行可以结束语句，因此保留换行，只删除行首行尾空白与空行，行内连续空白折叠为一个空格。
 */
function normalizeKotlin(text) {
  const scanned = scanTokens(text, KOTLIN_STARTS, kotlinToken)
  if (!scanned) return null
  const code = scanned.code.split(/\r\n|\r|\n/)
    .map(line => line.replace(/[ \t\f]+/g, ' ').replace(/^ | $/g, ''))
    .filter(Boolean)
    .join('\n')
  return { code, literals: scanned.literals }
}

const SQL_STARTS = /--|\/\*|['"`#$]/g

function sqlToken(text, i) {
  const ch = text[i]
  if (ch === '-') {
    // MySQL 规则：-- 后面是空白或文件结尾才是注释；`--x` 在 PostgreSQL 中是注释，方言不明，整份文件按代码处理。
    return /[ \t\f\n\r]/.test(text[i + 2] || ' ') ? { kind: 'comment', end: lineEnd(text, i) } : null
  }
  if (ch === '/') {
    const end = text.indexOf('*/', i + 2)
    // 块注释中再出现 /*：PostgreSQL 允许嵌套而 MySQL 不允许，结束位置不唯一。
    if (end < 0 || text.slice(i + 2, end).includes('/*')) return null
    // hint（/*+ *\/）与可执行注释（/*! *\/、MariaDB 的 /*M! *\/）会被数据库执行，按代码保留原文。
    const executable = /^\/\*(?:[+!]|M!)/.test(text.slice(i, i + 4))
    return { kind: executable ? 'literal' : 'comment', end: end + 2 }
  }
  // 反斜杠在 MySQL 字符串中是转义、在标准 SQL 中不是，字符串结束位置不唯一，出现即无法判定。
  if (ch === '\'' || ch === '"') return quoted(text, i, ch, { rejectBackslash: true, multiline: true, doubled: true })
  if (ch === '`') return quoted(text, i, '`', { multiline: true, doubled: true })
  // # 在 MySQL 中开始注释、在 PostgreSQL 中是运算符；$ 可以开始 PostgreSQL 的美元引号字符串。方言不明。
  return null
}

/** SQL（MySQL 规则）：删除 `-- ` 与 `/* *\/`，字符串、反引号标识符、hint 与可执行注释保留原文，连续空白折叠为一个空格。 */
function normalizeSql(text) {
  return collapseBlank(scanTokens(text, SQL_STARTS, sqlToken))
}

const XML_STARTS = /</g

/** XML 标签整体保留原文：属性值是代码，标签内的空白变化也按代码处理。 */
function xmlTag(text, i) {
  for (let j = i + 1; j < text.length; j += 1) {
    const ch = text[j]
    if (ch === '"' || ch === '\'') {
      const close = text.indexOf(ch, j + 1)
      if (close < 0) return null
      j = close
      continue
    }
    // DOCTYPE 内部子集可以含声明与注释，结构复杂，整份文件按代码处理。
    if (ch === '[' || ch === '<') return null
    if (ch === '>') return { kind: 'literal', end: j + 1 }
  }
  return null
}

function xmlToken(text, i) {
  if (text.startsWith('<!--', i)) return closeAfter(text, i + 4, '-->', 'comment')
  if (text.startsWith('<![CDATA[', i)) return closeAfter(text, i + 9, ']]>', 'literal')
  if (text.startsWith('<?', i)) return closeAfter(text, i + 2, '?>', 'literal')
  return xmlTag(text, i)
}

/** XML：删除 `<!-- -->`，CDATA、处理指令与标签（含属性值）保留原文，文本中的连续空白折叠为一个空格。 */
function normalizeXml(text) {
  return collapseBlank(scanTokens(text, XML_STARTS, xmlToken))
}

/**
 * properties（java.util.Properties 的行规则）：删除注释行与空行，删除行首空白。
 * - 行尾空白属于取值，保留；
 * - 续行（上一行以奇数个 \ 结尾）中的内容是取值，行首的 # 也不是注释；续行中的空行结束该取值，保留；
 * - 注释行末尾的 \ 不构成续行；Spring 的多文档分隔符 #--- / !--- 按代码处理。
 */
function normalizeProperties(text) {
  const lines = []
  let continued = false
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/^[ \t\f]+/, '')
    if (!continued && (!line || (/^[#!]/.test(line) && !/^[#!]---/.test(line)))) continue
    lines.push(line)
    continued = /(?:^|[^\\])(?:\\\\)*\\$/.test(line)
  }
  return { code: lines.join('\n'), literals: [] }
}

/** 支持的文件类型：扩展名 → 规范化函数（返回 null 表示无法可靠扫描）。其他类型一律按代码处理。 */
const COMMENT_RULES = {
  '.java': normalizeJava,
  '.kt': normalizeKotlin,
  '.kts': normalizeKotlin,
  '.sql': normalizeSql,
  '.xml': normalizeXml,
  '.properties': normalizeProperties,
}

/** 读取 blob 原始字节。 */
function readBlob(repo, sha) {
  const result = spawnSync('git', ['cat-file', 'blob', sha], { cwd: repo, maxBuffer: 64 * 1024 * 1024 })
  if (result.error) throw new GateError(`无法执行 git：${result.error.message}`)
  if (result.status !== 0) throw new GateError(`无法读取 blob ${sha}：${String(result.stderr).trim()}`)
  return result.stdout
}

/** 两个版本删除注释并规范化空白后是否相同；任一版本是二进制或无法可靠扫描时返回 false。 */
function sameIgnoringComments(repo, normalize, blobA, blobB) {
  const [a, b] = [blobA, blobB].map(sha => {
    const content = readBlob(repo, sha)
    // 按 latin1 解码，字节与字符一一对应：非法 UTF-8 不会被替换成同一个字符而误判相等。
    return content.includes(0) ? null : normalize(content.toString('latin1'))
  })
  return Boolean(a && b) && a.code === b.code
    && a.literals.length === b.literals.length && a.literals.every((literal, k) => literal === b.literals[k])
}

/** 同一对指纹在一次运行中只比较一次（evidence 对多个切片会重复比较同一段）。 */
const classifyCache = new Map()

/** 普通文件的 git 权限位（100644、100755 等）；符号链接与子模块不比较内容。 */
const REGULAR_FILE_MODE = /^100[0-7]{3}$/

/**
 * 比较两个指纹之间每个变化文件，区分只有注释与空白差异的文件（commentOnly）与其他文件（other）。
 * 新增、删除、类型或权限变化、二进制与不支持类型的文件归入 other。
 * @returns {{ commentOnly: string[], other: string[] }|null} 指纹不是 git-tree 格式或 tree 对象不存在时返回 null。
 */
function classifyChanges(repo, from, to) {
  const a = GIT_TREE_FINGERPRINT.exec(from)
  const b = GIT_TREE_FINGERPRINT.exec(to)
  if (!a || !b) return null
  const key = `${a[1]}..${b[1]}`
  if (classifyCache.has(key)) return classifyCache.get(key)
  const entries = diffTreeEntries(repo, from, to)
  let result = null
  if (entries) {
    result = { commentOnly: [], other: [] }
    // 改名的文件按删除加新增处理（状态为 D、A），不满足 status === 'M'，归入 other。
    for (const { file, modeA, modeB, blobA, blobB, status } of entries) {
      const normalize = COMMENT_RULES[path.extname(file).toLowerCase()]
      const comparable = status === 'M' && modeA === modeB && REGULAR_FILE_MODE.test(modeA) && normalize
      const target = comparable && sameIgnoringComments(repo, normalize, blobA, blobB) ? result.commentOnly : result.other
      target.push(file)
    }
  }
  classifyCache.set(key, result)
  return result
}

/**
 * 读取 tasks.md 的实现后修改登记表。
 * 编号与文件都为空的行视为模板空行，跳过。档位不合法或登记指纹不合法（为空、不是 git-tree 格式）的行报问题且不算登记。
 * @returns {{ rows: { id: string, files: string[], tier: string, fingerprint: string }[], issues: string[] }}
 *   rows 只含有效行，按表中顺序排列；issues 为行级问题。
 */
function readChangeLedger(changeRoot) {
  const rows = []
  const issues = []
  for (const row of parseTables(section(readTasks(changeRoot), CHANGE_LEDGER_TITLE))) {
    const id = clean(row['编号'] || '')
    const files = splitFiles(row['文件'] || '')
    if (!id && !files.length) continue
    const tier = clean(row['档位'] || '')
    const fingerprint = clean(row['登记指纹'] || '')
    const problems = []
    if (!CHANGE_TIERS.includes(tier)) problems.push(`档位「${tier || '(空)'}」不合法，应为 ${CHANGE_TIERS.join(' / ')}`)
    // 登记指纹把登记行绑定到它登记的那次修改：没有合法指纹就无法核对登记之后是否又有修改。
    if (!GIT_TREE_FINGERPRINT.test(fingerprint)) {
      problems.push(`登记指纹「${fingerprint || '(空)'}」不合法，应为修改与验证完成后 fingerprint 命令的输出`)
    }
    if (problems.length) {
      issues.push(`登记 ${id || '(未写编号)'} 的${problems.join('；')}：该行不算登记`)
      continue
    }
    rows.push({ id, files, tier, fingerprint })
  }
  return { rows, issues }
}

/**
 * 把不只有注释差异的文件（classify 的 other）与登记表匹配，按 design D2 第 6 步判定。classify 与沿用核对共用这一口径。
 * 文件 F 算登记：至少一行档位不是非行为的有效行列出 F，并且「该行登记指纹 → to」之间 F 只有注释差异或没有差异。
 * F 的档位取列出它的全部有效行中的最高档位。登记后又有修改的旧行也计入：只会多跑，不会漏跑。
 * @param {string} repo 仓库根目录，用于比较登记指纹与 to。
 * @param {string} changeRoot 变更目录。
 * @param {string[]} files other 中的文件。
 * @param {string} to 比较终点指纹：classify 的 --to；沿用核对时为汇总基线指纹。
 * @returns {{ registered: object[], unregistered: object[], issues: string[] }}
 *   registered 为 { file, id, tier }；unregistered 为 { file, reason }，没有任何有效行列出时 reason 为 NOT_REGISTERED；
 *   issues 为登记表的行级问题，不含文件级原因。
 */
function matchLedger(repo, changeRoot, files, to) {
  const { rows, issues } = readChangeLedger(changeRoot)
  const registered = []
  const unregistered = []
  for (const file of files) {
    const listed = rows.filter(row => row.files.includes(file))
    const reasons = []
    let covered = false
    for (const row of listed) {
      // 非行为档位的前提是 classify 判定只有注释差异；other 中的文件登记为非行为属于错登，该行不能证明已登记。
      if (row.tier === NON_BEHAVIOR_TIER) {
        reasons.push(`登记 ${row.id} 为非行为，但 classify 判定它不只有注释差异，应改为等价或行为`)
        continue
      }
      const since = classifyChanges(repo, row.fingerprint, to)
      // tree 对象不存在时无法核对登记之后的修改，按未登记处理：只会多跑，不会漏跑。
      if (!since) reasons.push(`登记 ${row.id} 的登记指纹 tree 对象不存在，应新增一行登记`)
      else if (since.other.includes(file)) reasons.push(`登记 ${row.id} 之后又有非注释修改，应新增一行登记`)
      else covered = true
    }
    if (covered) {
      // 同档位的多行取表中靠后的一行，即最近一次登记。
      const top = listed.reduce((best, row) => (CHANGE_TIERS.indexOf(row.tier) >= CHANGE_TIERS.indexOf(best.tier) ? row : best))
      registered.push({ file, id: top.id, tier: top.tier })
    } else {
      unregistered.push({ file, reason: reasons.length ? reasons.join('；') : NOT_REGISTERED })
    }
  }
  return { registered, unregistered, issues }
}

/**
 * classify 命令：注释差异识别结果，other 中的文件按登记表分为 registered 与 unregistered。
 * @returns {object} from、to、commentOnly、other、registered（{ file, id, tier }）、unregistered（文件名）与 issues。
 *   issues 含登记表的行级问题，以及有具体原因的未登记文件（文件、登记编号与原因）。
 * @throws {GateError} 指纹不是 git-tree 格式，或 tree 对象不存在时抛出（退出码 2）。
 */
function classifyCommand(repo, changeRoot, from, to) {
  for (const value of [from, to]) {
    if (!GIT_TREE_FINGERPRINT.test(value)) throw new GateError(`classify 的指纹不是 git-tree 格式：${value}`)
  }
  const result = classifyChanges(repo, from, to)
  if (!result) throw new GateError(`tree 对象不存在（可能已被 git gc 回收），无法比较 ${from} → ${to}`)
  const ledger = matchLedger(repo, changeRoot, result.other, to)
  // unregistered 保持文件名列表，与 other 同形；只有「未登记」以外的原因写入 issues，没有登记行的文件不重复报出。
  const reasons = ledger.unregistered.filter(item => item.reason !== NOT_REGISTERED).map(item => `${item.file} 不算登记：${item.reason}`)
  return { from, to, ...result, registered: ledger.registered, unregistered: ledger.unregistered.map(item => item.file),
    issues: [...ledger.issues, ...reasons] }
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

/**
 * 定位 `## 标题` 区块（标题按包含匹配），到下一个一、二级标题为止。
 * @returns {{ start: number, end: number, lines: string[] }|null} start 为标题行，end 为区块后的首行（不含）。
 */
function locateSection(text, title) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex(line => /^##\s/.test(line) && line.includes(title))
  if (start < 0) return null
  const end = lines.findIndex((line, i) => i > start && /^#{1,2}\s/.test(line))
  return { start, end: end < 0 ? lines.length : end, lines }
}

/** 取 `## 标题` 区块正文；不存在返回空串。 */
function section(text, title) {
  const found = locateSection(text, title)
  return found ? found.lines.slice(found.start + 1, found.end).join('\n') : ''
}

/** 删除 `## 标题` 区块（含标题行），返回其余正文。 */
function withoutSection(text, title) {
  const found = locateSection(text, title)
  return found ? [...found.lines.slice(0, found.start), ...found.lines.slice(found.end)].join('\n') : text
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

/** 读取「## 评审基线」区块中的身份字段（含可缺省字段，缺省为空串）。 */
function readBaseline(text) {
  const block = section(text, '评审基线')
  return Object.fromEntries([...BASELINE_KEYS, ...OPTIONAL_BASELINE_KEYS].map(key => [key, readField(block, key)]))
}

/**
 * Rules Version 2 的报告结构检查：Blocker 判据前缀与 Finding 台账三条一致性规则（design D5）。
 * @param {object[]} findings Findings 表中的 finding 行（已排除台账区块）。
 * @returns {string[]} 结构问题。
 */
function checkRulesV2(file, text, findings) {
  const issues = []
  for (const row of findings) {
    if (isBlocker(row) && !BLOCKER_CRITERION.test(clean(row['触发场景'] || ''))) {
      issues.push(`${file} 的 Blocker ${row.ID} 触发场景未以判据编号 [B1]–[B5] 开头（判据表见 dual-axis-review.md）`)
    }
  }
  if (!locateSection(text, LEDGER_TITLE)) {
    issues.push(`${file} 缺少「## ${LEDGER_TITLE}」区块（Rules Version ${RULES_VERSION} 必填）`)
    return issues
  }
  const ledger = parseTables(section(text, LEDGER_TITLE)).filter(row => FINDING_ID.test(row.ID || ''))
  const findingIds = new Set(findings.map(row => row.ID))
  const ledgerIds = new Set(ledger.map(row => row.ID))
  for (const row of ledger) {
    const status = clean(row['状态'] || '').toLowerCase()
    const closure = clean(row['闭环依据'] || '')
    if (status === 'closed') {
      // closed 必须指到落地位置；risk-accepted / false-positive 写留痕位置即可（gate-policy.md 第 4 节）。
      if (!LOCATION.test(closure) && !TEST_NAME.test(closure)) {
        issues.push(`${file} 台账 ${row.ID} 状态为 closed，但闭环依据不是 文件:行号 或测试名（如 OrderTest.createsOrder）`)
      }
    } else if (CLOSED_STATUSES.includes(status)) {
      if (!closure) issues.push(`${file} 台账 ${row.ID} 状态为 ${status} 但缺少闭环依据（留痕位置）`)
    } else if (!findingIds.has(row.ID)) {
      issues.push(`${file} 台账 ${row.ID} 未闭环，但不在 Findings 表中`)
    }
  }
  for (const id of findingIds) {
    if (!ledgerIds.has(id)) issues.push(`${file} 的 finding ${id} 未登记到「${LEDGER_TITLE}」`)
  }
  return issues
}

/** 严重级别为 Blocker：判据前缀检查与裁决共用同一口径。 */
const isBlocker = row => clean(row['严重级别'] || '') === 'Blocker'

/** 未闭环 Blocker 判据：严重级别为 Blocker 且闭环状态为 open 或缺省。 */
const isOpenBlocker = row => isBlocker(row) && !CLOSED_STATUSES.includes(clean(row['闭环状态'] || '').toLowerCase())

/** 读取原始报告的结论行（取最后一个单值结论行，模板中的「通过 / 有条件通过 / 打回」不会被误识别）。 */
function readAxisVerdict(text) {
  const matches = [...text.matchAll(/结论\s*[:：]\s*\**\s*(有条件通过|通过|打回)\s*\**\s*$/gm)]
  return matches.length ? matches[matches.length - 1][1] : ''
}

/** 读取 tasks.md 文本（不存在返回空串）。 */
const readTasks = changeRoot => readText(changeRoot, 'tasks.md') || ''

/** tasks.md 是否声明了切片证据引用：即按新规则创建的变更，双轴评审产物必需。 */
const declaresEvidence = tasks => /^\s*Evidence\s*[:：]/m.test(tasks)

/** overview.md 里的分级行：允许 markdown 引用前缀 `>`，写法见 gate-levels.md「分级决策责任」。 */
const TIER_LINE = /^\s*>?\s*分级\s*[:：]\s*(\S.*)$/

/**
 * 从 overview.md 的分级行读取变更等级（L0–L3）。
 * 读不到时返回 null：没有 overview.md、没有分级行、或写的是「未判定」都走这一支，
 * 由调用方按保守口径处理（见 reviewRequired）。
 * @returns {'L0'|'L1'|'L2'|'L3'|null} 等级；无法判定时为 null。
 */
function readTier(changeRoot) {
  const overview = readText(changeRoot, 'overview.md')
  if (overview === null) return null
  const line = overview.split(/\r?\n/).map(item => item.match(TIER_LINE)).find(Boolean)
  if (!line) return null
  const level = line[1].match(/\bL([0-3])\b/i)
  return level ? `L${level[1]}` : null
}

/**
 * 双轴评审产物是否必需。
 * L0/L1 只推荐、不阻断归档；L2/L3 必需。判定仍以「切片声明了 Evidence 引用」为触发条件，
 * 因此历史变更（无 Evidence 引用）保持不追溯，不会被新规则追加要求。
 * @param {string} changeRoot 变更目录。
 * @param {string} tasks tasks.md 文本。
 * @returns {boolean} true 表示缺少双轴评审产物时记阻断项。
 */
function reviewRequired(changeRoot, tasks) {
  if (!declaresEvidence(tasks)) return false
  const tier = readTier(changeRoot)
  return tier !== 'L0' && tier !== 'L1'
}

// ============================================================================
// 双轴评审校验
// ============================================================================

/**
 * 核对沿用条件（design D3）：沿用基线指纹到汇总基线指纹之间的每个变化文件，只有注释差异，或登记为等价。
 * 登记判定与 classify 相同：未登记、档位为行为、只登记为非行为的其他差异文件都让沿用不成立。
 * @param {string} from 沿用报告的基线指纹。
 * @param {string} to 汇总报告的基线指纹。
 * @returns {{ view: { axis: string, from: string, to: string, files: string[]|null }, issues: string[] }}
 *   files 为两指纹间的变化文件；无法核对时为 null。
 */
function checkCarried(repo, changeRoot, from, to) {
  const label = `${CARRIED_AXIS_KEY}: ${CARRIABLE_AXIS.value}`
  const view = { axis: CARRIABLE_AXIS.value, from, to, files: null }
  const diff = repo && from && to ? classifyChanges(repo, from, to) : null
  // 无法核对就无法证明沿用成立，按结构问题处理，与豁免链「无法核实即无效」口径一致。
  if (!diff) {
    return { view, issues: [`${label} 无法核对：沿用基线 ${from || '(缺少 Fingerprint)'} → 汇总基线 ${to || '(缺少 Fingerprint)'}`
      + ' 不是可比较的 git-tree 指纹或 tree 对象不存在，重跑 Spec Fidelity'] }
  }
  view.files = [...diff.commentOnly, ...diff.other].sort()
  const ledger = matchLedger(repo, changeRoot, diff.other, to)
  // 登记表的行级问题（档位或登记指纹不合法）也让沿用不成立：不合法的行可能正是某个增量文件的登记，只报「未登记」会丢掉真正原因。
  const issues = ledger.issues.map(issue => `${label} 的登记表问题：${issue}`)
  for (const { file, reason } of ledger.unregistered) {
    issues.push(`${label} 不成立：${file} 自沿用基线以来不只有注释差异（${reason}），按档位登记或重跑 Spec Fidelity`)
  }
  // 只有等价档位可以沿用：registered 中已排除非行为，剩下的行为档位要两轴都重跑。
  for (const item of ledger.registered.filter(entry => entry.tier !== EQUIVALENT_TIER)) {
    issues.push(`${label} 不成立：${item.file} 登记 ${item.id} 的档位为${item.tier}，行为修改要两轴都重跑`)
  }
  return { view, issues }
}

/**
 * 校验双轴评审产物并重新计算裁决（不采信汇总自述）。
 * @param {string} changeRoot 变更目录。
 * @param {object} options required：是否必须存在评审产物；currentFingerprint：用于评审基线陈旧提醒；
 *   repo：仓库根目录，用于判定基线以来是否只有注释差异。
 * @returns {object} applicable、verdict（PASSED / BLOCKED / INCOMPLETE）、carried（沿用轮的核对范围，非沿用轮为 null）、
 *   axes、issues、warnings 等。
 */
function checkReview(changeRoot, { required = false, currentFingerprint = null, repo = null } = {}) {
  const files = [...AXES.map(axis => axis.file), SUMMARY_FILE]
  if (!required && !files.some(file => existsSync(path.join(changeRoot, file)))) {
    const tier = readTier(changeRoot)
    const why = tier === 'L0' || tier === 'L1'
      ? `${tier} 推荐运行，未生成不阻断`
      : 'L0 豁免，或未启用本能力的历史变更'
    return { applicable: false, reason: `不适用：未生成双轴评审产物（${why}）`, verdict: null,
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
    const axisBaseline = readBaseline(text)
    baselines.push([axis.file, axisBaseline])
    const rulesVersion = axisBaseline['Rules Version']
    // 台账与上轮闭环验证表也用 finding ID 作首列，必须排除，否则已闭环的 ID 会被当作 finding。
    const findings = parseTables(withoutSection(withoutSection(text, LEDGER_TITLE), CLOSURE_TITLE))
      .filter(row => FINDING_ID.test(row.ID || ''))
    for (const row of findings) {
      if (!row.ID.startsWith(`${axis.prefix}-`)) issues.push(`${axis.file} 的 finding ${row.ID} 前缀与评审轴不符，应为 ${axis.prefix}-`)
      if (!LOCATION.test(row['位置'] || '')) issues.push(`${axis.file} 的 finding ${row.ID} 位置无法定位，须写成 文件:行号`)
    }
    if (rulesVersion === RULES_VERSION) issues.push(...checkRulesV2(axis.file, text, findings))
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

  // 沿用轮：Spec Fidelity 报告保留上一轮基线，不参加基线身份比较，改为核对沿用条件；open Blocker 照常计入裁决。
  const carriedValue = summary === null ? '' : readField(summary, CARRIED_AXIS_KEY)
  let carried = null
  let compared = baselines
  if (carriedValue && carriedValue !== CARRIABLE_AXIS.value) {
    issues.push(`汇总报告的 ${CARRIED_AXIS_KEY} 为 ${carriedValue}：只有 ${CARRIABLE_AXIS.value} 可以沿用`)
  } else if (carriedValue) {
    const carriedBaseline = baselines.find(([file]) => file === CARRIABLE_AXIS.file)
    const summaryBaseline = baselines.find(([file]) => file === SUMMARY_FILE)
    if (carriedBaseline) {
      const check = checkCarried(repo, changeRoot, carriedBaseline[1].Fingerprint, summaryBaseline[1].Fingerprint)
      carried = check.view
      issues.push(...check.issues)
      compared = baselines.filter(([file]) => file !== CARRIABLE_AXIS.file)
    }
  }

  // 固定基线：以第一份存在的报告为参照，逐项比较身份字段。
  const [referenceFile, reference] = compared[0] || []
  for (const [file, values] of compared) {
    for (const key of BASELINE_KEYS) {
      if (!values[key]) issues.push(`${file} 的评审基线缺少 ${key}`)
      else if (reference[key] && values[key] !== reference[key]) issues.push(`${file} 的评审基线 ${key} 与 ${referenceFile} 不一致`)
    }
    for (const key of OPTIONAL_BASELINE_KEYS) {
      if (values[key] !== reference[key]) {
        issues.push(`${file} 的评审基线 ${key}（${values[key] || '无'}）与 ${referenceFile}（${reference[key] || '无'}）不一致`)
      }
    }
  }
  const baseline = reference || null
  // 基线以来只有注释差异时不开新一轮评审，也就不提示陈旧。
  const commentOnlySince = () => {
    const diff = repo && classifyChanges(repo, baseline.Fingerprint, currentFingerprint)
    return Boolean(diff) && !diff.other.length
  }
  if (currentFingerprint && baseline && baseline.Fingerprint && baseline.Fingerprint !== currentFingerprint && !commentOnlySince()) {
    warnings.push(`评审基线 Fingerprint ${baseline.Fingerprint} 与当前实现 ${currentFingerprint} 不一致：评审后实现有变化。`
      + `运行 classify --from ${baseline.Fingerprint}，把 unregistered 中的文件（含门禁外提交）按档位登记到 tasks.md 的「## ${CHANGE_LEDGER_TITLE}」，`
      + '再按档位决定是否生成新基线重跑（规则见 post-implementation-changes.md）')
  }

  const verdict = blocked ? 'BLOCKED' : issues.length ? 'INCOMPLETE' : 'PASSED'
  return { applicable: true, verdict, declaredVerdict, baseline, carried, axes, issues, warnings }
}

// ============================================================================
// 切片证据校验
// ============================================================================

/** 切片标题区的声明行与 readSlices 结果字段的对应关系。 */
const SLICE_DECLARATIONS = { Seam: 'seam', Evidence: 'evidenceRef', Environment: 'environment' }

/**
 * 解析 tasks.md 的切片：编号、Seam、Evidence 引用、Environment 声明与勾选进度。
 * 只识别 `## Slice <id>: 标题` 结构；遇到其他一、二级标题即结束当前切片。
 */
function readSlices(tasks) {
  const slices = []
  let current = null
  for (const line of tasks.split(/\r?\n/)) {
    const heading = line.match(/^##\s+Slice\s+([\w.-]+)\s*[:：]\s*(.*)$/i)
    if (heading) {
      current = { id: heading[1], title: heading[2].trim(), seam: '', evidenceRef: '', environment: '', done: 0, total: 0 }
      slices.push(current)
      continue
    }
    if (/^#{1,2}\s/.test(line)) current = null
    if (!current) continue
    const declared = line.match(/^\s*(Seam|Evidence|Environment)\s*[:：]\s*(.*)$/)
    if (declared) {
      current[SLICE_DECLARATIONS[declared[1]]] = clean(declared[2])
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

/** 证据结果取值；PASS_WITH_BASELINE 表示完整套件只剩已知基线失败，按通过处理。 */
const EVIDENCE_RESULTS = ['PASS', 'PASS_WITH_BASELINE', 'FAIL']

/**
 * 校验 PASS_WITH_BASELINE 必带的字段：Baseline List 指向存在的文件（相对仓库根），Introduced Failures 为 0。
 * @returns {{ missing: string[], failures: string[] }}
 */
function inspectBaselineFields(repo, head) {
  const missing = []
  const failures = []
  const list = readField(head, 'Baseline List')
  if (!list) missing.push('Baseline List（PASS_WITH_BASELINE 必填）')
  else if (!existsSync(path.resolve(repo, list))) missing.push(`Baseline List（文件不存在：${list}）`)
  const introduced = readField(head, 'Introduced Failures')
  if (!/^\d+$/.test(introduced)) missing.push('Introduced Failures（PASS_WITH_BASELINE 必填，取值为整数）')
  else if (Number(introduced) !== 0) failures.push(`本次引入的失败为 ${introduced}，不能记为 PASS_WITH_BASELINE`)
  return { missing, failures }
}

/**
 * 检查一份证据的字段完整性与验证结果。
 * @returns {{ fields: object, missing: string[], failures: string[] }} missing 为缺失 / 非法项，failures 为失败的验证结果。
 */
function inspectEvidence(repo, text, sliceId) {
  // 字段只在首个二级标题之前读取，避免与豁免记录表等正文混淆。
  const head = text.split(/^##\s/m)[0]
  const fields = Object.fromEntries(EVIDENCE_FIELDS.map(key => [key, readField(head, key)]))
  const missing = EVIDENCE_FIELDS.filter(key => !fields[key])
  if (fields.Slice && fields.Slice !== sliceId) missing.push(`Slice（记录为 ${fields.Slice}，应为 ${sliceId}）`)
  for (const title of EVIDENCE_SECTIONS) {
    if (!countEntries(section(text, title))) missing.push(title)
  }

  const failures = []
  const outcomes = []
  const result = fields.Result.toUpperCase()
  if (fields.Result && !EVIDENCE_RESULTS.includes(result)) missing.push('Result（只能是 PASS / PASS_WITH_BASELINE / FAIL）')
  if (result === 'FAIL') failures.push('Result 为 FAIL')
  outcomes.push(result)
  for (const row of parseTables(section(text, '验证命令'))) {
    const outcome = (row['结果'] || '').toUpperCase()
    outcomes.push(outcome)
    if (!EVIDENCE_RESULTS.includes(outcome)) missing.push('验证命令结果（每行只能是 PASS / PASS_WITH_BASELINE / FAIL）')
    else if (outcome === 'FAIL') failures.push(`验证命令失败：${row['命令'] || '(未写命令)'}`)
  }
  if (outcomes.includes('PASS_WITH_BASELINE')) {
    const baseline = inspectBaselineFields(repo, head)
    missing.push(...baseline.missing)
    failures.push(...baseline.failures)
  }
  return { fields, missing: [...new Set(missing)], failures }
}

/** 豁免记录必填列（格式见 slice-evidence.md「豁免记录格式」）。 */
const EXEMPTION_COLUMNS = ['变化文件', '不影响本切片行为的理由', '判定人', '日期']

/** 拆分豁免记录的「变化文件」单元格（逗号、顿号、分号、空白或 <br> 分隔）。 */
const splitFiles = cell => cell.split(/<br\s*\/?>|[,，、;；\s]+/).map(clean).filter(Boolean)

/**
 * 沿豁免链从证据指纹走到当前指纹；每一段都必须字段齐全，且「变化文件」列全两指纹间的实际变化。
 * 链在某个指纹之后没有记录时，该指纹到当前指纹之间只有注释差异也算成立（不需要人工登记）。
 * 这里只用注释差异判定，不读实现后修改登记表：等价修改仍要用测试刷新证据。
 * @returns {{ ok: boolean, reason: string, commentOnly?: string[] }} ok 为 false 时 reason 说明链在哪一段失效
 *   （无记录时为空串）；由注释差异补全时 commentOnly 列出这一段的文件。
 */
function followExemptions(repo, rows, recorded, current) {
  const visited = new Set()
  let cursor = recorded
  while (cursor !== current) {
    if (visited.has(cursor)) return { ok: false, reason: '豁免记录出现循环' }
    visited.add(cursor)
    const row = rows.find(item => clean(item['From Fingerprint'] || '') === cursor)
    if (!row) {
      const diff = classifyChanges(repo, cursor, current)
      return diff && !diff.other.length ? { ok: true, reason: '', commentOnly: diff.commentOnly } : { ok: false, reason: '' }
    }
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

/** 证据中待环境补测表的区块标题（格式见 openspec-apply-change/shared/slice-evidence.md「待环境补测」）。 */
const PENDING_ENVIRONMENT_TITLE = '待环境补测'

/** 待环境补测登记行的负责人或补测计划为空时，提示中显示的缺省文字。 */
const NOT_WRITTEN = '(未写)'

/**
 * 生成待环境补测提示中「负责人 …，补测计划 …」一段。evidence 的 warning 与 archive 的 notes 共用，两个阶段的提示格式一致。
 * @param {{ owner: string, plan: string }} pending 成立的登记行（checkSlice 输出的 pendingEnvironment）。
 * @returns {string} 提示文字；为空的字段写 NOT_WRITTEN。
 */
function describePendingEnvironment({ owner, plan }) {
  return `负责人 ${owner || NOT_WRITTEN}，补测计划 ${plan || NOT_WRITTEN}`
}

/**
 * 查找成立的待环境补测登记：确认人不为空，并且登记指纹等于当前指纹，或两者之间只有注释差异。
 * 确认人只能由用户填写（规则同签字行）；代码在登记后有非注释修改时登记不再成立，需要用户重新确认。
 * 只对声明了 `Environment:` 的切片调用：本地可以验证的切片不能用登记代替重跑。
 * @returns {object|null} 成立的登记行；多行成立时取表中最后一行（最近的登记），没有时为 null。
 */
function findPendingEnvironment(repo, text, currentFingerprint) {
  const rows = parseTables(section(text, PENDING_ENVIRONMENT_TITLE)).reverse()
  return rows.find(row => {
    if (!clean(row['确认人'] || '')) return false
    const registered = clean(row['登记指纹'] || '')
    if (registered === currentFingerprint) return true
    const diff = classifyChanges(repo, registered, currentFingerprint)
    return Boolean(diff && !diff.other.length)
  }) || null
}

/**
 * 查找记录证据时登记的待环境补测行：登记指纹等于证据的 Fingerprint，表示记录证据时集成测试没有在本地运行。
 * 只对声明了 `Environment:` 的切片、证据新鲜或经豁免时调用；证据过期时用 findPendingEnvironment。
 * @returns {{ confirmed: object|null, unconfirmed: object|null }} 匹配行中最近的已确认行与未确认行，没有时为 null。
 */
function findDeferredAtRecording(text, evidenceFingerprint) {
  const rows = parseTables(section(text, PENDING_ENVIRONMENT_TITLE)).reverse()
    .filter(row => clean(row['登记指纹'] || '') === evidenceFingerprint)
  const confirmed = rows.find(row => clean(row['确认人'] || '')) || null
  return { confirmed, unconfirmed: confirmed ? null : rows[0] || null }
}

/** 待环境补测登记行在 evidence 输出中的视图（pendingEnvironment 字段）。 */
const pendingView = row => ({ fingerprint: clean(row['登记指纹'] || ''), owner: clean(row['负责人'] || ''),
  plan: clean(row['补测计划'] || ''), confirmer: clean(row['确认人'] || '') })

/** 从 `Evidence:` 行取证据路径（兼容 Markdown 链接写法）。 */
const evidencePath = ref => (ref.match(/[^\s()[\]`'"<>]+\.md/) || [''])[0]

/**
 * 校验单个切片的证据。已全部勾选的切片问题记 CRITICAL；部分勾选时只有缺证据文件记 CRITICAL，其余记 warning。
 * 声明了 `Environment:` 的切片有成立的待环境补测登记时，状态为 pending-environment，只记 warning：
 * 证据过期时按当前指纹判断登记；证据新鲜或经豁免时，登记指纹等于证据指纹的行表示记录证据时集成测试没有运行，
 * 已确认为 pending-environment，未确认为 incomplete。
 * @returns {{ slice: object, issues: string[], warnings: string[] }}
 */
function checkSlice(repo, changeRoot, slice, currentFingerprint) {
  const expected = `evidence/slice-${slice.id}.md`
  const label = `Slice ${slice.id}`
  const view = { id: slice.id, title: slice.title, seam: slice.seam, evidence: expected,
    tasks: { done: slice.done, total: slice.total }, status: 'pending' }
  if (slice.environment) view.environment = slice.environment
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

  const { fields, missing, failures } = inspectEvidence(repo, text, slice.id)
  view.fingerprint = fields.Fingerprint
  const problems = []
  const notices = []
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
      if (chain.commentOnly) {
        view.exemptedBy = 'comment-only'
        view.commentOnly = chain.commentOnly
      }
    } else {
      // 列出自证据以来的变化文件，供 Verify 判断重跑范围或登记豁免；无法计算时为 null。
      view.changedSinceEvidence = changedFiles(repo, fields.Fingerprint, currentFingerprint)
      // 待环境补测只对声明了 Environment: 的切片生效；没有声明时登记表不起作用，照常判为过期。
      const pending = slice.environment ? findPendingEnvironment(repo, text, currentFingerprint) : null
      if (pending) {
        view.status = 'pending-environment'
        view.pendingEnvironment = pendingView(pending)
        notices.push(`${label} 待环境补测（${slice.environment}）：证据指纹 ${fields.Fingerprint} ≠ 当前实现 ${currentFingerprint}；`
          + describePendingEnvironment(view.pendingEnvironment))
      } else {
        view.status = 'stale'
        problems.push(`${label} 证据过期：记录指纹 ${fields.Fingerprint} ≠ 当前实现 ${currentFingerprint}`
          + `${chain.reason ? `；${chain.reason}` : ''}，需重跑该切片验证并更新证据`)
      }
    }
  }
  if (slice.environment && (view.status === 'fresh' || view.status === 'exempted')) {
    // 集成测试在记录证据时就不能在本地运行：登记指纹等于证据指纹的登记表示这部分验证推迟到环境中补测（ADR-0007）。
    const deferred = findDeferredAtRecording(text, fields.Fingerprint)
    if (deferred.confirmed) {
      view.status = 'pending-environment'
      view.pendingEnvironment = pendingView(deferred.confirmed)
      notices.push(`${label} 待环境补测（${slice.environment}）：记录证据时集成测试没有在本地运行；`
        + describePendingEnvironment(view.pendingEnvironment))
    } else if (deferred.unconfirmed) {
      // 确认人只能由用户填写（规则同签字行）；未确认的推迟不能代替验证。
      view.status = 'incomplete'
      problems.push(`${label} 证据不完整：待环境补测登记 ${fields.Fingerprint} 缺少确认人，只能由用户填写`)
    }
  }
  const complete = slice.done === slice.total
  return { slice: view, issues: complete ? problems : [],
    warnings: [...notices, ...(complete ? [] : problems.map(item => `${item}（切片未全部勾选，暂记 warning）`))] }
}

/**
 * 校验变更的切片证据，并计算勾选项的阶段边界问题（taskIssues）。
 * taskIssues 不影响退出码，由 Verify 逐条记 CRITICAL（见 implementation-gate-check.md）。
 * @returns {object} applicable、reason（不适用理由）、currentFingerprint、slices、issues（CRITICAL）、warnings、taskIssues。
 */
function checkEvidence(repo, changeRoot, currentFingerprint) {
  const tasks = readText(changeRoot, 'tasks.md')
  const slices = tasks === null ? [] : readSlices(tasks)
  // 阶段边界检查不依赖切片证据是否适用：平铺任务清单与未启用证据的变更也计算。
  const taskIssues = tasks === null ? [] : findTaskIssues(tasks)
  const enabled = slices.some(slice => slice.evidenceRef) || existsSync(path.join(changeRoot, 'evidence'))
  const notApplicable = reason => ({ applicable: false, reason, currentFingerprint, slices: [], issues: [], warnings: [], taskIssues })
  // 不适用必须带理由返回，由 Verify 写进报告，不能静默当作通过。
  if (tasks === null) return notApplicable('不适用：变更没有 tasks.md')
  if (!slices.length) return notApplicable('不适用：tasks.md 无垂直切片（## Slice 标题），不强制切片证据')
  if (!enabled) return notApplicable('不适用：切片未声明 Evidence 引用，视为未启用切片证据的历史变更（不追溯）')

  const results = slices.map(slice => checkSlice(repo, changeRoot, slice, currentFingerprint))
  return { applicable: true, currentFingerprint, slices: results.map(item => item.slice),
    issues: results.flatMap(item => item.issues), warnings: results.flatMap(item => item.warnings), taskIssues }
}

// ============================================================================
// 勾选项的阶段边界（规则见 openspec-propose/shared/task-slicing.md「排除清单」）
// ============================================================================

/** 阶段命令：勾选项不能要求运行它们，也不能等它们通过后再勾选（排除清单 E1）。 */
const PHASE_COMMANDS = ['/opsx:quality', '/opsx:verify', '/opsx:overview', '/opsx:archive', 'openspec archive', 'openspec validate']

/** 运行类动词；英文按整词匹配。动词与命令之间允许空白与反引号。 */
const RUN_VERB = '(?:运行|执行|重跑|\\brerun\\b|\\brun\\b)'
const COMMAND_GAP = '[\\s`]*'

/**
 * 文本模式能可靠识别的两类任务问题；其他排除类别只写入规则文本，由 Verify 人工核对。
 * 只匹配命令本身，不匹配 skill 名称或命令文件路径（如 openspec-verify-change/SKILL.md），避免误报修改阶段 skill 的任务。
 */
const TASK_PATTERNS = (() => {
  const commands = PHASE_COMMANDS.map(escapeRegExp).join('|')
  return [
    { kind: 'phase-action', pattern: new RegExp(`${RUN_VERB}${COMMAND_GAP}(?:${commands})|(?:${commands})${COMMAND_GAP}(?:通过后|完成后)`, 'gi') },
    { kind: 'git-action', pattern: new RegExp(`${RUN_VERB}${COMMAND_GAP}git\\s+(?:commit|push)\\b`, 'gi') },
  ]
})()

/**
 * 否定词（design D6）：同一分句中出现在命中位置之前时不报出（如「不执行 git commit」）。
 * 中文词组按子串匹配，英文按整词匹配。单字「不」不算否定：「不同」「不再」「不变」等普通词不能阻止报出。
 * 已知漏报：「原先不在范围内」中的「不在」也会阻止报出。区分它要做分词，本脚本不做，由 Verify 人工核对排除清单时补上。
 */
const NEGATION = /不运行|不执行|不重跑|不在|不要|不得|不必|无需|禁止|\bnever\b|\bnot\b/i

/**
 * 含否定词但不表示否定的复合词（design D6）：查找否定词之前先从分句中删除。
 * 只排除「不必」「不得」两个词会漏掉「不得不重跑」中的「不重跑」，所以整词删除。
 * 已知误报：「不必要」「不得不」按子串删除。「不必要求」「不得不经」中的否定词「不必」「不得」也被删除，任务仍会报出。verify 记 CRITICAL 后改写任务措辞，例如改为「不必运行」。不再逐个增加例外：原因与上一条相同，脚本不做分词。
 */
const NOT_NEGATION = /不必要|不得不/g

/** 分句边界：中文逗号、句号、分号、冒号与换行。ASCII 冒号不算边界，因为 /opsx:verify 含冒号。 */
const CLAUSE_BOUNDARY = /[，。；：\n]/

/**
 * 读取 tasks.md 中未勾选的勾选项；缩进的续行属于上一个勾选项，空行或顶格行结束该项。
 * @returns {{ id: string, line: number, text: string }[]} id 取勾选框后的任务编号，没有编号时写行号。
 */
function readUncheckedTasks(tasks) {
  const items = []
  let current = null
  tasks.split(/\r?\n/).forEach((line, index) => {
    const box = line.match(/^\s*[-*]\s+\[([ xX])\]\s*(.*)$/)
    if (box) {
      const id = (box[2].match(/^([A-Za-z]*\d+(?:\.\d+)*)\b/) || [])[1] || `第 ${index + 1} 行`
      current = box[1] === ' ' ? { id, line: index + 1, text: box[2] } : null
      if (current) items.push(current)
      return
    }
    if (current && /^\s+\S/.test(line)) current.text += `\n${line.trim()}`
    else current = null
  })
  return items
}

/**
 * 命中位置是否在同一分句的否定词之后。
 * 「不执行」等否定词包含命中文本开头的运行动词，所以检查到命中文本末尾；命中文本本身不含否定词，找到的否定词一定从命中位置之前开始。
 */
function negated(text, match) {
  const clause = text.slice(0, match.index + match[0].length).split(CLAUSE_BOUNDARY).pop()
  return NEGATION.test(clause.replace(NOT_NEGATION, ''))
}

/**
 * 扫描未勾选的勾选项，报出要求运行阶段命令或 git 写操作的任务。每个任务每类最多报一条，text 为首个命中文本。
 * @returns {{ task: string, kind: string, text: string, line: number }[]}
 */
function findTaskIssues(tasks) {
  const issues = []
  for (const item of readUncheckedTasks(tasks)) {
    for (const { kind, pattern } of TASK_PATTERNS) {
      const hit = [...item.text.matchAll(pattern)].find(match => !negated(item.text, match))
      if (hit) issues.push({ task: item.id, kind, text: hit[0], line: item.line })
    }
  }
  return issues
}

// ============================================================================
// 归档前置校验
// ============================================================================

/**
 * 合并双轴评审与切片证据的阻断项；不适用的部分以理由写入 notes，不静默当作通过。
 * 待环境补测（pending-environment）的切片不阻断，切片、负责人与补测计划写入 notes，供归档摘要列出。
 * Verify 的其他 CRITICAL（未完成任务、需求未实现等）不在本脚本判定范围，由 archive 流程另行确认。
 * @returns {object} ok、blockers、notes、warnings，以及 review / evidence 明细。
 */
function checkArchive(repo, changeRoot, currentFingerprint) {
  const review = checkReview(changeRoot, { required: reviewRequired(changeRoot, readTasks(changeRoot)), currentFingerprint, repo })
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
  if (evidence.applicable) {
    blockers.push(...evidence.issues.map(issue => `切片证据：${issue}`))
    for (const slice of evidence.slices.filter(item => item.status === 'pending-environment')) {
      notes.push(`切片证据：Slice ${slice.id} 待环境补测（${slice.environment}），${describePendingEnvironment(slice.pendingEnvironment)}`)
    }
  } else {
    notes.push(evidence.reason)
  }
  return { ok: blockers.length === 0, blockers, notes, warnings: [...review.warnings, ...evidence.warnings], review, evidence }
}

// ============================================================================
// 基线差分回归
// ============================================================================

/** Maven Surefire 在失败测试后追加的标记，读取清单时删除。 */
const SUREFIRE_SUFFIX = /\s+<<<\s+(?:FAILURE|ERROR)!\s*$/

/**
 * 读取失败清单：每行一个测试标识，跳过空行与 `#` 注释行，删除 Surefire 后缀，去重并保持顺序。
 * @throws {GateError} 文件不存在时抛出。
 */
function readFailureList(file) {
  if (!existsSync(file) || !statSync(file).isFile()) throw new GateError(`失败清单不存在：${file}`)
  const ids = readFileSync(file, 'utf8').split(/\r?\n/)
    .map(line => line.trim().replace(SUREFIRE_SUFFIX, '').trim())
    .filter(line => line && !line.startsWith('#'))
  return [...new Set(ids)]
}

/**
 * 比较实际失败清单与已知基线失败清单。
 * @returns {{ introduced: string[], baselineMatched: number, fixed: string[] }} 只有 introduced 影响退出码。
 */
function regress(baselineFile, actualFile) {
  const baseline = readFailureList(baselineFile)
  const actual = readFailureList(actualFile)
  const known = new Set(baseline)
  const failing = new Set(actual)
  return {
    introduced: actual.filter(id => !known.has(id)),
    baselineMatched: actual.filter(id => known.has(id)).length,
    fixed: baseline.filter(id => !failing.has(id)),
  }
}

// ============================================================================
// 产物允许清单
// ============================================================================

/**
 * 变更目录允许的产物（路径相对 changeRoot，用 `/` 分隔），由各 OpenSpec skill 与 openspec CLI 声明的输出路径组成。
 * 新 skill 向变更目录写入新产物时，必须同步加入本清单。补充材料一律放 evidence/attachments/。
 */
const ARTIFACT_ALLOWLIST = [
  /^\.openspec\.yaml$/, // openspec CLI
  /^(proposal|design|tasks)\.md$/, // openspec-propose
  /^specs\/.+\.md$/, // openspec-propose / openspec-update-change
  /^review\/(architecture|concurrency|performance|database|security)\.md$/, // openspec-technical-review
  /^review-summary\.md$/, // openspec-technical-review
  /^review\/(standards|spec-fidelity|code-review-summary|code-quality)\.md$/, // openspec-code-quality（code-quality.md 为历史格式）
  /^review\/finding-details-summary\.md$/, /^review\/finding-details\/[^/]+\.md$/, /^\.finding-explain\.json$/, // openspec-finding-explain
  /^verification\.md$/, // openspec-verify-change
  /^evidence\/slice-[\w.-]+\.md$/, /^evidence\/attachments\/.+$/, // openspec-apply-change
  /^overview\.(md|html)$/, // openspec-change-overview
  /^discussion-log\.md$/, // openspec-discussion-sync / openspec-grill
  /^video\/(storyboard\.md|explainer\.srt)$/, /^video\/media\/.+$/, // openspec-explainer-video
]

/** 系统生成的文件，不计入产物检查。 */
const SYSTEM_FILES = /(^|\/)(\.DS_Store|Thumbs\.db)$/

/** 轮次副本：文件名带 `-round<N>` 或 `-r<N>`（规则要求原地覆盖）。 */
const ROUND_COPY = /-(round|r)\d+(\.[^/.]+)?$/i

/** 文件名自由的目录（补充材料、视频缓存）：不按 round 副本判定，`jdk-r17.log` 这类名字是正常文件。 */
const FREE_NAMING_DIRS = /^(evidence\/attachments|video\/media)\//

/** 递归列出目录下的全部文件，返回相对路径（`/` 分隔）。 */
function listFiles(root, rel = '') {
  return readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap(entry => {
    const child = rel ? `${rel}/${entry.name}` : entry.name
    return entry.isDirectory() ? listFiles(root, child) : [child]
  })
}

/**
 * 检查变更目录中允许清单外的文件；只给 warning，不阻断。
 * @returns {{ files: number, warnings: { file: string, reason: string }[] }}
 */
function checkHygiene(changeRoot) {
  const files = listFiles(changeRoot).filter(file => !SYSTEM_FILES.test(file)).sort()
  // 先判轮次副本：`evidence/slice-01-r2.md` 也能匹配切片证据的允许规则，但规则要求原地覆盖。
  const warnings = files.flatMap(file => {
    if (ROUND_COPY.test(file) && !FREE_NAMING_DIRS.test(file)) return [{ file, reason: 'round copy' }]
    if (ARTIFACT_ALLOWLIST.some(pattern => pattern.test(file))) return []
    return [{ file, reason: '不在产物允许清单中；补充材料请放到 evidence/attachments/' }]
  })
  return { files: files.length, warnings }
}

// ============================================================================
// 命令入口
// ============================================================================

/** 各子命令接受的 `--key value` 参数；其他参数一律按参数错误处理，不静默忽略。 */
const COMMAND_OPTIONS = {
  fingerprint: ['repo'],
  baseline: ['base', 'since', 'repo'],
  classify: ['from', 'to', 'repo'],
  review: ['repo'],
  evidence: ['repo'],
  archive: ['repo'],
  hygiene: [],
  regress: ['baseline', 'actual'],
}

/** 解析 `--key value` 形式的可选参数，只接受该子命令声明的参数。 */
function parseOptions(command, args) {
  const allowed = COMMAND_OPTIONS[command]
  const options = {}
  for (let i = 0; i < args.length; i += 1) {
    const match = /^--([a-z]+)$/.exec(args[i])
    if (!match || !allowed.includes(match[1])) throw new GateError(`${command} 不支持的参数：${args[i]}`)
    if (i + 1 >= args.length) throw new GateError(`${command} 的参数 ${args[i]} 缺少取值`)
    options[match[1]] = args[i + 1]
    i += 1
  }
  return options
}

const USAGE = '用法：node implementation-gate.mjs <fingerprint|baseline|review|evidence|archive|hygiene> <changeRoot> [--base <rev>] [--since <fingerprint>] [--repo <dir>]'
  + '\n      node implementation-gate.mjs classify <changeRoot> --from <fingerprint> [--to <fingerprint>] [--repo <dir>]'
  + '\n      node implementation-gate.mjs regress --baseline <file> --actual <file>'

/**
 * 执行子命令。
 * @param {string[]} argv 命令行参数（不含 node 与脚本路径）。
 * @returns {{ code: number, output: string }} 退出码与标准输出内容。
 */
function run(argv) {
  if (argv[0] === 'regress') {
    const options = parseOptions('regress', argv.slice(1))
    if (!options.baseline || !options.actual) throw new GateError(USAGE)
    const report = regress(path.resolve(options.baseline), path.resolve(options.actual))
    const ok = report.introduced.length === 0
    return { code: ok ? EXIT.PASS : EXIT.BLOCKED, output: `${JSON.stringify({ command: 'regress', ok, ...report }, null, 2)}\n` }
  }
  const [command, changeRootArg, ...rest] = argv
  if (!Object.prototype.hasOwnProperty.call(COMMAND_OPTIONS, command) || !changeRootArg) throw new GateError(USAGE)
  const options = parseOptions(command, rest)
  const target = path.resolve(changeRootArg)
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new GateError(`变更目录不存在：${target}`)
  const changeRoot = realpathSync(target)
  // 产物检查只读变更目录，不依赖 git。
  if (command === 'hygiene') {
    return { code: EXIT.PASS, output: `${JSON.stringify({ command, change: path.basename(changeRoot), ok: true, ...checkHygiene(changeRoot) }, null, 2)}\n` }
  }
  const repo = resolveRepo(options.repo || process.cwd())

  if (command === 'fingerprint') return { code: EXIT.PASS, output: `${computeFingerprint(repo, changeRoot)}\n` }
  if (command === 'baseline') {
    const { output, warnings } = renderBaseline(repo, changeRoot, options.base, options.since)
    return { code: EXIT.PASS, output, stderr: warnings.map(item => `${item}\n`).join('') }
  }
  if (command === 'classify') {
    if (!options.from) throw new GateError(`classify 缺少 --from <fingerprint>\n${USAGE}`)
    const report = classifyCommand(repo, changeRoot, options.from, options.to || computeFingerprint(repo, changeRoot))
    const ok = report.unregistered.length === 0
    return { code: ok ? EXIT.PASS : EXIT.BLOCKED,
      output: `${JSON.stringify({ command, change: path.basename(changeRoot), ok, ...report }, null, 2)}\n` }
  }

  const currentFingerprint = computeFingerprint(repo, changeRoot)
  let report
  let ok
  if (command === 'review') {
    report = checkReview(changeRoot, { required: reviewRequired(changeRoot, readTasks(changeRoot)), currentFingerprint, repo })
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
  const { code, output, stderr } = run(process.argv.slice(2))
  process.stdout.write(output)
  if (stderr) process.stderr.write(stderr)
  process.exitCode = code
} catch (error) {
  // 参数与环境错误只输出可读信息；非预期异常保留堆栈，便于定位脚本缺陷。
  process.stderr.write(`${error instanceof GateError ? error.message : error.stack}\n`)
  process.exitCode = EXIT.ERROR
}
