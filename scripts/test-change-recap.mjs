import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 通过 /opsx:archive 第 7 步与 /opsx:recap 实际调用的 recap.mjs 入口验证行为；
// 每个用例在临时目录里构造归档目录，不改动本仓库。
const SCRIPT = fileURLToPath(new URL('../skills/openspec-change-recap/scripts/recap.mjs', import.meta.url))

/** 默认的归档目录名：日期前缀 2026-10-28，变更名 eval-harness-v2。 */
const DIR = '2026-10-28-eval-harness-v2'

/**
 * 拼出一份完成清单。
 * @param {object} options name：标题行中的变更名；fields：头部字段，值为 null 时不写这一行；sections：二级标题 → 正文行。
 */
function recapText({
  name = 'eval-harness-v2',
  fields = {},
  sections = {},
} = {}) {
  const header = { 归档日期: '2026-10-28', 分级: 'L0', 主题: '评测与测试', 摘要: '新增 6 个单阶段评测用例与阶段快照检查', ...fields }
  const body = {
    新增: ['- 新增 6 个单阶段评测用例（evals/）'],
    修改: ['无'],
    删除: ['无'],
    修复: ['无'],
    没做与遗留: ['- design 移出 Slice 08–10（design.md）'],
    落点: ['- 文件：未定义'],
    ...sections,
  }
  return [
    `# 完成清单：${name}`,
    '',
    ...Object.entries(header).filter(([, value]) => value !== null).map(([key, value]) => `- ${key}：${value}`),
    '',
    ...Object.entries(body).flatMap(([heading, lines]) => [`## ${heading}`, '', ...lines, '']),
  ].join('\n')
}

/** 创建临时归档目录，返回写入与运行脚本的工具。 */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'change-recap-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const archive = join(root, 'archive')
  mkdirSync(archive, { recursive: true })
  const write = (rel, text) => {
    const file = join(archive, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
    return file
  }
  // git 不向临时目录的上级查找仓库：tmpdir 在某个仓库内时，「不在 git 工作区」的用例结果仍然确定。
  const ceiling = dirname(realpathSync(root))
  const run = (args, { cwd = root, env = {} } = {}) => {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: ceiling, ...env },
    })
    return { code: result.status, out: result.stdout, err: result.stderr, json: () => JSON.parse(result.stdout) }
  }
  const recap = (options, dir = DIR) => write(`${dir}/recap.md`, recapText(options))
  /** 在 root 下创建一个 git 仓库，写入 .gitignore（null 表示不写），返回仓库目录。 */
  const gitRepo = (name, gitignore) => {
    const repo = join(root, name)
    mkdirSync(repo, { recursive: true })
    const init = spawnSync('git', ['init', '-q'], { cwd: repo, encoding: 'utf8' })
    assert.equal(init.status, 0, init.stderr)
    if (gitignore !== null) writeFileSync(join(repo, '.gitignore'), gitignore)
    return repo
  }
  /** 在仓库的归档目录中写一份格式正确的完成清单，返回文件路径。 */
  const repoRecap = (repo, options) => {
    const file = join(repo, 'openspec/changes/archive', DIR, 'recap.md')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, recapText(options))
    return file
  }
  return { root, archive, write, run, recap, gitRepo, repoRecap }
}

/** 完成清单没有被 git 忽略时，告警给出的建议规则。 */
const SUGGESTED_RULE = 'openspec/changes/archive/*/recap.md'

/** 阻断项摘要：只保留字段名，便于整体断言。 */
const fields = report => report.blocking.map(item => item.field)

// ---------------------------------------------------------------------------
// Slice 01：完成清单的格式能被脚本检查（Seam：check）
// ---------------------------------------------------------------------------

test('check：格式正确的完成清单退出码 0，blocking 为空，header 给出 4 个头部字段', t => {
  const f = fixture(t)
  const result = f.run(['check', f.recap()])
  assert.equal(result.code, 0, result.out + result.err)
  const report = result.json()
  assert.deepEqual(Object.keys(report).sort(), ['blocking', 'gitIgnored', 'header', 'verdict', 'warnings'])
  assert.equal(report.verdict, 'PASS')
  assert.deepEqual(report.blocking, [])
  assert.deepEqual(report.header, {
    change: 'eval-harness-v2', archiveDate: '2026-10-28', tier: 'L0', theme: '评测与测试', summary: '新增 6 个单阶段评测用例与阶段快照检查',
  })
})

test('check：完成清单文件不存在时退出码 2，信息写出路径', t => {
  const f = fixture(t)
  const missing = join(f.archive, DIR, 'recap.md')
  const result = f.run(['check', missing])
  assert.equal(result.code, 2)
  assert.ok(result.err.includes(missing), result.err)
  assert.equal(f.run(['check']).code, 2)
  assert.equal(f.run(['check', missing, '--json']).code, 2)
})

