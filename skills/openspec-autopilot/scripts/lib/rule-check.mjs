/**
 * 启动前核对：读取已加载设置来源中的允许规则与 hook，以及 skill、命令、subagent 文件头中的授权（design D4）。
 *
 * 所属：skill openspec-autopilot。调用方：scheduler.mjs。
 * 职责：列出与 allowedCommands 之外的条目、给出所在文件；结果写入 rule-check.json，结果不变时不再发卡片。
 * 边界：只读；不修改用户的设置文件，也不代替用户清理条目（design D4「不通过」的处理方式）。
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

/** 允许出现在允许规则中的工具名：只读工具与本 skill 的 MCP 工具（design D4「启动前核对」）。 */
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob'])

/**
 * 扫描时跳过的目录名（design D4：嵌套的 skills 扫描排除 node_modules、.git 与 .claude/worktrees）。
 * 不按名称跳过 worktrees：项目中其他名为 worktrees 的目录照常扫描（quality R1 SPEC-08）。
 * .claude/worktrees 不需要列在这里：遍历遇到 .claude 时只扫描其中的 skills/，不进入 worktrees/。
 */
const SKIP_DIRS = new Set(['node_modules', '.git'])

/** 文件头中的 hook 类型：这两类会跳过权限宿主（design D4，评审 SEC-01、SEC-09）。 */
const BLOCKING_HOOKS = ['PreToolUse', 'PermissionRequest']

/**
 * 读取 JSON 文件。读不到或格式错误时返回 null，并让调用方按「解析失败不通过」处理。
 * @param {string} file 文件路径。
 * @returns {object|null} 解析出的对象。
 */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 解析文件头：第一对 --- 之间的内容。
 * @param {string} text 文件内容。
 * @returns {string|null} 文件头文本；没有文件头时为 null。
 */
export function frontMatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  return match ? match[1] : null
}

/**
 * 去掉条目两端成对的引号。
 * @param {string} text 条目文本。
 * @returns {string} 去掉引号后的文本。
 */
