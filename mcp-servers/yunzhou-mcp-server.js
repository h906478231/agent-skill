#!/usr/bin/env node

/**
 * 云舟 MCP 服务器
 * 为 OpenCode 提供云舟平台集成工具
 *
 * 提供的工具：
 * - yunzhou_fetch_task: 拉取任务详情
 * - yunzhou_list_tasks: 列出清单任务
 * - yunzhou_add_comment: 添加任务评论
 * - yunzhou_update_task: 更新任务状态
 * - yunzhou_get_config: 读取云舟配置（返回前自动过滤敏感字段）
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from '@modelcontextprotocol/sdk/types.js'
import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

// 用 execFile（参数以数组传递、不经过 shell）替代 exec，避免外部可控参数被 shell 解析造成命令注入
const execFileAsync = promisify(execFile)

// 创建 MCP 服务器
const server = new Server(
  {
    name: 'yunzhou-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
)

// 工具定义
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'yunzhou_fetch_task',
      description: '从云舟拉取指定任务的详细信息',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: {
            type: 'number',
            description: '云舟任务 ID'
          },
          profile: {
            type: 'string',
            description: 'flows-cli profile 名称',
            default: 'default'
          }
        },
        required: ['task_id']
      }
    },
    {
      name: 'yunzhou_list_tasks',
      description: '从云舟清单拉取任务列表',
      inputSchema: {
        type: 'object',
        properties: {
          column_id: {
            type: 'string',
            description: '清单 ID'
          },
          project_id: {
            type: 'string',
            description: '项目 ID（可选）'
          },
          completion: {
            type: 'string',
            description: '任务完成状态',
            enum: ['open', 'closed', 'all'],
            default: 'open'
          },
          limit: {
            type: 'number',
            description: '返回任务数量限制',
            default: 10,
            minimum: 1,
            maximum: 100
          },
          profile: {
            type: 'string',
            description: 'flows-cli profile 名称',
            default: 'default'
          }
        },
        required: ['column_id']
      }
    },
    {
      name: 'yunzhou_add_comment',
      description: '向云舟任务添加评论',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: {
            type: 'number',
            description: '云舟任务 ID'
          },
          content: {
            type: 'string',
            description: '评论内容（支持 Markdown）'
          },
          external_key: {
            type: 'string',
            description: '外部唯一标识（可选，用于幂等性）'
          },
          profile: {
            type: 'string',
            description: 'flows-cli profile 名称',
            default: 'default'
          }
        },
        required: ['task_id', 'content']
      }
    },
    {
      name: 'yunzhou_update_task',
      description: '更新云舟任务状态',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: {
            type: 'number',
            description: '云舟任务 ID'
          },
          completed: {
            type: 'boolean',
            description: '是否标记为完成'
          },
          profile: {
            type: 'string',
            description: 'flows-cli profile 名称',
            default: 'default'
          }
        },
        required: ['task_id']
      }
    },
    {
      name: 'yunzhou_get_config',
      description: '读取云舟配置文件',
      inputSchema: {
        type: 'object',
        properties: {
          project_name: {
            type: 'string',
            description: '项目名称（可选，返回该项目配置）'
          }
        }
      }
    }
  ]
}))

// 工具实现
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    switch (name) {
      case 'yunzhou_fetch_task':
        return await handleFetchTask(args)

      case 'yunzhou_list_tasks':
        return await handleListTasks(args)

      case 'yunzhou_add_comment':
        return await handleAddComment(args)

      case 'yunzhou_update_task':
        return await handleUpdateTask(args)

      case 'yunzhou_get_config':
        return await handleGetConfig(args)

      default:
        return {
          content: [
            {
              type: 'text',
              text: `未知工具: ${name}`
            }
          ],
          isError: true
        }
    }
  } catch (error) {
    // 错误堆栈只写 stderr 日志（stdio MCP 约定使用 console.error），不返回给模型，避免泄露内部路径等实现细节
    console.error(`[yunzhou-mcp] 执行失败: ${error.message}`)
    console.error(error.stack)
    return {
      content: [
        {
          type: 'text',
          text: `执行失败: ${error.message}`
        }
      ],
      isError: true
    }
  }
})

/**
 * 拉取任务详情
 */
