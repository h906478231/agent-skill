#!/usr/bin/env node
/**
 * 变更模型检查与渲染：对 design.md 中的 `change-model` 代码块做确定性检查，并生成并集布局、派生 Mermaid 与离线 overview.html。
 *
 * 所属：skill openspec-change-overview。调用方：/opsx:propose、/opsx:update、/opsx:apply、/opsx:verify（check），
 * /opsx:overview（render、mermaid），讲解视频（layout）。格式、6 项检查与卡点处理的事实源：shared/change-model.md
 * （本脚本只做确定性判定，不重复规则说明）。
 *
 * 用法：
 *   node change-model.mjs check <changeRoot> [--repo <dir>]     6 项检查；repo 缺省为 changeRoot 的上三级
 *   node change-model.mjs layout <changeRoot> [--repo <dir>]    并集布局 JSON（讲解视频等下游读取）
 *   node change-model.mjs render <changeRoot> [--repo <dir>]    写入 <changeRoot>/overview.html（离线单文件）
 *   node change-model.mjs mermaid <changeRoot> [--repo <dir>]   派生 Mermaid（对比视图），供 overview.md 第 2 块原样嵌入
 *
 * 输出：check 输出一个 JSON 对象 { verdict, blocking, warnings, exemptions }，字段与 ste-lint.mjs check 相同；
 *   layout 输出 { version, machines, flows }；render 输出 { verdict, output, ... } 摘要；mermaid 输出 Markdown 文本（无模型时为空）；
 *   检查不通过时 layout / render 输出检查报告，不布局、不写文件。
 * 退出码：0 通过（无阻断项）；1 存在阻断项；2 参数或环境错误（变更目录不存在等）。
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
// 内置 YAML 解析库：目标项目不一定执行 npm install，不能依赖其 node_modules。
import { load as loadYaml } from '../vendor/js-yaml.mjs'

/** 退出码：通过 / 存在阻断项 / 参数或环境错误，与 ste-lint.mjs、implementation-gate.mjs 一致。 */
const EXIT = Object.freeze({ PASS: 0, BLOCKED: 1, ERROR: 2 })

/** 规则编号，与 shared/change-model.md「6 项检查」表一致。 */
const RULE = Object.freeze({
  /** schema 与引用。 */
  SCHEMA: 'CM-1',
  /** 禁用别名等 STE 阻断项（调用 openspec-ste 的 ste-lint.mjs text）。 */
  ALIAS: 'CM-2',
  /** Scenario 覆盖。 */
  SCENARIO: 'CM-3',
  /** changed 必须有 before。 */
  BEFORE: 'CM-4',
  /** 已删除元素无指向。 */
  REMOVED_TARGET: 'CM-6',
  /** 可视化判定一致。 */
  DECISION: 'CM-5',
})

/** 本 skill 根目录；STE 检查脚本在同一 skills 根目录下的 openspec-ste 中。 */
const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STE_SCRIPT = path.resolve(SKILL_DIR, '..', 'openspec-ste', 'scripts', 'ste-lint.mjs')
/** STE 检查的环境告警编号（缺少术语表等），原样转为本检查的告警。 */
const STE_ENV_RULE = 'ENV'

/** 被检查的产物与代码块标记（相对 changeRoot）。 */
const DESIGN_FILE = 'design.md'
const FENCE_INFO = 'change-model'
const SPECS_DIR = 'specs'
/** 模型 schema 版本：格式升级时递增，旧版本报 schema 阻断。 */
const MODEL_VERSION = 1

/** 变动标记取值；不写表示未变。 */
const DIFF_VALUES = ['added', 'changed', 'removed']
/** step.kind 唯一允许的取值：判断步骤。 */
const DECISION_KIND = 'decision'

/**
 * 各元素的字段约束：required 必填、optional 可选、before 为 `before` 中允许写的字段（只写被修改字段的旧值）。
 * 连线没有 id，以 from + to 标识；改端点要拆成 removed + added 两条连线，所以 before 只允许 label。
 */
const ELEMENTS = Object.freeze({
  machine: { required: ['id', 'name', 'states', 'transitions'], optional: [] },
  state: { required: ['id', 'name'], optional: ['initial', 'final', 'diff', 'before'], before: ['name', 'initial', 'final'] },
  transition: { required: ['id', 'from', 'to', 'trigger'], optional: ['guard', 'diff', 'before', 'scenarios'],
    before: ['from', 'to', 'trigger', 'guard'] },
  flow: { required: ['id', 'name', 'steps', 'edges'], optional: [] },
  step: { required: ['id', 'name'], optional: ['actor', 'kind', 'async', 'causes', 'diff', 'before', 'scenarios'],
    before: ['name', 'actor', 'kind', 'async', 'causes'] },
  edge: { required: ['from', 'to'], optional: ['label', 'diff', 'before'], before: ['label'] },
})

/** 字段取值类型。 */
const FIELD_TYPES = Object.freeze({
  id: 'string', name: 'string', trigger: 'string', guard: 'string', label: 'string', actor: 'string',
  from: 'string', to: 'string', initial: 'boolean', final: 'boolean', async: 'boolean',
  kind: 'kind', causes: 'strings', scenarios: 'strings', diff: 'diff', before: 'map',
  states: 'list', transitions: 'list', steps: 'list', edges: 'list',
})

/** 顶层允许的键：时序图、字段变更、代码映射不属于变更模型（如 `sequences` 报 schema 阻断）。 */
const TOP_KEYS = ['version', 'machines', 'flows']

/** 参数或环境错误：以退出码 2 结束，与「检查不通过」区分。 */
class ModelError extends Error {}

// ============================================================================
// 读取 design.md
// ============================================================================

/** 围栏代码块起止行：记录围栏字符与长度，关闭行须使用同种字符且不短于开启行。 */
const FENCE = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/

/**
 * 拆分 design.md：提取 `change-model` 代码块，并返回代码块之外的行（用于解析「可视化判定」小节）。
 * @param {string} text design.md 内容。
 * @returns {{ blocks: { line: number, lines: string[] }[], prose: { line: number, text: string }[] }}
 *   block.line 为代码块第一行内容的行号（从 1 开始）。
 */
function splitDesign(text) {
  const blocks = []
  const prose = []
  let fence = null
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1
    if (fence) {
      const closing = FENCE.exec(raw)
      if (closing && closing[1][0] === fence.marker[0] && closing[1].length >= fence.marker.length && !closing[2]) {
        fence = null
      } else if (fence.block) {
        fence.block.lines.push(raw)
      }
      return
    }
    const opening = FENCE.exec(raw)
    if (opening) {
      fence = { marker: opening[1], block: opening[2] === FENCE_INFO ? { line: line + 1, lines: [] } : null }
      if (fence.block) blocks.push(fence.block)
      return
    }
    prose.push({ line, text: raw })
  })
  return { blocks, prose }
}

// ============================================================================
// 检查项
// ============================================================================

/**
 * 构造一条检查项。
 * @param {string} rule 规则编号。
 * @param {string} text 元素 ID、字段名或命中词。
 * @param {string} detail 可读说明。
 * @param {{ line?: number|null, path?: string }} [where] line：design.md 行号；path：字段位置。
 */
function finding(rule, text, detail, { line = null, path: at } = {}) {
  const item = { file: DESIGN_FILE, line, rule, text, detail }
  if (at) item.path = at
  return item
}