test('check：没有以「- 主题：」开头的行时退出码 1，blocking 中一项写出「主题」', t => {
  const f = fixture(t)
  const result = f.run(['check', f.recap({ fields: { 主题: null } })])
  assert.equal(result.code, 1, result.out + result.err)
  const report = result.json()
  assert.equal(report.verdict, 'BLOCKED')
  assert.deepEqual(fields(report), ['主题'])
  assert.equal(typeof report.blocking[0].line, 'number')
  assert.equal(report.header.theme, null)
})

test('check：头部字段的值为空、或顺序不是归档日期、分级、主题、摘要时，按字段写入 blocking 与行号', t => {
  const f = fixture(t)
  const empty = f.run(['check', f.recap({ fields: { 摘要: '' } })]).json()
  assert.deepEqual(fields(empty), ['摘要'])
  assert.equal(empty.blocking[0].line, 6)
  // 先写主题、再写分级：分级排在主题之后，报告分级。
  const swapped = recapText().replace('- 分级：L0\n- 主题：评测与测试', '- 主题：评测与测试\n- 分级：L0')
  const order = f.run(['check', f.write(`${DIR}/recap.md`, swapped)]).json()
  assert.deepEqual(fields(order), ['分级'])
  assert.equal(order.blocking[0].line, 5)
})

test('check：2026-10-28-eval-harness-v2 中写「- 归档日期：2026-10-27」时退出码 1，阻断项写出归档日期与应为的 2026-10-28', t => {
  const f = fixture(t)
  const result = f.run(['check', f.recap({ fields: { 归档日期: '2026-10-27' } })])
  assert.equal(result.code, 1, result.out + result.err)
  const report = result.json()
  assert.deepEqual(fields(report), ['归档日期'])
  assert.equal(report.blocking[0].line, 3)
  assert.match(report.blocking[0].detail, /2026-10-28/)
  // 不存在的日期也是阻断项，即使目录名的前缀相同。
  const invalid = f.run(['check', f.recap({ fields: { 归档日期: '2026-02-30' } }, '2026-02-30-eval-harness-v2')]).json()
  assert.deepEqual(fields(invalid), ['归档日期'])
})