async function handleFetchTask(args) {
  const { task_id, profile = 'default' } = args

  // 数值型参数显式校验：task_id 必须是正整数，非法值直接返回错误响应，不进入命令行
  const taskId = Number(task_id)
  if (!Number.isInteger(taskId) || taskId <= 0) {
    return {
      content: [
        {
          type: 'text',
          text: `非法的任务 ID: ${task_id}（应为正整数）`
        }
      ],
      isError: true
    }
  }

  console.error(`[yunzhou-mcp] 拉取任务 #${taskId}`)

  let result
  try {
    // 参数以数组传递，外部输入不会被 shell 解释为命令
    result = await execFileAsync('flows-cli', [
      'task', 'get',
      '--task-id', String(taskId),
      '--profile', String(profile),
      '--json'
    ])
  } catch (error) {
    // execFile 失败时子进程 stderr 挂在错误对象上，先保留原有 stderr 日志，再抛给上层统一返回错误响应
    if (error.stderr) {
      console.error(`[yunzhou-mcp] stderr: ${error.stderr}`)
    }
    throw error
  }

  const { stdout, stderr } = result

  if (stderr) {
    console.error(`[yunzhou-mcp] stderr: ${stderr}`)
  }

  const response = JSON.parse(stdout)

  if (!response.ok) {
    return {
      content: [
        {
          type: 'text',
          text: `拉取任务失败: ${response.error || '未知错误'}`
        }
      ],
      isError: true
    }
  }

  const task = response.data

  // 提取并格式化任务信息
  const taskInfo = {
    id: task.id,
    title: task.title,
    description: task.content || task.description || '',
    priority: task.priority || 'medium',
    type: inferTaskType(task),
    column_id: task.column_id,
    column_title: task.column_title,
    assignee: task.assignee?.name || '未分配',
    created_at: task.created_at,
    updated_at: task.updated_at,
    completed: task.completed || false
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(taskInfo, null, 2)
      }
    ]
  }
}

// 列表任务返回数量限制，与 yunzhou_list_tasks 工具 schema 中的 minimum/maximum 保持一致，避免出现魔法值
const MIN_TASK_LIMIT = 1
const MAX_TASK_LIMIT = 100

/**
 * 列出清单任务
 */
async function handleListTasks(args) {
  const { column_id, completion = 'open', limit = 10, profile = 'default' } = args

  // 数值型参数显式校验：limit 必须是 1~100 的整数（与工具 schema 的 minimum/maximum 一致），非法值直接返回错误响应
  const taskLimit = Number(limit)
  if (!Number.isInteger(taskLimit) || taskLimit < MIN_TASK_LIMIT || taskLimit > MAX_TASK_LIMIT) {
    return {
      content: [
        {
          type: 'text',
          text: `非法的 limit: ${limit}（应为 ${MIN_TASK_LIMIT}~${MAX_TASK_LIMIT} 之间的整数）`
        }
      ],
      isError: true
    }
  }

  console.error(`[yunzhou-mcp] 列出清单任务 (column: ${column_id})`)

  let result
  try {
    // 参数以数组传递，外部输入不会被 shell 解释为命令
    result = await execFileAsync('flows-cli', [
      'task', 'list',
      '--column-id', String(column_id),
      '--completion', String(completion),
      '--limit', String(taskLimit),
      '--profile', String(profile),
      '--json'
    ])
  } catch (error) {
    // execFile 失败时子进程 stderr 挂在错误对象上，先保留原有 stderr 日志，再抛给上层统一返回错误响应
    if (error.stderr) {
      console.error(`[yunzhou-mcp] stderr: ${error.stderr}`)
    }
    throw error
  }

  const { stdout, stderr } = result

  if (stderr) {
    console.error(`[yunzhou-mcp] stderr: ${stderr}`)
  }

  const response = JSON.parse(stdout)

  if (!response.ok) {
    return {
      content: [
        {
          type: 'text',
          text: `列出任务失败: ${response.error || '未知错误'}`
        }
      ],
      isError: true
    }
  }

  const tasks = (response.data.tasks || []).map(task => ({
    id: task.id,
    title: task.title,
    priority: task.priority || 'medium',
    type: inferTaskType(task),
    assignee: task.assignee?.name || '未分配',
    completed: task.completed || false
  }))

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          total: tasks.length,
          tasks
        }, null, 2)
      }
    ]
  }
}

