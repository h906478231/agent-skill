import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import {
  parseStageTable,
  parseCommandTable,
  checkHandoff,
  handoffEdges,
  checkCommands,
  findOrphans,
  checkRuleText,
  checkRepo,
} from './lib/stage-handoff.mjs'

/**
 * 阶段交接检查（add-workflow-change-testing，spec stage-handoff-check）。
 *
 * 前半部分用夹具文本测试 `scripts/lib/stage-handoff.mjs` 的反例：本仓库真实文件只能测通过的情况。
 * 最后一组测试读取本仓库真实的 phases.md、命令对照表与 skill 规则文本，只读文件，不启动子进程。
 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 与 design.md D8 相同的阶段表，作为反例夹具的基准；各测试只替换其中一行。 */
const STAGE_TABLE = `# Phases

## 各阶段的输入与新会话

说明文字。

| 阶段 | 读取的输入 | 产出 | 能否在新会话中开始 |
|------|-----------|------|-------------------|
| grill | \`CONTEXT.md\`、\`docs/adr/\`、\`proposal.md\`（已有时）、\`design.md\`（已有时） | \`CONTEXT.md\`、\`docs/adr/\`、\`discussion-log.md\` | 能 |
| explore | 对话；有变更时读取产物 | 无。用户要求时才写入产物 | 否 |
| propose / ff | 用户需求、\`discussion-log.md\`（grill 写入时）、已完成的产物 | \`proposal.md\`、\`design.md\`、\`specs/\`、\`tasks.md\` | 能 |
| update | 修改依据与全部产物 | \`proposal.md\`、\`design.md\`、\`specs/\`、\`tasks.md\` | 通常不能 |
| review | \`proposal.md\`、\`design.md\` | \`review-summary.md\`、\`review/\` | 能 |
| apply | \`proposal.md\`、\`specs/\`、\`design.md\`、\`tasks.md\`、\`review-summary.md\`（启用技术评审时） | 代码、\`evidence/\`、\`tasks.md\` | 能 |
| quality | 固定基线 diff、产物、\`evidence/\` | \`review/standards.md\`、\`review/spec-fidelity.md\`、\`review/code-review-summary.md\`、\`review/sonar.md\`（配置 Sonar 时） | 能 |
| verify | 产物、门禁脚本输出、\`review-summary.md\`（启用技术评审时）、\`verification.md\`（重跑时） | \`verification.md\` | 能 |
| archive | \`verification.md\`、门禁脚本输出、\`review-summary.md\`（启用技术评审时） | \`openspec/specs/\`、\`openspec/changes/archive/\` | 能 |
| overview | 全部产物 | \`overview.md\`、\`overview.html\`（有变更模型时） | 能 |

## 下一节
`

const COMMAND_TABLE = `### 命令-Skill 对照表

| 斜杠命令 | 对应 Skill | 说明 |
|---------|-----------|------|
| \`/opsx:propose <change>\` | \`openspec-propose\` | 生成产物 |
| \`/opsx:ff <change>\` | 无（上游命令） | 一次生成全部产物 |
| \`/opsx:review <change>\` | \`openspec-technical-review\` | 技术评审 |
| \`/opsx:verify <change>\` | \`openspec-verify-change\` | 验证 |

其他文字。
`

/** 把阶段表中以 `| <stage> |` 开头的一行替换为 line；line 为 null 时删除该行。 */
function replaceRow(stage, line) {
  const lines = STAGE_TABLE.split('\n')
  const index = lines.findIndex(l => l.startsWith(`| ${stage} |`))
  assert.ok(index >= 0, `夹具中没有 ${stage} 一行`)
  if (line === null) lines.splice(index, 1)
  else lines[index] = line
  return lines.join('\n')
}

const rowsOf = markdown => {
  const { rows, issues } = parseStageTable(markdown)
  assert.deepEqual(issues, [])
  return rows
}
const messages = issues => issues.map(i => i.message).join('\n')

// —— 阶段表的解析 ——

test('解析：输入与产出取行内代码，括号写出条件，propose / ff 一行对应两个阶段', () => {
  const rows = rowsOf(STAGE_TABLE)
  const apply = rows.find(r => r.stages.includes('apply'))
  assert.deepEqual(apply.inputs.map(i => [i.path, i.condition]), [
    ['proposal.md', null], ['specs/', null], ['design.md', null], ['tasks.md', null],
    ['review-summary.md', '启用技术评审时'],
  ])
  assert.deepEqual(apply.outputs.map(o => o.path), ['evidence/', 'tasks.md'])
  assert.deepEqual(rows.find(r => r.label === 'propose / ff').stages, ['propose', 'ff'])
  assert.deepEqual(rows.find(r => r.label === 'explore').outputs, [], '不是行内代码的文字不读取')
})

