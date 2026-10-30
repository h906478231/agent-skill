import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 阶段交接检查（add-workflow-change-testing，spec stage-handoff-check，design.md D8–D10）。
 *
 * 事实源：`phases.md`「各阶段的输入与新会话」表（输入与产出）与流程文档的「命令-Skill 对照表」。
 * 检查 5 项：输入有上游产出、分支中的阶段都在阶段表中、命令有对应的 skill、shared 文件没有孤立文件、
 * 阶段表与阶段 skill 的规则文本对账。只读文件，不启动子进程，不访问网络。
 *
 * 解析与检查函数只接收文本，`scripts/test-stage-handoff.mjs` 用夹具文本测试反例；
 * `checkRepo` 读取仓库真实文件后调用它们，供 `npm run test:handoff` 与 `evals/report.mjs` 使用。
 * 每个检查返回问题数组，元素为 `{ check, message, ...定位字段 }`，空数组表示通过。
 */

/** 阶段表事实源；对账时从 review skill 的规则文本中排除，否则 review 一行一定通过（D8，ARCH-12）。 */
export const PHASES_PATH = 'skills/openspec-technical-review/shared/phases.md'
/** 命令-Skill 对照表的事实源（D9）。不从命令文件内容推断 skill：上游命令文件不一定写出 skill 名。 */
export const COMMAND_DOC_PATH = 'workflow/OpenSpec-AI-研发流程.md'
export const STAGE_TABLE_HEADING = '## 各阶段的输入与新会话'
export const COMMAND_TABLE_HEADING = '### 命令-Skill 对照表'
/** 阶段表必须有的 4 列（spec「phases.md 的阶段表写明每个阶段的产出」）。 */
export const STAGE_TABLE_COLUMNS = ['阶段', '读取的输入', '产出', '能否在新会话中开始']

/**
 * 4 条以 archive 结束的分支。分支来自 gate-levels.md 的分级与方案类型，不是一张现成的表，
 * 所以写成常量；新增阶段时「每个阶段出现在分支或按需阶段中」失败，提醒修改这里（D8）。
 */
export const BRANCHES = [
  { name: '标准', stages: ['propose', 'review', 'apply', 'quality', 'verify', 'archive'] },
  { name: '评审回路', stages: ['propose', 'review', 'update', 'review', 'apply', 'quality', 'verify', 'archive'] },
  { name: 'L0 豁免', stages: ['propose', 'apply', 'verify', 'archive'] },
  { name: 'MVP 跳过评审', stages: ['propose', 'apply', 'quality', 'verify', 'archive'] },
]
/** 只在触发条件命中时运行、不在默认路径上的阶段。 */
export const ON_DEMAND_STAGES = ['grill', 'explore', 'overview', 'recap']
/** 项目级资产不随变更产生，作为无条件输入时不要求上游产出。 */
export const PROJECT_ASSETS = ['CONTEXT.md', 'docs/adr/']
/**
 * schema 定义的 4 个产物按 artifact id 匹配规则文本：上游生成的 propose、apply skill 用
 * `openspec status` 返回的 artifact id 定位产物，不写文件名（D8）。
 */
export const SCHEMA_ARTIFACTS = { 'proposal.md': 'proposal', 'design.md': 'design', 'specs/': 'specs', 'tasks.md': 'tasks' }
/** 对照表中上游命令的 skill 列取值：这类命令没有本仓库的 skill，对账与 SKILL.md 存在性检查都跳过。 */
export const UPSTREAM_SKILL = '无（上游命令）'

/** 引用扫描与规则文本对账都排除第三方代码目录（D8、D10）。 */
const isVendorPath = path => path.split('/').includes('vendor')
const REFERRER_EXT = /\.(md|js|mjs)$/
const RULE_TEXT_EXT = /\.(md|mjs)$/
const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** 匹配边界：文件名、artifact id 前后不能紧接字母、数字或 `-`（`gate-check.md` 不能命中 `apply-gate-check.md`）。 */
const bounded = token => new RegExp(`(?<![A-Za-z0-9-])${escapeRegExp(token)}(?![A-Za-z0-9-])`)

