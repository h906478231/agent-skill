#!/usr/bin/env node
/**
 * 将仓库与已有安装资产集中到 tigger，维护各工具入口、来源与可恢复的操作记录。
 * 输入为 CLI 参数与 HOME；不访问网络、不读取供应商数据库，也不执行资产代码。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const fail = message => { throw new Error(message) }
const exists = p => { try { fs.lstatSync(p); return true } catch (e) { if (e.code === 'ENOENT') return false; throw e } }
const within = (root, p) => p === root || p.startsWith(`${root}${path.sep}`)
// 只维护这两处的工具入口。opencode 与 Codex 经它们读取普通 skill，其他目录中的已有链接保持原状（ADR-0018）。
const ENTRY_ROOTS = ['.claude', '.agents']
const managedEntry = (home, p) => ENTRY_ROOTS.some(root => within(path.join(home, root), p))
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
// 仅复制资产已引用的配套文件，不把整个仓库、变更产物或缓存作为安装内容。
const supportKey = key => /^(docs|scripts)\//.test(key) || ['README.md', 'CONTEXT.md', 'CLAUDE.md', 'AGENTS.md'].includes(key)
const readJSON = p => JSON.parse(fs.readFileSync(p, 'utf8'))
const names = p => {
  if (!exists(p)) return []
  if (!fs.statSync(p).isDirectory()) fail(`源路径不是目录: ${p}`)
  return fs.readdirSync(p).filter(n => !n.startsWith('.')).sort()
}
const writeJSON = (p, value) => {
  const temporary = `${p}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, p)
}

/** 遍历实体内容但不跟随内部链接，避免摘要与复制越过资产边界。 */
function files(root) {
  const result = []
  function visit(p, relative) {
    const stat = fs.lstatSync(p)
    if (stat.isDirectory()) {
      result.push({ relative, type: 'directory' })
      for (const name of fs.readdirSync(p).sort()) visit(path.join(p, name), relative ? `${relative}/${name}` : name)
    } else if (stat.isSymbolicLink()) result.push({ relative, type: 'link', value: fs.readlinkSync(p) })
    else if (stat.isFile()) result.push({ relative, type: 'file', value: hash(fs.readFileSync(p)), executable: Boolean(stat.mode & 0o111) })
    else fail(`资产包含不支持的文件类型: ${p}`)
  }
  visit(root, '')
  return result
}
const digest = p => hash(JSON.stringify(files(p)))
function snapshot(p) {
  if (!exists(p)) return null
  const stat = fs.lstatSync(p)
  return stat.isSymbolicLink() ? { link: fs.readlinkSync(p) } : { digest: digest(p) }
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** 返回 HOME 到 p 之间第一个是链接或普通文件的路径；都是普通目录时返回 null。 */
function linkedParent(home, p) {
  let current = home
  for (const part of path.relative(home, p).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    if (!exists(current)) continue
    if (fs.lstatSync(current).isSymbolicLink() || !fs.statSync(current).isDirectory()) return current
  }
  return null
}

/** 实际存储与入口的父目录不能是链接；共享 skills 根是唯一允许的目录链接。 */
function plainParents(home, p) {
  const blocked = linkedParent(home, p)
  if (blocked) fail(`目录不能是链接或普通文件: ${blocked}`)
}

function options(args) {
  const result = { mode: 'sync', dry: false, resolutions: null }
  let selected = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--dry-run') result.dry = true
    else if (arg === '--help' || arg === '-h') result.help = true
    else if (arg === '--resolutions') {
      if (!args[++i] || args[i].startsWith('--')) fail('--resolutions 缺少文件路径')
      result.resolutions = path.resolve(args[i])
    } else if (arg === '--expect-plan') {
      result.expectedPlan = args[++i]
      if (!/^sha256:[a-f0-9]{64}$/.test(result.expectedPlan ?? '')) fail('--expect-plan 需要预览输出的 sha256 指纹')
    } else if (['--migrate-legacy', '--check', '--rollback'].includes(arg)) {
      if (selected) fail('执行模式不能同时使用')
      selected = true
      result.mode = { '--migrate-legacy': 'migrate', '--check': 'check', '--rollback': 'rollback' }[arg]
      if (arg === '--rollback') {
        result.run = args[++i]
        if (!result.run || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(result.run)) fail('回滚需要合法的运行编号')
      }
    } else fail(`未知参数: ${arg}（使用 --help 查看用法）`)
  }
  if ((result.dry || result.resolutions) && ['check', 'rollback'].includes(result.mode)) fail('核验或回滚不能使用预览及来源选择参数')
  if (result.expectedPlan && (result.mode !== 'migrate' || result.dry)) fail('--expect-plan 仅用于正式首次迁移')
  return result
}