test('表格缺少产出列：报出 phases.md 与缺少的列名', () => {
  const markdown = STAGE_TABLE
    .replace('| 阶段 | 读取的输入 | 产出 | 能否在新会话中开始 |', '| 阶段 | 读取的输入 | 能否在新会话中开始 |')
    .replace('|------|-----------|------|-------------------|', '|------|-----------|-------------------|')
  const { issues } = parseStageTable(markdown)
  assert.equal(issues.length, 1)
  assert.match(issues[0].message, /phases\.md/)
  assert.match(issues[0].message, /产出/)
})

// —— 每个输入文件都有上游产出 ——

test('本仓库的阶段表夹具：4 条分支的交接全部通过', () => {
  assert.deepEqual(checkHandoff(rowsOf(STAGE_TABLE)), [])
})

test('verify 不再产出 verification.md：标准分支中 archive 的输入没有上游产出', () => {
  const rows = rowsOf(replaceRow('verify', '| verify | 产物 | `verify-report.md` | 能 |'))
  const issues = checkHandoff(rows)
  const hit = issues.find(i => i.branch === '标准' && i.stage === 'archive' && i.file === 'verification.md')
  assert.ok(hit, messages(issues))
  assert.match(hit.message, /标准/)
  assert.match(hit.message, /archive/)
  assert.match(hit.message, /verification\.md/)
})

test('条件输入在 L0 豁免分支中不要求产出；去掉条件后 L0 豁免分支失败', () => {
  assert.equal(checkHandoff(rowsOf(STAGE_TABLE)).filter(i => i.branch === 'L0 豁免').length, 0)

  const unconditional = replaceRow('apply',
    '| apply | `proposal.md`、`specs/`、`design.md`、`tasks.md`、`review-summary.md` | 代码、`evidence/`、`tasks.md` | 能 |')
  const issues = checkHandoff(rowsOf(unconditional))
  assert.ok(issues.some(i => i.branch === 'L0 豁免' && i.stage === 'apply' && i.file === 'review-summary.md'), messages(issues))
  assert.ok(!issues.some(i => i.branch === '标准'), '标准分支有 review，仍然通过')
})

test('条件输入没有任何阶段产出时失败', () => {
  const rows = rowsOf(replaceRow('review', '| review | `proposal.md`、`design.md` | `review/` | 能 |'))
  const issues = checkHandoff(rows)
  assert.ok(issues.some(i => i.stage === 'apply' && i.file === 'review-summary.md' && !i.branch), messages(issues))
})

test('新增阶段没有归入分支：报出 sonar', () => {
  const markdown = STAGE_TABLE.replace('| overview |', '| sonar | `review/sonar.md`（配置 Sonar 时） | `review/sonar.md` | 能 |\n| overview |')
  const issues = checkHandoff(rowsOf(markdown))
  assert.equal(issues.length, 1, messages(issues))
  assert.equal(issues[0].stage, 'sonar')
  assert.match(issues[0].message, /sonar/)
})

test('分支中的阶段在阶段表中没有一行时失败', () => {
  const issues = checkHandoff(rowsOf(replaceRow('quality', null)))
  assert.ok(issues.some(i => i.branch === '标准' && i.stage === 'quality'), messages(issues))
  assert.ok(!issues.some(i => i.branch === 'L0 豁免'), 'L0 豁免分支没有 quality')
})

test('交接边：每个输入连到分支中最近一个产出它的上游阶段，供 evals/report.mjs 画阶段交接图', () => {
  const edges = handoffEdges(rowsOf(STAGE_TABLE))
  assert.ok(edges.every((e) => !e.broken), JSON.stringify(edges.filter((e) => e.broken)))
  assert.deepEqual(edges.find((e) => e.branch === '标准' && e.to === 'archive' && e.from === 'verify'),
    { branch: '标准', from: 'verify', fromIndex: 4, to: 'archive', toIndex: 5, files: ['verification.md'], broken: false })
  assert.ok(edges.some((e) => e.branch === '标准' && e.from === 'review' && e.to === 'archive' && e.files.includes('review-summary.md')),
    '有条件输入在分支中有产出时画边')
  assert.ok(edges.some((e) => e.branch === '评审回路' && e.from === 'update' && e.fromIndex === 2 && e.to === 'apply' && e.files.includes('proposal.md')),
    '取最近的上游：评审回路中 apply 的 proposal.md 来自 update')
  assert.ok(edges.some((e) => e.branch === '评审回路' && e.from === 'review' && e.fromIndex === 3 && e.to === 'apply'), '第二次 review')
  assert.ok(!edges.some((e) => e.branch === 'L0 豁免' && e.files.includes('review-summary.md')), '有条件输入在分支中没有产出时不画边')
  assert.ok(!edges.some((e) => e.files.includes('CONTEXT.md')), '项目资产不画边')
})