function unquote(text) {
  return text.replace(/^(['"])(.*)\1$/, '$2')
}

/**
 * 按逗号或空白拆分 allowed-tools 的单行写法。括号内的空格与逗号不拆开：Bash(git status:*) 是一条规则。
 * @param {string} text 单行值。
 * @returns {string[]} 条目。
 */
function splitTools(text) {
  const items = []
  let current = ''
  let depth = 0
  for (const char of text) {
    if (char === '(') depth += 1
    if (char === ')') depth = Math.max(0, depth - 1)
    if (depth === 0 && (char === ',' || /\s/.test(char))) {
      if (current.trim()) items.push(unquote(current.trim()))
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) items.push(unquote(current.trim()))
  return items.filter(Boolean)
}

/**
 * 读出文件头中的 allowed-tools。支持三种写法：单行逗号或空格分隔、行内列表 [a, b]、YAML 块列表（- a）。
 * 只认单行逗号写法时，YAML 列表被读成一个错误的条目，清单外的工具不会被报出（quality R1 SPEC-08）。
 * @param {string} matter 文件头文本。
 * @returns {string[]|null} 允许规则列表；没有这个键时为空数组；写了键却解析不出条目时为 null，调用方按不通过处理。
 */
function allowedToolsOf(matter) {
  const lines = matter.split(/\r?\n/)
  const index = lines.findIndex(line => /^allowed-tools\s*:/.test(line))
  if (index < 0) return []
  const inline = lines[index].replace(/^allowed-tools\s*:/, '').trim()
  if (inline) {
    const body = inline.startsWith('[') && inline.endsWith(']') ? inline.slice(1, -1) : inline
    const items = splitTools(body)
    return items.length ? items : null
  }
  const items = []
  for (const line of lines.slice(index + 1)) {
    const match = /^\s+-\s*(.*)$/.exec(line)
    if (!match) break
    const item = unquote(match[1].trim())
    if (item) items.push(item)
  }
  return items.length ? items : null
}

/**
 * 判断文件头中是否有阻塞性的 hook。
 * @param {string} matter 文件头文本。
 * @returns {boolean} 有 PreToolUse 或 PermissionRequest 时为 true。
 */
function hasBlockingHook(matter) {
  // hook 类型在 YAML 里是缩进的子键，行首可能有空格（design D4 的文件头示例）。
  return BLOCKING_HOOKS.some(type => new RegExp(`(^|\\n)\\s*${type}\\s*:`).test(matter))
}

/**
 * 判断一条允许规则是否在允许清单中。
 * @param {string} rule 允许规则。
 * @param {Set<string>} commands 项目的 allowedCommands。
 * @returns {boolean} 在清单中时为 true。
 */
function ruleAllowed(rule, commands) {
  if (READ_TOOLS.has(rule)) return true
  if (rule.startsWith('mcp__autopilot__')) return true
  return commands.has(rule)
}

/**
 * 列出一个目录下的全部文件（递归），跟随软链接并按真实路径去重。
 * @param {string} dir 目录。
 * @param {Set<string>} visited 已访问的真实目录。
 * @returns {string[]} 文件路径。
 */
function listFiles(dir, visited = new Set()) {
  if (!existsSync(dir)) return []
  let real
  try {
    real = realpathSync(dir)
  } catch {
    return []
  }
  if (visited.has(real)) return []
  visited.add(real)
  const files = []
  for (const item of readdirSync(dir)) {
    const child = path.join(dir, item)
    let info
    try {
      info = statSync(child)
    } catch {
      continue
    }
    if (info.isDirectory()) files.push(...listFiles(child, visited))
    else files.push(child)
  }
  return files
}

/**
 * 收集要扫描的文件头文件路径：用户级与项目级的 skill、命令、subagent（design D4「启动前核对」）。
 * @param {string} home 用户主目录。
 * @param {string} projectRoot 项目根目录。
 * @returns {string[]} 文件路径。
 */
function headerFiles(home, projectRoot) {
  const files = []
  const user = path.join(home, '.claude')
  for (const file of listFiles(path.join(user, 'skills'))) {
    if (path.basename(file) === 'SKILL.md') files.push(file)
  }
  for (const file of listFiles(path.join(user, 'commands'))) {
    if (file.endsWith('.md')) files.push(file)
  }
  for (const file of listFiles(path.join(user, 'agents'))) {
    if (file.endsWith('.md')) files.push(file)
  }
  const project = path.join(projectRoot, '.claude')
  for (const sub of ['skills', 'commands', 'agents']) {
    for (const file of listFiles(path.join(project, sub))) {
      if (file.endsWith('.md')) files.push(file)
    }
  }
  // 项目根下嵌套的 skills 目录，跳过 node_modules、.git 与 .claude/worktrees（design D4）。
  const stack = [projectRoot]
  while (stack.length) {
    const dir = stack.pop()
    let items
    try {
      items = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const item of items) {
      if (!item.isDirectory()) continue
      if (SKIP_DIRS.has(item.name)) continue
      const child = path.join(dir, item.name)
      if (item.name === '.claude') {
        const skillDir = path.join(child, 'skills')
        for (const file of listFiles(skillDir)) {
          if (path.basename(file) === 'SKILL.md') files.push(file)
        }
        continue
      }
      stack.push(child)
    }
  }
  return [...new Set(files)]
}

/**
 * 检查一个设置文件中的允许规则与 hook。
 * @param {string} file 设置文件路径。
 * @param {Set<string>} commands 项目的 allowedCommands。
 * @returns {string[]} 不通过的条目说明。
 */
function checkSettings(file, commands) {
  const issues = []
  if (!existsSync(file)) return issues
  const content = readJson(file)
  // 解析失败时不通过（design D4「文件不存在或没有这些键时通过，JSON 解析失败时不通过」）。
  if (!content) return [`设置文件无法解析：${file}`]
  const allow = (content.permissions && content.permissions.allow) || []
  for (const rule of allow) {
    if (!ruleAllowed(rule, commands)) issues.push(`${file}：允许规则 ${rule}`)
  }
  const additional = (content.permissions && content.permissions.additionalDirectories) || []
  if (additional.length) {
    for (const dir of additional) issues.push(`${file}：additionalDirectories ${dir}`)
  }
  const hooks = content.hooks || {}
  for (const type of BLOCKING_HOOKS) {
    if (hooks[type]) issues.push(`${file}：${type} hook`)
  }
  if (content.disableAllHooks === true) issues.push(`${file}：disableAllHooks`)
  return issues
}

/**
 * 检查一个文件头中的 allowed-tools 与 hook。
 * @param {string} file 文件路径。
 * @param {Set<string>} commands 项目的 allowedCommands。
 * @returns {string[]} 不通过的条目说明。
 */
function checkHeader(file, commands) {
  const issues = []
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return [`文件无法读取：${file}`]
  }
  const matter = frontMatter(text)
  if (!matter) return issues
  if (hasBlockingHook(matter)) issues.push(`${file}：文件头中的 hook`)
  // 只能由用户手动调用的 skill 不检查 allowed-tools：agent 不能自行调用它（design D4）。
  if (/disable-model-invocation:\s*true/.test(matter)) return issues
  const tools = allowedToolsOf(matter)
  // 解析不出条目时不通过：与设置文件「解析失败不通过」一致（design D4）。
  if (tools === null) {
    issues.push(`${file}：allowed-tools 无法解析`)
    return issues
  }
  for (const rule of tools) {
    if (!ruleAllowed(rule, commands)) issues.push(`${file}：allowed-tools ${rule}`)
  }
  return issues
}

/**
 * 检查 skill 目录中的插件清单：这类目录会连同其中的 hook、agent 与 MCP 一起加载（design D4，评审 SEC-13）。
 * @param {string} home 用户主目录。
 * @returns {string[]} 不通过的条目说明。
 */
function checkPluginDirs(home) {
  const issues = []
  for (const dir of [path.join(home, '.claude', 'skills'), path.join(home, '.claude', 'skills', 'synced')]) {
    if (!existsSync(dir)) continue
    for (const item of readdirSync(dir)) {
      const plugin = path.join(dir, item, '.claude-plugin')
      if (existsSync(plugin)) issues.push(`${plugin}：skill 目录带插件清单`)
    }
  }
  return issues
}

/**
 * 对一个项目做启动前核对。
 * @param {string} home 用户主目录。
 * @param {string} projectRoot 项目根目录。
 * @param {string[]} allowedCommands 项目的允许命令清单。
 * @returns {string[]} 不通过的条目说明；为空表示通过。
 */
export function checkProject(home, projectRoot, allowedCommands) {
  const commands = new Set(allowedCommands)
  const issues = [
    ...checkSettings(path.join(home, '.claude', 'settings.json'), commands),
    ...checkSettings(path.join(projectRoot, '.claude', 'settings.json'), commands),
    ...checkPluginDirs(home),
  ]
  for (const file of headerFiles(home, projectRoot)) {
    issues.push(...checkHeader(file, commands))
    // 扫描到的每个 skill 目录都检查插件清单，不只是用户级的（spec autopilot-scheduler 第 3 条，quality R1 SPEC-08）。
    if (path.basename(file) === 'SKILL.md') {
      const plugin = path.join(path.dirname(file), '.claude-plugin')
      if (existsSync(plugin)) issues.push(`${plugin}：skill 目录带插件清单`)
    }
  }
  // 用户级 skill 目录会被两处检查报出：按文本去重。
  return [...new Set(issues)]
}