/**
 * 添加评论
 */
async function handleAddComment(args) {
  const { task_id, content, external_key, profile = 'default' } = args

  // 数值型参数显式校验：task_id 必须是正整数，非法值直接返回错误响应，不进入命令行
  const taskId = Number(task_id)
  if (!Number.isInteger(taskId) || taskId <= 0) {
    return {
      content: [
        {
          type: 'text',
          text: `非法的任务 ID: ${task_id}（应为正整数）`
        }
      ],
      isError: true
    }
  }

  console.error(`[yunzhou-mcp] 添加评论到任务 #${taskId}`)

  // 写入临时文件
  const tmpDir = os.tmpdir()
  // taskId 已归一化为整数，拼接出的文件名不会包含路径分隔符，避免路径穿越
  const tmpFile = path.join(tmpDir, `yunzhou-comment-${taskId}-${Date.now()}.md`)
  await fs.writeFile(tmpFile, content, 'utf-8')

  try {
    // 参数以数组传递，不再经过 shell，因此临时文件路径和外键都不需要手工加引号
    const cliArgs = [
      'task', 'comment', 'add',
      '--task-id', String(taskId),
      '--content-file', tmpFile
    ]
    // external_key 为可选参数，仅在显式传入时追加，保持与原命令参数顺序和语义一致
    if (external_key) {
      cliArgs.push('--external-key', String(external_key))
    }
    cliArgs.push('--profile', String(profile), '--json')

    let result
    try {
      result = await execFileAsync('flows-cli', cliArgs)
    } catch (error) {
      // execFile 失败时子进程 stderr 挂在错误对象上，先保留原有 stderr 日志，再抛给上层统一返回错误响应
      if (error.stderr) {
        console.error(`[yunzhou-mcp] stderr: ${error.stderr}`)
      }
      throw error
    }

    const { stdout, stderr } = result

    if (stderr) {
      console.error(`[yunzhou-mcp] stderr: ${stderr}`)
    }

    const response = JSON.parse(stdout)

    if (!response.ok) {
      return {
        content: [
          {
            type: 'text',
            text: `添加评论失败: ${response.error || '未知错误'}`
          }
        ],
        isError: true
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: `✅ 评论已添加到任务 #${task_id}`
        }
      ]
    }
  } finally {
    // 清理临时文件
    try {
      await fs.unlink(tmpFile)
    } catch (err) {
      console.error(`[yunzhou-mcp] 清理临时文件失败: ${err.message}`)
    }
  }
}

/**
 * 更新任务状态
 */
async function handleUpdateTask(args) {
  const { task_id, completed, profile = 'default' } = args

  // 数值型参数显式校验：task_id 必须是正整数，非法值直接返回错误响应，不进入命令行
  const taskId = Number(task_id)
  if (!Number.isInteger(taskId) || taskId <= 0) {
    return {
      content: [
        {
          type: 'text',
          text: `非法的任务 ID: ${task_id}（应为正整数）`
        }
      ],
      isError: true
    }
  }

  console.error(`[yunzhou-mcp] 更新任务 #${taskId}`)

  const params = []
  if (completed !== undefined) {
    // 保持原命令的字符串化语义（true/false 原样透传），不做布尔归一化，避免改变调用方传入的取值
    params.push('--completed', String(completed))
  }

  if (params.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: '未指定任何更新参数'
        }
      ],
      isError: true
    }
  }

  const cliArgs = [
    'task', 'update',
    '--task-id', String(taskId),
    ...params,
    '--profile', String(profile),
    '--json'
  ]

  let result
  try {
    // 参数以数组传递，外部输入不会被 shell 解释为命令
    result = await execFileAsync('flows-cli', cliArgs)
  } catch (error) {
    // execFile 失败时子进程 stderr 挂在错误对象上，先保留原有 stderr 日志，再抛给上层统一返回错误响应
    if (error.stderr) {
      console.error(`[yunzhou-mcp] stderr: ${error.stderr}`)
    }
    throw error
  }

  const { stdout, stderr } = result

  if (stderr) {
    console.error(`[yunzhou-mcp] stderr: ${stderr}`)
  }

  const response = JSON.parse(stdout)

  if (!response.ok) {
    return {
      content: [
        {
          type: 'text',
          text: `更新任务失败: ${response.error || '未知错误'}`
        }
      ],
      isError: true
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: `✅ 任务 #${task_id} 已更新`
      }
    ]
  }
}

