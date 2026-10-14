#!/usr/bin/env node
/**
 * STE 检查：对变更产物与纯文本执行确定性检查，按阻断与告警分级输出。
 *
 * 所属：skill openspec-ste。调用方：/opsx:propose、/opsx:update、/opsx:apply、/opsx:verify（check），
 * 变更模型检查与分镜检查（text）。规则事实源（本脚本只做确定性判定，不重复规则说明）：
 *   - 规则表与分级：openspec-ste/shared/ste-rules.md
 *   - 禁用别名：项目根 CONTEXT.md 的 `_Avoid_`（格式见 openspec-grill/shared/context-format.md）
 *
 * 用法：
 *   node ste-lint.mjs check <changeRoot> [--repo <dir>]   产物检查；repo 缺省为 changeRoot 的上三级
 *   node ste-lint.mjs text [--repo <dir>]                 从 stdin 读文本检查；repo 缺省为当前目录
 *   node ste-lint.mjs reply-hook                          Claude Code Stop hook：stdin 读事件，检查本次回复
 *   node ste-lint.mjs config-snippet                      由规则表生成 openspec/config.yaml 的 rules 片段
 *
 * 输出：check / text 输出一个 JSON 对象 { verdict, blocking, warnings, exemptions }；config-snippet 输出 YAML；
 *   reply-hook 命中禁用别名时输出 { decision: 'block', reason }，只有告警时输出 { systemMessage }，放行时无输出，退出码恒为 0。
 * 配置：内置默认值 shared/vocabulary.yaml，项目 openspec/ste.yaml 按 add / remove / thresholds 合并。
 * 退出码：0 通过（无阻断项）；1 存在阻断项；2 参数或环境错误（变更目录不存在、术语表非法等）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// 内置 YAML 解析库：目标项目不一定执行 npm install，不能依赖其 node_modules。
import { load as loadYaml } from '../vendor/js-yaml.mjs'

/** 退出码：通过 / 存在阻断项 / 参数或环境错误，与 implementation-gate.mjs 一致。 */
const EXIT = Object.freeze({ PASS: 0, BLOCKED: 1, ERROR: 2 })

/** 本 skill 根目录，用于定位内置词表与规则表。 */
const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VOCABULARY_FILE = path.join(SKILL_DIR, 'shared', 'vocabulary.yaml')
const RULES_FILE = path.join(SKILL_DIR, 'shared', 'ste-rules.md')
/** 项目覆盖文件（相对项目根）。 */
const PROJECT_CONFIG = 'openspec/ste.yaml'

/** 规则编号，与 shared/ste-rules.md 的「编号」列一致。 */
const RULE = Object.freeze({
  /** 禁用别名：同一事物只用一个术语（← STE R1.11）。 */
  ALIAS: 'C-R1.11',
  /** 非受控通用词（← STE R1.1）。 */
  VOCABULARY: 'C-R1.1',
  /** 模糊词（← STE R4.1）。 */
  VAGUE: 'C-R4.1',
  /** 名词串（← STE R2.1）。 */
  NOUN_CLUSTER: 'C-R2.1',
  /** 被动语态（← STE R3.6）。 */
  PASSIVE: 'C-R3.6',
  /** 指令句长度（← STE R5.1）。 */
  INSTRUCTION_LENGTH: 'C-R5.1',
  /** 一句一个指令（← STE R5.2）。 */
  STEP: 'C-R5.2',
  /** 描述句长度（← STE R6.3）。 */
  DESCRIPTIVE_LENGTH: 'C-R6.3',
  /** 段落句数（← STE R6.6）。 */
  PARAGRAPH: 'C-R6.6',
  /** 安全提示开头（← STE R7.2）。 */
  SAFETY: 'C-R7.2',
  /** 环境告警：缺少术语表、多领域术语表等，不对应 STE 规则。 */
  ENV: 'ENV',
})

/** 检查模式：产物（check / text）与对话回复的分级不同，见 ste-rules.md「产物 / 对话」列。 */
const MODE = Object.freeze({ ARTIFACT: 'artifact', REPLY: 'reply' })

/** 命中级别：阻断项影响退出码，告警项不影响。 */
const LEVEL = Object.freeze({ BLOCKING: 'blocking', WARNING: 'warning' })

/** 别名、非受控词与模糊词的最少字数：检查用子串匹配，更短的词会大面积误报。 */
const MIN_WORD_LENGTH = 2