test('check：标题行的变更名与目录名不同、或缺少标题行时，阻断项写出「标题行」与应为的变更名', t => {
  const f = fixture(t)
  const renamed = f.run(['check', f.recap({ name: 'eval-harness' })]).json()
  assert.deepEqual(fields(renamed), ['标题行'])
  assert.equal(renamed.blocking[0].line, 1)
  assert.match(renamed.blocking[0].detail, /eval-harness-v2/)
  const untitled = f.run(['check', f.write(`${DIR}/recap.md`, recapText().replace(/^# .*\n/, '# 总览\n'))]).json()
  assert.deepEqual(fields(untitled), ['标题行'])
  // 不在 YYYY-MM-DD-<变更名> 目录中的文件不是已归档变更的完成清单。
  const active = f.run(['check', f.recap({}, 'eval-harness-v2')]).json()
  assert.deepEqual(fields(active), ['归档目录'])
})

test('check：「- 分级：L0 豁免。判定人：用户」不在取值域内，退出码 1，阻断项写出「分级」；取值域内的 6 个值都通过', t => {
  const f = fixture(t)
  const result = f.run(['check', f.recap({ fields: { 分级: 'L0 豁免。判定人：用户' } })])
  assert.equal(result.code, 1, result.out + result.err)
  const report = result.json()
  assert.deepEqual(fields(report), ['分级'])
  assert.equal(report.blocking[0].line, 4)
  for (const tier of ['L0', 'L1', 'L2', 'L3', 'MVP', '未定义']) {
    assert.equal(f.run(['check', f.recap({ fields: { 分级: tier } })]).code, 0, tier)
  }
})

test('check：缺少「## 落点」或「## 修复」写在「## 删除」之前时，阻断项写出该二级标题与行号', t => {
  const f = fixture(t)
  const missing = f.run(['check', f.write(`${DIR}/recap.md`, recapText().replace(/## 落点\n\n- 文件：未定义\n/, ''))])
  assert.equal(missing.code, 1, missing.out + missing.err)
  assert.deepEqual(fields(missing.json()), ['## 落点'])
  const swapped = recapText().replace('## 删除\n\n无\n\n## 修复\n\n无', '## 修复\n\n无\n\n## 删除\n\n无')
  const order = f.run(['check', f.write(`${DIR}/recap.md`, swapped)]).json()
  assert.deepEqual(fields(order), ['## 删除'])
  assert.equal(swapped.split('\n')[order.blocking[0].line - 1], '## 删除')
})

test('check：「## 删除」一节只有一行「无」时退出码 0', t => {
  const f = fixture(t)
  const result = f.run(['check', f.recap({ sections: { 删除: ['无'], 修改: ['- 修改归档步骤（skills/openspec-archive-change/SKILL.md）'] } })])
  assert.equal(result.code, 0, result.out + result.err)
  assert.deepEqual(result.json().blocking, [])
})

test('check：项目 .gitignore 含 /openspec 时 gitIgnored 为 true，warnings 为空', t => {
  const f = fixture(t)
  const repo = f.gitRepo('ignores', '/openspec\n')
  const result = f.run(['check', f.repoRecap(repo)])
  assert.equal(result.code, 0, result.out + result.err)
  const report = result.json()
  assert.equal(report.gitIgnored, true)
  assert.deepEqual(report.warnings, [])
})

test('check：项目不忽略完成清单时 gitIgnored 为 false，warnings 给出建议规则；退出码只由 blocking 决定', t => {
  const f = fixture(t)
  const repo = f.gitRepo('commits', 'node_modules/\n')
  const valid = f.run(['check', f.repoRecap(repo)])
  assert.equal(valid.code, 0, valid.out + valid.err)
  const report = valid.json()
  assert.equal(report.gitIgnored, false)
  assert.equal(report.warnings.length, 1)
  assert.equal(report.warnings[0].suggestedRule, SUGGESTED_RULE)
  assert.ok(report.warnings[0].detail.includes(SUGGESTED_RULE), report.warnings[0].detail)
  const invalid = f.run(['check', f.repoRecap(repo, { fields: { 主题: null } })])
  assert.equal(invalid.code, 1)
  assert.equal(invalid.json().gitIgnored, false)
})

test('check：完成清单不在 git 工作区、或找不到 git 时 gitIgnored 为 null，warnings 为空', t => {
  const f = fixture(t)
  const outside = f.run(['check', f.recap()]).json()
  assert.equal(outside.gitIgnored, null)
  assert.deepEqual(outside.warnings, [])
  // PATH 指向空目录：execFileSync 找不到 git（ENOENT），不得映射为 true。
  const noGit = f.run(['check', f.repoRecap(f.gitRepo('no-git', '/openspec\n'))], { env: { PATH: mkdtempSync(join(f.root, 'empty-path-')) } })
  assert.equal(noGit.code, 0, noGit.out + noGit.err)
  assert.equal(noGit.json().gitIgnored, null)
})

test('check：完成清单在不忽略它的仓库 A，进程 cwd 在仓库 B 时，gitIgnored 为 false 并告警', t => {
  const f = fixture(t)
  const a = f.gitRepo('repo-a', null)
  // 仓库 B 忽略全部文件：脚本若按进程 cwd 判定，结果不会是 false。
  const b = f.gitRepo('repo-b', '*\n')
  const report = f.run(['check', f.repoRecap(a)], { cwd: b }).json()
  assert.equal(report.gitIgnored, false)
  assert.equal(report.warnings[0].suggestedRule, SUGGESTED_RULE)
})

test('check：经符号链接传入完成清单时，按真实路径判定归档目录与 git 忽略状态', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t)
  const file = f.repoRecap(f.gitRepo('linked', '/openspec\n'))
  const link = join(f.root, 'recap-link.md')
  symlinkSync(file, link)
  const result = f.run(['check', link])
  assert.equal(result.code, 0, result.out + result.err)
  assert.equal(result.json().gitIgnored, true)
})

// ---------------------------------------------------------------------------
// Slice 02：跨变更总表按主题分组打印（Seam：list）
// ---------------------------------------------------------------------------

/** 在归档目录中写一份完成清单：目录名 `<date>-<name>`，主题与摘要按参数写入。 */
function archived(f, date, name, theme, summary = `${name} 的摘要`) {
  return f.recap({ name, fields: { 归档日期: date, 主题: theme, 摘要: summary, 分级: 'L1' } }, `${date}-${name}`)
}

test('list：3 份「门禁与评审」与 1 份「STE 规则」时，先打印「门禁与评审」，组内按归档日期从新到旧', t => {
  const f = fixture(t)
  archived(f, '2026-10-23', 'close-tier-review-leftovers', '门禁与评审')
  archived(f, '2026-10-27', 'guard-agent-git-on-artifacts', '门禁与评审', '摘要含 | 竖线')
  archived(f, '2026-10-26', 'add-change-head', '门禁与评审')
  archived(f, '2026-10-27', 'add-ste-gate', 'STE 规则')
  const result = f.run(['list', f.archive])
  assert.equal(result.code, 0, result.out + result.err)
  const out = result.out
  assert.ok(out.indexOf('门禁与评审') < out.indexOf('STE 规则'), out)
  const rows = out.split('\n').filter(line => /^\| 2026-/.test(line)).map(line => line.split(' | ')[1])
  assert.deepEqual(rows, ['guard-agent-git-on-artifacts', 'add-change-head', 'close-tier-review-leftovers', 'add-ste-gate'])
  // 单元格中的 | 转义，表格列数不变。
  assert.ok(out.includes('摘要含 \\| 竖线'), out)

  const json = f.run(['list', f.archive, '--json']).json()
  assert.deepEqual(Object.keys(json).sort(), ['missing', 'themes', 'total', 'withRecap'])
  assert.equal(json.total, 4)
  assert.equal(json.withRecap, 4)
  assert.deepEqual(json.themes.map(group => [group.theme, group.count]), [['门禁与评审', 3], ['STE 规则', 1]])
  assert.deepEqual(json.themes[0].changes[0], {
    dir: '2026-10-27-guard-agent-git-on-artifacts', change: 'guard-agent-git-on-artifacts', archiveDate: '2026-10-27', tier: 'L1', summary: '摘要含 | 竖线',
  })
  assert.deepEqual(json.missing, [])
})

test('list：2026-10-08-add-change-model-visualization 没有 recap.md 时列入「没有完成清单」，退出码 0', t => {
  const f = fixture(t)
  archived(f, '2026-10-28', 'eval-harness-v2', '评测与测试')
  mkdirSync(join(f.archive, '2026-10-08-add-change-model-visualization'))
  const result = f.run(['list', f.archive])
  assert.equal(result.code, 0, result.out + result.err)
  const missingSection = result.out.slice(result.out.indexOf('## 没有完成清单'))
  assert.ok(missingSection.includes('2026-10-08-add-change-model-visualization'), result.out)
  const json = f.run(['list', f.archive, '--json']).json()
  assert.equal(json.total, 2)
  assert.equal(json.withRecap, 1)
  assert.deepEqual(json.missing.map(item => item.dir), ['2026-10-08-add-change-model-visualization'])
})

test('list：recap.md 没有「- 摘要：」时列入「没有完成清单」，原因写出「摘要」；只读头部，正文缺少二级标题不影响总表', t => {
  const f = fixture(t)
  f.recap({ fields: { 摘要: null } }, '2026-10-27-add-ste-gate')
  f.write('2026-10-28-eval-harness-v2/recap.md', recapText().replace(/## 落点\n\n- 文件：未定义\n/, ''))
  const json = f.run(['list', f.archive, '--json']).json()
  assert.deepEqual(json.missing.map(item => item.dir), ['2026-10-27-add-ste-gate'])
  assert.match(json.missing[0].reason, /摘要/)
  assert.deepEqual(json.themes.flatMap(group => group.changes.map(row => row.dir)), ['2026-10-28-eval-harness-v2'])
  const out = f.run(['list', f.archive]).out
  assert.match(out.slice(out.indexOf('## 没有完成清单')), /2026-10-27-add-ste-gate \| .*摘要/)
})

/** 目录下全部文件的相对路径与内容，用于比较运行前后是否有写入。 */
function snapshot(dir) {
  const files = entry => (entry.isDirectory() ? snapshot(join(dir, entry.name)) : [[join(dir, entry.name), readFileSync(join(dir, entry.name), 'utf8')]])
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).flatMap(files)
}

test('list：运行前后归档目录的文件列表与内容相同', t => {
  const f = fixture(t)
  archived(f, '2026-10-28', 'eval-harness-v2', '评测与测试')
  mkdirSync(join(f.archive, '2026-10-08-add-change-model-visualization'))
  f.write('2026-10-08-add-change-model-visualization/proposal.md', '# proposal\n')
  const before = snapshot(f.archive)
  assert.equal(f.run(['list', f.archive]).code, 0)
  assert.equal(f.run(['list', f.archive, '--json']).code, 0)
  assert.deepEqual(snapshot(f.archive), before)
})

test('list：归档目录不存在时退出码 2，信息写出路径；参数错误时退出码 2', t => {
  const f = fixture(t)
  const missing = join(f.root, 'no-archive')
  const result = f.run(['list', missing])
  assert.equal(result.code, 2)
  assert.ok(result.err.includes(`归档目录不存在：${missing}`), result.err)
  assert.equal(f.run(['list']).code, 2)
  assert.equal(f.run(['list', f.archive, '--yaml']).code, 2)
})