function help() {
  console.log(`用法: migrate-skills.sh [--dry-run] [--migrate-legacy | --check | --rollback <run-id>] [--resolutions <file>] [--expect-plan <fingerprint>]
无模式参数       手动同步当前仓库到 ~/.tigger，保护较新版本并维护工具入口
--migrate-legacy  以当前仓库为基础合并 ~/.cc-switch（只读）、~/.agents、~/.claude 的已有安装。同名归并，独有资产迁入后建链接
--dry-run         只读预览来源、版本、冲突、备份和入口操作，不创建锁或目录
--resolutions     JSON 对象：目标相对路径到本次候选来源绝对路径。不能绕过防降级
--expect-plan     正式首次迁移必填，使用 --migrate-legacy --dry-run 输出的计划指纹
--check           核验存储与入口，不依赖 cc-switch 运行
--rollback        按 ~/.tigger/.backups/<run-id>/record.json 恢复本次修改
--help            显示帮助
实际目录: ~/.tigger/{skills,commands,agents/claude,workflows}
工具入口: ~/.agents/skills -> ~/.tigger/skills；~/.claude 的 skills、commands、agents、workflows 使用逐项链接。
只维护这两处入口，只发布 Claude Code 格式的 agent。opencode 与 Codex 经这两处读取 skill；
~/.config/opencode 与 ~/.codex 中的已有链接不处理，需要时人工删除。
内置 .system、插件、认证和无关设置保留。工作区修改仅在手动运行时同步。
迁移前退出 cc-switch 和资产更新进程；供应商备份与卸载由用户完成。`)
}

/** 只比较可识别的声明版本；无法比较时交给来源证据或冲突选择，不用时间戳。 */
function version(source, key) {
  if (!key.startsWith('skills/')) return null
  let value
  if (key === 'skills/flows-role-comment') {
    const script = path.join(source, 'scripts/check_update.py')
    if (exists(script)) value = fs.readFileSync(script, 'utf8').match(/^BASE_VERSION\s*=\s*(\d+)\s*$/m)?.[1]
  } else {
    const text = fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8')
    const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]
    value = frontmatter?.match(/^version:\s*["']?(v?\d+(?:\.\d+){0,2})["']?\s*$/m)?.[1]
  }
  return value ? value.replace(/^v/, '').split('.').map(Number) : null
}
function compareVersion(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const delta = (a[i] || 0) - (b[i] || 0)
    if (delta) return Math.sign(delta)
  }
  return 0
}