/** 名词串判定：按虚词与标点拆分后仍连续出现的最少汉字数。 */
const NOUN_CLUSTER_MIN = 12
/** 名词串拆分用的虚词（单字）；只选几乎不出现在实词内部的字，减少漏拆。 */
const FUNCTION_CHARS = /[的地得了着过和与及或而并且但在从向对为以于由把被将给是也都就才又不没之其这那很最]/
/** 含「被」但不是被字句的词。 */
const PASSIVE_EXCEPTIONS = ['被动']
/** 指令句中表示串联多个动作的写法。 */
const STEP_CONNECTORS = /并|然后|[；;]/
/** 含「并」但不表示串联动作的词。 */
const STEP_EXCEPTIONS = ['并发', '合并', '并行', '并列', '并集', '并非', '兼并', '并存']
/** 安全提示的开头词。 */
const SAFETY_PREFIX = /^(警告|注意)\s*[：:，,]?\s*(.*)$/
/** 句子切分：中文句末标点、英文句末标点（其后为空白或行尾，避免切开 1.5、C-R1.1）。 */
const SENTENCE_END = /[。！？!?]|\.(?=\s|$)/
/** 告警中引用原文的最大字数。 */
const SNIPPET_LENGTH = 20

/** 术语可选类别：STE 技术名词（R1.5）与技术动词（R1.12）在 CONTEXT.md 中的落点。 */
const CATEGORIES = ['技术名词', '技术动词']

/** 产物检查的扫描范围（相对 changeRoot）；review/、evidence/、overview.md 等派生文件不在范围内。 */
const ARTIFACT_FILES = ['proposal.md', 'design.md', 'tasks.md']
const SPECS_DIR = 'specs'

/** text 子命令的 file 字段取值。 */
const STDIN_FILE = '<stdin>'

const NO_GLOSSARY_WARNING = '未建立术语表，一词一义无法校验'
const CONTEXT_MAP_WARNING = '存在 CONTEXT-MAP.md，不支持多领域术语表，只读取根目录 CONTEXT.md'

/** 参数或环境错误：以退出码 2 结束，与「检查不通过」区分。 */
class LintError extends Error {}

// ============================================================================
// 术语表
// ============================================================================

/**
 * 解析 CONTEXT.md 的术语、禁用别名与类别。
 * @param {string} text CONTEXT.md 内容。
 * @returns {{ terms: object[] }} 每个术语含 names（全部写法）、canonical（替代词）、category、avoid。
 * @throws {LintError} 别名只有 1 个字或类别取值非法时抛出：子串匹配下 1 个字的别名会大面积误报。
 */
function parseGlossary(text) {
  const terms = []
  let current = null
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim()
    const header = /^\*\*(.+?)\*\*\s*[:：]$/.exec(line)
    if (header) {
      current = { ...termNames(header[1].trim()), category: null, avoid: [] }
      terms.push(current)
      return
    }
    // 标题行结束当前术语，避免把下一节的说明误读为该术语的属性。
    if (line.startsWith('#')) current = null
    if (!current) return
    const avoid = /^_Avoid_\s*[:：]\s*(.*)$/.exec(line)
    if (avoid) {
      for (const alias of splitList(avoid[1])) {
        if ([...alias].length < MIN_WORD_LENGTH) {
          throw new LintError(`CONTEXT.md 第 ${index + 1} 行：禁用别名「${alias}」少于 ${MIN_WORD_LENGTH} 个字，子串匹配会大面积误报，请改为更长的写法或删除`)
        }
        current.avoid.push(alias)
      }
      return
    }
    const category = /^_Category_\s*[:：]\s*(.*)$/.exec(line)
    if (category) {
      const value = category[1].trim().replace(/[。.]$/, '')
      if (!CATEGORIES.includes(value)) {
        throw new LintError(`CONTEXT.md 第 ${index + 1} 行：_Category_ 取值「${value}」非法，只能是 ${CATEGORIES.join(' / ')}`)
      }
      current.category = value
    }
  })
  return { terms }
}

/** 拆分术语标题 `English（中文）`：中文名作为替代词，英文名与中文名都参与长术语去误报。 */
function termNames(title) {
  const match = /^(.*?)\s*[（(]\s*(.+?)\s*[）)]$/.exec(title)
  if (!match) return { names: [title], canonical: title }
  return { names: [match[1], match[2]].filter(Boolean), canonical: match[2] }
}

/** 按「、」「,」「，」「;」「；」拆分列表，去掉句末标点与空项。 */
function splitList(text) {
  return text.split(/[、,，;；]/).map(item => item.trim().replace(/[。.]$/, '')).filter(Boolean)
}

/**
 * 读取项目根目录的术语表并生成禁用别名规则。
 * @returns {{ aliases: object[], names: string[], warnings: object[] }} names 为全部术语写法；
 *   没有 CONTEXT.md 时 aliases 为空并附带告警，表示已降级。
 */