/** 生成正则安全的字面量。 */
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 在代码块中定位元素所在行：YAML 解析结果不带行号，按 `key: value` 文本查找，找不到时回退到起点行。
 * @param {{ line: number, lines: string[] }} block 代码块。
 * @returns {(pairs: [string, string][], from?: number) => number} 返回 design.md 行号。
 */
function locator(block) {
  return (pairs, from = block.line) => {
    const patterns = pairs.map(([key, value]) =>
      new RegExp(`(^|[\\s{,-])${key}:\\s*["']?${escapeRegExp(String(value))}["']?(?=[\\s,}]|$)`))
    for (let i = Math.max(0, from - block.line); i < block.lines.length; i += 1) {
      if (patterns.every(pattern => pattern.test(block.lines[i]))) return block.line + i
    }
    return from
  }
}

// ============================================================================
// 规则 1：schema 与引用
// ============================================================================

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 判断值是否符合字段类型。 */
function typeMatches(type, value) {
  switch (type) {
    case 'string': return typeof value === 'string' && value.trim() !== ''
    case 'boolean': return typeof value === 'boolean'
    case 'kind': return value === DECISION_KIND
    case 'strings': return Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim() !== '')
    case 'diff': return DIFF_VALUES.includes(value)
    case 'map': return isPlainObject(value)
    case 'list': return Array.isArray(value)
    default: return false
  }
}

/** 类型说明，用于报告。 */
const TYPE_HINTS = Object.freeze({
  string: '非空字符串（纯数字请加引号）', boolean: 'true 或 false', kind: `只能是 ${DECISION_KIND}`,
  strings: '字符串列表', diff: DIFF_VALUES.join(' / '), map: '映射', list: '列表',
})

/**
 * 校验一个元素的字段：未知字段、缺少必填、取值类型、`before` 的字段与取值。
 * @param {string} kind ELEMENTS 中的元素类型。
 * @param {*} value 元素。
 * @param {string} at 字段位置，如 `machines[0].states[1]`。
 * @param {number} line 元素所在行。
 * @param {object[]} out 检查项输出。
 * @returns {boolean} 元素是否为映射（不是映射时不再检查其子元素）。
 */
function checkElement(kind, value, at, line, out) {
  const spec = ELEMENTS[kind]
  const add = (text, detail, where = at) => out.push(finding(RULE.SCHEMA, text, detail, { line, path: where }))
  if (!isPlainObject(value)) {
    add(at, `${kind} 必须是映射`)
    return false
  }
  const label = typeof value.id === 'string' ? value.id : at
  const allowed = [...spec.required, ...spec.optional]
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) add(label, `${kind} 含未知字段 ${key}（允许 ${allowed.join(', ')}）`, `${at}.${key}`)
  }
  for (const key of spec.required) {
    if (value[key] === undefined) add(label, `${kind} 缺少必填字段 ${key}`, `${at}.${key}`)
  }
  for (const key of allowed) {
    if (value[key] === undefined || typeMatches(FIELD_TYPES[key], value[key])) continue
    add(label, `${key} 必须是${TYPE_HINTS[FIELD_TYPES[key]]}`, `${at}.${key}`)
  }
  if (isPlainObject(value.before)) {
    // before 只描述「被修改的元素」的旧值，未变、新增、删除的元素写 before 没有含义。
    if (value.diff !== 'changed') add(label, '只有 diff: changed 的元素可以写 before', `${at}.before`)
    for (const [key, old] of Object.entries(value.before)) {
      if (!spec.before.includes(key)) {
        add(label, `before 含不可修改的字段 ${key}（${kind} 允许 ${spec.before.join(', ')}）`, `${at}.before.${key}`)
      } else if (old !== null && !typeMatches(FIELD_TYPES[key], old)) {
        // 旧值为 null 表示「变更前没有该字段」，如新增 guard。
        add(label, `before.${key} 必须是${TYPE_HINTS[FIELD_TYPES[key]]}或 null`, `${at}.before.${key}`)
      }
    }
  }
  return true
}

/** 检查 ID 在给定范围内唯一。 */
function checkUnique(items, kind, scope, out) {
  const seen = new Set()
  for (const { item, at, line } of items) {
    if (typeof item.id !== 'string') continue
    if (seen.has(item.id)) out.push(finding(RULE.SCHEMA, item.id, `${kind} ID ${item.id} 在${scope}内重复`, { line, path: `${at}.id` }))
    seen.add(item.id)
  }
}

/**
 * 规则 1：解析代码块并校验 schema、ID 唯一与引用存在。
 * @param {{ line: number, lines: string[] }} block change-model 代码块。
 * @returns {{ model: object|null, findings: object[] }} 只有完全通过时 model 才非空，后续规则只在合法模型上运行。
 */
function checkSchema(block) {
  const out = []
  let data
  try {
    data = loadYaml(block.lines.join('\n'))
  } catch (error) {
    const line = error.mark && Number.isInteger(error.mark.line) ? block.line + error.mark.line : block.line
    return { model: null, findings: [finding(RULE.SCHEMA, FENCE_INFO, `YAML 解析失败：${error.reason || error.message}`, { line })] }
  }
  if (!isPlainObject(data)) {
    return { model: null, findings: [finding(RULE.SCHEMA, FENCE_INFO, '变更模型必须是映射', { line: block.line })] }
  }
  const locate = locator(block)
  for (const key of Object.keys(data)) {
    if (!TOP_KEYS.includes(key)) {
      out.push(finding(RULE.SCHEMA, key, `顶层只允许 ${TOP_KEYS.join(', ')}；时序图、字段变更、代码映射不属于变更模型`,
        { line: locate([[key, '']]), path: key }))
    }
  }
  if (data.version !== MODEL_VERSION) {
    out.push(finding(RULE.SCHEMA, 'version', `version 必须是 ${MODEL_VERSION}`, { line: block.line, path: 'version' }))
  }
  for (const key of ['machines', 'flows']) {
    if (data[key] !== undefined && !Array.isArray(data[key])) {
      out.push(finding(RULE.SCHEMA, key, `${key} 必须是列表`, { line: block.line, path: key }))
    }
  }
  const machines = Array.isArray(data.machines) ? data.machines : []
  const flows = Array.isArray(data.flows) ? data.flows : []

  // 逐个元素校验字段；记录元素与行号，供唯一性与引用检查复用。
  const diagrams = { machine: [], flow: [] }
  const transitions = []
  const walk = (kind, list, key, children) => list.forEach((diagram, i) => {
    const at = `${key}[${i}]`
    const line = locate([['id', diagram && diagram.id]])
    if (!checkElement(kind, diagram, at, line, out)) return
    const entry = { item: diagram, at, line, children: {} }
    diagrams[kind].push(entry)
    for (const [childKey, childKind] of children) {
      if (!Array.isArray(diagram[childKey])) continue
      entry.children[childKey] = []
      diagram[childKey].forEach((child, j) => {
        const childAt = `${at}.${childKey}[${j}]`
        const pairs = childKind === 'edge' ? [['from', child && child.from], ['to', child && child.to]] : [['id', child && child.id]]
        const childLine = locate(pairs, line)
        if (checkElement(childKind, child, childAt, childLine, out)) entry.children[childKey].push({ item: child, at: childAt, line: childLine })
      })
    }
  })
  walk('machine', machines, 'machines', [['states', 'state'], ['transitions', 'transition']])
  walk('flow', flows, 'flows', [['steps', 'step'], ['edges', 'edge']])

  checkUnique(diagrams.machine, 'machine', '全部状态机', out)
  checkUnique(diagrams.flow, 'flow', '全部流程', out)
  for (const machine of diagrams.machine) {
    const states = machine.children.states || []
    checkUnique(states, 'state', `状态机 ${machine.item.id} `, out)
    transitions.push(...(machine.children.transitions || []))
    const stateIds = new Set(states.map(({ item }) => item.id))
    for (const { item, at, line } of machine.children.transitions || []) {
      for (const key of ['from', 'to']) {
        const refs = [[key, item[key]], ...(isPlainObject(item.before) && typeof item.before[key] === 'string' ? [[`before.${key}`, item.before[key]]] : [])]
        for (const [field, ref] of refs) {
          if (typeof ref === 'string' && !stateIds.has(ref)) {
            out.push(finding(RULE.SCHEMA, item.id, `${field} 指向不存在的状态 ${ref}`, { line, path: `${at}.${field}` }))
          }
        }
      }
    }
  }
  // 迁移 ID 在全部状态机内唯一：步骤的 causes 跨状态机引用迁移。
  checkUnique(transitions, 'transition', '全部状态机', out)
  const transitionIds = new Set(transitions.map(({ item }) => item.id))
  for (const flow of diagrams.flow) {
    const steps = flow.children.steps || []
    checkUnique(steps, 'step', `流程 ${flow.item.id} `, out)
    const stepIds = new Set(steps.map(({ item }) => item.id))
    for (const { item, at, line } of steps) {
      for (const ref of Array.isArray(item.causes) ? item.causes : []) {
        if (!transitionIds.has(ref)) out.push(finding(RULE.SCHEMA, item.id, `causes 指向不存在的迁移 ${ref}`, { line, path: `${at}.causes` }))
      }
    }
    const edgeKeys = new Set()
    for (const { item, at, line } of flow.children.edges || []) {
      const key = `${item.from}->${item.to}`
      for (const end of ['from', 'to']) {
        if (typeof item[end] === 'string' && !stepIds.has(item[end])) {
          out.push(finding(RULE.SCHEMA, key, `连线 ${end} 指向不存在的步骤 ${item[end]}`, { line, path: `${at}.${end}` }))
        }
      }
      // 连线以 from + to 标识，重复会让布局与 Mermaid 着色无法对应到唯一连线。
      if (edgeKeys.has(key)) out.push(finding(RULE.SCHEMA, key, `流程 ${flow.item.id} 内连线 ${key} 重复`, { line, path: at }))
      edgeKeys.add(key)
    }
  }
  // 后续规则按元素类型遍历，带上所属图与行号，便于报告。
  const elements = { states: [], transitions: [], steps: [], edges: [] }
  for (const { item: diagram, children } of [...diagrams.machine, ...diagrams.flow]) {
    for (const [key, list] of Object.entries(children)) elements[key].push(...list.map(entry => ({ ...entry, diagram })))
  }
  // 可视化判定只需要状态机与流程的 ID，schema 有误时也尽量比较，减少修正轮次。
  const ids = { machines: idsOf(machines), flows: idsOf(flows) }
  return { model: out.length ? null : { version: data.version, machines, flows }, findings: out, elements, ids }
}