/** 按未转义的 `|` 拆分表格行，去掉首尾空单元格。 */
function splitRow(line) {
  const cells = line.trim().split(/(?<!\\)\|/).map(c => c.trim())
  return cells.slice(1, cells.length - 1)
}

/** 取 heading 之后第一张表格（连续的 `|` 行），返回表头与数据行；找不到时返回 null。 */
function tableAfter(markdown, heading) {
  const lines = markdown.split('\n')
  const start = lines.findIndex(l => l.trim() === heading)
  if (start < 0) return null
  let i = start + 1
  while (i < lines.length && !lines[i].startsWith('|')) {
    if (/^#{1,6} /.test(lines[i])) return null
    i++
  }
  const block = []
  while (i < lines.length && lines[i].startsWith('|')) block.push(lines[i++])
  if (block.length < 2) return null
  return { header: splitRow(block[0]), rows: block.slice(2).map(splitRow) }
}

/**
 * 取单元格中的文件与目录：行内代码是文件，紧跟其后的括号（全角或半角）是读取条件。
 * 不是行内代码的文字是说明，不读取（spec「phases.md 的阶段表写明每个阶段的产出」）。
 */
function filesInCell(cell) {
  const files = []
  for (const m of cell.matchAll(/`([^`]+)`(?:（([^）]*)）|\(([^)]*)\))?/g)) {
    files.push({ path: m[1].trim(), condition: (m[2] ?? m[3] ?? '').trim() || null })
  }
  return files
}

/**
 * 解析 phases.md 的「各阶段的输入与新会话」表。
 *
 * @param {string} markdown phases.md 全文
 * @param {string} [source] 出错时写进消息的文件名
 * @returns {{ rows: Array<{label: string, stages: string[], inputs: Array<{path: string, condition: string|null}>, outputs: Array<{path: string, condition: string|null}>}>, issues: object[] }}
 *   表格或列缺失时 rows 为空，issues 写出缺少的内容
 */
export function parseStageTable(markdown, source = PHASES_PATH) {
  const table = tableAfter(markdown, STAGE_TABLE_HEADING)
  if (!table) {
    return { rows: [], issues: [{ check: 'table', message: `${source}：找不到「${STAGE_TABLE_HEADING.replace(/^#+ /, '')}」表` }] }
  }
  const missing = STAGE_TABLE_COLUMNS.filter(c => !table.header.includes(c))
  if (missing.length) {
    return { rows: [], issues: [{ check: 'table', message: `${source}：「各阶段的输入与新会话」表缺少列：${missing.join('、')}` }] }
  }
  const [stageCol, inputCol, outputCol] = STAGE_TABLE_COLUMNS.map(c => table.header.indexOf(c))
  const rows = table.rows.map(cells => ({
    label: cells[stageCol],
    // `propose / ff` 一行同时对应两个阶段
    stages: cells[stageCol].split('/').map(s => s.trim()).filter(Boolean),
    inputs: filesInCell(cells[inputCol] ?? ''),
    outputs: filesInCell(cells[outputCol] ?? ''),
  }))
  return { rows, issues: [] }
}

/**
 * 解析流程文档的「命令-Skill 对照表」。
 *
 * @param {string} markdown 流程文档全文
 * @param {string} [source] 出错时写进消息的文件名
 * @returns {{ rows: Array<{command: string, skill: string}>, issues: object[] }} command 不含 `/opsx:` 前缀；
 *   上游命令的 skill 为 `UPSTREAM_SKILL`
 */
export function parseCommandTable(markdown, source = COMMAND_DOC_PATH) {
  const table = tableAfter(markdown, COMMAND_TABLE_HEADING)
  if (!table) {
    return { rows: [], issues: [{ check: 'commands', message: `${source}：找不到「命令-Skill 对照表」` }] }
  }
  const rows = []
  for (const cells of table.rows) {
    const command = cells[0]?.match(/\/opsx:([A-Za-z0-9-]+)/)?.[1]
    if (!command) continue
    rows.push({ command, skill: (cells[1] ?? '').replace(/`/g, '').trim() })
  }
  return { rows, issues: [] }
}

/** 阶段名到阶段表一行的对应；`propose / ff` 一行同时对应两个阶段。 */
function stageRowMap(rows) {
  const rowOf = new Map()
  for (const row of rows) for (const stage of row.stages) rowOf.set(stage, row)
  return rowOf
}

/**
 * 各分支的交接边：下游阶段的每个输入，连到分支中最近一个产出它的上游阶段（评审回路中 review 出现两次，取后一次）。
 * 无条件输入没有上游产出、也不是项目资产时，从分支中的前一个阶段画断开的边（下游是第一个阶段时 from 为 null）；
 * 有条件输入在分支中没有产出时不画边。checkHandoff 的分支检查与 evals/report.mjs 的阶段交接图都用这里的结果。
 *
 * @param {ReturnType<typeof parseStageTable>['rows']} rows 阶段表
 * @returns {Array<{branch: string, from: string|null, fromIndex: number, to: string, toIndex: number, files: string[], broken: boolean}>}
 *   同一条分支中上下游相同、状态相同的文件合成一条边
 */
export function handoffEdges(rows) {
  const rowOf = stageRowMap(rows)
  const produces = (stage, path) => rowOf.get(stage)?.outputs.some(o => o.path === path) ?? false
  const edges = new Map()
  const add = (branch, fromIndex, toIndex, file, broken) => {
    const key = `${branch.name}|${fromIndex}|${toIndex}|${broken}`
    if (!edges.has(key)) {
      edges.set(key, {
        branch: branch.name, from: fromIndex >= 0 ? branch.stages[fromIndex] : null, fromIndex,
        to: branch.stages[toIndex], toIndex, files: [], broken,
      })
    }
    const edge = edges.get(key)
    if (!edge.files.includes(file)) edge.files.push(file)
  }
  for (const branch of BRANCHES) {
    branch.stages.forEach((stage, index) => {
      const row = rowOf.get(stage)
      if (!row) return
      for (const input of row.inputs) {
        if (PROJECT_ASSETS.includes(input.path)) continue
        let from = index - 1
        while (from >= 0 && !produces(branch.stages[from], input.path)) from--
        if (from >= 0) add(branch, from, index, input.path, false)
        else if (!input.condition) add(branch, index - 1, index, input.path, true)
      }
    })
  }
  return [...edges.values()]
}

/**
 * 检查阶段表的输入能接上产出（spec「每个输入文件都有上游产出」）。
 *
 * - 无条件输入：每条包含该阶段的分支中，之前的某个阶段产出它，或它是项目资产。
 * - 有条件输入：阶段表中有阶段产出它即可（L0 豁免分支没有 review，仍然通过）。
 * - 分支中的阶段都在阶段表中；阶段表的每个阶段出现在分支或按需阶段中。
 *
 * @param {ReturnType<typeof parseStageTable>['rows']} rows 阶段表
 * @returns {object[]} 问题，带 branch（有条件输入的问题没有）、stage、file
 */
export function checkHandoff(rows) {
  const issues = []
  const rowOf = stageRowMap(rows)
  for (const branch of BRANCHES) {
    for (const stage of branch.stages) {
      if (rowOf.has(stage)) continue
      issues.push({ check: 'handoff', branch: branch.name, stage, message: `分支「${branch.name}」的阶段 ${stage} 在阶段表中没有一行` })
    }
  }
  for (const edge of handoffEdges(rows)) {
    if (!edge.broken) continue
    for (const file of edge.files) {
      issues.push({
        check: 'handoff', branch: edge.branch, stage: edge.to, file,
        message: `分支「${edge.branch}」中 ${edge.to} 的输入 ${file} 没有上游产出`,
      })
    }
  }

  for (const row of rows) {
    for (const input of row.inputs) {
      if (!input.condition || PROJECT_ASSETS.includes(input.path)) continue
      if (rows.some(r => r.outputs.some(o => o.path === input.path))) continue
      issues.push({
        check: 'handoff', stage: row.stages[0], file: input.path,
        message: `${row.label} 的输入 ${input.path}（${input.condition}）没有任何阶段产出`,
      })
    }
  }

  const covered = new Set([...BRANCHES.flatMap(b => b.stages), ...ON_DEMAND_STAGES])
  for (const row of rows) {
    if (row.stages.some(s => covered.has(s))) continue
    issues.push({
      check: 'handoff', stage: row.stages[0],
      message: `阶段 ${row.label} 不在任何分支或按需阶段中，修改 scripts/lib/stage-handoff.mjs 的 BRANCHES 或 ON_DEMAND_STAGES`,
    })
  }
  return issues
}

/**
 * 检查命令文件与对照表（spec「每个命令都有对应的 skill」）。
 *
 * @param {ReturnType<typeof parseCommandTable>['rows']} commandRows 对照表
 * @param {string[]} commandFiles `claude/commands/opsx/` 下的文件名（如 `apply.md`）
 * @param {string[]} skillNames 有 `SKILL.md` 的 skill 目录名
 * @returns {object[]} 问题
 */
export function checkCommands(commandRows, commandFiles, skillNames) {
  const issues = []
  for (const file of commandFiles) {
    if (commandRows.some(r => `${r.command}.md` === file)) continue
    issues.push({ check: 'commands', file, message: `claude/commands/opsx/${file} 在命令-Skill 对照表中没有对应的行` })
  }
  for (const row of commandRows) {
    if (!commandFiles.includes(`${row.command}.md`)) {
      issues.push({ check: 'commands', file: `${row.command}.md`, message: `命令-Skill 对照表的 /opsx:${row.command} 没有命令文件 claude/commands/opsx/${row.command}.md` })
    }
    if (row.skill !== UPSTREAM_SKILL && !skillNames.includes(row.skill)) {
      issues.push({ check: 'commands', skill: row.skill, message: `命令-Skill 对照表的 /opsx:${row.command} 写的 skill ${row.skill} 没有 skills/${row.skill}/SKILL.md` })
    }
  }
  return issues
}

/**
 * 找出没有被引用的 shared 规则文件（spec「shared 规则文件没有孤立文件」）。
 *
 * 引用方是 `skills/` 与 `claude/commands/` 下的 `.md`、`.js`、`.mjs` 文件，被检查的文件本身与 `vendor/` 除外。
 *
 * @param {string[]} sharedFiles `skills/<skill>/shared/*.md` 的仓库相对路径
 * @param {Array<{path: string, text: string}>} files 候选引用方
 * @returns {object[]} 每个孤立文件一个问题
 */
export function findOrphans(sharedFiles, files) {
  const referrers = files.filter(f =>
    (f.path.startsWith('skills/') || f.path.startsWith('claude/commands/')) && REFERRER_EXT.test(f.path) && !isVendorPath(f.path))
  const issues = []
  for (const shared of sharedFiles) {
    const pattern = bounded(shared.split('/').pop())
    if (referrers.some(f => f.path !== shared && pattern.test(f.text))) continue
    issues.push({ check: 'orphans', file: shared, message: `${shared} 没有被 skills/ 或 claude/commands/ 下的其他文件引用` })
  }
  return issues
}

/** 阶段表中一个文件对应的规则文本匹配：schema 产物按 artifact id，目录按最后一级目录名加 `/`，其他按完整写法。 */
function ruleTextPattern(path) {
  if (SCHEMA_ARTIFACTS[path]) return bounded(SCHEMA_ARTIFACTS[path])
  if (path.endsWith('/')) {
    const dir = `${path.slice(0, -1).split('/').pop()}/`
    return new RegExp(`(?<![A-Za-z0-9-])${escapeRegExp(dir)}`)
  }
  return bounded(path)
}

/**
 * 阶段表与阶段 skill 的规则文本对账（spec「阶段表与阶段 skill 的规则文本对账」）。
 *
 * 交接断开最常见的原因是修改 skill 的规则文本，只核对阶段表时测不出（ARCH-01）。
 * 阶段 `X` 按对照表的 `/opsx:X` 找 skill；上游命令跳过。规则文本是 `skills/<skill>/` 下的 `.md` 与 `.mjs`，
 * `vendor/` 与阶段表事实源除外。
 *
 * @param {ReturnType<typeof parseStageTable>['rows']} rows 阶段表
 * @param {ReturnType<typeof parseCommandTable>['rows']} commandRows 对照表
 * @param {Array<{path: string, text: string}>} files 仓库文件（相对路径与内容）
 * @returns {object[]} 问题，带 stage、skill、file
 */
export function checkRuleText(rows, commandRows, files) {
  const issues = []
  for (const row of rows) {
    const paths = [...new Set([...row.inputs, ...row.outputs].map(f => f.path))]
    if (!paths.length) continue
    for (const stage of row.stages) {
      const command = commandRows.find(r => r.command === stage)
      if (!command) {
        issues.push({ check: 'rule-text', stage, message: `阶段 ${stage} 在命令-Skill 对照表中没有 /opsx:${stage}，无法对账规则文本` })
        continue
      }
      if (command.skill === UPSTREAM_SKILL) continue
      const texts = files
        .filter(f => f.path.startsWith(`skills/${command.skill}/`) && RULE_TEXT_EXT.test(f.path) && !isVendorPath(f.path) && f.path !== PHASES_PATH)
        .map(f => f.text)
      for (const path of paths) {
        const pattern = ruleTextPattern(path)
        if (texts.some(t => pattern.test(t))) continue
        issues.push({
          check: 'rule-text', stage, skill: command.skill, file: path,
          message: `阶段 ${stage} 的 ${path} 没有出现在 skill ${command.skill} 的规则文本中`,
        })
      }
    }
  }
  return issues
}

/** 递归读取 dir 下的引用方候选文件；跳过 vendor/（占扫描字节的一半以上）与 node_modules/。 */
function readTexts(root, dir, out) {
  const abs = join(root, dir)
  if (!existsSync(abs)) return out
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name !== 'vendor' && entry.name !== 'node_modules') readTexts(root, rel, out)
    } else if (REFERRER_EXT.test(entry.name)) {
      out.push({ path: rel, text: readFileSync(join(root, rel), 'utf8') })
    }
  }
  return out
}

/**
 * 读取仓库真实文件并运行 5 项检查。
 *
 * @param {string} root 仓库根目录
 * @returns {{ stageRows: object[], commandRows: object[], issues: object[] }} 阶段表解析失败时只做命令与孤立文件检查
 */
export function checkRepo(root) {
  const stage = parseStageTable(readFileSync(join(root, PHASES_PATH), 'utf8'))
  const command = parseCommandTable(readFileSync(join(root, COMMAND_DOC_PATH), 'utf8'))
  const files = readTexts(root, 'claude/commands', readTexts(root, 'skills', []))
  const skillNames = readdirSync(join(root, 'skills'), { withFileTypes: true })
    .filter(e => e.isDirectory() && existsSync(join(root, 'skills', e.name, 'SKILL.md')))
    .map(e => e.name)
  const commandFiles = readdirSync(join(root, 'claude/commands/opsx')).filter(f => f.endsWith('.md'))
  const sharedFiles = files.map(f => f.path).filter(p => /^skills\/[^/]+\/shared\/[^/]+\.md$/.test(p))

  const issues = [
    ...stage.issues,
    ...command.issues,
    ...checkCommands(command.rows, commandFiles, skillNames),
    ...findOrphans(sharedFiles, files),
  ]
  if (!stage.issues.length) {
    issues.push(...checkHandoff(stage.rows))
    if (!command.issues.length) issues.push(...checkRuleText(stage.rows, command.rows, files))
  }
  return { stageRows: stage.rows, commandRows: command.rows, issues }
}
