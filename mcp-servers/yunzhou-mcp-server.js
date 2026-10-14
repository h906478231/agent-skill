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

// flows-cli 输出缓冲上限：单任务详情实测约 50KB，清单模式 limit=100 实测约 0.3MB，
// 留出 8MB 上限以保证含长描述或评论较多的读取不会被默认的 1MB 限制打断
const MAX_CLI_OUTPUT_BYTES = 8 * 1024 * 1024

/**
 * 归一化 flows-cli 返回的错误信息
 *
 * CLI 的 JSON envelope 里 error 是对象（{ code, message }），直接拼进模板串会得到 "[object Object]"，
 * 因此这里显式取出 message 与 code；同时兼容返回纯字符串错误的历史形态。
 *
 * @param {*} error envelope 的 error 字段
 * @returns {string} 可直接展示给调用方的错误描述
 */
function formatCliError(error) {
  if (!error) {
    return '未知错误'
  }
  if (typeof error === 'string') {
    return error
  }
  const message = error.message || '未知错误'
  return error.code === undefined ? message : `${message}（错误码 ${error.code}）`
}

/**
 * 解析 flows-cli 的 JSON 输出
 *
 * @param {string} text 子进程 stdout
 * @returns {object|null} envelope 对象；不是合法 JSON 对象时返回 null
 */
