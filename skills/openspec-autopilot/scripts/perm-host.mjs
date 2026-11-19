#!/usr/bin/env node
/**
 * 权限宿主：MCP 服务，只有一个工具 approve，一律拒绝并写明下一步怎么做。
 *
 * 所属：skill openspec-autopilot。调用方：调度脚本用 --permission-prompt-tool mcp__autopilot__approve 挂载。
 * 输入：标准输入的 MCP JSON-RPC 消息。输出：标准输出的 MCP JSON-RPC 响应。
 * 存在原因：claude -p 只在配置了权限宿主时提供 AskUserQuestion（实验 1）。
 * 边界：只读环境变量与调用参数，只写托管目录的日志；不执行命令、不改文件（design D8）。
 */

import { readFileSync } from 'node:fs'
import { appendLog } from './lib/home.mjs'

/** 命令与路径在拒绝消息中的最大长度（design D8）。 */
const MESSAGE_LIMIT = 120

/** 日志中命令的最大长度（design D8，实验 4）。 */
const LOG_LIMIT = 200

/**
 * 读出标准输入的全部内容。
 * @returns {string} 输入文本。
 */
function readInput() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 截断文本并加省略号。
 * @param {string} text 原文。
 * @param {number} limit 最大长度。
 * @returns {string} 截断后的文本。
 */
function cut(text, limit) {
  const value = String(text ?? '')
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

/**
 * 取工具调用的参数：兼容参数放在 arguments 或 params 两种形状。
 * @param {object} params MCP 调用参数。
 * @returns {{ toolName: string, input: object }} 工具名与工具输入。
 */
function callArguments(params) {
  const args = (params && params.arguments) || (params && params.input) || {}
  const toolName = args.tool_name || args.toolName || ''
  const input = args.input || args.tool_input || args
  return { toolName, input }
}

/**
 * 生成拒绝消息（design D8）。
 * @param {string} toolName 工具名。
 * @param {object} input 工具输入。
 * @returns {string} 拒绝消息。
 */
function denyMessage(toolName, input) {
  if (toolName === 'AskUserQuestion') {
    // 并行调用时 defer 不生效，提问落到权限宿主：要求 agent 单独调用这一轮（design D8）。
    return '托管不允许并行调用：这一轮只调用 AskUserQuestion，不要同时调用其他工具。'
  }
  if (toolName === 'Bash') {
    const command = cut(input && input.command, MESSAGE_LIMIT)
    const allowed = process.env.AUTOPILOT_ALLOWED_COMMANDS || ''
    return `托管不允许这条命令：${command}。Bash 没有被整体禁用，以下命令前缀可以直接运行：${allowed}。`
      + '每次只运行一条命令，不用 cd、管道、;、&& 连接；读文件用 Read，搜索用 Grep 与 Glob。不要因为这条拒绝询问用户。'
  }
  const filePath = cut(input && (input.file_path || input.notebook_path || input.path), MESSAGE_LIMIT)
  return `托管不允许：${toolName} ${filePath}。不要因为这条拒绝询问用户，换一种允许的方式继续。`
}

/** 处理一条 MCP 消息。 */
function handle(message) {
  if (!message || message.method !== 'tools/call') return null
  const { toolName, input } = callArguments(message.params)
  const command = toolName === 'Bash' ? cut(input && input.command, LOG_LIMIT) : ''
  // 日志只记命令的前 200 个字符，不记整行事件与回调 token（design D2、D8）。
  appendLog('perm-host', 'permission', { tool: toolName, command })
  const messageText = denyMessage(toolName, input)
  return {
    jsonrpc: '2.0',
    id: message.id,
    result: {
      content: [{ type: 'text', text: messageText }],
      structuredContent: { behavior: 'deny', message: messageText },
      isError: true,
    },
  }
}

/** 主流程：逐行读入 MCP 消息并写回响应。 */
function main() {
  const input = readInput()
  for (const line of input.split('\n')) {
    const text = line.trim()
    if (!text) continue
    let message
    try {
      message = JSON.parse(text)
    } catch {
      continue
    }
    const response = handle(message)
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`)
  }
}

main()
