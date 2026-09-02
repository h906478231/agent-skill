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
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from '@modelcontextprotocol/sdk/types.js'
import { exec } from 'child_process'
import { promisify } from 'util'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

const execAsync = promisify(exec)

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
    return {
      content: [
        {
          type: 'text',
          text: `执行失败: ${error.message}\n\n堆栈:\n${error.stack}`
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

  console.error(`[yunzhou-mcp] 拉取任务 #${task_id}`)

  const { stdout, stderr } = await execAsync(
    `flows-cli task get --task-id ${task_id} --profile ${profile} --json`
  )

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

/**
 * 列出清单任务
 */
async function handleListTasks(args) {
  const { column_id, completion = 'open', limit = 10, profile = 'default' } = args

  console.error(`[yunzhou-mcp] 列出清单任务 (column: ${column_id})`)

  const { stdout, stderr } = await execAsync(
    `flows-cli task list --column-id ${column_id} --completion ${completion} --limit ${limit} --profile ${profile} --json`
  )

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

  console.error(`[yunzhou-mcp] 添加评论到任务 #${task_id}`)

  // 写入临时文件
  const tmpDir = os.tmpdir()
  const tmpFile = path.join(tmpDir, `yunzhou-comment-${task_id}-${Date.now()}.md`)
  await fs.writeFile(tmpFile, content, 'utf-8')

  try {
    const cmd = [
      'flows-cli task comment add',
      `--task-id ${task_id}`,
      `--content-file "${tmpFile}"`,
      external_key ? `--external-key "${external_key}"` : '',
      `--profile ${profile}`,
      '--json'
    ].filter(Boolean).join(' ')

    const { stdout, stderr } = await execAsync(cmd)

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

  console.error(`[yunzhou-mcp] 更新任务 #${task_id}`)

  const params = []
  if (completed !== undefined) {
    params.push(`--completed ${completed}`)
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

  const cmd = [
    'flows-cli task update',
    `--task-id ${task_id}`,
    ...params,
    `--profile ${profile}`,
    '--json'
  ].join(' ')

  const { stdout, stderr } = await execAsync(cmd)

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
 * 读取配置文件
 */
async function handleGetConfig(args) {
  const { project_name } = args

  console.error(`[yunzhou-mcp] 读取配置`)

  const configPath = path.join(os.homedir(), '.yunzhou', 'config.json')

  try {
    const content = await fs.readFile(configPath, 'utf-8')
    const config = JSON.parse(content)

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
            text: JSON.stringify(project, null, 2)
          }
        ]
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(config, null, 2)
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