function parseCliEnvelope(text) {
  if (!text) {
    return null
  }
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 执行 flows-cli 并返回 JSON envelope
 *
 * CLI 的业务失败（任务不存在、参数非法等）同样会输出 `{ ok:false, error:{ code, message } }`，
 * 但退出码是 1，execFile 因此抛异常并把 envelope 留在 error.stdout 上。
 * 这里统一回收 stdout 中的 envelope，避免调用方只看到 "Command failed" 这类无信息量的报错。
 *
 * @param {string[]} cliArgs 命令行参数（不含可执行文件名），调用方负责先完成参数校验
 * @returns {Promise<object>} CLI 的 JSON envelope；输出无法解析时返回合成的错误 envelope
 */
async function runCliJson(cliArgs) {
  let stdout
  let stderr
  try {
    // maxBuffer 显式放宽：execFile 默认 1MB，而清单模式 limit=100 的任务列表实测约 0.3MB、
    // 含长描述的清单会突破默认上限并抛 ERR_CHILD_PROCESS_STDIO_MAXBUFFER，导致读取直接失败
    ;({ stdout, stderr } = await execFileAsync('flows-cli', cliArgs, { maxBuffer: MAX_CLI_OUTPUT_BYTES }))
  } catch (error) {
    if (error.stderr) {
      console.error(`[yunzhou-mcp] stderr: ${error.stderr}`)
    }
    const envelope = parseCliEnvelope(error.stdout)
    return envelope || { ok: false, error: { message: error.message } }
  }

  if (stderr) {
    console.error(`[yunzhou-mcp] stderr: ${stderr}`)
  }

  return parseCliEnvelope(stdout) || { ok: false, error: { message: '无法解析 flows-cli 输出' } }
}

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
          completion: {
            type: 'string',
            description: '任务完成状态（closed 为兼容别名，等同 completed）',
            enum: ['open', 'completed', 'closed', 'all'],
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

  // 参数以数组传递，外部输入不会被 shell 解释为命令；CLI 的业务错误由 runCliJson 统一还原
  const response = await runCliJson([
    'task', 'get',
    '--task-id', String(taskId),
    '--profile', String(profile),
    '--json'
  ])

  if (!response.ok) {
    return {
      content: [
        {
          type: 'text',
          text: `拉取任务失败: ${formatCliError(response.error)}`
        }
      ],
      isError: true
    }
  }

  // CLI 契约：envelope 的 data 是聚合对象（project / task / placements / comments 等），任务本体在 data.task
  const task = response.data?.task

  if (!task) {
    return {
      content: [
        {
          type: 'text',
          text: '拉取任务失败: 响应中缺少 task 数据'
        }
      ],
      isError: true
    }
  }

  // 任务所在的清单（看板列）由 placements 提供：任务本体没有 column_id / column_title 字段
  const placement = Array.isArray(task.placements) ? task.placements[0] : undefined

  // 提取并格式化任务信息
  const taskInfo = {
    id: task.id,
    title: task.title,
    description: task.description || '',
    priority: task.priority || '普通',
    type: inferTaskType(task),
    project_id: placement?.projectId,
    column_id: placement?.columnId,
    column_title: placement?.columnTitle,
    assignee: task.assigneeName || '未分配',
    created_at: task.createdAt,
    completed_at: task.completedAt,
    completed: isTaskCompleted(task)
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
 * 归一化 task list 返回的 tasks 字段
 *
 * CLI 契约：task list 的 tasks 字段可能是以任务 ID 为键的对象（清单模式的实际返回），也可能是数组；
 * 两种形态都必须能遍历，否则对象形态直接调用 map 会抛 "map is not a function"。
 *
 * @param {*} tasks response.data.tasks
 * @returns {Array<object>} 任务数组；字段缺失或类型非预期时返回空数组
 */
function normalizeTaskList(tasks) {
  if (Array.isArray(tasks)) {
    return tasks
  }
  if (tasks && typeof tasks === 'object') {
    return Object.values(tasks)
  }
  return []
}

/**
 * 判断任务是否已完成
 *
 * CLI 不返回 completed 布尔字段，只返回完成时间与完成人，因此以 completedAt 是否存在为准。
 *
 * @param {object} task 任务对象（task get / task list 返回的形态）
 * @returns {boolean} 是否已完成
 */
function isTaskCompleted(task) {
  return task.completedAt !== undefined && task.completedAt !== null
}

// 列表任务返回数量限制，与 yunzhou_list_tasks 工具 schema 中的 minimum/maximum 保持一致，避免出现魔法值
const MIN_TASK_LIMIT = 1
const MAX_TASK_LIMIT = 100

/**
 * 列出清单任务
 */
async function handleListTasks(args) {
  const { column_id, completion = 'open', limit = 10, profile = 'default' } = args

  // column_id 为必填：CLI 的项目模式（--project-id）不支持分页与完成状态过滤，会一次性返回项目全部任务，
  // 结果既会撑爆子进程 stdout 缓冲区，也会灌满模型上下文，因此本工具只提供清单模式
  if (String(column_id ?? '').length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: '必须指定 column_id'
        }
      ],
      isError: true
    }
  }

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

  // CLI 只接受 open|completed|all；closed 是早期 schema 中的写法，归一化为 completed，避免历史调用直接报参数错误
  const cliCompletion = completion === 'closed' ? 'completed' : String(completion)

  console.error(`[yunzhou-mcp] 列出清单 ${column_id} 的任务`)

  // 参数以数组传递，外部输入不会被 shell 解释为命令；CLI 的业务错误由 runCliJson 统一还原
  const response = await runCliJson([
    'task', 'list',
    '--column-id', String(column_id),
    '--completion', cliCompletion,
    '--limit', String(taskLimit),
    '--profile', String(profile),
    '--json'
  ])

  if (!response.ok) {
    return {
      content: [
        {
          type: 'text',
          text: `列出任务失败: ${formatCliError(response.error)}`
        }
      ],
      isError: true
    }
  }

  const tasks = normalizeTaskList(response.data?.tasks).map(task => ({
    id: task.id,
    title: task.title,
    priority: task.priority || '普通',
    type: inferTaskType(task),
    assignee: task.assigneeName || '未分配',
    completed: isTaskCompleted(task)
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

    // 业务错误由 runCliJson 统一还原，避免只剩 "Command failed" 这类无信息量的报错
    const response = await runCliJson(cliArgs)

    if (!response.ok) {
      return {
        content: [
          {
            type: 'text',
            text: `添加评论失败: ${formatCliError(response.error)}`
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

  // 参数以数组传递，外部输入不会被 shell 解释为命令；业务错误由 runCliJson 统一还原
  const response = await runCliJson(cliArgs)

  if (!response.ok) {
    return {
      content: [
        {
          type: 'text',
          text: `更新任务失败: ${formatCliError(response.error)}`
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