/**
 * 匹配疑似凭据的字段名（不区分大小写）
 * 采用黑名单式键名匹配做兜底，因为配置结构可能变化，白名单式过滤容易失效
 */
const SENSITIVE_FIELD_PATTERN = /token|secret|password|passwd|credential|cookie|auth|apikey|api_key/i

/**
 * 递归过滤对象/数组中的敏感字段
 *
 * @param {*} value 待过滤的任意 JSON 值
 * @returns {*} 过滤后的副本；命中敏感键名的字段会整条丢弃，其余结构保持不变
 */
function filterSensitiveFields(value) {
  if (Array.isArray(value)) {
    return value.map(filterSensitiveFields)
  }

  if (value !== null && typeof value === 'object') {
    const filtered = {}
    for (const [key, item] of Object.entries(value)) {
      // 命中敏感键名则整条丢弃，避免令牌、密钥等凭据进入模型上下文
      if (SENSITIVE_FIELD_PATTERN.test(key)) {
        continue
      }
      filtered[key] = filterSensitiveFields(item)
    }
    return filtered
  }

  return value
}

/**
 * 读取配置文件
 */
async function handleGetConfig(args) {
  const { project_name } = args

  console.error(`[yunzhou-mcp] 读取配置`)

  const configPath = path.join(os.homedir(), '.yunzhou', 'config.json')

  try {
    const content = await fs.readFile(configPath, 'utf-8')
    const config = JSON.parse(content)

    // 防御性过滤：返回给模型前递归剔除键名疑似凭据的字段。
    // 原因：~/.yunzhou/config.json 目前虽只有普通配置，但 CLI 后续版本可能把 token/secret 等凭据写入同一文件，
    // 模型上下文不应包含这类敏感信息，因此在这里做统一兜底。
    const safeConfig = filterSensitiveFields(config)

    if (project_name) {
      const project = config.projects?.find(p => p.name === project_name)
      if (!project) {
        return {
          content: [
            {
              type: 'text',
              text: `未找到项目: ${project_name}`
            }
          ],
          isError: true
        }
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(filterSensitiveFields(project), null, 2)
          }
        ]
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(safeConfig, null, 2)
        }
      ]
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `读取配置失败: ${error.message}`
        }
      ],
      isError: true
    }
  }
}

/**
 * 推断任务类型
 */
function inferTaskType(task) {
  const title = (task.title || '').toLowerCase()
  const desc = (task.content || task.description || '').toLowerCase()
  const text = `${title} ${desc}`

  if (text.includes('fix') || text.includes('修复') || text.includes('bug')) {
    return 'bug'
  }
  if (text.includes('优化') || text.includes('improve') || text.includes('refactor') || text.includes('重构')) {
    return 'optimization'
  }
  return 'feature'
}

// 启动服务器
const transport = new StdioServerTransport()
server.connect(transport)

console.error('云舟 MCP 服务器已启动')
console.error('提供的工具:')
console.error('  - yunzhou_fetch_task')
console.error('  - yunzhou_list_tasks')
console.error('  - yunzhou_add_comment')
console.error('  - yunzhou_update_task')
console.error('  - yunzhou_get_config')