test('交接边：无条件输入没有上游产出时，从分支中的前一个阶段画断开的边', () => {
  const edges = handoffEdges(rowsOf(replaceRow('verify', '| verify | 产物 | `verify-report.md` | 能 |')))
  assert.deepEqual(edges.filter((e) => e.broken && e.branch === '标准').map((e) => [e.from, e.to, e.files]), [['verify', 'archive', ['verification.md']]])
})

// —— 阶段表与阶段 skill 的规则文本对账 ——

const commandRows = () => {
  const { rows, issues } = parseCommandTable(COMMAND_TABLE)
  assert.deepEqual(issues, [])
  return rows
}

/** 只含 propose、review、verify 三行的阶段表，其余阶段在对照表夹具中没有命令。 */
const RULE_TABLE = STAGE_TABLE.split('\n')
  .filter(l => !/^\| (grill|explore|update|apply|quality|archive|overview) \|/.test(l))
  .join('\n')

/** 三个阶段 skill 的规则文本夹具：每个文件名都出现。 */
const ruleFiles = () => [
  { path: 'skills/openspec-propose/SKILL.md', text: '读取 discussion-log.md；按 artifact id proposal、design、specs、tasks 生成。' },
  { path: 'skills/openspec-technical-review/SKILL.md', text: '读取 proposal 与 design，写 review/architecture.md 与 review-summary.md。' },
  { path: 'skills/openspec-verify-change/SKILL.md', text: '读取 review-summary.md，写入 verification.md。' },
]

test('对账：每个文件名都出现时通过；schema 产物按 artifact id 匹配', () => {
  assert.deepEqual(checkRuleText(rowsOf(RULE_TABLE), commandRows(), ruleFiles()), [])
})

test('verify 的规则文本不再出现 verification.md：报出 verify、openspec-verify-change 与 verification.md', () => {
  const files = ruleFiles().map(f => f.path.includes('verify-change')
    ? { ...f, text: '读取 review-summary.md，写入 verify-report.md。' } : f)
  const issues = checkRuleText(rowsOf(RULE_TABLE), commandRows(), files)
  assert.equal(issues.length, 1, messages(issues))
  assert.equal(issues[0].stage, 'verify')
  assert.equal(issues[0].skill, 'openspec-verify-change')
  assert.equal(issues[0].file, 'verification.md')
  assert.match(issues[0].message, /verify.*openspec-verify-change.*verification\.md|verification\.md.*openspec-verify-change/)
})

test('文件按完整写法匹配：前后紧接字母、数字或 - 时不算出现', () => {
  const files = ruleFiles().map(f => f.path.includes('verify-change')
    ? { ...f, text: '读取 review-summary.md，写入 old-verification.md 与 verification.mdx。' } : f)
  const issues = checkRuleText(rowsOf(RULE_TABLE), commandRows(), files)
  assert.deepEqual(issues.map(i => i.file), ['verification.md'])
})

test('只有 vendor 目录出现文件名：判为没有出现', () => {
  const files = ruleFiles().map(f => f.path.includes('verify-change')
    ? { ...f, text: '读取 review-summary.md。' } : f)
  files.push({ path: 'skills/openspec-verify-change/vendor/lib/notes.md', text: '写入 verification.md。' })
  const issues = checkRuleText(rowsOf(RULE_TABLE), commandRows(), files)
  assert.deepEqual(issues.map(i => [i.stage, i.file]), [['verify', 'verification.md']])
})

test('阶段表本身不计入规则文本：只有 phases.md 出现 review-summary.md 时 review 一行失败', () => {
  const files = ruleFiles().map(f => f.path.includes('technical-review')
    ? { ...f, text: '读取 proposal 与 design，写 review/architecture.md。' } : f)
  files.push({ path: 'skills/openspec-technical-review/shared/phases.md', text: '| review | `review-summary.md` |' })
  const issues = checkRuleText(rowsOf(RULE_TABLE), commandRows(), files)
  assert.equal(issues.length, 1, messages(issues))
  assert.deepEqual([issues[0].stage, issues[0].skill, issues[0].file], ['review', 'openspec-technical-review', 'review-summary.md'])
})