/** 列表中写成字符串的 id。 */
const idsOf = list => list.filter(item => isPlainObject(item) && typeof item.id === 'string').map(item => item.id)

// ============================================================================
// 规则 3、4、6：Scenario 覆盖、修改必须有旧值、已删除元素无指向
// ============================================================================

/** spec 中 Scenario 标题行。 */
const SCENARIO_HEADING = /^####\s+Scenario:\s*(.+?)\s*$/

/**
 * 扫描变更目录 specs/<capability>/spec.md，建立 Scenario 引用索引。
 * @returns {Set<string>} 形如 `<capability>/<scenario name>` 的引用集合；capability 为 specs/ 下的相对目录。
 */
function scenarioIndex(changeRoot) {
  const index = new Set()
  const walk = rel => {
    const dir = path.join(changeRoot, rel)
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(child)
      else if (entry.name === 'spec.md') {
        const capability = rel.slice(SPECS_DIR.length + 1)
        for (const line of readFileSync(path.join(changeRoot, child), 'utf8').split(/\r?\n/)) {
          const match = SCENARIO_HEADING.exec(line)
          if (match) index.add(`${capability}/${match[1]}`)
        }
      }
    }
  }
  if (existsSync(path.join(changeRoot, SPECS_DIR))) walk(SPECS_DIR)
  return index
}

/** 需要 Scenario 覆盖的变动：新增与修改。删除不要求覆盖，但写了的引用同样必须存在。 */
const NEEDS_SCENARIO = ['added', 'changed']

/** 连线的显示标识：连线没有 id，以 from + to 标识。 */
const edgeKey = edge => `${edge.from}->${edge.to}`

/**
 * 规则 3、4、6：在 schema 合法的模型上检查 Scenario 覆盖、changed 的 before、已删除元素的指向。
 * @param {object} elements checkSchema 返回的元素索引。
 * @param {Set<string>} scenarios Scenario 引用索引。
 * @returns {object[]} 检查项。
 */
function checkCoverage(elements, scenarios) {
  const out = []
  for (const { item, at, line } of [...elements.transitions, ...elements.steps]) {
    const refs = item.scenarios || []
    if (NEEDS_SCENARIO.includes(item.diff) && !refs.length) {
      out.push(finding(RULE.SCENARIO, item.id, `diff: ${item.diff} 的元素必须至少引用 1 个 Scenario`, { line, path: `${at}.scenarios` }))
    }
    for (const ref of refs) {
      if (!scenarios.has(ref)) {
        out.push(finding(RULE.SCENARIO, item.id, `Scenario 引用 ${ref} 不存在（格式 <capability>/<scenario name>，按 specs/<capability>/spec.md 的 #### Scenario: 精确匹配）`,
          { line, path: `${at}.scenarios` }))
      }
    }
  }
  for (const { item, at, line } of [...elements.states, ...elements.transitions, ...elements.steps, ...elements.edges]) {
    // 空映射等同于没写：读者看不到任何旧值。
    if (item.diff === 'changed' && !(item.before && Object.keys(item.before).length)) {
      out.push(finding(RULE.BEFORE, item.id || edgeKey(item), 'diff: changed 的元素必须用 before 写出被修改字段的旧值', { line, path: `${at}.before` }))
    }
  }
  const removed = new Set([...elements.states, ...elements.steps]
    .filter(({ item }) => item.diff === 'removed').map(({ item, diagram }) => `${diagram.id}/${item.id}`))
  for (const { item, at, line, diagram } of [...elements.transitions, ...elements.edges]) {
    if (item.diff === 'removed') continue
    for (const end of ['from', 'to']) {
      if (removed.has(`${diagram.id}/${item[end]}`)) {
        out.push(finding(RULE.REMOVED_TARGET, item.id || edgeKey(item), `${end} 指向已删除的元素 ${item[end]}；请删除或改写该${item.id ? '迁移' : '连线'}`,
          { line, path: `${at}.${end}` }))
      }
    }
  }
  return out
}

// ============================================================================
// 规则 2：禁用别名（STE text 检查）
// ============================================================================

/** 参与 STE 检查的文字字段；before 中的旧值不检查，旧叫法正是被改掉的内容。 */
const TEXT_FIELDS = ['name', 'trigger', 'guard', 'label']