function loadAliases(repo) {
  const warnings = []
  if (existsSync(path.join(repo, 'CONTEXT-MAP.md'))) warnings.push(envWarning(CONTEXT_MAP_WARNING))
  const file = path.join(repo, 'CONTEXT.md')
  // 缺少术语表时显式降级：跳过禁用别名规则，其他规则照常执行。
  if (!existsSync(file)) return { aliases: [], names: [], warnings: [envWarning(NO_GLOSSARY_WARNING), ...warnings] }
  const { terms } = parseGlossary(readFileSync(file, 'utf8'))
  const names = terms.flatMap(term => term.names)
  const aliases = terms.flatMap(term => term.avoid.map(alias => ({
    word: alias,
    rule: RULE.ALIAS,
    replacement: term.canonical,
    category: term.category,
    shields: longerNames(names, alias),
  })))
  return { aliases, names, warnings }
}

/**
 * 术语表中包含 word 的更长写法。命中位置落在这些写法内时不报告，
 * 如别名「单子」落在术语「单子编号规则」内。禁用别名、非受控词与模糊词共用这一条去误报规则。
 */
const longerNames = (names, word) => names.filter(name => name.length > word.length && name.includes(word))

/** 环境告警不对应文件中的某一行，file 与 line 为 null。 */
const envWarning = detail => ({ file: null, line: null, rule: RULE.ENV, text: '', detail })

// ============================================================================
// 词表与配置合并
// ============================================================================