test('目录按最后一级目录名加 / 匹配，前面紧接字母、数字或 - 时不算出现', () => {
  const files = ruleFiles().map(f => f.path.includes('technical-review')
    ? { ...f, text: '读取 proposal 与 design，写 pre-review/x.md 与 review-summary.md。' } : f)
  const issues = checkRuleText(rowsOf(RULE_TABLE), commandRows(), files)
  assert.deepEqual(issues.map(i => [i.stage, i.file]), [['review', 'review/']])
})

test('上游命令跳过对账：propose / ff 一行只核对 openspec-propose', () => {
  const issues = checkRuleText(rowsOf(RULE_TABLE), commandRows(), ruleFiles())
  assert.ok(!issues.some(i => i.stage === 'ff'), messages(issues))

  const files = ruleFiles().map(f => f.path.includes('openspec-propose') ? { ...f, text: '按 artifact id 生成。' } : f)
  const missing = checkRuleText(rowsOf(RULE_TABLE), commandRows(), files)
  assert.ok(missing.every(i => i.stage === 'propose' && i.skill === 'openspec-propose'), messages(missing))
  assert.ok(missing.some(i => i.file === 'discussion-log.md'), messages(missing))
})

// —— 每个命令都有对应的 skill ——

test('新增命令没有写入对照表：报出 sonar.md', () => {
  const issues = checkCommands(commandRows(), ['propose.md', 'ff.md', 'review.md', 'verify.md', 'sonar.md'],
    ['openspec-propose', 'openspec-technical-review', 'openspec-verify-change'])
  assert.equal(issues.length, 1, messages(issues))
  assert.match(issues[0].message, /sonar\.md/)
})

test('对照表写了不存在的 skill：报出 openspec-verify', () => {
  const { rows } = parseCommandTable(COMMAND_TABLE.replace('`openspec-verify-change`', '`openspec-verify`'))
  const issues = checkCommands(rows, ['propose.md', 'ff.md', 'review.md', 'verify.md'],
    ['openspec-propose', 'openspec-technical-review', 'openspec-verify-change'])
  assert.equal(issues.length, 1, messages(issues))
  assert.match(issues[0].message, /openspec-verify(?!-)/)
})

test('对照表中的命令文件不存在时失败', () => {
  const issues = checkCommands(commandRows(), ['propose.md', 'ff.md', 'review.md'],
    ['openspec-propose', 'openspec-technical-review', 'openspec-verify-change'])
  assert.equal(issues.length, 1, messages(issues))
  assert.match(issues[0].message, /verify\.md/)
})

// —— shared 规则文件没有孤立文件 ——

test('新增的 shared 文件没有被引用：报出该文件路径', () => {
  const shared = ['skills/openspec-apply-change/shared/tdd-discipline.md', 'skills/openspec-apply-change/shared/foo.md']
  const files = [
    { path: 'skills/openspec-apply-change/SKILL.md', text: '见 shared/tdd-discipline.md。' },
    { path: 'skills/openspec-apply-change/shared/foo.md', text: '只有自己写 foo.md。' },
    { path: 'skills/openspec-apply-change/vendor/readme.md', text: '第三方代码提到 foo.md。' },
    { path: 'skills/openspec-apply-change/notes.txt', text: 'foo.md' },
  ]
  const issues = findOrphans(shared, files)
  assert.equal(issues.length, 1, messages(issues))
  assert.match(issues[0].message, /skills\/openspec-apply-change\/shared\/foo\.md/)
})

test('文件名是另一个文件名的后缀：gate-check.md 判为孤立文件', () => {
  const shared = ['skills/openspec-ste/shared/gate-check.md', 'skills/openspec-technical-review/shared/apply-gate-check.md']
  const files = [{ path: 'claude/commands/opsx/apply.md', text: '先读取 shared/apply-gate-check.md。' }]
  const issues = findOrphans(shared, files)
  assert.deepEqual(issues.map(i => i.file), ['skills/openspec-ste/shared/gate-check.md'])
})

// —— 本仓库的真实文件 ——

test('本仓库当前的阶段表通过检查：交接、命令、孤立文件与规则文本对账全部通过，耗时不超过 1 秒', () => {
  const started = performance.now()
  const { stageRows, issues } = checkRepo(REPO_ROOT)
  const elapsed = performance.now() - started
  assert.deepEqual(issues.map(i => i.message), [])
  assert.ok(stageRows.length >= 10, `阶段表只解析出 ${stageRows.length} 行`)
  assert.ok(elapsed < 1000, `检查耗时 ${Math.round(elapsed)} ms，超过 1 秒`)
})