/**
 * 规则 2：把 name / trigger / guard / label 按行传给 `ste-lint.mjs text`，阻断项转为 CM-2，行号映射回 design.md。
 * 找不到 openspec-ste 时跳过并告警，其他规则照常执行。
 * @param {object} model 合法模型。
 * @param {object} elements checkSchema 返回的元素索引（含行号）。
 * @param {Function} locate 代码块行定位函数。
 * @param {string} repo 项目根目录（STE 读取其 CONTEXT.md）。
 * @returns {{ blocking: object[], warnings: object[], exemptions: number }}
 * @throws {ModelError} STE 检查报参数或环境错误（退出码 2，如 CONTEXT.md 非法）时抛出。
 */
function checkAliases(model, elements, locate, repo) {
  if (!existsSync(STE_SCRIPT)) {
    const detail = `未找到 openspec-ste（${STE_SCRIPT} 不存在），已跳过 ${RULE.ALIAS} 禁用别名检查`
    return { blocking: [], warnings: [{ file: null, line: null, rule: RULE.ALIAS, text: '', detail }], exemptions: 0 }
  }
  const entries = []
  const collect = (item, at, line) => {
    for (const field of TEXT_FIELDS) {
      if (typeof item[field] === 'string') entries.push({ value: item[field], at: `${at}.${field}`, line: locate([[field, item[field]]], line) })
    }
  }
  model.machines.forEach((machine, i) => collect(machine, `machines[${i}]`, locate([['id', machine.id]])))
  model.flows.forEach((flow, i) => collect(flow, `flows[${i}]`, locate([['id', flow.id]])))
  for (const key of ['states', 'transitions', 'steps', 'edges']) {
    for (const { item, at, line } of elements[key]) collect(item, at, line)
  }
  if (!entries.length) return { blocking: [], warnings: [], exemptions: 0 }
  // 每个值占一行，STE 报告的行号减 1 即 entries 下标；多行值折成一行。
  const input = entries.map(entry => entry.value.replace(/\r?\n/g, ' ')).join('\n')
  const result = spawnSync(process.execPath, [STE_SCRIPT, 'text', '--repo', repo], { input, encoding: 'utf8' })
  if (result.status !== 0 && result.status !== 1) {
    throw new ModelError(`STE 检查失败（退出码 ${result.status}）：${(result.stderr || '').trim()}`)
  }
  const report = JSON.parse(result.stdout)
  const blocking = report.blocking.map(item => {
    const entry = entries[item.line - 1]
    const out = finding(RULE.ALIAS, item.text, `「${entry.value}」含 STE 阻断项「${item.text}」（${item.rule}）${item.replacement ? `，改用「${item.replacement}」` : ''}`,
      { line: entry.line, path: entry.at })
    if (item.replacement) out.replacement = item.replacement
    out.steRule = item.rule
    return out
  })
  // 名称是短语而不是句子，句长、名词串等启发式告警没有意义，只转发环境告警（如缺少术语表）。
  const warnings = report.warnings.filter(item => item.rule === STE_ENV_RULE)
    .map(item => ({ file: null, line: null, rule: RULE.ALIAS, text: '', detail: item.detail, steRule: item.rule }))
  return { blocking, warnings, exemptions: report.exemptions || 0 }
}

// ============================================================================
// 规则 5：可视化判定一致
// ============================================================================

/** 小节标题与两行判定：条件名 → 命中时应声明的模型键。 */
const DECISION_TITLE = '可视化判定'
const DECISION_ROWS = Object.freeze({ 状态变动: 'machines', 流程变动: 'flows' })
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const DECISION_ROW = /^(状态变动|流程变动)\s*[：:]\s*(.*)$/
/** 命中行：`命中 → machines: a, b`，箭头也接受 `->`。 */
const HIT = /^命中\s*(?:→|->)\s*([A-Za-z]+)\s*[：:]\s*(.*)$/
/** 命中行末尾的括号备注（中文或英文括号）：与未命中行一样允许写原因，不参与 ID 解析。 */
const TRAILING_REMARK = /\s*[（(][^（）()]*[）)]\s*$/

/**
 * 规则 5：解析 design.md 的「可视化判定」小节，与模型中的状态机、流程 ID 双向比较。
 * 判定不依赖变更等级：propose 阶段还没有等级，所以 design.md 存在即要求该小节。
 * @param {{ line: number, text: string }[]} prose 代码块之外的行（代码块中的同名标题不算小节）。
 * @param {{ machines: string[], flows: string[] }|null} ids 模型中的 ID；YAML 无法解析时为 null，只检查小节格式。
 * @returns {object[]} 检查项。
 */