/** 读取并解析 YAML 文件；解析失败按环境错误处理，报出文件与原因。 */
function readYaml(file, label) {
  try {
    return loadYaml(readFileSync(file, 'utf8')) ?? {}
  } catch (error) {
    throw new LintError(`${label} 解析失败：${error.message}`)
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * 校验辅助：不合法时抛出带文件名的环境错误。
 * 项目文件非法时不静默回退到默认值，否则使用方以为规则已覆盖，实际仍按默认值检查。
 */
function expect(condition, label, message) {
  if (!condition) throw new LintError(`${label} 不符合格式：${message}`)
}

function expectKeys(value, allowed, label, where) {
  expect(isPlainObject(value), label, `${where} 必须是映射`)
  const unknown = Object.keys(value).filter(key => !allowed.includes(key))
  expect(!unknown.length, label, `${where} 含未知字段 ${unknown.join(', ')}（允许 ${allowed.join(', ')}）`)
}

/** 校验词条长度不少于 MIN_WORD_LENGTH。 */
function expectWord(word, label, where) {
  expect(typeof word === 'string' && [...word.trim()].length >= MIN_WORD_LENGTH, label, `${where} 必须是至少 ${MIN_WORD_LENGTH} 个字的字符串`)
}

function expectStrings(value, label, where) {
  expect(Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim()), label, `${where} 必须是字符串列表`)
}

/** 校验并归一化一个词表条目 { word, replacement, exceptions }。 */
function vocabularyEntry(entry, label, where) {
  expectKeys(entry, ['word', 'replacement', 'exceptions'], label, where)
  expectWord(entry.word, label, `${where}.word`)
  expect(typeof entry.replacement === 'string' && entry.replacement.trim(), label, `${where}.replacement 必须是非空字符串`)
  if (entry.exceptions !== undefined) expectStrings(entry.exceptions, label, `${where}.exceptions`)
  return { word: entry.word.trim(), replacement: entry.replacement.trim(), exceptions: entry.exceptions || [] }
}

/** 校验并归一化一个模糊词条目：字符串或 { word, exceptions }。 */
function vagueEntry(entry, label, where) {
  if (typeof entry === 'string') entry = { word: entry }
  expectKeys(entry, ['word', 'exceptions'], label, where)
  expectWord(entry.word, label, `${where}.word`)
  if (entry.exceptions !== undefined) expectStrings(entry.exceptions, label, `${where}.exceptions`)
  return { word: entry.word.trim(), exceptions: entry.exceptions || [] }
}

/** 可配置的阈值键：描述句字数（C-R6.3）、指令句字数（C-R5.1）、段落句数（C-R6.6）。 */
const THRESHOLD_KEYS = ['descriptive', 'instruction', 'paragraph']

/**
 * 校验阈值映射。
 * @param {object} value thresholds 映射。
 * @param {string} label 报错时标明的文件。
 * @param {boolean} required true 用于内置默认值，三个键必须齐全；false 用于项目覆盖，只校验出现的键。
 * @returns {object} 原映射。
 * @throws {LintError} 含未知键、缺少必需键或取值不是正整数时抛出。
 */
function thresholdValues(value, label, required) {
  expectKeys(value, THRESHOLD_KEYS, label, 'thresholds')
  for (const key of THRESHOLD_KEYS) {
    if (value[key] === undefined && !required) continue
    expect(Number.isInteger(value[key]) && value[key] > 0, label, `thresholds.${key} 必须是正整数`)
  }
  return value
}

/** 读取内置默认值 shared/vocabulary.yaml。 */
function loadDefaults() {
  const label = 'openspec-ste/shared/vocabulary.yaml'
  const data = readYaml(VOCABULARY_FILE, label)
  expectKeys(data, ['version', 'thresholds', 'vocabulary', 'vague', 'safetyStarts'], label, '顶层')
  expect(Array.isArray(data.vocabulary), label, 'vocabulary 必须是列表')
  expect(Array.isArray(data.vague), label, 'vague 必须是列表')
  expectStrings(data.safetyStarts, label, 'safetyStarts')
  return {
    thresholds: thresholdValues(data.thresholds, label, true),
    vocabulary: data.vocabulary.map((entry, i) => vocabularyEntry(entry, label, `vocabulary[${i}]`)),
    vague: data.vague.map((entry, i) => vagueEntry(entry, label, `vague[${i}]`)),
    safetyStarts: data.safetyStarts,
  }
}

/** 按 add / remove 合并一组条目：先删除，再追加；add 中与默认值同名的条目覆盖默认值。 */
function mergeEntries(defaults, override, toEntry, label, where) {
  if (override === undefined) return defaults
  expectKeys(override, ['add', 'remove'], label, where)
  const remove = override.remove || []
  expectStrings(remove, label, `${where}.remove`)
  const add = override.add || []
  expect(Array.isArray(add), label, `${where}.add 必须是列表`)
  const added = add.map((entry, i) => toEntry(entry, label, `${where}.add[${i}]`))
  const dropped = new Set([...remove.map(word => word.trim()), ...added.map(entry => entry.word)])
  return [...defaults.filter(entry => !dropped.has(entry.word)), ...added]
}

/**
 * 读取内置默认值并合并项目 openspec/ste.yaml。
 * @returns {{ thresholds: object, vocabulary: object[], vague: object[], safetyStarts: string[] }}
 * @throws {LintError} 项目文件不是合法 YAML 或不符合 schema 时抛出。
 */
function loadConfig(repo) {
  const defaults = loadDefaults()
  const file = path.join(repo, PROJECT_CONFIG)
  if (!existsSync(file)) return defaults
  const label = PROJECT_CONFIG
  const data = readYaml(file, label)
  expectKeys(data, ['version', 'vocabulary', 'vague', 'thresholds'], label, '顶层')
  return {
    thresholds: { ...defaults.thresholds, ...(data.thresholds === undefined ? {} : thresholdValues(data.thresholds, label, false)) },
    vocabulary: mergeEntries(defaults.vocabulary, data.vocabulary, vocabularyEntry, label, 'vocabulary'),
    vague: mergeEntries(defaults.vague, data.vague, vagueEntry, label, 'vague'),
    safetyStarts: defaults.safetyStarts,
  }
}

/**
 * 生成词级规则：禁用别名、非受控通用词、模糊词。
 * 对话回复中非受控词与模糊词只告警（level 为 warning），禁用别名在两种模式下都阻断。
 */
function wordRules(aliases, config, glossaryNames, mode) {
  const level = mode === MODE.REPLY ? LEVEL.WARNING : LEVEL.BLOCKING
  const shields = entry => [...entry.exceptions, ...longerNames(glossaryNames, entry.word)]
  return [
    ...aliases.map(rule => ({ ...rule, level: LEVEL.BLOCKING })),
    ...config.vocabulary.map(entry => ({ word: entry.word, rule: RULE.VOCABULARY, replacement: entry.replacement,
      shields: shields(entry), level })),
    ...config.vague.map(entry => ({ word: entry.word, rule: RULE.VAGUE, shields: shields(entry), level })),
  ]
}

// ============================================================================
// 预处理
// ============================================================================

/** 围栏代码块起止行。 */
const FENCE = /^\s*(```|~~~)/
/** 行内代码（含多个反引号包裹）。 */
const INLINE_CODE = /(`+)[^`]*?\1/g
/** URL：允许路径中含中文，到空白或中文标点为止。 */
const URL = /\b(?:https?|ftp|file):\/\/[^\s)）>\]，。；、]+/g
/** 按空白与标点切出的片段，用于判定文件路径。 */
const TOKEN = /[^\s，。、；：！？（）()「」『』《》<>"'“”‘’[\]{}|,;!?]+/g
/** 带扩展名的文件名结尾，如 `.md`、`.mjs`。 */
const FILE_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,5}$/
/** 代码标识符候选：ASCII 单词，可带点调用。 */
const IDENTIFIER = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g
/** 标识符判定：含驼峰、下划线或点调用；`STE`、`purchase` 这类普通英文词不算，英文别名在正文中仍能命中。 */
const IDENTIFIER_SHAPE = /[a-z][A-Z]|_|\./

/** 路径首段：只含英文字母、数字与 `_.*@~-`，可为空（`/x`、`./x`）。 */
const PATH_HEAD = /^[\w.*@~-]*$/

/**
 * 片段是否为文件路径（可含中文段，如 `docs/单子/readme`、`单子.md`）：
 * - 含「/」时，首段必须是英文路径段。「用户A/用户B退单」「退单/refund」这类中文开头的并列写法不算路径，避免漏检别名；
 * - 不含「/」时，以扩展名结尾且含英文字母才算文件名。
 */
function isFilePath(token) {
  if (token.includes('/')) {
    const head = token.slice(0, token.indexOf('/'))
    return PATH_HEAD.test(head) && /[A-Za-z]/.test(token)
  }
  return FILE_EXTENSION.test(token)
}
/** 显式豁免注释：`<!-- term-allow: 词1、词2 -->`。 */
const TERM_ALLOW = /<!--\s*term-allow\s*[:：]\s*(.*?)\s*-->/g

/**
 * 逐行预处理：去掉代码、URL、文件路径、标识符与 HTML 注释，保留原行号，收集 term-allow 豁免词。
 * 被删除的片段替换为空格，避免两侧文字拼接成新词造成误报。
 * @param {string} text 原文。
 * @param {{ dropQuotes?: boolean }} [options] dropQuotes：删除 markdown 引用块（对话回复中常引用用户原话）。
 * @returns {{ line: number, raw: string, clean: string, allow: Set<string> }[]}
 */
function preprocess(text, { dropQuotes = false } = {}) {
  let fence = null
  let inComment = false
  return text.split(/\r?\n/).map((raw, index) => {
    const result = { line: index + 1, raw, clean: '', allow: new Set() }
    if (fence) {
      if (raw.trim().startsWith(fence)) fence = null
      return result
    }
    const opening = FENCE.exec(raw)
    if (opening) {
      fence = opening[1]
      return result
    }
    if (dropQuotes && /^\s*>/.test(raw)) return result
    let line = raw
    if (inComment) {
      const end = line.indexOf('-->')
      if (end < 0) return result
      line = ' '.repeat(end + 3) + line.slice(end + 3)
      inComment = false
    }
    for (const match of line.matchAll(TERM_ALLOW)) splitList(match[1]).forEach(word => result.allow.add(word))
    line = line.replace(/<!--[\s\S]*?-->/g, ' ')
    const open = line.indexOf('<!--')
    if (open >= 0) {
      line = line.slice(0, open)
      inComment = true
    }
    result.clean = line.replace(INLINE_CODE, ' ').replace(URL, ' ')
      .replace(TOKEN, token => (isFilePath(token) ? ' ' : token))
      .replace(IDENTIFIER, word => (IDENTIFIER_SHAPE.test(word) ? ' ' : word))
    return result
  })
}

// ============================================================================
// 匹配
// ============================================================================

/**
 * 判断一行中是否存在未被保护短语覆盖的命中。
 * @param {string} line 预处理后的行。
 * @param {string} word 待匹配词。
 * @param {string[]} shields 包含该词的更长短语（长术语、例外短语）。
 */
function hasUnshieldedMatch(line, word, shields) {
  const covered = []
  for (const shield of shields) {
    for (let at = line.indexOf(shield); at >= 0; at = line.indexOf(shield, at + 1)) covered.push([at, at + shield.length])
  }
  for (let at = line.indexOf(word); at >= 0; at = line.indexOf(word, at + 1)) {
    if (!covered.some(([start, end]) => start <= at && at + word.length <= end)) return true
  }
  return false
}

/**
 * 对一段文本执行词级规则。同一行同一个词只报告一次。
 * @param {string} file 报告中的文件路径。
 * @param {object[]} lines preprocess 的结果。
 * @param {object[]} rules 词级规则：word、rule、replacement、shields、level 等。
 * @returns {{ blocking: object[], warnings: object[], exemptions: number }}
 */
function matchWords(file, lines, rules) {
  const blocking = []
  const warnings = []
  let exemptions = 0
  for (const { line, clean, allow } of lines) {
    if (!clean.trim()) continue
    for (const rule of rules) {
      if (!hasUnshieldedMatch(clean, rule.word, rule.shields)) continue
      if (allow.has(rule.word)) {
        exemptions += 1
        continue
      }
      const finding = { file, line, rule: rule.rule, text: rule.word }
      if (rule.replacement) finding.replacement = rule.replacement
      if (rule.category) finding.category = rule.category
      ;(rule.level === LEVEL.BLOCKING ? blocking : warnings).push(finding)
    }
  }
  return { blocking, warnings, exemptions }
}

// ============================================================================
// 启发式与统计规则（只告警）
// ============================================================================

/**
 * 按原始行判断行类型：标题、表格不参与句子类规则；复选框任务行与有序列表项是指令句；
 * 无序列表项与引用块按描述句处理但各自成段；其余为正文。
 */
function lineKind(raw) {
  if (/^\s{0,3}#/.test(raw)) return 'heading'
  if (/^\s*\|/.test(raw)) return 'table'
  if (/^\s*[-*+]\s+\[[ xX]\]/.test(raw) || /^\s*\d+[.)]\s/.test(raw)) return 'instruction'
  if (/^\s*(?:[-*+]\s|>)/.test(raw)) return 'item'
  return 'prose'
}

/** 去掉列表、复选框、引用标记与强调符号，只留句子文字。 */
function sentenceText(clean) {
  return clean.replace(/^\s*(?:[-*+]\s+\[[ xX]\]\s*|[-*+]\s+|\d+[.)]\s+|>\s*)/, '').replace(/[*_]{1,3}/g, '').trim()
}

/** 计数口径（ste-rules.md「阈值与计数口径」）：每个汉字计 1，连续英文字母或数字计 1，标点不计。 */
function countChars(sentence) {
  return (sentence.match(/[\u4e00-\u9fff]/g) || []).length + (sentence.match(/[A-Za-z0-9]+/g) || []).length
}

/** 告警中引用的原文片段：压缩删除代码、路径后留下的连续空白，超长截断。 */
function snippet(text) {
  const chars = [...text.replace(/\s+/g, ' ').trim()]
  return chars.length > SNIPPET_LENGTH ? `${chars.slice(0, SNIPPET_LENGTH).join('')}…` : chars.join('')
}

const splitSentences = text => text.split(SENTENCE_END).map(item => item.trim()).filter(item => countChars(item) > 0)

const withoutWords = (text, words) => words.reduce((acc, word) => acc.split(word).join(' '), text)

/**
 * 对一段文本执行启发式与统计规则。
 * @param {string} file 报告中的文件路径。
 * @param {object[]} lines preprocess 的结果。
 * @param {object} config 合并后的配置（阈值、安全提示开头词）。
 * @returns {object[]} 告警列表。
 */
function heuristics(file, lines, config) {
  const warnings = []
  const warn = (line, rule, text, detail) => warnings.push({ file, line, rule, text, detail })
  const { descriptive, instruction, paragraph } = config.thresholds
  let block = null
  const closeParagraph = () => {
    if (block && block.sentences > paragraph) warn(block.line, RULE.PARAGRAPH, snippet(block.first), `段落 ${block.sentences} 句 > ${paragraph}`)
    block = null
  }

  for (const { line, raw, clean } of lines) {
    const kind = lineKind(raw)
    const text = sentenceText(clean)
    if (!text || kind === 'heading' || kind === 'table') {
      closeParagraph()
      continue
    }
    const sentences = splitSentences(text)
    // 段落只由连续的正文行组成；列表项、引用块各自成段，不累计句数。
    if (kind === 'prose') {
      if (!block) block = { line, sentences: 0, first: sentences[0] || text }
      block.sentences += sentences.length
    } else {
      closeParagraph()
    }

    for (const sentence of sentences) {
      const count = countChars(sentence)
      if (kind === 'instruction' && count > instruction) {
        warn(line, RULE.INSTRUCTION_LENGTH, snippet(sentence), `指令句 ${count} 字 > ${instruction}`)
      } else if (kind !== 'instruction' && count > descriptive) {
        warn(line, RULE.DESCRIPTIVE_LENGTH, snippet(sentence), `描述句 ${count} 字 > ${descriptive}`)
      }
      const safety = SAFETY_PREFIX.exec(sentence)
      if (safety && !config.safetyStarts.some(start => safety[2].startsWith(start))) {
        warn(line, RULE.SAFETY, snippet(sentence), '安全提示没有以命令词或条件词开头')
      }
    }

    const cluster = (text.match(/[\u4e00-\u9fff]+/g) || [])
      .flatMap(run => run.split(FUNCTION_CHARS))
      .find(piece => piece.length >= NOUN_CLUSTER_MIN)
    if (cluster) warn(line, RULE.NOUN_CLUSTER, cluster, `连续 ${cluster.length} 个汉字没有虚词或标点`)

    if (withoutWords(text, PASSIVE_EXCEPTIONS).includes('被')) warn(line, RULE.PASSIVE, snippet(text), '「被」字句')

    if (kind === 'instruction') {
      const connector = STEP_CONNECTORS.exec(withoutWords(text, STEP_EXCEPTIONS))
      if (connector) warn(line, RULE.STEP, snippet(text), `指令句含多个动作（「${connector[0]}」）`)
    }
  }
  closeParagraph()
  return warnings
}

// ============================================================================
// 子命令
// ============================================================================

/** 列出 changeRoot 下需要检查的产物（相对路径，按固定顺序）。 */
function listArtifacts(changeRoot) {
  const files = ARTIFACT_FILES.filter(rel => existsSync(path.join(changeRoot, rel)))
  const walk = rel => {
    const dir = path.join(changeRoot, rel)
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(child)
      else if (entry.name.endsWith('.md')) files.push(child)
    }
  }
  walk(SPECS_DIR)
  return files
}

/**
 * 对多段文本执行全部规则并汇总为报告。
 * @param {string} repo 项目根目录（读取 CONTEXT.md）。
 * @param {{ file: string, text: string }[]} documents 待检查文本。
 */
function lint(repo, documents) {
  const config = loadConfig(repo)
  const { aliases, names, warnings } = loadAliases(repo)
  const rules = wordRules(aliases, config, names, MODE.ARTIFACT)
  const blocking = []
  let exemptions = 0
  for (const { file, text } of documents) {
    const lines = preprocess(text)
    const result = matchWords(file, lines, rules)
    blocking.push(...result.blocking)
    warnings.push(...result.warnings, ...heuristics(file, lines, config))
    exemptions += result.exemptions
  }
  return { verdict: blocking.length ? 'BLOCKED' : 'PASS', blocking, warnings, exemptions }
}

// ============================================================================
// 对话回复（Claude Code Stop hook）
// ============================================================================

/** 取消息的文本块；content 为字符串时视为一个文本块。 */
function textBlocks(message) {
  const content = message && message.content
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content.filter(block => block && block.type === 'text' && typeof block.text === 'string').map(block => block.text)
}

/**
 * 从 transcript 读取本次回复：最后一条用户消息之后的全部 assistant 文本块。
 * tool_result 与 isMeta（注入的 skill 正文等）条目虽然 type 为 user，但不是用户输入，不作为分界。
 * @param {string} file transcript JSONL 路径。
 * @returns {string|null} 回复文本；文件不存在或无法解析时返回 null。
 */
function readReply(file) {
  if (typeof file !== 'string' || !existsSync(file)) return null
  let entries
  try {
    entries = readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line))
  } catch {
    return null
  }
  const main = entries.filter(item => item && !item.isSidechain)
  let start = 0
  main.forEach((item, index) => {
    if (item.type === 'user' && !item.isMeta && textBlocks(item.message).length) start = index + 1
  })
  return main.slice(start).filter(item => item.type === 'assistant').flatMap(item => textBlocks(item.message)).join('\n')
}

/**
 * Stop hook：回复含禁用别名时输出 block 决策，让 Claude 改用术语重写；其余情况一律放行。
 * 本次回复 = transcript 中最后一条用户消息之后的 assistant 文本 + 事件的 last_assistant_message。
 * 降级原则：hook 不得让会话失败，缺少术语表、transcript 读不到或解析失败都放行（退出码 0）。
 * @param {string} input stdin 中的 hook 事件 JSON。
 * @returns {string} 标准输出内容；空串表示放行且无提示。
 */
function replyHook(input) {
  let event
  try {
    event = JSON.parse(input)
  } catch {
    return ''
  }
  // 第二次 Stop（已因本 hook 重写过一次）直接放行，保证最多重试 1 次，不会循环阻断。
  if (!event || event.stop_hook_active === true) return ''
  const repo = process.env.CLAUDE_PROJECT_DIR || event.cwd || process.cwd()
  if (!existsSync(path.join(repo, 'CONTEXT.md'))) return ''
  const transcriptReply = readReply(event.transcript_path)
  if (transcriptReply === null) return ''
  // Claude Code 触发 Stop hook 时，最后一条回复可能尚未写入 transcript；事件的 last_assistant_message
  // 带有这条回复的文本，合并进来检查。transcript 已包含该文本时不重复。
  const last = typeof event.last_assistant_message === 'string' ? event.last_assistant_message : ''
  const reply = last && !transcriptReply.includes(last) ? `${transcriptReply}\n${last}` : transcriptReply
  if (!reply.trim()) return ''

  const { aliases, names } = loadAliases(repo)
  let config
  try {
    config = loadConfig(repo)
  } catch {
    // 词表配置非法只影响告警，不影响禁用别名阻断，降级为只检查禁用别名。
    config = { vocabulary: [], vague: [] }
  }
  const result = matchWords('<reply>', preprocess(reply, { dropQuotes: true }), wordRules(aliases, config, names, MODE.REPLY))
  if (result.blocking.length) {
    const pairs = [...new Set(result.blocking.map(item => `${item.text} → ${item.replacement}`))]
    const reason = ['回复中出现 CONTEXT.md 的禁用别名，请改用术语表中的术语重写这条回复：', ...pairs].join('\n')
    return `${JSON.stringify({ decision: 'block', reason })}\n`
  }
  if (result.warnings.length) {
    const words = [...new Set(result.warnings.map(item => (item.replacement ? `${item.text} → ${item.replacement}` : item.text)))]
    return `${JSON.stringify({ systemMessage: `STE 告警（不阻断）：${words.join('、')}` })}\n`
  }
  return ''
}

// ============================================================================
// config.yaml 规则片段
// ============================================================================

/** 片段覆盖的 OpenSpec 产物 ID（spec-driven schema）。 */
const SNIPPET_ARTIFACTS = ['proposal', 'design', 'specs', 'tasks']
/** 规则表中采纳规则所在的小节标题。 */
const ADOPTED_SECTION = '## 采纳的规则'

/**
 * 由 shared/ste-rules.md「采纳的规则」表生成 openspec/config.yaml 的 rules 片段，规则表是唯一事实源。
 * 规则只列一次，用 YAML 锚点供四类产物共用，避免四份副本互相漂移。
 * @returns {string} YAML 片段。
 * @throws {LintError} 规则表缺失或没有可用的规则行时抛出。
 */
function configSnippet() {
  if (!existsSync(RULES_FILE)) throw new LintError(`规则表不存在：${RULES_FILE}`)
  const lines = readFileSync(RULES_FILE, 'utf8').split(/\r?\n/)
  const start = lines.findIndex(line => line.trim() === ADOPTED_SECTION)
  if (start < 0) throw new LintError(`规则表缺少「${ADOPTED_SECTION.slice(3)}」小节：${RULES_FILE}`)
  const rules = []
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break
    const cells = line.split('|').map(cell => cell.trim())
    // 表格行形如 | 编号 | ← STE | 规则 | 检查方法 | 产物 | 对话 |，只取编号为 C-R 开头的数据行。
    if (cells.length >= 4 && /^C-R\d+\.\d+$/.test(cells[1])) rules.push(`${cells[1]}：${cells[3]}`)
  }
  if (!rules.length) throw new LintError(`规则表「${ADOPTED_SECTION.slice(3)}」小节没有规则行：${RULES_FILE}`)
  const [first, ...rest] = SNIPPET_ARTIFACTS
  return [
    '# 中文 STE 规则（由 openspec-ste/shared/ste-rules.md 生成：node ste-lint.mjs config-snippet）',
    '# 修改规则请改规则表后重新生成，不要直接编辑本片段。',
    'rules:',
    `  ${first}: &ste-rules`,
    ...rules.map(rule => `    - ${JSON.stringify(rule)}`),
    ...rest.map(artifact => `  ${artifact}: *ste-rules`),
    '',
  ].join('\n')
}

/** 解析 `--repo <dir>` 可选参数。 */
function parseOptions(args) {
  const options = {}
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '--repo' || i + 1 >= args.length) throw new LintError(`无法识别的参数：${args[i]}`)
    options.repo = path.resolve(args[i + 1])
    i += 1
  }
  return options
}

const USAGE = '用法：node ste-lint.mjs check <changeRoot> [--repo <dir>] | text [--repo <dir>] | reply-hook | config-snippet'

/**
 * 执行子命令。
 * @param {string[]} argv 命令行参数（不含 node 与脚本路径）。
 * @returns {{ code: number, output: string }} 退出码与标准输出内容。
 */
function run(argv) {
  const [command, ...rest] = argv
  let report
  if (command === 'check') {
    const [changeRootArg, ...optionArgs] = rest
    if (!changeRootArg) throw new LintError(USAGE)
    const changeRoot = path.resolve(changeRootArg)
    if (!existsSync(changeRoot) || !statSync(changeRoot).isDirectory()) throw new LintError(`变更目录不存在：${changeRoot}`)
    // changeRoot 通常为 <repo>/openspec/changes/<name>，缺省取上三级作为项目根。
    const repo = parseOptions(optionArgs).repo || path.resolve(changeRoot, '..', '..', '..')
    report = lint(repo, listArtifacts(changeRoot).map(rel => ({ file: rel, text: readFileSync(path.join(changeRoot, rel), 'utf8') })))
  } else if (command === 'text') {
    const repo = parseOptions(rest).repo || process.cwd()
    report = lint(repo, [{ file: STDIN_FILE, text: readFileSync(0, 'utf8') }])
  } else if (command === 'config-snippet' && !rest.length) {
    return { code: EXIT.PASS, output: configSnippet() }
  } else {
    throw new LintError(USAGE)
  }
  return { code: report.blocking.length ? EXIT.BLOCKED : EXIT.PASS, output: `${JSON.stringify(report, null, 2)}\n` }
}

/** reply-hook 入口：任何异常都放行（退出码 0），不让会话因检查脚本失败。 */
function runHook() {
  try {
    process.stdout.write(replyHook(readFileSync(0, 'utf8')))
  } catch (error) {
    process.stderr.write(`ste-lint reply-hook 已放行：${error.message}\n`)
  }
}

/** check / text / config-snippet 入口：参数与环境错误以退出码 2 结束。 */
function runCommand() {
  try {
    const { code, output } = run(process.argv.slice(2))
    process.stdout.write(output)
    process.exitCode = code
  } catch (error) {
    // 参数与环境错误只输出可读信息；非预期异常保留堆栈，便于定位脚本缺陷。
    process.stderr.write(`${error instanceof LintError ? error.message : error.stack}\n`)
    process.exitCode = EXIT.ERROR
  }
}

if (process.argv[2] === 'reply-hook') runHook()
else runCommand()