/** 对未带版本的仓库旧副本比对 Git blob，不检出文件、不修改索引或工作区。 */
function historical(candidate, repositorySource) {
  const relative = path.relative(repo, repositorySource).split(path.sep).join('/')
  try {
    const algorithm = execFileSync('git', ['-C', repo, 'rev-parse', '--show-object-format'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (!['sha1', 'sha256'].includes(algorithm)) return false
    const signature = files(candidate.source).filter(f => f.type !== 'directory').map(f => {
      const content = f.type === 'link' ? Buffer.from(f.value) : fs.readFileSync(path.join(candidate.source, f.relative))
      const oid = crypto.createHash(algorithm).update(`blob ${content.length}\0`).update(content).digest('hex')
      return `${f.type === 'link' ? '120000' : f.executable ? '100755' : '100644'} blob ${oid}\t${relative}${f.relative ? `/${f.relative}` : ''}`
    }).sort().join('\0')
    const commits = execFileSync('git', ['-C', repo, 'log', '--format=%H', '--all', '--', relative], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 }).trim().split('\n').filter(Boolean)
    return commits.some(commit => execFileSync('git', ['-C', repo, 'ls-tree', '-rz', commit, '--', relative], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(Boolean).sort().join('\0') === signature)
  } catch { return false }
}

/** 提取本地相对引用，排除网址、锚点与模板参数，保留带空格的 Markdown 路径。 */
function* localReferences(text) {
  for (const match of text.matchAll(/\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/g)) {
    const raw = (match[1] || match[2]).split('#')[0].split('?')[0]
    if (!raw || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(raw) || /[${}*]/.test(raw)) continue
    let relative
    try { relative = decodeURIComponent(raw) } catch { relative = raw }
    yield [match[0], relative]
  }
}

/** 收集当前仓库与受管安装来源，输出完整只读计划。 */
function plan(home, opt) {
  const target = path.join(home, '.tigger')
  const statePath = path.join(target, '.migration-state.json')
  plainParents(home, target)
  plainParents(home, path.join(target, '.backups'))
  plainParents(home, path.join(home, '.agents'))
  const shared = path.join(home, '.agents/skills')
  if (exists(shared) && fs.lstatSync(shared).isSymbolicLink() && path.resolve(path.dirname(shared), fs.readlinkSync(shared)) !== path.join(target, 'skills')) fail(`共享目录链接指向未知目标: ${shared}`)
  for (const root of ['skills', 'commands', 'workflows', 'agents/claude']) plainParents(home, path.join(target, root))
  for (const kind of ['skills', 'commands', 'agents', 'workflows']) plainParents(home, path.join(home, '.claude', kind))
  if (exists(statePath) && !fs.lstatSync(statePath).isFile()) fail(`配置必须是普通文件: ${statePath}`)
  const stateBefore = snapshot(statePath)
  const state = stateBefore ? readJSON(statePath) : { entries: {} }
  if (!state.entries || typeof state.entries !== 'object' || (state.schema !== undefined && state.schema !== 1)) fail('来源记录格式无法识别')
  if (!exists(path.join(repo, 'skills')) || !fs.statSync(path.join(repo, 'skills')).isDirectory()) fail(`缺少源目录: ${repo}/skills`)
  const candidates = new Map()
  const origins = []
  const logs = []
  const knownRoots = ['.cc-switch', '.agents', '.claude', '.codex', '.config/opencode', '.tigger'].map(p => path.join(home, p)).map(p => exists(p) ? fs.realpathSync(p) : p)
  const resolutions = opt.resolutions ? readJSON(opt.resolutions) : {}
  if (!resolutions || typeof resolutions !== 'object' || Array.isArray(resolutions)) fail('来源选择必须是 JSON 对象')
  function add(key, p, owner, tool = null) {
    if ((!/^(skills|commands|workflows|agents\/claude)\/[A-Za-z0-9_\u0080-￿][^/]*$/.test(key) && !supportKey(key)) || key.split('/').some(part => !part || part === '..' || part === '.') || /[\u0000-\u001f\\]/.test(key)) fail(`非法目标名称: ${key}`)
    if (!exists(p)) fail(`来源不存在: ${p}`)
    let source
    try { source = fs.realpathSync(p) } catch { fail(`来源链接悬空: ${p}`) }
    if (owner !== 'repository' && ![repo, ...knownRoots].some(root => within(root, source))) fail(`来源链接越出声明范围: ${p}`)
    if (key.startsWith('skills/')) {
      const skill = path.join(source, 'SKILL.md')
      if (!exists(skill) || !fs.statSync(skill).isFile() || !fs.readFileSync(skill).length) fail(`SKILL.md 缺失或为空: ${p}`)
    }
    if (key.startsWith('agents/') && (!fs.statSync(source).isFile() || !fs.readFileSync(source).length)) fail(`agent 定义无效: ${p}`)
    if (key.startsWith('workflows/') && key.endsWith('.workflow.js')) {
      const text = fs.readFileSync(source, 'utf8')
      const meta = /^\s*export\s+const\s+meta\s*=/m
      if (!meta.test(text)) fail(`workflow 缺少 export const meta: ${p}`)
      try { new (Object.getPrototypeOf(async function () {}).constructor)('args', 'agent', 'phase', 'log', text.replace(meta, 'const meta =')) } catch { fail(`workflow 语法无效: ${p}`) }
    }
    const entry = { key, source, original: p, owner, digest: digest(source), version: version(source, key) }
    const list = candidates.get(key) || []
    if (!list.some(c => c.original === p && c.owner === owner)) list.push(entry)
    candidates.set(key, list)
    // cc-switch 只作为来源读取：其中的条目不改为链接，也不移入备份。
    if (owner !== 'repository' && !within(target, p) && managedEntry(home, p)) origins.push({ key, path: p, tool })
  }
  function scan(base, kind, owner, tool) {
    for (const name of names(base)) {
      const p = path.join(base, name)
      if (fs.lstatSync(p).isSymbolicLink() && !fs.existsSync(p)) fail(`来源链接悬空: ${p}`)
      if (kind === 'skills' && (!fs.statSync(p).isDirectory() || !exists(path.join(p, 'SKILL.md')))) {
        // 共享目录会整体替换；未知条目不能随备份一起从活动入口消失。
        if (base === shared) fail(`共享 skills 目录有非 skill 条目，请先处理: ${p}`)
        logs.push(`跳过 ${name}: 缺少 SKILL.md`)
        continue
      }
      if (kind === 'agents') {
        if (!/\.(md|toml|yaml|yml)$/.test(name)) continue
        const agentTool = tool || (name.endsWith('.toml') ? 'codex' : /\.ya?ml$/.test(name) || /^mode\s*:/m.test(fs.readFileSync(p, 'utf8')) ? 'opencode' : 'claude')
        // 只发布 Claude Code 格式的定义；opencode 与 Codex 的定义不复制、不建链接。
        if (agentTool !== 'claude') {
          logs.push(`跳过 ${name}: 不是 Claude Code 格式的 agent 定义（${agentTool}）`)
          continue
        }
        add(`agents/claude/${name}`, p, owner, agentTool)
      } else add(`${kind}/${name}`, p, owner, tool)
    }
  }
  scan(path.join(repo, 'skills'), 'skills', 'repository')
  scan(path.join(repo, 'workflow'), 'workflows', 'repository')
  scan(path.join(repo, 'claude/commands'), 'commands', 'repository')
  // 仓库内 opencode 形态只发布给 opencode，不把权限字段作为 Claude 配置。
  scan(path.join(repo, 'claude/agents'), 'agents', 'repository')
  const queue = [...candidates.values()].flat().filter(c => c.owner === 'repository')
  const visited = new Set()
  for (let index = 0; index < queue.length; index++) {
    const entry = queue[index]
    for (const file of files(entry.source)) {
      const source = path.join(entry.source, file.relative)
      if (file.type !== 'file' || !source.endsWith('.md') || visited.has(source)) continue
      visited.add(source)
      const text = fs.readFileSync(source, 'utf8')
      for (const match of localReferences(text)) {
        const dependency = path.resolve(path.dirname(source), match[1])
        if (!within(repo, dependency) || !exists(dependency)) continue
        const relative = path.relative(repo, dependency).split(path.sep).join('/')
        if (!supportKey(relative) && !['docs', 'scripts'].includes(relative)) continue
        for (const item of files(dependency)) {
          if (item.type === 'directory') continue
          const p = path.join(dependency, item.relative)
          const key = path.relative(repo, p).split(path.sep).join('/')
          if (candidates.has(key)) continue
          add(key, p, 'repository')
          queue.push(candidates.get(key)[0])
        }
      }
    }
  }
  // 上次发布的配套文件也参与来源保护，不因引用清单变化而丢失本地修改。
  for (const key of Object.keys(state.entries)) if (supportKey(key) && within(target, path.resolve(target, key)) && exists(path.join(target, key))) add(key, path.join(target, key), 'target')
  for (const kind of ['skills', 'commands', 'workflows']) scan(path.join(target, kind), kind, 'target')
  scan(path.join(target, 'agents/claude'), 'agents', 'target', 'claude')
  if (opt.mode === 'migrate') {
    for (const kind of ['skills', 'commands', 'workflows', 'agents']) scan(path.join(home, '.cc-switch', kind), kind, 'external')
    // 不扫描 ~/.codex 与 ~/.config/opencode：那里只有这两个工具自己读取的内容，脚本不改写。
    for (const [root, tool] of [['.agents', 'shared'], ['.claude', 'claude']]) {
      for (const kind of ['skills', 'commands', 'workflows', 'agents']) {
        if (tool === 'shared' && kind === 'agents') continue
        scan(path.join(home, root, kind), kind, 'external', tool)
      }
    }
    if (exists(shared) && !fs.lstatSync(shared).isSymbolicLink()) {
      for (const name of fs.readdirSync(shared).filter(n => n.startsWith('.'))) {
        // Finder 元数据不是资产；随原目录进入备份，不将其复制到统一安装目录。
        if (name === '.DS_Store' && fs.lstatSync(path.join(shared, name)).isFile()) logs.push('共享目录 .DS_Store 将随原目录进入备份')
        else fail(`共享 skills 目录有隐藏条目，请先处理: ${path.join(shared, name)}`)
      }
    }
  } else if (exists(shared) && !fs.lstatSync(shared).isSymbolicLink()) fail('共享 skills 已有实际目录，请先使用 --migrate-legacy 合并')
  const selected = new Map()
  const stale = []
  const conflicts = []
  for (const [key, list] of candidates) {
    const installed = path.join(target, key)
    plainParents(home, path.dirname(installed))
    if (exists(installed) && fs.lstatSync(installed).isSymbolicLink()) fail(`实际资产不能是链接: ${installed}`)
    const source = list.find(c => c.owner === 'repository')
    const previous = state.repository === repo ? state.entries[key] : null
    if (!source && previous?.owner === 'repository' && exists(path.dirname(previous.source)) && !exists(previous.source) && list.every(c => c.owner === 'target') && list[0].digest === previous.digest) {
      stale.push(key)
      continue
    }
    const versions = list.filter(c => c.version)
    const highest = versions.reduce((best, c) => !best || compareVersion(c.version, best.version) > 0 ? c : best, null)
    let chosen
    if (resolutions[key] !== undefined) {
      chosen = list.find(c => c.original === resolutions[key] || c.source === resolutions[key])
      if (!chosen) fail(`来源选择不是本次候选: ${key}`)
      if (highest && (!chosen.version || compareVersion(chosen.version, highest.version) < 0)) fail(`来源选择会降级或无法证明版本: ${key}`)
    } else {
      const distinct = [...new Set(list.map(c => c.digest))]
      const retained = list.find(c => c.owner === 'target' && previous?.owner === 'external' && previous.digest === c.digest)
      // 相同内容不能改变已确认的外部归属，外部副本自行更新过也一样，否则删除仓库源时会误清理外部副本。
      // 只有 --resolutions 显式选择仓库路径时才转为仓库发布。
      if (distinct.length === 1) chosen = list.find(c => c.owner === 'target' && previous?.owner === 'external') || source || list[0]
      else {
        // 先保留最高声明版本；没有声明的差异仍须通过来源记录或历史确认。
        const pool = highest ? list.filter(c => !c.version || compareVersion(c.version, highest.version) === 0) : list
        const preferred = pool.includes(source) ? source : highest || pool[0]
        if (retained && pool.includes(retained) && (!highest || retained.version) && pool.every(c => c.owner === 'repository' || c.digest === retained.digest)) {
          chosen = retained
        } else if (pool.every(c => c.digest === preferred.digest || (source === preferred && (
          (c.owner === 'target' && previous?.owner === 'repository' && previous.digest === c.digest) ||
          ((c.owner !== 'target' || previous?.owner !== 'external') && historical(c, source.source))
        )))) chosen = preferred
      }
    }
    if (!chosen) {
      conflicts.push(`${key}:\n${list.map(c => `  ${c.original} [${c.version?.join('.') || '版本未知'}] ${c.digest}`).join('\n')}`)
      continue
    }
    const owner = chosen.owner === 'repository' ? 'repository' : chosen.owner === 'target' && previous?.digest === chosen.digest ? previous.owner : 'external'
    selected.set(key, { ...chosen, owner, publishedSource: chosen.owner === 'target' && previous?.owner === owner ? previous.source : chosen.source, target: installed })
    logs.push(`${chosen === source ? '同步当前仓库' : '保留或迁入安装内容'}: ${key} [${chosen.version?.join('.') || '按内容与来源判断'}]`)
  }
  for (const key of Object.keys(resolutions)) if (!candidates.has(key)) fail(`来源选择包含本次范围外的目标: ${key}`)
  if (conflicts.length) {
    if (opt.dry && opt.mode === 'migrate') printCandidates({ target, candidates, selected, stale })
    fail(`同名内容存在未解决冲突，请用 --resolutions 指定保留来源:\n${conflicts.join('\n')}`)
  }
  const links = new Map()
  const originKeys = new Map(origins.map(origin => [origin.path, origin.key]))
  const replacingShared = exists(shared) && !fs.lstatSync(shared).isSymbolicLink()
  function link(p, targetPath) {
    plainParents(home, path.dirname(p))
    const before = snapshot(p)
    // 迁移只接管已扫描为同一资产的入口。共享目录已在枚举时验证全部条目。
    const known = originKeys.get(p) === path.relative(target, targetPath) || (p === shared && replacingShared)
    if (before && (!before.link || path.resolve(path.dirname(p), before.link) !== targetPath) && !known) fail(`入口已有未知内容，请处理冲突: ${p}`)
    links.set(p, targetPath)
  }
  const skillKeys = [...selected.keys()].filter(key => key.startsWith('skills/'))
  link(shared, path.join(target, 'skills'))
  for (const key of skillKeys) link(path.join(home, '.claude', key), path.join(target, key))
  for (const [key, entry] of selected) {
    if (key.startsWith('skills/') || supportKey(key)) continue
    const pieces = key.split('/')
    link(path.join(home, '.claude', pieces[0], pieces.at(-1)), entry.target)
  }
  for (const origin of origins) {
    if (within(shared, origin.path)) continue
    link(origin.path, path.join(target, origin.key))
  }
  for (const key of stale) {
    logs.push(`清理受管残留链接并备份旧副本: ${key}`)
    // 配套文件没有工具入口。
    if (supportKey(key)) continue
    // 旧版日常同步可能丢失兼容入口记录，因此也按约定位置查找链接。
    // 只清理仍指向该受管目标的链接；位置限于两处入口（共享根不含 agents），
    // 其他工具目录与 cc-switch 中的链接由用户处理。父目录为链接的位置不属于本脚本管理，跳过。
    for (const root of ENTRY_ROOTS) {
      if (root === '.agents' && key.startsWith('agents/')) continue
      const entryKey = key.startsWith('agents/') ? `agents/${key.split('/').at(-1)}` : key
      const p = path.join(home, root, entryKey)
      if (!exists(p) || !fs.lstatSync(p).isSymbolicLink() || linkedParent(home, path.dirname(p))) continue
      if (path.resolve(path.dirname(p), fs.readlinkSync(p)) === path.join(target, key)) links.set(p, null)
    }
  }
  // 日常同步不会扫描旧安装，但仍须核验上次记录的兼容入口。
  // 旧记录中两处以外的入口不再维护，跳过：用户人工删除它们与下次同步的先后不影响结果。
  for (const [file, destination] of state.links ?? []) {
    if (destination === null || links.has(file) || !within(target, destination) || !managedEntry(home, file)) continue
    const key = path.relative(target, destination)
    const removing = stale.includes(key)
    if (!removing && !selected.has(key)) continue
    const kind = key.split('/')[0]
    if (!['skills', 'commands', 'agents', 'workflows'].includes(kind) ||
        !ENTRY_ROOTS.some(root => file === path.join(home, root, kind, path.basename(key)))) fail(`来源记录入口越界: ${file}`)
    plainParents(home, path.dirname(file))
    const before = snapshot(file)
    const matches = before?.link && path.resolve(path.dirname(file), before.link) === destination
    if (matches) links.set(file, removing ? null : destination)
    else if (!removing) fail(`入口目标偏离或悬空: ${file}`)
  }
  const linkBefore = new Map([...links].map(([p]) => [p, snapshot(p)]))
  const targetBefore = new Map([...candidates.keys()].map(key => [path.join(target, key), snapshot(path.join(target, key))]))
  return { home, target, statePath, stateBefore, selected, candidates, stale, links, linkBefore, targetBefore, logs }
}

/** 保留各候选的原入口和实际来源，让计划能核对同一实体的多个链接。 */
function candidateRows(p) {
  return [...p.candidates].flatMap(([key, entries]) => entries.map(entry => ({
    ...entry,
    target: path.join(p.target, key),
    action: p.stale.includes(key) ? '清理' : !p.selected.has(key) ? '未解决冲突'
      : p.selected.get(key).original === entry.original ? '采用' : '归并或备份',
  })))
}

function printCandidates(p) {
  console.log('候选来源（每行一个 JSON 对象）:')
  for (const row of candidateRows(p)) console.log(JSON.stringify(row))
}

/** 计划指纹还绑定执行前的入口与来源记录状态。 */
function planFingerprint(p) {
  return `sha256:${hash(JSON.stringify({
    candidates: candidateRows(p),
    selected: [...p.selected],
    links: [...p.links],
    linkBefore: [...p.linkBefore],
    targetBefore: [...p.targetBefore],
    stateBefore: p.stateBefore,
  }))}`
}

/** 暂存时重写可映射的内部链接，并验证迁移不会新增失效的本地 Markdown 引用。 */
function stageAssets(p, stage) {
  const mappings = [...p.candidates].flatMap(([key, list]) => list.map(c => ({ source: c.source, target: path.join(p.target, key) }))).sort((a, b) => b.source.length - a.source.length)
  function mapped(source) {
    const item = mappings.find(m => within(m.source, source))
    return item ? path.join(item.target, path.relative(item.source, source)) : null
  }
  function finalExists(destination) {
    if (!within(p.target, destination)) return exists(destination)
    const relative = path.relative(p.target, destination)
    return exists(path.join(stage, relative))
  }
  for (const [key, entry] of p.selected) {
    const destination = path.join(stage, key)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.cpSync(entry.source, destination, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true })
  }
  for (const [key, entry] of p.selected) {
    for (const file of files(entry.source)) {
      const source = path.join(entry.source, file.relative)
      const staged = path.join(stage, key, file.relative)
      const final = path.join(p.target, key, file.relative)
      if (file.type === 'link') {
        const original = path.resolve(path.dirname(source), file.value)
        const destination = mapped(original)
        if (!destination) fail(`内部链接越出资产范围: ${source}`)
        if (exists(source) && !finalExists(destination)) fail(`迁移会新增失效链接: ${source}`)
        fs.unlinkSync(staged)
        fs.symlinkSync(path.relative(path.dirname(final), destination), staged)
      } else if (file.type === 'file' && source.endsWith('.md')) {
        const text = fs.readFileSync(source, 'utf8')
        for (const match of localReferences(text)) {
          const original = path.resolve(path.dirname(source), match[1])
          if (!exists(original)) { console.log(`历史引用缺失: ${source}: ${match[1]}`); continue }
          const destination = path.resolve(path.dirname(final), match[1])
          if (!finalExists(destination)) fail(`迁移会新增失效引用: ${source}: ${match[1]}`)
        }
      }
    }
  }
}

/** 预览也在 HOME 之外的临时目录完成暂存，让引用与链接校验的结论与正式执行一致。 */
function previewStage(p) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'tigger-preview-'))
  try { stageAssets(p, stage) } finally { fs.rmSync(stage, { recursive: true, force: true }) }
}

