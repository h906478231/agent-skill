#!/usr/bin/env node
/**
 * 安装脚本：写出托管目录的配置模板与两个 launchd 配置文件（add-autopilot-loop design D13）。
 *
 * 所属：skill openspec-autopilot。调用方：用户在已安装的 skill 副本中手动运行（deployment.md）。
 * 用法：node install.mjs [--write]
 *   不带参数时只打印要写入的文件与 launchctl 命令；--write 才写入，已存在的配置不覆盖。
 * 边界：不运行 launchctl，不填写密钥；飞书凭据由 lark-cli 自己管理（design D2）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { homeDir } from './lib/home.mjs'

/** 本 skill 的目录。 */
const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** launchd 给进程的默认 PATH：只有系统目录，找不到 node、claude、lark-cli（评审 ARCH-01）。 */
const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']

/** 调度脚本的缺省定时间隔（秒），配置中有 intervalSeconds 时用配置的值（design D13）。 */
const DEFAULT_INTERVAL_SECONDS = 300

/** 两个 launchd 配置：标签、模板与脚本。 */
const AGENTS = [
  { label: 'com.openspec.autopilot.scheduler', script: 'scheduler.mjs' },
  { label: 'com.openspec.autopilot.bridge', script: 'bridge.mjs' },
]

/**
 * 在当前 PATH 中找命令所在的目录；找不到时为 null。
 * @param {string} command 命令名或绝对路径。
 * @returns {string|null} 目录。
 */
function commandDir(command) {
  if (!command) return null
  if (path.isAbsolute(command)) return path.dirname(command)
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    if (existsSync(path.join(dir, command))) return dir
  }
  return null
}

/**
 * 组装 launchd 的 PATH：node、claudeBin、larkBin 所在目录在前，系统目录在后（design D13，评审 ARCH-01）。
 * @param {object} config 托管配置（可能是模板）。
 * @returns {string} PATH 值。
 */
function launchdPath(config) {
  const dirs = [path.dirname(process.execPath), commandDir(config.claudeBin || 'claude'), commandDir(config.larkBin || 'lark-cli')]
    .filter(Boolean).filter(dir => !SYSTEM_PATH.includes(dir))
  return [...new Set(dirs), ...SYSTEM_PATH].join(':')
}

/**
 * 把值转成 plist 中的字符串内容（转义 XML 特殊字符）。
 * @param {string} value 原值。
 * @returns {string} 转义后的值。
 */
function xml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 生成一个 launchd 配置文件的内容。
 * @param {object} agent 标签与脚本。
 * @param {object} config 托管配置。
 * @param {string} home 托管目录。
 * @returns {string} plist 内容。
 */
function renderPlist(agent, config, home) {
  const template = readFileSync(path.join(SKILL_DIR, 'templates', `${agent.label}.plist`), 'utf8')
  return template
    .replace(/<NODE_BIN>/g, xml(process.execPath))
    .replace(/<SCRIPT>/g, xml(path.join(SKILL_DIR, 'scripts', agent.script)))
    .replace(/<PATH>/g, xml(launchdPath(config)))
    .replace(/<AUTOPILOT_HOME>/g, xml(home))
    .replace(/<INTERVAL_SECONDS>/g, String(Number(config.intervalSeconds) || DEFAULT_INTERVAL_SECONDS))
}

/** 命令行入口。 */
function main(argv) {
  const write = argv.includes('--write')
  const unknown = argv.filter(arg => arg !== '--write')
  if (unknown.length) {
    process.stderr.write(`不支持的参数：${unknown.join(' ')}\n用法：node install.mjs [--write]\n`)
    return 2
  }
  const home = homeDir()
  const configFile = path.join(home, 'config.json')
  const agentsDir = path.join(homedir(), 'Library', 'LaunchAgents')
  const template = readFileSync(path.join(SKILL_DIR, 'templates', 'config.example.json'), 'utf8')
  // 已有配置时按它生成 PATH 与定时间隔；配置不覆盖（design D13）。
  const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : JSON.parse(template)
  const plists = AGENTS.map(agent => ({ ...agent, file: path.join(agentsDir, `${agent.label}.plist`), content: renderPlist(agent, config, home) }))

  const lines = [write ? '已写入：' : '将写入（加 --write 才写入）：',
    `- ${configFile}${existsSync(configFile) ? '（已存在，不覆盖）' : ''}`,
    ...plists.map(item => `- ${item.file}`), '',
    '加载（填写配置中的 ownerOpenId 与 projects 后由你执行）：',
    ...plists.map(item => `  launchctl bootstrap gui/$(id -u) ${item.file}`),
    '卸载：',
    ...plists.map(item => `  launchctl bootout gui/$(id -u) ${item.file}`)]

  if (write) {
    // 托管目录 0o700、配置 0o600（design D2，评审 SEC-08）。
    mkdirSync(home, { recursive: true, mode: 0o700 })
    if (!existsSync(configFile)) writeFileSync(configFile, template, { mode: 0o600 })
    mkdirSync(agentsDir, { recursive: true })
    for (const item of plists) writeFileSync(item.file, item.content)
  }
  process.stdout.write(`${lines.join('\n')}\n`)
  return 0
}

process.exitCode = main(process.argv.slice(2))