function checkDecision(prose, ids) {
  const out = []
  const add = (text, detail, line = null) => out.push(finding(RULE.DECISION, text, detail, { line }))
  const start = prose.findIndex(({ text }) => {
    const heading = HEADING.exec(text)
    return heading && heading[2] === DECISION_TITLE
  })
  if (start < 0) {
    add(DECISION_TITLE, `design.md 缺少「${DECISION_TITLE}」小节：逐条声明状态变动、流程变动是否命中（格式见 shared/change-model.md）`)
    return out
  }
  const level = HEADING.exec(prose[start].text)[1].length
  const declared = { machines: [], flows: [] }
  const seen = new Set()
  for (const { line, text } of prose.slice(start + 1)) {
    const heading = HEADING.exec(text)
    if (heading && heading[1].length <= level) break
    const row = DECISION_ROW.exec(text.replace(/^\s*[-*+]\s+/, '').replace(/\*\*/g, '').trim())
    if (!row) continue
    const [, label, value] = row
    if (seen.has(label)) {
      add(label, `「${label}」重复声明`, line)
      continue
    }
    seen.add(label)
    if (value.startsWith('未命中')) continue
    const hit = HIT.exec(value)
    const key = DECISION_ROWS[label]
    if (!hit) {
      add(label, `「${label}」格式应为「命中 → ${key}: <ID 列表>」或「未命中」`, line)
    } else if (hit[1] !== key) {
      add(label, `「${label}」命中时应声明 ${key}，实际为 ${hit[1]}`, line)
    } else {
      const list = hit[2].replace(TRAILING_REMARK, '').split(/[\s,，、]+/).map(id => id.replace(/`/g, '').trim()).filter(Boolean)
      if (!list.length) add(label, `「${label}」声明命中但没有列出 ${key} 的 ID`, line)
      declared[key].push(...list.map(id => ({ id, line })))
    }
  }
  const sectionLine = prose[start].line
  for (const label of Object.keys(DECISION_ROWS)) {
    if (!seen.has(label)) add(label, `「${DECISION_TITLE}」小节缺少「${label}」一行`, sectionLine)
  }
  if (!ids) return out
  for (const [key, list] of Object.entries(declared)) {
    for (const { id, line } of list) {
      if (!ids[key].includes(id)) add(id, `「${DECISION_TITLE}」声明命中 ${key}: ${id}，但变更模型中没有该${key === 'machines' ? '状态机' : '流程'}`, line)
    }
  }
  for (const [key, list] of Object.entries(ids)) {
    for (const id of list) {
      if (!declared[key].some(item => item.id === id)) {
        add(id, `变更模型中的${key === 'machines' ? '状态机' : '流程'} ${id} 没有在「${DECISION_TITLE}」小节中声明`, sectionLine)
      }
    }
  }
  return out
}

// ============================================================================
// 汇总
// ============================================================================

/**
 * 对一个变更目录执行全部检查。
 * @param {string} changeRoot 变更目录。
 * @param {string} repo 项目根目录（读取 CONTEXT.md）。
 * @returns {{ report: object, model: object|null }} report 为输出 JSON；model 只在检查通过且存在模型时非空。
 */
function checkChange(changeRoot, repo) {
  const blocking = []
  const warnings = []
  let exemptions = 0
  const designPath = path.join(changeRoot, DESIGN_FILE)
  let model = null
  // 没有 design.md 的变更不要求可视化判定，也没有模型可查。
  if (existsSync(designPath)) {
    const { blocks, prose } = splitDesign(readFileSync(designPath, 'utf8'))
    let ids = { machines: [], flows: [] }
    if (blocks.length > 1) {
      ids = null
      blocks.slice(1).forEach(block => blocking.push(finding(RULE.SCHEMA, FENCE_INFO,
        `design.md 最多一个 ${FENCE_INFO} 代码块，共 ${blocks.length} 个`, { line: block.line - 1 })))
    } else if (blocks.length === 1) {
      const schema = checkSchema(blocks[0])
      blocking.push(...schema.findings)
      model = schema.model
      // schema 不合法时元素结构不可信，其余规则只在合法模型上运行。
      if (model) {
        const aliases = checkAliases(model, schema.elements, locator(blocks[0]), repo)
        blocking.push(...aliases.blocking)
        warnings.push(...aliases.warnings)
        exemptions += aliases.exemptions
        blocking.push(...checkCoverage(schema.elements, scenarioIndex(changeRoot)))
      }
      ids = schema.ids || null
    }
    blocking.push(...checkDecision(prose, ids))
  }
  const report = { verdict: blocking.length ? 'BLOCKED' : 'PASS', blocking, warnings, exemptions }
  return { report, model: blocking.length ? null : model }
}

// ============================================================================
// 并集布局（layout）
// ============================================================================

/** 内置布局库 elkjs（EPL-2.0，原样分发）：UMD 包，经 createRequire 按 CommonJS 加载。 */
const ELK_FILE = path.join(SKILL_DIR, 'vendor', 'elk.bundled.js')

/**
 * ELK 布局参数：layered 算法自上而下；固定随机种子并按输入顺序（已按 ID 排序）决定同层次序，
 * 保证同一模型、同一 skill 版本的输出字节一致。
 */
const ELK_OPTIONS = Object.freeze({
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.randomSeed': '1',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.spacing.nodeNode': '40',
  'elk.layered.spacing.nodeNodeBetweenLayers': '56',
  'elk.spacing.edgeLabel': '6',
  'elk.padding': '[top=24,left=24,bottom=24,right=24]',
})

/** 节点尺寸规则（像素，对应 13px 字号）：宽度按文字宽度计算并设上限，超出时换行。 */
const SIZE = Object.freeze({
  /** 汉字等全角字符宽度。 */
  WIDE_CHAR: 14,
  /** 英文、数字等半角字符宽度。 */
  NARROW_CHAR: 8,
  /** 单行文字最大宽度，超出换行。 */
  MAX_TEXT: 168,
  /** 连线标签单行最大宽度。 */
  MAX_LABEL: 140,
  LINE_HEIGHT: 18,
  PAD_X: 14,
  PAD_Y: 9,
  MIN_NODE_WIDTH: 72,
  /** 判断步骤画成六边形，两端尖角多占的宽度。 */
  DECISION_EXTRA: 24,
})

/** 坐标保留 1 位小数：输出更短，且不影响显示。 */
const round = value => Math.round(value * 10) / 10

/** 半角字符（ASCII 与半角符号）按窄字符计宽，其余按全角计宽。 */
const charWidth = char => (char.codePointAt(0) < 0x2e80 ? SIZE.NARROW_CHAR : SIZE.WIDE_CHAR)

/** 折行单位：连续的英文、数字与常见符号作为一个词（如 overview.html），其余每个字符单独成词。 */
const WRAP_TOKEN = /[A-Za-z0-9._\-/@#]+|[\s\S]/gu

/**
 * 按最大宽度把文字折成多行：中文逐字折行，英文单词不拆开；单词本身超过一行时再逐字拆开。
 * @returns {{ lines: string[], width: number }} width 为最宽一行的宽度。
 */
function wrapText(text, maxWidth) {
  const lines = []
  let current = ''
  let currentWidth = 0
  let widest = 0
  const breakLine = () => {
    lines.push(current)
    widest = Math.max(widest, currentWidth)
    current = ''
    currentWidth = 0
  }
  for (const token of text.match(WRAP_TOKEN) || ['']) {
    const tokenWidth = [...token].reduce((sum, char) => sum + charWidth(char), 0)
    if (current && currentWidth + tokenWidth > maxWidth) breakLine()
    for (const char of tokenWidth > maxWidth ? [...token] : [token]) {
      const width = [...char].reduce((sum, c) => sum + charWidth(c), 0)
      if (current && currentWidth + width > maxWidth) breakLine()
      current += char
      currentWidth += width
    }
  }
  lines.push(current)
  return { lines, width: Math.max(widest, currentWidth) }
}

/** 文字块尺寸：多段文字（如变更前后的名称）取能容纳全部写法的尺寸，切换视图时节点大小不变。 */
function textBox(texts, maxWidth) {
  const wrapped = texts.map(text => wrapText(text, maxWidth))
  return {
    width: Math.max(...wrapped.map(item => item.width)),
    lineCount: Math.max(...wrapped.map(item => item.lines.length)),
  }
}

/** 按代码点比较 ID：不受运行环境语言设置影响。 */
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** 字段的变更前取值：before 中写了该字段（含 null）取旧值，否则与当前值相同。 */
const beforeValue = (item, key) => (item.before && Object.prototype.hasOwnProperty.call(item.before, key) ? item.before[key] : item[key])

/** 迁移标签：触发条件，有 guard 时追加 `[guard]`。 */
const transitionLabel = (trigger, guard) => (guard ? `${trigger} [${guard}]` : trigger)

/** 节点在 ELK 中的尺寸：变更前后的名称都要放得下。 */
function nodeSize(names, decision) {
  const box = textBox(names, SIZE.MAX_TEXT)
  const width = Math.max(SIZE.MIN_NODE_WIDTH, box.width + SIZE.PAD_X * 2) + (decision ? SIZE.DECISION_EXTRA : 0)
  return { width, height: box.lineCount * SIZE.LINE_HEIGHT + SIZE.PAD_Y * 2 }
}

/** 连线标签在 ELK 中的尺寸；没有标签时返回 null。 */
function labelSize(texts) {
  const present = texts.filter(Boolean)
  if (!present.length) return null
  const box = textBox(present, SIZE.MAX_LABEL)
  return { width: box.width + 8, height: box.lineCount * SIZE.LINE_HEIGHT }
}

/** 统一的元素属性：未写 diff 记为 unchanged，未写 before 记为 null，便于下游直接读取。 */
const diffOf = item => item.diff || 'unchanged'

/**
 * 把一个状态机转换为 ELK 图的节点与连线（全部元素的并集，含删除的元素）。
 * 迁移改了 from 或 to 时，旧路线作为单独的连线 `<id>@before` 参与布局：变更前视图显示旧路线。
 */
function machineGraph(machine) {
  const nodes = [...machine.states].sort(byId).map(state => ({
    data: { id: state.id, name: state.name, initial: state.initial === true, final: state.final === true,
      diff: diffOf(state), before: state.before || null },
    size: nodeSize([state.name, beforeValue(state, 'name')].filter(Boolean), false),
  }))
  const edges = []
  for (const transition of [...machine.transitions].sort(byId)) {
    const label = transitionLabel(transition.trigger, transition.guard)
    const oldLabel = transitionLabel(beforeValue(transition, 'trigger'), beforeValue(transition, 'guard'))
    const moved = beforeValue(transition, 'from') !== transition.from || beforeValue(transition, 'to') !== transition.to
    edges.push({
      data: { id: transition.id, from: transition.from, to: transition.to, trigger: transition.trigger, guard: transition.guard || null,
        diff: diffOf(transition), before: transition.before || null, scenarios: transition.scenarios || [], route: 'current', text: label },
      // 终点未变时，同一条线要放下变更前后两种标签；终点变了则旧标签画在旧路线上。
      label: labelSize(moved ? [label] : [label, oldLabel]),
    })
    if (moved) {
      edges.push({
        data: { id: `${transition.id}@before`, of: transition.id, from: beforeValue(transition, 'from'), to: beforeValue(transition, 'to'),
          diff: diffOf(transition), route: 'before', text: oldLabel },
        label: labelSize([oldLabel]),
      })
    }
  }
  return { id: machine.id, name: machine.name, nodes, edges }
}

/** 把一个流程转换为 ELK 图的节点与连线（全部元素的并集，含删除的元素）。 */
function flowGraph(flow) {
  const nodes = [...flow.steps].sort(byId).map(step => ({
    data: { id: step.id, name: step.name, actor: step.actor || null, kind: step.kind || null, async: step.async === true,
      causes: step.causes || [], diff: diffOf(step), before: step.before || null, scenarios: step.scenarios || [] },
    size: nodeSize([step.name, beforeValue(step, 'name')].filter(Boolean), step.kind === DECISION_KIND || beforeValue(step, 'kind') === DECISION_KIND),
  }))
  const edges = flow.edges.map(edge => ({ ...edge, id: edgeKey(edge) })).sort(byId).map(edge => ({
    data: { id: edge.id, from: edge.from, to: edge.to, label: edge.label || null, diff: diffOf(edge), before: edge.before || null, text: edge.label || null },
    label: labelSize([edge.label, beforeValue(edge, 'label')]),
  }))
  return { id: flow.id, name: flow.name, nodes, edges }
}

/** 取 ELK 连线的路径点：起点、折点、终点。 */
function routePoints(elkEdge) {
  const points = []
  for (const section of elkEdge.sections || []) {
    points.push(section.startPoint, ...(section.bendPoints || []), section.endPoint)
  }
  return points.map(point => ({ x: round(point.x), y: round(point.y) }))
}

/**
 * 对一张图做一次布局，返回布局 JSON 中的一项。
 * @param {object} elk ELK 实例。
 * @param {{ id: string, name: string, nodes: object[], edges: object[] }} graph machineGraph / flowGraph 的结果。
 */
async function layoutGraph(elk, graph) {
  const result = await elk.layout({
    id: graph.id,
    layoutOptions: ELK_OPTIONS,
    children: graph.nodes.map(node => ({ id: node.data.id, width: node.size.width, height: node.size.height })),
    edges: graph.edges.map(edge => ({ id: edge.data.id, sources: [edge.data.from], targets: [edge.data.to],
      labels: edge.label ? [{ id: `${edge.data.id}#label`, text: edge.data.text, ...edge.label }] : [] })),
  })
  const placed = new Map(result.children.map(child => [child.id, child]))
  const routed = new Map(result.edges.map(edge => [edge.id, edge]))
  return {
    id: graph.id,
    name: graph.name,
    width: round(result.width),
    height: round(result.height),
    nodes: graph.nodes.map(node => {
      const child = placed.get(node.data.id)
      return { ...node.data, x: round(child.x), y: round(child.y), width: round(child.width), height: round(child.height) }
    }),
    edges: graph.edges.map(edge => {
      const elkEdge = routed.get(edge.data.id)
      const label = elkEdge.labels && elkEdge.labels[0]
      return { ...edge.data, points: routePoints(elkEdge),
        labelBox: label ? { x: round(label.x), y: round(label.y), width: round(label.width), height: round(label.height) } : null }
    }),
  }
}

/**
 * 计算整个变更模型的并集布局：每个状态机与流程独立布局，输入为全部元素（含删除的元素）并按 ID 排序。
 * 视图切换只改变元素的显示与样式，不重新布局，因此前后视图共用坐标。
 * @param {object|null} model 合法模型；null 表示没有变更模型。
 * @returns {Promise<{ version: number, machines: object[], flows: object[] }>} 布局 JSON。
 */
async function computeLayout(model) {
  if (!model) return { version: MODEL_VERSION, machines: [], flows: [] }
  const ELK = createRequire(import.meta.url)(ELK_FILE)
  const elk = new ELK()
  const machines = []
  for (const machine of model.machines) machines.push(await layoutGraph(elk, machineGraph(machine)))
  const flows = []
  for (const flow of model.flows) flows.push(await layoutGraph(elk, flowGraph(flow)))
  return { version: MODEL_VERSION, machines, flows }
}

// ============================================================================
// HTML 渲染（render）
// ============================================================================

const TEMPLATE_FILE = path.join(SKILL_DIR, 'assets', 'overview-template.html')
/** 输出文件（相对 changeRoot）：提交 git，随 archive 归档；只由 render 生成，禁止手改。 */
const OUTPUT_FILE = 'overview.html'
/** 模板占位，与 assets/overview-template.html 一致。 */
const PLACEHOLDER = Object.freeze({ TITLE: '{{TITLE}}', BODY: '<!--CHANGE_MODEL_BODY-->', DATA: '<!--CHANGE_MODEL_DATA-->' })
/** 图形细节（像素）：状态与步骤的圆角、初始状态圆点半径、终止状态内框缩进。 */
const SHAPE = Object.freeze({ STATE_RADIUS: 8, STEP_RADIUS: 4, START_RADIUS: 5, FINAL_INSET: 3 })
const KIND_TEXT = Object.freeze({ machine: '状态机', flow: '流程' })

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escapeXml = value => String(value).replace(/[&<>"']/g, char => XML_ESCAPES[char])

/**
 * 多行文字：以 (cx, cy) 为中心垂直排列。
 * @param {string} text 原文，按 maxWidth 折行（与布局时的尺寸规则一致）。
 */
function svgText(text, cx, cy, maxWidth, className) {
  const { lines } = wrapText(text, maxWidth)
  const top = cy - ((lines.length - 1) * SIZE.LINE_HEIGHT) / 2
  const spans = lines.map((line, i) => `<tspan x="${round(cx)}" y="${round(top + i * SIZE.LINE_HEIGHT)}">${escapeXml(line)}</tspan>`).join('')
  return `<text${className ? ` class="${className}"` : ''}>${spans}</text>`
}

/** 变更前后文字不同时输出两份，由视图样式决定显示哪一份；相同时只输出一份。 */
function svgTexts(after, before, cx, cy, maxWidth) {
  if (before === after || before === null || before === undefined) return svgText(after, cx, cy, maxWidth)
  return svgText(after, cx, cy, maxWidth, 'cm-text-after') + svgText(before, cx, cy, maxWidth, 'cm-text-before')
}

/** 节点：状态为圆角矩形，步骤为矩形，判断步骤为六边形；初始状态左侧加圆点，终止状态加内框，异步步骤加角标。 */
function svgNode(kind, diagramId, node) {
  const { width: w, height: h } = node
  const decision = node.kind === DECISION_KIND
  const classes = ['cm-el', 'cm-node', `diff-${node.diff}`, decision && 'cm-decision', node.initial && 'cm-initial', node.final && 'cm-final']
    .filter(Boolean).join(' ')
  const tip = SIZE.DECISION_EXTRA / 2
  const shape = decision
    ? `<polygon class="cm-shape" points="${[[tip, 0], [w - tip, 0], [w, h / 2], [w - tip, h], [tip, h], [0, h / 2]].map(([x, y]) => `${round(x)},${round(y)}`).join(' ')}"/>`
    : `<rect class="cm-shape" width="${w}" height="${h}" rx="${kind === 'machine' ? SHAPE.STATE_RADIUS : SHAPE.STEP_RADIUS}"/>`
  const inset = SHAPE.FINAL_INSET
  const parts = [
    shape,
    node.final ? `<rect class="cm-inner" x="${inset}" y="${inset}" width="${round(w - inset * 2)}" height="${round(h - inset * 2)}" rx="${SHAPE.STATE_RADIUS - inset}"/>` : '',
    node.initial ? `<circle class="cm-start" cx="${-SHAPE.START_RADIUS * 2}" cy="${round(h / 2)}" r="${SHAPE.START_RADIUS}"/>` : '',
    node.async ? `<text class="cm-badge" x="${w}" y="-6">异步</text>` : '',
    svgTexts(node.name, beforeValue(node, 'name'), w / 2, h / 2, SIZE.MAX_TEXT),
  ]
  return `<g class="${classes}" data-key="${escapeXml(`${kind}/${diagramId}/${node.id}`)}" transform="translate(${node.x},${node.y})" tabindex="0" role="button" aria-label="${escapeXml(node.name)}">${parts.join('')}</g>`
}

/** 连线标签的变更前文字：迁移取旧 trigger / guard 拼成的标签，流程连线取旧 label。 */
function edgeBeforeText(kind, edge) {
  if (!edge.before || edge.route === 'before') return null
  return kind === 'machine' ? transitionLabel(beforeValue(edge, 'trigger'), beforeValue(edge, 'guard')) : beforeValue(edge, 'label')
}

/** 连线：路径、加宽的透明点击区域与标签。改了终点的迁移标 cm-moved，变更前视图隐藏它、显示旧路线。 */
function svgEdge(kind, diagramId, edge, moved) {
  const classes = ['cm-el', 'cm-edge', `diff-${edge.diff}`, `route-${edge.route || 'current'}`, moved && 'cm-moved'].filter(Boolean).join(' ')
  const d = edge.points.map((point, i) => `${i ? 'L' : 'M'}${point.x},${point.y}`).join(' ')
  let label = ''
  if (edge.labelBox && edge.text) {
    const box = edge.labelBox
    label = `<g class="cm-label"><rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="3"/>${
      svgTexts(edge.text, edgeBeforeText(kind, edge), box.x + box.width / 2, box.y + box.height / 2, SIZE.MAX_LABEL)}</g>`
  }
  return `<g class="${classes}" data-key="${escapeXml(`${kind}/${diagramId}/${edge.id}`)}" tabindex="0" role="button" aria-label="${escapeXml(edge.text || edge.id)}"><path class="cm-line" d="${d}"/><path class="cm-hit" d="${d}"/>${label}</g>`
}

/** 一张图的 HTML 片段：先画连线，再画节点，节点盖住连线端点。 */
function svgDiagram(kind, diagram) {
  const moved = new Set(diagram.edges.filter(edge => edge.route === 'before').map(edge => edge.of))
  const edges = diagram.edges.map(edge => svgEdge(kind, diagram.id, edge, moved.has(edge.id)))
  const nodes = diagram.nodes.map(node => svgNode(kind, diagram.id, node))
  return [
    `<section class="diagram" id="${escapeXml(`${kind}-${diagram.id}`)}">`,
    `<h2>${KIND_TEXT[kind]}：${escapeXml(diagram.name)} <code>${escapeXml(diagram.id)}</code></h2>`,
    `<div class="canvas"><svg class="graph" viewBox="0 0 ${diagram.width} ${diagram.height}" width="${diagram.width}" height="${diagram.height}" role="img" aria-label="${escapeXml(`${KIND_TEXT[kind]} ${diagram.name}`)}">`,
    ...edges,
    ...nodes,
    '</svg></div>',
    '</section>',
  ].join('\n')
}

/**
 * 由布局 JSON 生成 overview.html 全文：模板 + 内联 SVG + 内联布局 JSON，不含时间戳等易变内容，保证字节一致。
 * @param {string} title 页面标题。
 * @param {object} layout computeLayout 的结果。
 */
function renderHtml(title, layout) {
  const body = [
    ...layout.machines.map(machine => svgDiagram('machine', machine)),
    ...layout.flows.map(flow => svgDiagram('flow', flow)),
  ].join('\n')
  // 转义「<」：防止数据中的 </script> 或 <!-- 提前结束内联脚本。
  const data = JSON.stringify(layout).replace(/</g, '\\u003c')
  return readFileSync(TEMPLATE_FILE, 'utf8')
    .split(PLACEHOLDER.TITLE).join(escapeXml(title))
    .split(PLACEHOLDER.BODY).join(body)
    .split(PLACEHOLDER.DATA).join(data)
}

// ============================================================================
// 派生 Mermaid（mermaid）
// ============================================================================

/** 对比视图的着色：与 overview.html 同一套低对比度配色，新增绿色、修改黄色、删除红色虚线。 */
const MERMAID_CLASSES = Object.freeze({
  added: 'fill:#edf7f0,stroke:#6bb486,stroke-width:2px,color:#3f4a5a',
  changed: 'fill:#fbf5e3,stroke:#d4ae5a,stroke-width:2px,color:#3f4a5a',
  removed: 'fill:#fcf0f0,stroke:#de8c8c,stroke-width:2px,stroke-dasharray:5 5,color:#3f4a5a',
})
/** 流程连线的 linkStyle：stateDiagram 不支持给迁移线着色，所以迁移改用标签前缀。 */
const MERMAID_LINKS = Object.freeze({
  added: 'stroke:#6bb486,stroke-width:2px',
  changed: 'stroke:#d4ae5a,stroke-width:2px',
  removed: 'stroke:#de8c8c,stroke-width:2px,stroke-dasharray:5 5',
})
/** 迁移标签前缀。 */
const DIFF_PREFIX = Object.freeze({ added: '➕ ', changed: '✏️ ', removed: '❌ ' })
/** Mermaid 保留字：作为节点 ID 会导致语法错误，追加下划线。 */
const MERMAID_RESERVED = ['end', 'graph', 'flowchart', 'subgraph', 'class', 'classdef', 'style', 'linkstyle', 'click', 'state', 'note', 'direction', 'default']
const MERMAID_INDENT = '    '
const MERMAID_LEGEND = '图例：➕ 新增　✏️ 修改　❌ 删除；绿色为新增，黄色为修改，红色虚线为删除。'

/** 文字中会破坏 Mermaid 语法的字符改用实体码。 */
const MERMAID_ENTITIES = { '"': '#quot;', ';': '#59;', '|': '#124;', '<': '#lt;', '>': '#gt;', '#': '#35;' }
const escapeMermaid = text => String(text).replace(/[";|<>#]/g, char => MERMAID_ENTITIES[char])

/**
 * 为一张图生成 Mermaid 安全的 ID：只保留字母、数字与下划线，避开保留字与重复。
 * @returns {(id: string) => string} 原 ID → Mermaid ID。
 */
function mermaidIds(ids) {
  const mapping = new Map()
  const used = new Set()
  for (const id of ids) {
    let safe = id.replace(/[^A-Za-z0-9_]/g, '_')
    if (!/^[A-Za-z]/.test(safe) || MERMAID_RESERVED.includes(safe.toLowerCase())) safe = `n_${safe}`
    let candidate = safe
    for (let i = 2; used.has(candidate); i += 1) candidate = `${safe}_${i}`
    used.add(candidate)
    mapping.set(id, candidate)
  }
  return id => mapping.get(id)
}

/** 三种变动的 classDef：固定全部输出，读者对照图例即可。 */
const mermaidClassDefs = () => DIFF_VALUES.map(diff => `classDef ${diff} ${MERMAID_CLASSES[diff]}`)

/** class 行：每种出现的变动一行，列出该变动的元素。 */
function mermaidClassLines(items, idOf) {
  return DIFF_VALUES.map(diff => [diff, items.filter(item => item.diff === diff).map(item => idOf(item.id))])
    .filter(([, ids]) => ids.length)
    .map(([diff, ids]) => `class ${ids.join(',')} ${diff}`)
}

/** 状态机 → stateDiagram-v2（对比视图）：变动状态用 class 着色，迁移标签加前缀，改了起点或终点的迁移另画旧路线。 */
function mermaidMachine(machine) {
  const idOf = mermaidIds(machine.states.map(state => state.id))
  const body = []
  for (const state of machine.states) body.push(`state "${escapeMermaid(state.name)}" as ${idOf(state.id)}`)
  for (const state of machine.states) if (state.initial) body.push(`[*] --> ${idOf(state.id)}`)
  for (const transition of machine.transitions) {
    const prefix = DIFF_PREFIX[transition.diff] || ''
    const label = transitionLabel(transition.trigger, transition.guard)
    body.push(`${idOf(transition.from)} --> ${idOf(transition.to)} : ${prefix}${escapeMermaid(label)}`)
    const from = beforeValue(transition, 'from')
    const to = beforeValue(transition, 'to')
    if (from !== transition.from || to !== transition.to) {
      const oldLabel = transitionLabel(beforeValue(transition, 'trigger'), beforeValue(transition, 'guard'))
      body.push(`${idOf(from)} --> ${idOf(to)} : ${DIFF_PREFIX.removed}${escapeMermaid(oldLabel)}`)
    }
  }
  for (const state of machine.states) if (state.final) body.push(`${idOf(state.id)} --> [*]`)
  return ['stateDiagram-v2', ...[...mermaidClassDefs(), ...body, ...mermaidClassLines(machine.states, idOf)].map(line => MERMAID_INDENT + line)]
}

/** 流程 → flowchart TD（对比视图）：节点用 class 着色，连线按出现顺序用 linkStyle 着色，删除的连线画成虚线。 */
function mermaidFlow(flow) {
  const idOf = mermaidIds(flow.steps.map(step => step.id))
  const body = []
  for (const step of flow.steps) {
    const text = `"${escapeMermaid(step.name)}"`
    body.push(`${idOf(step.id)}${step.kind === DECISION_KIND ? `{${text}}` : `[${text}]`}`)
  }
  const links = []
  flow.edges.forEach((edge, index) => {
    const arrow = edge.diff === 'removed' ? '-.->' : '-->'
    body.push(`${idOf(edge.from)} ${arrow}${edge.label ? `|${escapeMermaid(edge.label)}|` : ''} ${idOf(edge.to)}`)
    if (edge.diff) links.push(`linkStyle ${index} ${MERMAID_LINKS[edge.diff]}`)
  })
  return ['flowchart TD', ...[...mermaidClassDefs(), ...body, ...links, ...mermaidClassLines(flow.steps, idOf)].map(line => MERMAID_INDENT + line)]
}

/**
 * 由合法模型生成 overview.md 第 2 块的 Mermaid 文本：每张图一个小标题与一个 mermaid 代码块，末尾附图例。
 * 文本由 skill 原样插入固定标记之间，不得手改。
 * @param {object|null} model 合法模型；null 时返回空串。
 */
function renderMermaid(model) {
  if (!model) return ''
  const sections = [
    ...model.machines.map(machine => ({ heading: `#### ${KIND_TEXT.machine}：${machine.name}（${machine.id}）`, lines: mermaidMachine(machine) })),
    ...model.flows.map(flow => ({ heading: `#### ${KIND_TEXT.flow}：${flow.name}（${flow.id}）`, lines: mermaidFlow(flow) })),
  ]
  return `${[...sections.flatMap(({ heading, lines }) => [heading, '', '```mermaid', ...lines, '```', '']), MERMAID_LEGEND].join('\n')}\n`
}

// ============================================================================
// 入口
// ============================================================================

const USAGE = '用法：node change-model.mjs check|layout|render|mermaid <changeRoot> [--repo <dir>]'

/** 检查报告的输出：layout 等子命令在检查不通过时同样输出报告，以相同退出码结束。 */
const reportOutput = report => ({ code: report.blocking.length ? EXIT.BLOCKED : EXIT.PASS, output: `${JSON.stringify(report, null, 2)}\n` })

/** 解析 `<changeRoot> [--repo <dir>]`。 */
function parseArgs(args) {
  const [changeRootArg, ...rest] = args
  if (!changeRootArg) throw new ModelError(USAGE)
  const changeRoot = path.resolve(changeRootArg)
  if (!existsSync(changeRoot) || !statSync(changeRoot).isDirectory()) throw new ModelError(`变更目录不存在：${changeRoot}`)
  let repo = null
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] !== '--repo' || i + 1 >= rest.length) throw new ModelError(`无法识别的参数：${rest[i]}`)
    repo = path.resolve(rest[i + 1])
    i += 1
  }
  // changeRoot 通常为 <repo>/openspec/changes/<name>，缺省取上三级作为项目根。
  return { changeRoot, repo: repo || path.resolve(changeRoot, '..', '..', '..') }
}

/**
 * 执行子命令。
 * @param {string[]} argv 命令行参数（不含 node 与脚本路径）。
 * @returns {Promise<{ code: number, output: string }>} 退出码与标准输出内容。
 */
async function run(argv) {
  const [command, ...rest] = argv
  if (!['check', 'layout', 'render', 'mermaid'].includes(command)) throw new ModelError(USAGE)
  const { changeRoot, repo } = parseArgs(rest)
  const { report, model } = checkChange(changeRoot, repo)
  // 先检查：不合法的模型不布局、不渲染，也不写任何文件。
  if (command === 'check' || report.blocking.length) return reportOutput(report)
  if (command === 'mermaid') return { code: EXIT.PASS, output: renderMermaid(model) }
  const layout = await computeLayout(model)
  if (command === 'layout') return { code: EXIT.PASS, output: `${JSON.stringify(layout, null, 2)}\n` }
  // 没有变更模型时 overview.md 保持 ASCII 流程，不生成 overview.html。
  if (!model) return { code: EXIT.PASS, output: `${JSON.stringify({ verdict: 'PASS', output: null, detail: '没有变更模型，未生成 overview.html' }, null, 2)}\n` }
  const title = `变更总览图：${path.basename(changeRoot)}`
  writeFileSync(path.join(changeRoot, OUTPUT_FILE), renderHtml(title, layout))
  const summary = { verdict: 'PASS', output: OUTPUT_FILE, machines: layout.machines.length, flows: layout.flows.length }
  return { code: EXIT.PASS, output: `${JSON.stringify(summary, null, 2)}\n` }
}

run(process.argv.slice(2)).then(({ code, output }) => {
  process.stdout.write(output)
  process.exitCode = code
}, error => {
  // 参数与环境错误只输出可读信息；非预期异常保留堆栈，便于定位脚本缺陷。
  process.stderr.write(`${error instanceof ModelError ? error.message : error.stack}\n`)
  process.exitCode = EXIT.ERROR
})