function verifyUnchanged(p) {
  for (const list of p.candidates.values()) for (const entry of list) if (!exists(entry.original) || fs.realpathSync(entry.original) !== entry.source || digest(entry.source) !== entry.digest) fail(`来源发生变化，请重新预览: ${entry.original}`)
  for (const [file, before] of [...p.targetBefore, ...p.linkBefore, [p.statePath, p.stateBefore]]) if (!equal(snapshot(file), before)) fail(`入口或配置发生变化，请重新预览: ${file}`)
}

/** 回滚只接触本次登记路径；有后续修改时保留该项并报告，不恢复整份旧配置。 */
function restore(home, root, run, bestEffort = false) {
  const runRoot = path.join(root, '.backups', run)
  const recordPath = path.join(runRoot, 'record.json')
  plainParents(home, runRoot)
  if (!exists(recordPath) || !fs.lstatSync(recordPath).isFile()) fail('找不到普通文件形式的运行记录')
  const record = readJSON(recordPath)
  const allowed = ['.tigger', '.claude/skills', '.claude/commands', '.claude/agents', '.claude/workflows', '.agents/skills', '.agents/commands', '.agents/workflows', '.codex/skills', '.codex/agents', '.codex/commands', '.codex/workflows', '.config/opencode/skills', '.config/opencode/agents', '.config/opencode/commands', '.config/opencode/workflows', '.cc-switch/skills', '.cc-switch/agents', '.cc-switch/commands', '.cc-switch/workflows'].map(p => path.join(home, p))
  if (record.schema !== 1 || record.home !== home || !Array.isArray(record.operations)) fail('运行记录格式或 HOME 不匹配')
  const checks = record.operations.map((op, i) => {
    if (!path.isAbsolute(op.path) || path.normalize(op.path) !== op.path || !allowed.some(base => within(base, op.path)) && op.path !== path.join(home, '.codex/config.toml') || within(path.join(root, '.backups'), op.path) || op.path === root) fail('运行记录含范围外路径')
    plainParents(home, path.dirname(op.path))
    const backup = path.join(runRoot, 'objects', String(i))
    const current = snapshot(op.path)
    const saved = snapshot(backup)
    const untouched = equal(current, op.before) && saved === null
    const safe = untouched || equal(current, op.after) || current === null && equal(saved, op.before)
    return { op, backup, safe, untouched, saved }
  })
  if (!bestEffort && checks.some(c => !c.safe)) fail(`回滚遇到后续修改，未覆盖: ${checks.filter(c => !c.safe).map(c => c.op.path).join(', ')}`)
  const failures = []
  for (const check of checks.reverse()) {
    const { op, backup, safe, untouched, saved } = check
    if (!safe) { failures.push(op.path); continue }
    if (untouched) continue
    try {
      if (!equal(saved, op.before)) fail(`备份内容变化: ${backup}`)
      fs.rmSync(op.path, { recursive: true, force: true })
      if (op.before) { fs.mkdirSync(path.dirname(op.path), { recursive: true }); fs.renameSync(backup, op.path) }
    } catch { failures.push(op.path) }
  }
  record.status = failures.length ? 'recovery-needed' : 'rolled-back'
  writeJSON(recordPath, record)
  if (failures.length) fail(`未恢复项: ${failures.join(', ')}；备份: ${runRoot}`)
  console.log(`已恢复运行: ${run}`)
}

