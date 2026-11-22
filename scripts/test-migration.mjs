import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../migrate-skills.sh', import.meta.url))
const helper = fileURLToPath(new URL('./migrate-assets.mjs', import.meta.url))
const workflow = "export const meta = { name: 'demo', description: 'test', phases: [] };\nawait agent('test'); return {};\n"

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'tigger-migration-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo with spaces')
  const home = join(root, 'home with spaces')
  fs.mkdirSync(join(repo, 'skills'), { recursive: true })
  fs.mkdirSync(join(repo, 'scripts'))
  fs.mkdirSync(home)
  fs.cpSync(script, join(repo, 'migrate-skills.sh'))
  fs.cpSync(helper, join(repo, 'scripts/migrate-assets.mjs'))
  const write = (p, text) => { fs.mkdirSync(dirname(p), { recursive: true }); fs.writeFileSync(p, text) }
  write(join(repo, 'skills/demo/SKILL.md'), '# Demo\n')
  write(join(repo, 'skills/demo/assets/template.html'), '<html></html>\n')
  write(join(repo, 'workflow/demo.workflow.js'), workflow)
  const run = (args = [], env = {}) => spawnSync('/bin/bash', [join(repo, 'migrate-skills.sh'), ...args], {
    cwd: root, env: { ...process.env, HOME: home, ...env }, encoding: 'utf8',
  })
  const migrate = (args = [], env = {}) => {
    const preview = run(['--migrate-legacy', '--dry-run', ...args], env)
    if (preview.status !== 0) return preview
    return run(['--migrate-legacy', ...args, '--expect-plan', planToken(preview)], env)
  }
  const dest = join(home, '.tigger')
  const state = () => JSON.parse(fs.readFileSync(join(dest, '.migration-state.json'), 'utf8'))
  return { root, repo, home, dest, write, run, migrate, state, claude: join(home, '.claude'), legacy: join(home, '.cc-switch') }
}
const planToken = result => result.stdout.match(/^计划指纹: (sha256:[a-f0-9]{64})$/m)?.[1]
const success = result => assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
const failure = (result, pattern) => { assert.notEqual(result.status, 0); if (pattern) assert.match(result.stderr, pattern) }
function snapshot(p) {
  if (!fs.existsSync(p)) return null
  const result = {}
  function visit(dir, prefix = '') {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = join(dir, name), key = `${prefix}${name}`, stat = fs.lstatSync(file)
      if (stat.isSymbolicLink()) result[key] = ['link', fs.readlinkSync(file)]
      else if (stat.isDirectory()) { result[key] = ['directory']; visit(file, `${key}/`) }
      else result[key] = ['file', fs.readFileSync(file).toString('base64')]
    }
  }
  visit(p)
  return result
}
function skill(f, root, name, text = '# External\n') { f.write(join(root, 'skills', name, 'SKILL.md'), text) }
function flows(f, root, version) {
  skill(f, root, 'flows-role-comment', '# Flows\n')
  f.write(join(root, 'skills/flows-role-comment/scripts/check_update.py'), `BASE_VERSION = ${version}\n`)
}
function git(f, ...args) {
  const result = spawnSync('git', ['-C', f.repo, ...args], { encoding: 'utf8' })
  success(result)
  return result.stdout.trim()
}
function commit(f) {
  git(f, 'add', '.')
  git(f, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture')
}
function initializeGit(f) { git(f, 'init'); commit(f) }
function fault(f, body, args = []) {
  const preload = join(f.root, 'fault.cjs')
  f.write(preload, `const fs = require('node:fs');\n${body}\n`)
  return spawnSync(process.execPath, ['--require', preload, join(f.repo, 'scripts/migrate-assets.mjs'), ...args], {
    cwd: f.root, env: { ...process.env, HOME: f.home }, encoding: 'utf8',
  })
}

test('当前仓库复制、权限、内部链接、workflow 资源及多工具入口', t => {
  const f = fixture(t)
  f.write(join(f.repo, 'workflow/resources/config.json'), '{}')
  f.write(join(f.repo, 'workflow/.ignored'), 'hidden')
  f.write(join(f.repo, 'skills/demo/run.sh'), '#!/bin/sh\nexit 0\n')
  fs.chmodSync(join(f.repo, 'skills/demo/run.sh'), 0o755)
  fs.symlinkSync('SKILL.md', join(f.repo, 'skills/demo/alias.md'))
  success(f.run())
  assert.equal(fs.readlinkSync(join(f.home, '.agents/skills')), join(f.dest, 'skills'))
  for (const root of [f.claude, join(f.home, '.config/opencode')]) assert.equal(fs.readlinkSync(join(root, 'skills/demo')), join(f.dest, 'skills/demo'))
  assert.equal(fs.readlinkSync(join(f.dest, 'skills/demo/alias.md')), 'SKILL.md')
  assert.ok(fs.statSync(join(f.dest, 'skills/demo/run.sh')).mode & 0o100)
  assert.equal(fs.readFileSync(join(f.claude, 'workflows/resources/config.json'), 'utf8'), '{}')
  assert.equal(fs.existsSync(join(f.dest, 'workflows/.ignored')), false)
  assert.equal(fs.existsSync(f.legacy), false)
  success(f.run(['--check']))
})

test('仓库变化仅在手动再次同步后进入安装目录并保留旧内容备份', t => {
  const f = fixture(t)
  success(f.run())
  f.write(join(f.repo, 'skills/demo/SKILL.md'), '# Updated\n')
  fs.rmSync(join(f.repo, 'skills/demo/assets'), { recursive: true })
  assert.equal(fs.readFileSync(join(f.dest, 'skills/demo/SKILL.md'), 'utf8'), '# Demo\n')
  success(f.run())
  assert.equal(fs.readFileSync(join(f.dest, 'skills/demo/SKILL.md'), 'utf8'), '# Updated\n')
  assert.equal(fs.existsSync(join(f.dest, 'skills/demo/assets')), false)
  const run = f.state().run
  const record = JSON.parse(fs.readFileSync(join(f.dest, '.backups', run, 'record.json'), 'utf8'))
  const index = record.operations.findIndex(op => op.path === join(f.dest, 'skills/demo'))
  assert.equal(fs.readFileSync(join(f.dest, '.backups', run, 'objects', String(index), 'SKILL.md'), 'utf8'), '# Demo\n')
})

test('预览首次同步、旧安装合并与残留清理均只读', t => {
  const f = fixture(t)
  success(f.run(['--dry-run']))
  assert.deepEqual(fs.readdirSync(f.home), [])
  skill(f, f.legacy, 'extra')
  let before = snapshot(f.home)
  success(f.run(['--migrate-legacy', '--dry-run']))
  assert.deepEqual(snapshot(f.home), before)
  success(f.migrate())
  fs.rmSync(join(f.repo, 'skills/demo'), { recursive: true })
  before = snapshot(f.home)
  const result = f.run(['--dry-run'])
  success(result)
  assert.match(result.stdout, /清理受管残留链接/)
  assert.deepEqual(snapshot(f.home), before)
})

test('首次迁移必须使用仍与来源一致的预览计划', t => {
  const f = fixture(t)
  skill(f, f.legacy, 'external')
  const before = snapshot(f.home)
  const preview = f.run(['--migrate-legacy', '--dry-run'])
  success(preview)
  assert.match(preview.stdout, /"original":.*\/skills\/external/)
  assert.match(preview.stdout, /"source":.*\/skills\/external/)
  assert.match(preview.stdout, /"digest":"[a-f0-9]{64}"/)
  const token = preview.stdout.match(/^计划指纹: (sha256:[a-f0-9]{64})$/m)?.[1]
  assert.ok(token)
  assert.deepEqual(snapshot(f.home), before)
  failure(f.run(['--migrate-legacy']), /--expect-plan/)
  f.write(join(f.repo, 'skills/demo/SKILL.md'), '# Changed after preview\n')
  failure(f.run(['--migrate-legacy', '--expect-plan', token]), /计划发生变化/)
  assert.deepEqual(snapshot(f.home), before)
  const updated = f.run(['--migrate-legacy', '--dry-run'])
  success(updated)
  const updatedToken = updated.stdout.match(/^计划指纹: (sha256:[a-f0-9]{64})$/m)?.[1]
  assert.ok(updatedToken)
  success(f.run(['--migrate-legacy', '--expect-plan', updatedToken]))
  assert.equal(fs.readFileSync(join(f.dest, 'skills/demo/SKILL.md'), 'utf8'), '# Changed after preview\n')
})

test('首次迁移合并同名、迁入外部独有项、原路径转链接、Codex 去重', t => {
  const f = fixture(t)
  fs.cpSync(join(f.repo, 'skills/demo'), join(f.legacy, 'skills/demo'), { recursive: true })
  skill(f, join(f.home, '.agents'), 'lark-im')
  skill(f, f.claude, 'local')
  f.write(join(f.home, '.agents/.skill-lock.json'), '{"fixture":true}')
  f.write(join(f.home, '.codex/skills/.system/keep.md'), 'builtin')
  fs.mkdirSync(join(f.home, '.codex/skills'), { recursive: true })
  fs.symlinkSync(join(f.legacy, 'skills/demo'), join(f.home, '.codex/skills/demo'))
  success(f.migrate())
  assert.equal(fs.readlinkSync(join(f.legacy, 'skills/demo')), join(f.dest, 'skills/demo'))
  assert.equal(fs.readlinkSync(join(f.claude, 'skills/local')), join(f.dest, 'skills/local'))
  assert.equal(fs.existsSync(join(f.home, '.codex/skills/demo')), false)
  assert.equal(fs.readFileSync(join(f.home, '.codex/skills/.system/keep.md'), 'utf8'), 'builtin')
  assert.equal(fs.readFileSync(join(f.home, '.agents/.skill-lock.json'), 'utf8'), '{"fixture":true}')
  assert.equal(f.state().entries['skills/lark-im'].owner, 'external')
  success(f.migrate())
  success(f.run(['--check']))
})

test('安装目录中的 ZIP 和非 skill 文件保持原状，共享目录未知项不被隐藏', t => {
  const f = fixture(t)
  f.write(join(f.home, '.codex/skills/归档.zip'), 'archive fixture')
  f.write(join(f.claude, 'skills/note.txt'), 'local note')
  f.write(join(f.home, '.agents/skills/.DS_Store'), 'finder metadata')
  const original = snapshot(f.home)
  success(f.run(['--migrate-legacy', '--dry-run']))
  assert.deepEqual(snapshot(f.home), original)
  success(f.migrate())
  assert.equal(fs.readFileSync(join(f.home, '.codex/skills/归档.zip'), 'utf8'), 'archive fixture')
  assert.equal(fs.readFileSync(join(f.claude, 'skills/note.txt'), 'utf8'), 'local note')
  assert.equal(fs.existsSync(join(f.dest, 'skills/归档.zip')), false)
  const runRoot = join(f.dest, '.backups', f.state().run)
  const record = JSON.parse(fs.readFileSync(join(runRoot, 'record.json'), 'utf8'))
  const index = record.operations.findIndex(op => op.path === join(f.home, '.agents/skills'))
  assert.equal(fs.readFileSync(join(runRoot, 'objects', String(index), '.DS_Store'), 'utf8'), 'finder metadata')
  f.write(join(f.dest, 'skills/note.txt'), 'target note')
  success(f.run(['--check']))
  const hidden = fixture(t)
  hidden.write(join(hidden.home, '.agents/skills/.unknown'), 'keep hidden')
  const hiddenBefore = snapshot(hidden.home)
  failure(hidden.run(['--migrate-legacy']), /隐藏条目/)
  assert.deepEqual(snapshot(hidden.home), hiddenBefore)
  const other = fixture(t)
  other.write(join(other.home, '.agents/skills/note.txt'), 'keep')
  const before = snapshot(other.home)
  failure(other.run(['--migrate-legacy']), /非 skill 条目/)
  assert.deepEqual(snapshot(other.home), before)
  fs.rmSync(join(other.home, '.agents/skills/note.txt'))
  other.write(join(other.home, '.agents/skills/.private/keep.txt'), 'hidden content')
  const hiddenDirectoryBefore = snapshot(other.home)
  failure(other.run(['--migrate-legacy']), /隐藏条目/)
  assert.deepEqual(snapshot(other.home), hiddenDirectoryBefore)
})

test('首次及后续同步禁止云舟 v7 覆盖 v8，仓库较新 v9 可手动发布', t => {
  const f = fixture(t)
  flows(f, f.repo, 7)
  flows(f, f.legacy, 8)
  success(f.migrate())
  success(f.run())
  assert.match(fs.readFileSync(join(f.dest, 'skills/flows-role-comment/scripts/check_update.py'), 'utf8'), /BASE_VERSION = 8/)
  flows(f, f.repo, 9)
  success(f.run())
  assert.match(fs.readFileSync(join(f.dest, 'skills/flows-role-comment/scripts/check_update.py'), 'utf8'), /BASE_VERSION = 9/)
})

test('同步保留兼容入口并清理已删除仓库资产的旧链接', t => {
  const f = fixture(t)
  fs.cpSync(join(f.repo, 'skills/demo'), join(f.legacy, 'skills/demo'), { recursive: true })
  const command = join(f.home, '.agents/commands/local.md')
  f.write(command, '# Local command\n')
  success(f.migrate())
  success(f.run())
  const commandTarget = fs.readlinkSync(command)
  fs.unlinkSync(command)
  failure(f.run(['--check']), /入口目标偏离或悬空/)
  fs.symlinkSync(commandTarget, command)
  fs.rmSync(join(f.repo, 'skills/demo'), { recursive: true })
  success(f.run())
  assert.equal(fs.readdirSync(join(f.legacy, 'skills')).includes('demo'), false)
  assert.equal(fs.readlinkSync(command), commandTarget)
  success(f.run(['--check']))
  success(f.run(['--migrate-legacy', '--dry-run']))
})

test('来源记录缺少兼容入口时，删除仓库资产仍清理旧根链接', t => {
  const f = fixture(t)
  fs.cpSync(join(f.repo, 'skills/demo'), join(f.legacy, 'skills/demo'), { recursive: true })
  success(f.migrate())
  // 模拟旧版日常同步丢失兼容入口记录。
  const legacyLink = join(f.legacy, 'skills/demo')
  const recorded = f.state()
  f.write(join(f.dest, '.migration-state.json'), JSON.stringify({ ...recorded, links: recorded.links.filter(([file]) => file !== legacyLink) }))
  fs.rmSync(join(f.repo, 'skills/demo'), { recursive: true })
  success(f.run())
  assert.equal(fs.readdirSync(join(f.legacy, 'skills')).includes('demo'), false)
  success(f.run(['--check']))
  success(f.run(['--migrate-legacy', '--dry-run']))
})

test('清理旧根链接不触碰回滚范围外的入口，同步运行仍可回滚', t => {
  const f = fixture(t)
  f.write(join(f.repo, 'claude/agents/helper.md'), '---\nmodel: inherit\n---\nHelper\n')
  success(f.run())
  const outside = join(f.home, '.agents/agents/helper.md')
  fs.mkdirSync(dirname(outside), { recursive: true })
  fs.symlinkSync(join(f.dest, 'agents/claude/helper.md'), outside)
  fs.rmSync(join(f.repo, 'claude/agents/helper.md'))
  success(f.run())
  assert.equal(fs.lstatSync(outside).isSymbolicLink(), true)
  success(f.run(['--rollback', f.state().run]))
})

test('删除 cc-switch 旧根后，工具入口与核验仍独立可用', t => {
  const f = fixture(t)
  skill(f, f.legacy, 'external')
  success(f.migrate())
  fs.rmSync(f.legacy, { recursive: true })
  success(f.run(['--check']))
  assert.equal(fs.readFileSync(join(f.claude, 'skills/external/SKILL.md'), 'utf8'), '# External\n')
})

test('本地引用支持普通相对路径、带空格与 URL 编码路径', t => {
  const f = fixture(t)
  f.write(join(f.repo, 'docs/guide with spaces.md'), '# Guide\n')
  f.write(join(f.repo, 'workflow/guide.md'), '[guide](<../docs/guide with spaces.md>)\n[encoded](../docs/guide%20with%20spaces.md)\n')
  f.write(join(f.repo, 'skills/demo/SKILL.md'), '[asset](assets/template.html)\n')
  success(f.run())
  assert.equal(fs.readFileSync(join(f.dest, 'docs/guide with spaces.md'), 'utf8'), '# Guide\n')
})

test('macOS 路径别名不改变 HOME 下的声明来源范围', t => {
  const f = fixture(t)
  skill(f, f.legacy, 'external')
  const alias = f.home.replace(/^\/private\/var\//, '/var/')
  success(f.migrate([], { HOME: alias }))
  success(f.run(['--check'], { HOME: alias }))
})

test('声明版本按数字比较，不按字符串排序或文件时间判断', t => {
  const f = fixture(t)
  skill(f, f.repo, 'versioned', '---\nversion: 1.9.0\n---\nold')
  skill(f, f.legacy, 'versioned', '---\nversion: 1.10.0\n---\nnew')
  success(f.migrate())
  assert.match(fs.readFileSync(join(f.dest, 'skills/versioned/SKILL.md'), 'utf8'), /1.10.0/)
})

test('当前工作区包含未提交修改与新增 skill，已知旧副本通过历史识别', t => {
  const f = fixture(t)
  initializeGit(f)
  fs.cpSync(join(f.repo, 'skills/demo'), join(f.legacy, 'skills/demo'), { recursive: true })
  f.write(join(f.repo, 'skills/demo/SKILL.md'), '# Uncommitted\n')
  skill(f, f.repo, 'untracked')
  success(f.migrate())
  assert.equal(fs.readFileSync(join(f.dest, 'skills/demo/SKILL.md'), 'utf8'), '# Uncommitted\n')
  assert.equal(fs.existsSync(join(f.dest, 'skills/untracked/SKILL.md')), true)
  assert.equal(f.state().dirty, true)
  assert.equal(f.state().commit, git(f, 'rev-parse', 'HEAD'))
})

test('无法判定的差异预览及执行均失败且不写入，指定候选后可迁移', t => {
  const f = fixture(t)
  skill(f, f.legacy, 'demo', '# Different\n')
  const before = snapshot(f.home)
  for (const args of [['--migrate-legacy'], ['--migrate-legacy', '--dry-run']]) failure(f.run(args), /未解决冲突/)
  assert.deepEqual(snapshot(f.home), before)
  const resolutions = join(f.root, 'resolutions.json')
  f.write(resolutions, JSON.stringify({ 'skills/demo': join(f.repo, 'skills/demo') }))
  success(f.migrate(['--resolutions', resolutions]))
  assert.equal(fs.readFileSync(join(f.dest, 'skills/demo/SKILL.md'), 'utf8'), '# Demo\n')
})

test('手动同步保留首次明确选定的外部副本', t => {
  const f = fixture(t)
  skill(f, f.legacy, 'demo', '# Chosen local\n')
  const resolutions = join(f.root, 'resolutions.json')
  f.write(resolutions, JSON.stringify({ 'skills/demo': join(f.legacy, 'skills/demo') }))
  success(f.migrate(['--resolutions', resolutions]))
  success(f.run())
  assert.equal(fs.readFileSync(join(f.dest, 'skills/demo/SKILL.md'), 'utf8'), '# Chosen local\n')
  assert.equal(f.state().entries['skills/demo'].owner, 'external')
  fs.rmSync(join(f.repo, 'skills/demo'), { recursive: true })
  fs.cpSync(join(f.dest, 'skills/demo'), join(f.repo, 'skills/demo'), { recursive: true })
  success(f.run())
  assert.equal(f.state().entries['skills/demo'].owner, 'external')
  fs.rmSync(join(f.repo, 'skills/demo'), { recursive: true })
  success(f.run())
  assert.equal(fs.readFileSync(join(f.dest, 'skills/demo/SKILL.md'), 'utf8'), '# Chosen local\n')
})

test('外部副本自行更新后，仓库改为相同内容再删除仍保留外部副本', t => {
  const chosen = fixture(t)
  skill(chosen, chosen.legacy, 'demo', '# Chosen local\n')
  const resolutions = join(chosen.root, 'resolutions.json')
  chosen.write(resolutions, JSON.stringify({ 'skills/demo': join(chosen.legacy, 'skills/demo') }))
  success(chosen.migrate(['--resolutions', resolutions]))
  skill(chosen, chosen.dest, 'demo', '# Updated by installer\n')
  fs.rmSync(join(chosen.repo, 'skills/demo'), { recursive: true })
  fs.cpSync(join(chosen.dest, 'skills/demo'), join(chosen.repo, 'skills/demo'), { recursive: true })
  success(chosen.run())
  assert.equal(chosen.state().entries['skills/demo'].owner, 'external')
  fs.rmSync(join(chosen.repo, 'skills/demo'), { recursive: true })
  success(chosen.run())
  assert.equal(fs.readFileSync(join(chosen.dest, 'skills/demo/SKILL.md'), 'utf8'), '# Updated by installer\n')
  assert.equal(fs.readlinkSync(join(chosen.claude, 'skills/demo')), join(chosen.dest, 'skills/demo'))
  success(chosen.run(['--check']))

  const yunzhou = fixture(t)
  flows(yunzhou, yunzhou.repo, 7)
  flows(yunzhou, yunzhou.legacy, 8)
  success(yunzhou.migrate())
  flows(yunzhou, yunzhou.dest, 9)
  fs.rmSync(join(yunzhou.repo, 'skills/flows-role-comment'), { recursive: true })
  fs.cpSync(join(yunzhou.dest, 'skills/flows-role-comment'), join(yunzhou.repo, 'skills/flows-role-comment'), { recursive: true })
  success(yunzhou.run())
  assert.equal(yunzhou.state().entries['skills/flows-role-comment'].owner, 'external')
  fs.rmSync(join(yunzhou.repo, 'skills/flows-role-comment'), { recursive: true })
  success(yunzhou.run())
  assert.match(fs.readFileSync(join(yunzhou.dest, 'skills/flows-role-comment/scripts/check_update.py'), 'utf8'), /BASE_VERSION = 9/)
})

test('候选选择不能绕过版本保护或选择范围外路径', t => {
  const f = fixture(t)
  flows(f, f.repo, 7); flows(f, f.legacy, 8)
  const resolutions = join(f.root, 'choices.json')
  f.write(resolutions, JSON.stringify({ 'skills/flows-role-comment': join(f.repo, 'skills/flows-role-comment') }))
  failure(f.run(['--migrate-legacy', '--resolutions', resolutions]), /降级/)
  f.write(resolutions, JSON.stringify({ 'skills/flows-role-comment': '/not/a/candidate' }))
  failure(f.run(['--migrate-legacy', '--resolutions', resolutions]), /不是本次候选/)
})

test('第三方更新与非仓库发布资产在同步中保留，普通 skill 新入口可补齐', t => {
  const f = fixture(t)
  skill(f, f.legacy, 'external')
  success(f.migrate())
  skill(f, f.dest, 'external', '# Updated by installer\n')
  skill(f, f.dest, 'new-third-party')
  success(f.run())
  assert.equal(fs.readFileSync(join(f.dest, 'skills/external/SKILL.md'), 'utf8'), '# Updated by installer\n')
  assert.equal(fs.readlinkSync(join(f.claude, 'skills/new-third-party')), join(f.dest, 'skills/new-third-party'))
  assert.equal(f.state().entries['skills/external'].owner, 'external')
})

test('飞书模拟删除与复制通过整个共享目录链接写入 tigger', t => {
  const f = fixture(t)
  skill(f, join(f.home, '.agents'), 'lark-im')
  success(f.migrate())
  fs.rmSync(join(f.home, '.agents/skills/lark-im'), { recursive: true })
  skill(f, join(f.home, '.agents'), 'lark-im', '# Installed update\n')
  assert.equal(fs.lstatSync(join(f.home, '.agents/skills')).isSymbolicLink(), true)
  assert.equal(fs.readFileSync(join(f.dest, 'skills/lark-im/SKILL.md'), 'utf8'), '# Installed update\n')
  success(f.run(['--check']))
})

test('仅移除相关 Codex 禁用表，保留 hatch-pet、TUI、注释及无关文本', t => {
  const f = fixture(t)
  skill(f, join(f.home, '.agents'), 'lark-im')
  const unaffected = '# keep\n[[skills.config]]\npath = "hatch-pet"\nenabled = false\n[tui]\nscreen_reader_detection_done = true\n[fixture]\nvalue = "placeholder"\n'
  f.write(join(f.home, '.codex/config.toml'), `[[skills.config]]\npath = ${JSON.stringify(join(f.home, '.agents/skills/lark-im/SKILL.md'))}\nenabled = false\n${unaffected}`)
  success(f.migrate())
  assert.equal(fs.readFileSync(join(f.home, '.codex/config.toml'), 'utf8'), unaffected)
})

test('日常同步与核验保留已安装 skill 的 Codex 禁用项', t => {
  const f = fixture(t)
  success(f.run())
  const skillPath = join(f.home, '.agents/skills/demo/SKILL.md')
  const existingState = f.state()
  f.write(join(f.dest, '.migration-state.json'), JSON.stringify({ ...existingState, oldPaths: [skillPath] }))
  const configPath = join(f.home, '.codex/config.toml')
  const config = `[[skills.config]]\npath = ${JSON.stringify(skillPath)}\nenabled = false\n[tui]\nvalue = true\n`
  f.write(configPath, config)
  success(f.run(['--check']))
  success(f.run())
  success(f.migrate())
  assert.equal(fs.readFileSync(configPath, 'utf8'), config)
  success(f.run(['--check']))
})

test('需清理的 Codex 旧禁用表无法识别时在写入前失败', t => {
  const f = fixture(t)
  skill(f, join(f.home, '.agents'), 'lark-im')
  const skillPath = join(f.home, '.agents/skills/lark-im/SKILL.md')
  f.write(join(f.home, '.codex/config.toml'), `[[skills.config]]\npath = ${JSON.stringify(skillPath)}\nunknown = 1\n`)
  const before = snapshot(f.home)
  failure(f.migrate(), /无法识别/)
  assert.deepEqual(snapshot(f.home), before)
})

test('工具专用 agent 变体、独立 TOML/YAML 与命令组层级保留', t => {
  const f = fixture(t)
  f.write(join(f.repo, 'claude/agents/demo.md'), '---\nmodel: inherit\n---\nClaude')
  f.write(join(f.repo, 'claude/agents/ddd-architect.md'), '---\nmode: primary\n---\nopencode')
  f.write(join(f.claude, 'agents/architect.md'), '---\nmodel: opus\n---\nClaude')
  f.write(join(f.legacy, 'agents/architect.md'), '---\nmode: primary\n---\nopencode')
  f.write(join(f.home, '.codex/agents/local.toml'), 'name = "fixture"\n')
  f.write(join(f.home, '.config/opencode/agents/reviewer.yaml'), 'mode: subagent\n')
  f.write(join(f.repo, 'claude/commands/opsx/nested/demo.md'), '# Command')
  success(f.migrate())
  assert.match(fs.readFileSync(join(f.dest, 'agents/claude/architect.md'), 'utf8'), /model: opus/)
  assert.match(fs.readFileSync(join(f.dest, 'agents/opencode/architect.md'), 'utf8'), /mode: primary/)
  assert.equal(fs.existsSync(join(f.dest, 'agents/codex/local.toml')), true)
  assert.equal(fs.existsSync(join(f.dest, 'agents/opencode/reviewer.yaml')), true)
  assert.equal(fs.existsSync(join(f.claude, 'agents/ddd-architect.md')), false)
  assert.equal(fs.readlinkSync(join(f.home, '.config/opencode/agents/ddd-architect.md')), join(f.dest, 'agents/opencode/ddd-architect.md'))
  assert.equal(fs.readFileSync(join(f.claude, 'commands/opsx/nested/demo.md'), 'utf8'), '# Command')
})

test('清理仅作用于来源记录归属仓库且未被外部修改的资产', t => {
  const f = fixture(t)
  skill(f, f.repo, 'removed')
  skill(f, f.legacy, 'external')
  success(f.migrate())
  fs.rmSync(join(f.repo, 'skills/removed'), { recursive: true })
  f.write(join(f.dest, 'skills/demo/SKILL.md'), '# Local edit')
  fs.rmSync(join(f.repo, 'skills/demo'), { recursive: true })
  success(f.run())
  assert.equal(fs.existsSync(join(f.dest, 'skills/removed')), false)
  assert.equal(fs.existsSync(join(f.claude, 'skills/removed')), false)
  assert.equal(fs.readFileSync(join(f.dest, 'skills/demo/SKILL.md'), 'utf8'), '# Local edit')
  assert.equal(fs.existsSync(join(f.dest, 'skills/external/SKILL.md')), true)
})

test('源目录整体缺失或失去 SKILL.md 时不卸载已发布资产', t => {
  const f = fixture(t)
  f.write(join(f.repo, 'claude/commands/opsx/demo.md'), '# Command')
  success(f.run())
  fs.rmSync(join(f.repo, 'workflow'), { recursive: true })
  fs.rmSync(join(f.repo, 'claude/commands'), { recursive: true })
  fs.rmSync(join(f.repo, 'skills/demo/SKILL.md'))
  success(f.run())
  assert.equal(fs.existsSync(join(f.dest, 'workflows/demo.workflow.js')), true)
  assert.equal(fs.existsSync(join(f.dest, 'commands/opsx/demo.md')), true)
  assert.equal(fs.existsSync(join(f.dest, 'skills/demo/SKILL.md')), true)
})

test('空 assets 可安装；缺失 skills 或非法可选源目录在写入前失败', t => {
  const f = fixture(t)
  fs.rmSync(join(f.repo, 'skills'), { recursive: true })
  failure(f.run(), /缺少源目录/)
  assert.deepEqual(fs.readdirSync(f.home), [])
  fs.mkdirSync(join(f.repo, 'skills'))
  fs.rmSync(join(f.repo, 'workflow'), { recursive: true })
  success(f.run())
  f.write(join(f.repo, 'workflow'), 'not a directory')
  const before = snapshot(f.home)
  failure(f.run(), /不是目录/)
  assert.deepEqual(snapshot(f.home), before)
})

test('workflow 只编译不执行，无 meta、空内容与语法错误均拒绝', t => {
  const f = fixture(t)
  for (const value of ['', 'const x = 1', 'export const meta = {;']) {
    f.write(join(f.repo, 'workflow/demo.workflow.js'), value)
    failure(f.run())
    assert.deepEqual(fs.readdirSync(f.home), [])
  }
  f.write(join(f.repo, 'workflow/demo.workflow.js'), "export const meta = {}; throw new Error('must not execute');")
  success(f.run())
})

test('根、备份及入口父目录链接在写入前拒绝', t => {
  for (const relative of ['.tigger', '.tigger/skills', '.tigger/.backups', '.claude/skills', '.config/opencode/agents']) {
    const f = fixture(t)
    fs.mkdirSync(dirname(join(f.home, relative)), { recursive: true })
    fs.symlinkSync(f.repo, join(f.home, relative))
    const before = snapshot(f.home)
    failure(f.run())
    assert.deepEqual(snapshot(f.home), before)
  }
})

test('未知入口、悬空来源与范围外链接不会被默认覆盖', t => {
  for (const mode of ['local', 'dangling', 'external']) {
    const f = fixture(t)
    if (mode === 'local') skill(f, f.claude, 'demo')
    else {
      const external = join(f.root, 'external')
      f.write(join(external, 'SKILL.md'), '# External')
      fs.mkdirSync(join(f.claude, 'skills'), { recursive: true })
      fs.symlinkSync(mode === 'dangling' ? join(f.root, 'missing') : external, join(f.claude, 'skills/demo'))
    }
    const before = snapshot(f.home)
    failure(f.run(mode === 'local' ? [] : ['--migrate-legacy']))
    assert.deepEqual(snapshot(f.home), before)
  }
})

test('首次迁移拒绝覆盖与普通 skill 同名的无关文件', t => {
  for (const tool of ['.claude', '.config/opencode', '.codex']) {
    const f = fixture(t)
    f.write(join(f.home, tool, 'skills/demo'), 'unrelated local file')
    const before = snapshot(f.home)
    failure(f.run(['--migrate-legacy', '--dry-run']), /入口已有未知内容|Codex 同名入口尚未合并/)
    assert.deepEqual(snapshot(f.home), before)
  }
})

test('迁移锁冲突无副作用', t => {
  const f = fixture(t)
  success(f.run())
  fs.mkdirSync(join(f.dest, '.migration-lock'))
  const before = snapshot(f.home)
  failure(f.run(), /已有迁移/)
  assert.deepEqual(snapshot(f.home), before)
})

test('复制失败不修改安装内容并释放暂存目录与锁', t => {
  const f = fixture(t)
  success(f.run())
  const before = snapshot(f.home)
  failure(fault(f, "fs.cpSync = () => { throw new Error('fixture copy failure') }"), /copy failure/)
  assert.deepEqual(snapshot(f.home), before)
})

test('首个入口切换失败时撤销已写入内容并释放锁', t => {
  const f = fixture(t)
  initializeGit(f)
  fs.cpSync(join(f.repo, 'skills/demo'), join(f.legacy, 'skills/demo'), { recursive: true })
  f.write(join(f.repo, 'skills/demo/SKILL.md'), '# New\n')
  const preview = f.run(['--migrate-legacy', '--dry-run'])
  success(preview)
  const result = fault(f, "const original = fs.symlinkSync; fs.symlinkSync = (target, p, ...rest) => { if (p.endsWith('/.claude/skills/demo')) throw new Error('fixture link failure'); return original(target, p, ...rest) }", ['--migrate-legacy', '--expect-plan', planToken(preview)])
  failure(result, /link failure/)
  assert.equal(fs.readFileSync(join(f.legacy, 'skills/demo/SKILL.md'), 'utf8'), '# Demo\n')
  assert.equal(fs.existsSync(join(f.dest, 'skills/demo')), false)
  assert.equal(fs.existsSync(join(f.dest, '.migration-lock')), false)
})

test('复制期间来源变化导致停止，不使用旧摘要切换', t => {
  const f = fixture(t)
  const result = fault(f, "const original = fs.cpSync; fs.cpSync = (source, destination, ...rest) => { const value = original(source, destination, ...rest); if (source.endsWith('/skills/demo')) fs.writeFileSync(source + '/SKILL.md', '# Changed during copy'); return value } ")
  failure(result, /来源发生变化/)
  assert.equal(fs.existsSync(join(f.dest, 'skills/demo')), false)
})

test('完整回滚恢复原目录、旧入口与 Codex 配置', t => {
  const f = fixture(t)
  skill(f, join(f.home, '.agents'), 'lark-im')
  const config = `[[skills.config]]\npath = ${JSON.stringify(join(f.home, '.agents/skills/lark-im/SKILL.md'))}\nenabled = false\n[tui]\nvalue = true\n`
  f.write(join(f.home, '.codex/config.toml'), config)
  success(f.migrate())
  const run = f.state().run
  success(f.run(['--rollback', run]))
  assert.equal(fs.lstatSync(join(f.home, '.agents/skills')).isDirectory(), true)
  assert.equal(fs.readFileSync(join(f.home, '.agents/skills/lark-im/SKILL.md'), 'utf8'), '# External\n')
  assert.equal(fs.readFileSync(join(f.home, '.codex/config.toml'), 'utf8'), config)
  assert.equal(fs.existsSync(join(f.dest, 'skills/lark-im')), false)
})

test('回滚前的用户修改和第三方更新不会被旧备份覆盖', t => {
  for (const kind of ['skill', 'config']) {
    const f = fixture(t)
    skill(f, join(f.home, '.agents'), 'lark-im')
    f.write(join(f.home, '.codex/config.toml'), `[[skills.config]]\npath = ${JSON.stringify(join(f.home, '.agents/skills/lark-im/SKILL.md'))}\nenabled = false\n`)
    success(f.migrate())
    const run = f.state().run
    if (kind === 'skill') f.write(join(f.dest, 'skills/lark-im/SKILL.md'), '# Later update')
    else f.write(join(f.home, '.codex/config.toml'), '# Later config')
    const before = snapshot(f.home)
    failure(f.run(['--rollback', run]), /后续修改/)
    assert.deepEqual(snapshot(f.home), before)
  }
})

test('未完成运行阻止覆盖并支持显式恢复', t => {
  const f = fixture(t)
  success(f.run())
  const run = f.state().run
  const p = join(f.dest, '.backups', run, 'record.json')
  const record = JSON.parse(fs.readFileSync(p, 'utf8'))
  record.status = 'running'
  f.write(p, JSON.stringify(record))
  failure(f.run(), /未完成运行/)
  success(f.run(['--rollback', run]))
})

test('核验检测旧根入口和第三方新增 skill 缺少入口', t => {
  const f = fixture(t)
  success(f.run())
  fs.symlinkSync(join(f.legacy, 'skills/old'), join(f.claude, 'skills/old'))
  failure(f.run(['--check']), /cc-switch/)
  fs.unlinkSync(join(f.claude, 'skills/old'))
  skill(f, f.dest, 'new')
  failure(f.run(['--check']), /尚未补齐/)
  success(f.run())
  success(f.run(['--check']))
})

test('内部相对链接保持解析，历史缺失引用单列，新失效引用拒绝', t => {
  const f = fixture(t)
  skill(f, f.repo, 'sibling')
  fs.symlinkSync('../sibling/SKILL.md', join(f.repo, 'skills/demo/sibling.md'))
  f.write(join(f.repo, 'skills/demo/SKILL.md'), '# Demo\n[old](./missing.md)\n[sibling](../sibling/SKILL.md)\n')
  const result = f.run()
  success(result)
  assert.match(result.stdout, /历史引用缺失/)
  assert.equal(fs.readFileSync(join(f.dest, 'skills/demo/sibling.md'), 'utf8'), '# External\n')
  f.write(join(f.repo, 'docs/guide.md'), 'guide')
  f.write(join(f.repo, 'skills/demo/SKILL.md'), '# Demo\n[guide](../../docs/guide.md)\n')
  success(f.run())
  assert.equal(fs.readFileSync(join(f.dest, 'docs/guide.md'), 'utf8'), 'guide')
  f.write(join(f.repo, 'outside/unsupported.md'), 'outside')
  f.write(join(f.repo, 'skills/demo/SKILL.md'), '# Demo\n[outside](../../outside/unsupported.md)\n')
  failure(f.run(), /新增失效引用/)
})

test('资产引用的根目录说明文件随同步复制，预览与执行对失效引用结论一致', t => {
  const f = fixture(t)
  f.write(join(f.repo, 'CLAUDE.md'), '# Project rules\n')
  f.write(join(f.repo, 'AGENTS.md'), '# Agent rules\n')
  f.write(join(f.repo, 'skills/demo/SKILL.md'), '# Demo\n[rules](../../CLAUDE.md)\n[agents](../../AGENTS.md)\n')
  success(f.run(['--dry-run']))
  success(f.run())
  assert.equal(fs.readFileSync(join(f.dest, 'CLAUDE.md'), 'utf8'), '# Project rules\n')
  assert.equal(fs.readFileSync(join(f.dest, 'AGENTS.md'), 'utf8'), '# Agent rules\n')
  assert.equal(fs.existsSync(join(f.claude, 'CLAUDE.md')), false)
  f.write(join(f.repo, 'outside/unsupported.md'), 'outside')
  f.write(join(f.repo, 'skills/demo/SKILL.md'), '# Demo\n[outside](../../outside/unsupported.md)\n')
  const before = snapshot(f.home)
  failure(f.run(['--dry-run']), /新增失效引用/)
  assert.deepEqual(snapshot(f.home), before)
  failure(f.run(), /新增失效引用/)
})

test('Node.js 低于 16.15 时入口在写入前退出', t => {
  const f = fixture(t)
  const bin = join(f.root, 'old-node-bin')
  f.write(join(bin, 'node'), '#!/bin/sh\necho 16.14.0\n')
  fs.chmodSync(join(bin, 'node'), 0o755)
  failure(f.run([], { PATH: `${bin}:${process.env.PATH}` }), /16\.15/)
  assert.deepEqual(fs.readdirSync(f.home), [])
})

test('核验发现已安装 skill 的 SKILL.md 为空', t => {
  const f = fixture(t)
  success(f.run())
  fs.writeFileSync(join(f.dest, 'skills/demo/SKILL.md'), '')
  failure(f.run(['--check']), /SKILL\.md/)
})

test('旧实体与 Codex 配置改写后失败时自动恢复', t => {
  const f = fixture(t)
  fs.cpSync(join(f.repo, 'skills/demo'), join(f.legacy, 'skills/demo'), { recursive: true })
  skill(f, join(f.home, '.agents'), 'lark-im')
  const configPath = join(f.home, '.codex/config.toml')
  const config = `[[skills.config]]\npath = ${JSON.stringify(join(f.home, '.agents/skills/lark-im/SKILL.md'))}\nenabled = false\n[tui]\nvalue = true\n`
  f.write(configPath, config)
  const preview = f.run(['--migrate-legacy', '--dry-run'])
  success(preview)
  // 来源记录在入口、旧实体与配置都改写之后才写入，在此注入失败。
  const result = fault(f, "const original = fs.renameSync; fs.renameSync = (from, to, ...rest) => { if (String(to).endsWith('.migration-state.json')) throw new Error('fixture state failure'); return original(from, to, ...rest) }", ['--migrate-legacy', '--expect-plan', planToken(preview)])
  failure(result, /state failure/)
  assert.equal(fs.lstatSync(join(f.legacy, 'skills/demo')).isDirectory(), true)
  assert.equal(fs.readFileSync(join(f.legacy, 'skills/demo/SKILL.md'), 'utf8'), '# Demo\n')
  assert.equal(fs.lstatSync(join(f.home, '.agents/skills')).isDirectory(), true)
  assert.equal(fs.readFileSync(join(f.home, '.agents/skills/lark-im/SKILL.md'), 'utf8'), '# External\n')
  assert.equal(fs.readFileSync(configPath, 'utf8'), config)
  assert.equal(fs.existsSync(join(f.claude, 'skills/demo')), false)
  assert.equal(fs.existsSync(join(f.dest, 'skills/demo')), false)
  assert.equal(fs.existsSync(join(f.dest, '.migration-lock')), false)
  const runs = fs.readdirSync(join(f.dest, '.backups'))
  assert.equal(runs.length, 1)
  const record = JSON.parse(fs.readFileSync(join(f.dest, '.backups', runs[0], 'record.json'), 'utf8'))
  assert.equal(record.status, 'rolled-back')
  // 证明故障发生在配置与旧实体都已改写之后。
  for (const p of [configPath, join(f.legacy, 'skills/demo'), join(f.home, '.agents/skills')]) assert.ok(record.operations.some(op => op.path === p), p)
})

test('帮助、无效参数、非法 HOME 与回滚编号均不写入', t => {
  const f = fixture(t)
  success(f.run(['--help']))
  for (const args of [['--unknown'], ['--check', '--migrate-legacy'], ['--rollback', '../../x'], ['--resolutions'], ['--check', '--dry-run']]) failure(f.run(args))
  failure(f.run([], { HOME: '' })); failure(f.run([], { HOME: 'relative' }))
  assert.deepEqual(fs.readdirSync(f.home), [])
})

test('真实仓库在隔离 HOME 中预览、安装、核验且不修改开发源', t => {
  const f = fixture(t)
  const run = args => spawnSync('/bin/bash', [script, ...args], { cwd: f.root, env: { ...process.env, HOME: f.home }, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  success(run(['--dry-run']))
  assert.deepEqual(fs.readdirSync(f.home), [])
  success(run([]))
  success(run(['--check']))
  const actualRepo = dirname(script)
  for (const name of fs.readdirSync(join(actualRepo, 'skills'))) {
    if (name.startsWith('.') || !fs.existsSync(join(actualRepo, 'skills', name, 'SKILL.md'))) continue
    assert.equal(fs.readFileSync(join(f.dest, 'skills', name, 'SKILL.md'), 'utf8'), fs.readFileSync(join(actualRepo, 'skills', name, 'SKILL.md'), 'utf8'))
  }
})
