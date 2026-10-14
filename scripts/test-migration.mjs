import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, existsSync,
  symlinkSync, readlinkSync, readdirSync, lstatSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = new URL('../migrate-skills.sh', import.meta.url)
const workflow = "export const meta = { name: 'demo', description: 'test', phases: [] };\nawait agent('test'); return {};\n"

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'skill-migration-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo with spaces')
  const home = join(root, 'home with spaces')
  mkdirSync(repo)
  mkdirSync(home)
  mkdirSync(join(repo, 'skills'))
  cpSync(script, join(repo, 'migrate-skills.sh'))
  const write = (path, text) => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }
  write(join(repo, 'skills/demo/SKILL.md'), '# Demo\n')
  write(join(repo, 'skills/demo/assets/template.html'), '<html></html>\n')
  write(join(repo, 'workflow/demo.workflow.js'), workflow)
  const run = (args = [], env = {}) => spawnSync('/bin/bash', [join(repo, 'migrate-skills.sh'), ...args], {
    cwd: root, env: { ...process.env, HOME: home, ...env }, encoding: 'utf8',
  })
  return { root, repo, home, write, run, dest: join(home, '.cc-switch'), claude: join(home, '.claude') }
}

function success(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
}

function snapshot(path) {
  if (!existsSync(path)) return null
  const result = {}
  function visit(dir, prefix = '') {
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name)
      const key = `${prefix}${name}`
      const stat = lstatSync(file)
      if (stat.isSymbolicLink()) result[key] = ['link', readlinkSync(file)]
      else if (stat.isDirectory()) { result[key] = ['directory']; visit(file, `${key}/`) }
      else result[key] = ['file', readFileSync(file).toString('base64')]
    }
  }
  visit(path)
  return result
}