/** 在锁内暂存全部内容，再逐项备份和写入；每次改写前先持久化操作记录。 */
function install(p, opt) {
  let stage
  let run
  let journal
  let journalPath
  const createdRoot = !exists(p.target)
  fs.mkdirSync(p.target, { recursive: true })
  const lock = path.join(p.target, '.migration-lock')
  try { fs.mkdirSync(lock) } catch (e) { if (e.code === 'EEXIST') fail(`已有迁移或遗留锁，请检查: ${lock}`); throw e }
  try {
    const backups = path.join(p.target, '.backups')
    for (const name of names(backups)) {
      const record = path.join(backups, name, 'record.json')
      if (exists(record) && ['running', 'recovery-needed'].includes(readJSON(record).status)) fail(`存在未完成运行，请先 --rollback ${name}`)
    }
    verifyUnchanged(p)
    stage = fs.mkdtempSync(path.join(p.target, '.migration-stage-'))
    stageAssets(p, stage)
    verifyUnchanged(p)
    run = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`
    const runRoot = path.join(backups, run)
    fs.mkdirSync(path.join(runRoot, 'objects'), { recursive: true, mode: 0o700 })
    journalPath = path.join(runRoot, 'record.json')
    journal = { schema: 1, home: p.home, status: 'running', operations: [] }
    writeJSON(journalPath, journal)
    function replace(destination, value) {
      const before = snapshot(destination)
      const after = value === null ? null : value.link ? { link: value.link } : snapshot(value.file)
      if (equal(before, after)) return
      plainParents(p.home, path.dirname(destination))
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      const index = journal.operations.length
      journal.operations.push({ path: destination, before, after })
      writeJSON(journalPath, journal)
      if (before) fs.renameSync(destination, path.join(runRoot, 'objects', String(index)))
      if (value?.link) fs.symlinkSync(value.link, destination)
      else if (value?.file) fs.renameSync(value.file, destination)
    }
    const entries = {}
    for (const [key, entry] of p.selected) {
      const staged = path.join(stage, key)
      const contentDigest = digest(staged)
      replace(entry.target, { file: staged })
      entries[key] = { owner: entry.owner, source: entry.publishedSource, digest: contentDigest, sourceDigest: entry.digest, version: entry.version }
    }
    for (const key of p.stale) replace(path.join(p.target, key), null)
    fs.mkdirSync(path.join(p.target, 'skills'), { recursive: true })
    for (const [file, target] of p.links) replace(file, target === null ? null : { link: target })
    let commit = null
    let dirty = null
    try {
      commit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      dirty = Boolean(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim())
    } catch { /* 非 Git 副本没有提交号，实际来源仍由摘要表示。 */ }
    const stagedState = path.join(stage, 'state.json')
    writeJSON(stagedState, { schema: 1, repository: repo, commit, dirty, run, entries, links: [...p.links] })
    replace(p.statePath, { file: stagedState })
    check(p.home)
    journal.status = 'complete'
    writeJSON(journalPath, journal)
    console.log(`迁移完成。运行编号: ${run}\n备份与操作记录: ${runRoot}`)
  } catch (error) {
    if (journal?.operations.length) {
      try { restore(p.home, p.target, run, true) } catch (recovery) { console.error(recovery.message) }
    } else if (journalPath) { journal.status = 'rolled-back'; writeJSON(journalPath, journal) }
    throw error
  } finally {
    if (stage) fs.rmSync(stage, { recursive: true, force: true })
    fs.rmdirSync(lock)
    if (createdRoot && !fs.readdirSync(p.target).length) fs.rmdirSync(p.target)
  }
}

/** 核验当前内容能被工具发现；第三方更新后的摘要不与迁移时的摘要锁定比较。 */
function check(home) {
  const root = path.join(home, '.tigger')
  plainParents(home, root)
  const statePath = path.join(root, '.migration-state.json')
  if (!exists(statePath) || !fs.lstatSync(statePath).isFile()) fail('缺少来源记录，请先同步或迁移')
  const state = readJSON(statePath)
  if (state.schema !== 1 || !state.entries || !Array.isArray(state.links)) fail('来源记录格式无法识别')
  for (const key of Object.keys(state.entries)) {
    const p = path.resolve(root, key)
    if (!within(root, p) || p === root) fail('来源记录目标越界')
    plainParents(home, path.dirname(p))
    if (!exists(p) || fs.lstatSync(p).isSymbolicLink()) fail(`实际内容缺失或不是实体: ${p}`)
    const skill = path.join(p, 'SKILL.md')
    // 空文件或非普通文件的 SKILL.md 无法被工具加载，核验不能判为通过。
    if (key.startsWith('skills/') && (!fs.existsSync(skill) || !fs.statSync(skill).isFile() || fs.statSync(skill).size === 0)) fail(`skill 的 SKILL.md 缺失、为空或不是普通文件: ${p}`)
  }
  for (const [file, target] of state.links) {
    if (!within(home, file)) fail('来源记录入口越界')
    // 旧记录中 cc-switch 与其他工具目录的入口不再维护，可由用户删除；只核验两处入口。
    if (!managedEntry(home, file)) continue
    if (target === null) { if (exists(file)) fail(`已替代入口重新出现: ${file}`); continue }
    if (!exists(file) || !fs.lstatSync(file).isSymbolicLink() || path.resolve(path.dirname(file), fs.readlinkSync(file)) !== target || !fs.existsSync(file)) fail(`入口目标偏离或悬空: ${file}`)
  }
  const shared = path.join(home, '.agents/skills')
  if (!exists(shared) || !fs.lstatSync(shared).isSymbolicLink() || path.resolve(path.dirname(shared), fs.readlinkSync(shared)) !== path.join(root, 'skills')) fail('共享 skills 入口未指向 tigger')
  for (const name of names(path.join(root, 'skills'))) {
    if (!fs.statSync(path.join(root, 'skills', name)).isDirectory() || !exists(path.join(root, 'skills', name, 'SKILL.md'))) continue
    const p = path.join(home, '.claude/skills', name)
    if (!exists(p) || !fs.lstatSync(p).isSymbolicLink() || path.resolve(path.dirname(p), fs.readlinkSync(p)) !== path.join(root, 'skills', name)) fail(`普通 skill 尚未补齐工具入口: ${p}`)
  }
  for (const tool of ENTRY_ROOTS) {
    for (const kind of ['skills', 'commands', 'workflows', 'agents']) {
      for (const name of names(path.join(home, tool, kind))) {
        const p = path.join(home, tool, kind, name)
        if (fs.lstatSync(p).isSymbolicLink() && within(path.join(home, '.cc-switch'), path.resolve(path.dirname(p), fs.readlinkSync(p)))) fail(`仍有指向 cc-switch 的入口: ${p}`)
      }
    }
  }
  console.log('文件与入口核验通过；真实工具加载、第三方远程更新仍需部署验收。')
}

try {
  const opt = options(process.argv.slice(2))
  if (opt.help) help()
  else {
    const home = process.env.HOME
    if (!home || !path.isAbsolute(home) || !fs.existsSync(home) || !fs.statSync(home).isDirectory()) fail('HOME 必须是已存在的绝对目录')
    if (opt.mode === 'check') check(home)
    else if (opt.mode === 'rollback') {
      const root = path.join(home, '.tigger')
      plainParents(home, root)
      const lock = path.join(root, '.migration-lock')
      fs.mkdirSync(lock)
      try { restore(home, root, opt.run) } finally { fs.rmdirSync(lock) }
    } else {
      const p = plan(home, opt)
      const fingerprint = opt.mode === 'migrate' ? planFingerprint(p) : null
      if (fingerprint && !opt.dry) {
        if (!opt.expectedPlan) fail('正式迁移需要 --expect-plan，先运行 --migrate-legacy --dry-run')
        if (opt.expectedPlan !== fingerprint) fail('迁移计划发生变化，请重新预览并确认')
      }
      console.log(`迁移来源: ${repo}\n目标目录: ${p.target}`)
      for (const line of p.logs) console.log(line)
      console.log(`共 ${[...p.selected.keys()].filter(k => k.startsWith('skills/')).length} skills；入口操作 ${p.links.size} 项`)
      if (opt.dry) {
        previewStage(p)
        if (fingerprint) {
          printCandidates(p)
          console.log(`计划指纹: ${fingerprint}`)
        }
        console.log('预览完成，未写入任何文件。')
      } else install(p, opt)
    }
  }
} catch (error) {
  console.error(`错误: ${error.message}`)
  process.exitCode = 1
}