test('首次迁移、计数、资源、权限、内部链接和重复更新', t => {
  const f = fixture(t)
  f.write(join(f.repo, 'workflow/resources/config.json'), '{}')
  f.write(join(f.repo, 'workflow/demo.md'), 'workflow docs')
  f.write(join(f.repo, 'workflow/.ignored'), 'hidden')
  f.write(join(f.repo, 'skills/demo/run.sh'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(f.repo, 'skills/demo/run.sh'), 0o755)
  symlinkSync('SKILL.md', join(f.repo, 'skills/demo/alias.md'))
  const first = f.run()
  success(first)
  assert.match(first.stdout, /1 skills、1 workflows、2 个 workflow 资源/)
  assert.equal(readlinkSync(join(f.claude, 'skills/demo')), join(f.dest, 'skills/demo'))
  assert.equal(readlinkSync(join(f.dest, 'skills/demo/alias.md')), 'SKILL.md')
  assert.ok(lstatSync(join(f.dest, 'skills/demo/run.sh')).mode & 0o100)
  assert.equal(readFileSync(join(f.claude, 'workflows/resources/config.json'), 'utf8'), '{}')
  assert.equal(existsSync(join(f.dest, 'workflows/.ignored')), false)
  f.write(join(f.repo, 'skills/demo/SKILL.md'), '# Updated\n')
  rmSync(join(f.repo, 'skills/demo/assets'), { recursive: true })
  success(f.run())
  assert.equal(readFileSync(join(f.dest, 'skills/demo/SKILL.md'), 'utf8'), '# Updated\n')
  assert.equal(existsSync(join(f.dest, 'skills/demo/assets')), false)
  const [backup] = readdirSync(join(f.dest, '.migration-backups'))
  assert.equal(readFileSync(join(f.dest, '.migration-backups', backup, 'skills/demo/SKILL.md'), 'utf8'), '# Demo\n')
  assert.equal(existsSync(join(f.dest, '.migration-lock')), false)
})

test('dry-run 首次运行和已安装时都不写入，且预览残留清理', t => {
  const f = fixture(t)
  success(f.run(['--dry-run']))
  assert.deepEqual(readdirSync(f.home), [])
  success(f.run())
  rmSync(join(f.repo, 'skills/demo'), { recursive: true })
  const before = snapshot(f.home)
  const result = f.run(['--dry-run'])
  success(result)
  assert.match(result.stdout, /清理受管残留链接/)
  assert.deepEqual(snapshot(f.home), before)
})

test('删除源后清理有效和悬空受管链接，保留其他来源及无链接副本', t => {
  const f = fixture(t)
  success(f.run())
  rmSync(join(f.repo, 'skills/demo'), { recursive: true })
  rmSync(join(f.repo, 'workflow/demo.workflow.js'))
  symlinkSync(join(f.dest, 'skills/missing'), join(f.claude, 'skills/missing'))
  symlinkSync('/other/install/skill', join(f.claude, 'skills/external'))
  f.write(join(f.dest, 'skills/unlinked/SKILL.md'), 'keep')
  f.write(join(f.claude, 'skills/local/SKILL.md'), 'local')
  success(f.run())
  assert.deepEqual(readdirSync(join(f.claude, 'skills')).sort(), ['external', 'local'])
  assert.equal(existsSync(join(f.dest, 'skills/demo')), false)
  assert.equal(existsSync(join(f.dest, 'workflows/demo.workflow.js')), false)
  assert.equal(readFileSync(join(f.dest, 'skills/unlinked/SKILL.md'), 'utf8'), 'keep')
  assert.equal(readdirSync(join(f.dest, '.migration-backups')).length, 1)
})

test('无 SKILL.md 的目录跳过且不卸载已有副本', t => {
  const f = fixture(t)
  success(f.run())
  rmSync(join(f.repo, 'skills/demo/SKILL.md'))
  const result = f.run()
  success(result)
  assert.match(result.stdout, /跳过 demo/)
  assert.equal(readFileSync(join(f.claude, 'skills/demo/SKILL.md'), 'utf8'), '# Demo\n')
})

test('缺失 skills 报错；空 skills 和可选 workflow 缺失可正常运行', t => {
  const f = fixture(t)
  rmSync(join(f.repo, 'skills'), { recursive: true })
  assert.notEqual(f.run().status, 0)
  assert.deepEqual(readdirSync(f.home), [])
  mkdirSync(join(f.repo, 'skills'))
  rmSync(join(f.repo, 'workflow'), { recursive: true })
  const result = f.run()
  success(result)
  assert.match(result.stdout, /0 skills、0 workflows/)
})

test('workflow 目录整体缺失时保留已安装 workflow', t => {
  const f = fixture(t)
  success(f.run())
  rmSync(join(f.repo, 'workflow'), { recursive: true })
  success(f.run())
  assert.equal(readFileSync(join(f.claude, 'workflows/demo.workflow.js'), 'utf8'), workflow)
})

test('空、缺 meta 和语法错误的 workflow 在写入前失败', t => {
  const f = fixture(t)
  for (const source of ['', 'const value = 1;', 'export const meta = {;']) {
    f.write(join(f.repo, 'workflow/demo.workflow.js'), source)
    assert.notEqual(f.run().status, 0)
    assert.notEqual(f.run(['--dry-run']).status, 0)
    assert.deepEqual(readdirSync(f.home), [])
  }
})

test('workflow 只编译不执行', t => {
  const f = fixture(t)
  f.write(join(f.repo, 'workflow/demo.workflow.js'), `export const meta = {}; throw new Error('must not execute');`)
  success(f.run())
})

test('默认覆盖两侧同名目录、文件、外部和悬空链接，分开备份且预览不写入', t => {
  for (const [key, installedFile, content] of [
    ['skills/demo', 'skills/demo/SKILL.md', '# Demo\n'],
    ['workflows/demo.workflow.js', 'workflows/demo.workflow.js', workflow],
    ['commands/opsx', 'commands/opsx/review.md', '# Review\n'],
    ['commands/standalone.md', 'commands/standalone.md', '# Standalone\n'],
    ['agents/demo.md', 'agents/demo.md', '# Agent\n'],
  ]) {
    for (const type of ['directory', 'file', 'symlink', 'dangling']) {
      const f = fixture(t)
      if (key.startsWith('commands/') || key.startsWith('agents/')) {
        f.write(join(f.repo, 'claude', installedFile), content)
      }
      const external = join(f.root, 'external')
      f.write(join(external, 'keep.txt'), 'external data')
      const originalLink = type === 'dangling' ? join(f.root, 'missing') : external
      for (const [base, value] of [[f.dest, 'store data'], [f.claude, 'claude data']]) {
        const target = join(base, key)
        mkdirSync(join(target, '..'), { recursive: true })
        if (type === 'directory') f.write(join(target, 'old.txt'), value)
        else if (type === 'file') writeFileSync(target, value)
        else symlinkSync(originalLink, target)
      }
      const before = snapshot(f.home)
      const preview = f.run(['--dry-run'])
      success(preview)
      assert.match(preview.stdout, /备份并覆盖同名安装项/)
      assert.deepEqual(snapshot(f.home), before)
      success(f.run())
      assert.equal(readlinkSync(join(f.claude, key)), join(f.dest, key))
      assert.equal(lstatSync(join(f.dest, key)).isSymbolicLink(), false)
      assert.equal(readFileSync(join(f.claude, installedFile), 'utf8'), content)
      const [backup] = readdirSync(join(f.dest, '.migration-backups'))
      for (const [prefix, value] of [['', 'store data'], ['claude', 'claude data']]) {
        const saved = join(f.dest, '.migration-backups', backup, prefix, key)
        if (type === 'directory') assert.equal(readFileSync(join(saved, 'old.txt'), 'utf8'), value)
        else if (type === 'file') assert.equal(readFileSync(saved, 'utf8'), value)
        else assert.equal(readlinkSync(saved), originalLink)
      }
      assert.equal(readFileSync(join(external, 'keep.txt'), 'utf8'), 'external data')
    }
  }
})

test('仍拒绝安装根目录和备份目录符号链接', t => {
  for (const relative of ['.cc-switch', '.claude/skills', '.claude/agents', '.cc-switch/agents', '.cc-switch/.migration-backups']) {
    const f = fixture(t)
    const target = join(f.home, relative)
    mkdirSync(join(target, '..'), { recursive: true })
    symlinkSync(f.repo, target)
    const before = snapshot(f.home)
    assert.notEqual(f.run().status, 0)
    assert.deepEqual(snapshot(f.home), before)
  }
})

test('入口目录符号链接复制为实体副本', t => {
  const f = fixture(t)
  f.write(join(f.root, 'shared/SKILL.md'), '# Shared')
  symlinkSync(join(f.root, 'shared'), join(f.repo, 'skills/shared'))
  success(f.run())
  assert.equal(lstatSync(join(f.dest, 'skills/shared')).isSymbolicLink(), false)
  assert.equal(readFileSync(join(f.claude, 'skills/shared/SKILL.md'), 'utf8'), '# Shared')
})

test('复制失败不影响旧副本并释放暂存目录和锁', t => {
  const f = fixture(t)
  success(f.run())
  const before = snapshot(f.home)
  const bin = join(f.root, 'bin')
  f.write(join(bin, 'cp'), '#!/bin/sh\nexit 1\n')
  chmodSync(join(bin, 'cp'), 0o755)
  assert.notEqual(f.run([], { PATH: `${bin}:${process.env.PATH}` }).status, 0)
  assert.deepEqual(snapshot(f.home), before)
})

test('创建链接失败时恢复两侧旧副本，包括真实目录和悬空链接', t => {
  for (const type of ['directory', 'dangling']) {
    const f = fixture(t)
    for (const base of [f.dest, f.claude]) {
      const target = join(base, 'skills/demo')
      mkdirSync(join(target, '..'), { recursive: true })
      if (type === 'directory') f.write(join(target, 'SKILL.md'), base)
      else symlinkSync(join(f.root, 'missing'), target)
    }
    const bin = join(f.root, 'bin')
    f.write(join(bin, 'ln'), '#!/bin/sh\nexit 1\n')
    chmodSync(join(bin, 'ln'), 0o755)
    assert.notEqual(f.run([], { PATH: `${bin}:${process.env.PATH}` }).status, 0)
    for (const base of [f.dest, f.claude]) {
      if (type === 'directory') assert.equal(readFileSync(join(base, 'skills/demo/SKILL.md'), 'utf8'), base)
      else assert.equal(readlinkSync(join(base, 'skills/demo')), join(f.root, 'missing'))
    }
    assert.equal(existsSync(join(f.dest, '.migration-lock')), false)
  }
})

test('Claude 同名项备份失败时恢复旧副本且保留原目录', t => {
  const f = fixture(t)
  f.write(join(f.dest, 'skills/demo/SKILL.md'), 'old store')
  f.write(join(f.claude, 'skills/demo/SKILL.md'), 'old claude')
  const bin = join(f.root, 'bin')
  f.write(join(bin, 'mv'), '#!/bin/sh\ncase "$1" in */.claude/skills/demo) exit 1 ;; esac\nexec /bin/mv "$@"\n')
  chmodSync(join(bin, 'mv'), 0o755)
  assert.notEqual(f.run([], { PATH: `${bin}:${process.env.PATH}` }).status, 0)
  assert.equal(readFileSync(join(f.dest, 'skills/demo/SKILL.md'), 'utf8'), 'old store')
  assert.equal(readFileSync(join(f.claude, 'skills/demo/SKILL.md'), 'utf8'), 'old claude')
  assert.equal(existsSync(join(f.dest, '.migration-lock')), false)
})

test('帮助、非法参数和非法 HOME 不写入', t => {
  const f = fixture(t)
  success(f.run(['--help']))
  assert.notEqual(f.run(['--unknown']).status, 0)
  assert.notEqual(f.run([], { HOME: '' }).status, 0)
  assert.notEqual(f.run([], { HOME: 'relative' }).status, 0)
  assert.deepEqual(readdirSync(f.home), [])
})

test('迁移锁冲突不修改现有安装和锁', t => {
  const f = fixture(t)
  success(f.run())
  mkdirSync(join(f.dest, '.migration-lock'))
  const before = snapshot(f.home)
  assert.notEqual(f.run().status, 0)
  assert.deepEqual(snapshot(f.home), before)
})

test('commands 保留命令组层级、更新文件并仅清理受管残留', t => {
  const f = fixture(t)
  f.write(join(f.repo, 'claude/commands/opsx/review.md'), '# Review')
  f.write(join(f.repo, 'claude/commands/opsx/nested/task.md'), '# Nested')
  f.write(join(f.repo, 'claude/commands/standalone.md'), '# Standalone')
  f.write(join(f.repo, 'claude/commands/.ignored'), 'hidden')
  const first = f.run()
  success(first)
  assert.match(first.stdout, /2 个 commands 条目/)
  assert.equal(readlinkSync(join(f.claude, 'commands/opsx')), join(f.dest, 'commands/opsx'))
  assert.equal(readFileSync(join(f.claude, 'commands/opsx/nested/task.md'), 'utf8'), '# Nested')
  assert.equal(existsSync(join(f.claude, 'commands/.ignored')), false)
  assert.equal(existsSync(join(f.claude, 'command')), false)
  f.write(join(f.claude, 'commands/local.md'), 'local')
  symlinkSync('/external/command', join(f.claude, 'commands/external.md'))
  f.write(join(f.repo, 'claude/commands/opsx/review.md'), '# Updated')
  rmSync(join(f.repo, 'claude/commands/opsx/nested'), { recursive: true })
  rmSync(join(f.repo, 'claude/commands/standalone.md'))
  const before = snapshot(f.home)
  const preview = f.run(['--dry-run'])
  success(preview)
  assert.match(preview.stdout, /清理受管残留链接并备份旧副本: commands\/standalone.md/)
  assert.deepEqual(snapshot(f.home), before)
  success(f.run())
  assert.equal(readFileSync(join(f.claude, 'commands/opsx/review.md'), 'utf8'), '# Updated')
  assert.equal(existsSync(join(f.claude, 'commands/opsx/nested')), false)
  assert.deepEqual(readdirSync(join(f.claude, 'commands')).sort(), ['external.md', 'local.md', 'opsx'])
  rmSync(join(f.repo, 'claude/commands/opsx'), { recursive: true })
  success(f.run())
  assert.deepEqual(readdirSync(join(f.claude, 'commands')).sort(), ['external.md', 'local.md'])
})

test('commands 源目录整体缺失时保留安装，非法源路径在写入前失败', t => {
  const f = fixture(t)
  f.write(join(f.repo, 'claude/commands/opsx/review.md'), '# Review')
  success(f.run())
  rmSync(join(f.repo, 'claude/commands'), { recursive: true })
  success(f.run())
  assert.equal(readFileSync(join(f.claude, 'commands/opsx/review.md'), 'utf8'), '# Review')
  f.write(join(f.repo, 'claude/commands'), 'not a directory')
  const before = snapshot(f.home)
  assert.notEqual(f.run().status, 0)
  assert.deepEqual(snapshot(f.home), before)
})

test('commands 链接创建失败时恢复两侧旧命令组', t => {
  const f = fixture(t)
  f.write(join(f.repo, 'claude/commands/opsx/review.md'), '# New')
  f.write(join(f.dest, 'commands/opsx/review.md'), 'old store')
  f.write(join(f.claude, 'commands/opsx/review.md'), 'old claude')
  const bin = join(f.root, 'bin')
  f.write(join(bin, 'ln'), '#!/bin/sh\ncase "$3" in */commands/opsx) exit 1 ;; esac\nexec /bin/ln "$@"\n')
  chmodSync(join(bin, 'ln'), 0o755)
  assert.notEqual(f.run([], { PATH: `${bin}:${process.env.PATH}` }).status, 0)
  assert.equal(readFileSync(join(f.dest, 'commands/opsx/review.md'), 'utf8'), 'old store')
  assert.equal(readFileSync(join(f.claude, 'commands/opsx/review.md'), 'utf8'), 'old claude')
  assert.equal(existsSync(join(f.dest, '.migration-lock')), false)
})

test('agents 首次迁移、重复更新及受管清理，不触碰其他安装', t => {
  const f = fixture(t)
  f.write(join(f.repo, 'claude/agents/demo.md'), '# Agent')
  f.write(join(f.repo, 'claude/agents/removed.md'), '# Removed')
  f.write(join(f.repo, 'claude/agents/.hidden.md'), 'hidden')
  f.write(join(f.repo, 'claude/agents/notes.txt'), 'not an agent')
  success(f.run(['--dry-run']))
  assert.deepEqual(readdirSync(f.home), [])
  const first = f.run()
  success(first)
  assert.match(first.stdout, /2 agents/)
  assert.equal(readlinkSync(join(f.claude, 'agents/demo.md')), join(f.dest, 'agents/demo.md'))
  assert.deepEqual(readdirSync(join(f.dest, 'agents')).sort(), ['demo.md', 'removed.md'])
  f.write(join(f.repo, 'claude/agents/demo.md'), '# Updated')
  rmSync(join(f.repo, 'claude/agents/removed.md'))
  f.write(join(f.claude, 'agents/local.md'), 'local')
  symlinkSync('/external/agent', join(f.claude, 'agents/external.md'))
  symlinkSync(join(f.dest, 'agents/missing.md'), join(f.claude, 'agents/missing.md'))
  const before = snapshot(f.home)
  const preview = f.run(['--dry-run'])
  success(preview)
  assert.match(preview.stdout, /清理受管残留链接并备份旧副本: agents\/removed.md/)
  assert.deepEqual(snapshot(f.home), before)
  success(f.run())
  assert.equal(readFileSync(join(f.claude, 'agents/demo.md'), 'utf8'), '# Updated')
  assert.deepEqual(readdirSync(join(f.claude, 'agents')).sort(), ['demo.md', 'external.md', 'local.md'])
  const [backup] = readdirSync(join(f.dest, '.migration-backups'))
  assert.equal(readFileSync(join(f.dest, '.migration-backups', backup, 'agents/removed.md'), 'utf8'), '# Removed')
})

test('agents 缺失源目录保留安装，空定义和非法源目录在写入前失败', t => {
  const f = fixture(t)
  f.write(join(f.repo, 'claude/agents/demo.md'), '# Agent')
  success(f.run())
  rmSync(join(f.repo, 'claude/agents'), { recursive: true })
  success(f.run())
  assert.equal(readFileSync(join(f.claude, 'agents/demo.md'), 'utf8'), '# Agent')
  f.write(join(f.repo, 'claude/agents/demo.md'), '')
  const before = snapshot(f.home)
  assert.notEqual(f.run().status, 0)
  assert.deepEqual(snapshot(f.home), before)
  rmSync(join(f.repo, 'claude/agents'), { recursive: true })
  f.write(join(f.repo, 'claude/agents'), 'not a directory')
  assert.notEqual(f.run().status, 0)
  assert.deepEqual(snapshot(f.home), before)
})

test('跳过 opencode 专用 agent 且不修改既有同名安装', t => {
  const f = fixture(t)
  f.write(join(f.repo, 'claude/agents/ddd-architect.md'), '---\nmode: primary\n---\n')
  f.write(join(f.repo, 'claude/agents/ddd-architect-claude.md'), '# Claude')
  f.write(join(f.claude, 'agents/ddd-architect.md'), 'existing')
  const result = f.run()
  success(result)
  assert.match(result.stdout, /跳过 ddd-architect.md: opencode 专用/)
  assert.match(result.stdout, /1 agents/)
  assert.equal(existsSync(join(f.dest, 'agents/ddd-architect.md')), false)
  assert.equal(readFileSync(join(f.claude, 'agents/ddd-architect.md'), 'utf8'), 'existing')
  assert.equal(readFileSync(join(f.claude, 'agents/ddd-architect-claude.md'), 'utf8'), '# Claude')
})

test('agents 创建链接失败时恢复两侧旧文件', t => {
  const f = fixture(t)
  f.write(join(f.repo, 'claude/agents/demo.md'), '# New')
  f.write(join(f.dest, 'agents/demo.md'), 'old store')
  f.write(join(f.claude, 'agents/demo.md'), 'old claude')
  const bin = join(f.root, 'bin')
  f.write(join(bin, 'ln'), '#!/bin/sh\ncase "$3" in */agents/demo.md) exit 1 ;; esac\nexec /bin/ln "$@"\n')
  chmodSync(join(bin, 'ln'), 0o755)
  assert.notEqual(f.run([], { PATH: `${bin}:${process.env.PATH}` }).status, 0)
  assert.equal(readFileSync(join(f.dest, 'agents/demo.md'), 'utf8'), 'old store')
  assert.equal(readFileSync(join(f.claude, 'agents/demo.md'), 'utf8'), 'old claude')
  assert.equal(existsSync(join(f.dest, '.migration-lock')), false)
})

test('仓库真实资源在隔离 HOME 中预览并完整安装', t => {
  const f = fixture(t)
  const run = args => spawnSync('/bin/bash', [fileURLToPath(script), ...args], {
    cwd: f.root, env: { ...process.env, HOME: f.home }, encoding: 'utf8',
  })
  success(run(['--dry-run']))
  assert.deepEqual(readdirSync(f.home), [])
  success(run([]))
  const skills = fileURLToPath(new URL('../skills/', import.meta.url))
  for (const name of readdirSync(skills)) {
    if (name.startsWith('.') || !existsSync(join(skills, name, 'SKILL.md'))) continue
    assert.equal(readFileSync(join(f.claude, 'skills', name, 'SKILL.md'), 'utf8'),
      readFileSync(join(skills, name, 'SKILL.md'), 'utf8'))
  }
  const workflows = fileURLToPath(new URL('../workflow/', import.meta.url))
  assert.deepEqual(readdirSync(join(f.dest, 'workflows')).sort(),
    readdirSync(workflows).filter(name => !name.startsWith('.')).sort())
  const commands = fileURLToPath(new URL('../claude/commands/', import.meta.url))
  assert.deepEqual(snapshot(join(f.dest, 'commands')), snapshot(commands))
  for (const name of readdirSync(commands).filter(name => !name.startsWith('.'))) {
    assert.equal(readlinkSync(join(f.claude, 'commands', name)), join(f.dest, 'commands', name))
  }
  const agents = fileURLToPath(new URL('../claude/agents/', import.meta.url))
  const agentNames = readdirSync(agents).filter(name => name.endsWith('.md')
    && !name.startsWith('.') && name !== 'ddd-architect.md').sort()
  assert.deepEqual(readdirSync(join(f.dest, 'agents')).sort(), agentNames)
  for (const name of agentNames) {
    assert.equal(readlinkSync(join(f.claude, 'agents', name)), join(f.dest, 'agents', name))
    assert.equal(readFileSync(join(f.claude, 'agents', name), 'utf8'), readFileSync(join(agents, name), 'utf8'))
  }
})
