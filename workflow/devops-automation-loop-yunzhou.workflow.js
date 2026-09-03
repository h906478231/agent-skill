export const meta = {
  name: 'devops-automation-loop-yunzhou',
  description: '云舟全流程自动化：从云舟拉取任务 → 分析 → OpenSpec开发 → 提交 → 回写状态',
  phases: [
    { title: 'Fetch', detail: '从云舟拉取待办任务' },
    { title: 'Analyze', detail: '需求分析与可行性评估' },
    { title: 'Develop', detail: 'OpenSpec 工作流开发' },
    { title: 'Commit', detail: '代码提交与验证' },
    { title: 'Sync', detail: '回写状态到云舟' },
  ],
}

// 配置参数
// args:
//   {
//     profile: 'default',                      // 云舟 CLI profile 名称（可选）
//     projectId: '<project-id>',              // 云舟项目ID（可选，未指定则使用默认项目）
//     projectName: '<project-name>',          // 项目名称（可选，用于按名称选择项目）
//     taskId: <task-id>,                      // 指定任务ID（可选，不指定则自动拉取）
//     columnId: '<column-id>',                // 从指定清单拉取任务（可选）
//     autoCommit: true,                       // 是否自动提交代码（默认false需人工确认）
//     skipAnalysis: false,                    // 跳过需求分析（默认false）
//   }

// 辅助函数：清理 agent 返回的 JSON 内容（去除 markdown 代码块）
function cleanJsonResponse(text) {
  if (!text) return text
  // 去除 markdown 代码块标记
  let cleaned = text.trim()
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.substring(7)
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.substring(3)
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.substring(0, cleaned.length - 3)
  }
  return cleaned.trim()
}

// 从全局配置文件加载默认值
// 直接通过 agent 读取配置文件（使用 Bash cat 命令确保返回纯文本）
const configContent = await agent(
  '执行命令读取云舟配置文件，返回纯 JSON 内容（不要添加任何说明文字）：cat ~/.yunzhou/config.json 2>/dev/null || echo "FILE_NOT_FOUND"',
  { label: 'read-yunzhou-config' }
)

let config = null
let defaultProject = null

// 解析配置文件
try {
  const trimmedContent = configContent.trim()
  if (trimmedContent && trimmedContent !== 'FILE_NOT_FOUND') {
    config = JSON.parse(cleanJsonResponse(trimmedContent))
    log('✓ 成功加载云舟配置文件')
  } else {
    log('⚠️  配置文件不存在：~/.yunzhou/config.json')
  }
} catch (e) {
  log(`❌ 配置文件解析失败: ${e.message}`)
  log(`   原始内容: ${configContent.substring(0, 200)}...`)
}

// 优先使用参数中的配置
let selectedProjectId = args && args.projectId

// 如果提供了项目名称但未提供 projectId，从配置文件中查找
if (!selectedProjectId && args && args.projectName && config && config.projects) {
  const projectByName = config.projects.find(p => p.name === args.projectName)
  if (projectByName) {
    selectedProjectId = projectByName.projectId
    defaultProject = projectByName
    log(`✓ 按名称找到项目：${args.projectName}`)
  } else {
    log(`⚠️  未找到名为 "${args.projectName}" 的项目`)
  }
}

// 如果还没有 projectId，从配置文件读取默认项目
if (!selectedProjectId && config && config.defaultProjectId) {
  selectedProjectId = config.defaultProjectId
  log(`✓ 使用默认项目ID：${selectedProjectId}`)
}

// 查找项目配置
if (selectedProjectId && config && config.projects) {
  defaultProject = config.projects.find(p => p.projectId === selectedProjectId)
  if (defaultProject) {
    log(`使用项目配置：${defaultProject.name}`)
  }
}

const profile = (args && args.profile) || (config && config.yunzhou && config.yunzhou.profile) || 'default'
let projectId = (args && args.projectId) || (defaultProject && defaultProject.projectId)
const taskId = args && args.taskId
const columnId = (args && args.columnId) || (defaultProject && defaultProject.defaultColumnId)
const autoCommit = (args && args.autoCommit) !== undefined ? args.autoCommit : (config && config.workflow && config.workflow.autoCommit) || false
const skipAnalysis = (args && args.skipAnalysis) !== undefined ? args.skipAnalysis : (config && config.workflow && config.workflow.skipAnalysis) || false

// 验证必需参数
if (!projectId) {
  log('❌ 错误：未指定项目ID，且未找到默认项目配置')
  log('')
  log('调试信息：')
  log(`  配置文件存在: ${config ? '是' : '否'}`)
  log(`  配置中的默认项目ID: ${config && config.defaultProjectId ? config.defaultProjectId : '未设置'}`)
  log(`  参数 projectId: ${args && args.projectId ? args.projectId : '未指定'}`)
  log(`  参数 projectName: ${args && args.projectName ? args.projectName : '未指定'}`)
  log(`  defaultProject: ${defaultProject ? defaultProject.name : '未找到'}`)
  log('')
  log('解决方法：')
  log('  1. 运行 ./setup-yunzhou-config.sh 配置项目')
  log('  2. 或在调用时明确指定项目：')
  log('     workflow("devops-automation-loop-yunzhou", {')
  log('       projectName: "Lokra",')
  log('       taskId: ' + (taskId || '<task-id>'))
  log('     })')
  log('')
  return { status: 'failed', reason: 'missing_project_id' }
}
// ============================================================
// 确定代码仓库路径
// ============================================================

log('【代码仓库配置检查】')

// 调试信息：显示当前配置状态
log(`调试信息：`)
log(`  args.codeRepo: ${args && args.codeRepo ? args.codeRepo : '未指定'}`)
log(`  defaultProject: ${defaultProject ? defaultProject.name : '未找到'}`)
log(`  defaultProject.codeRepo: ${defaultProject && defaultProject.codeRepo ? defaultProject.codeRepo : '未配置'}`)
log('')

const codeRepo = (args && args.codeRepo) || (defaultProject && defaultProject.codeRepo)

if (!codeRepo) {
  log('❌ 错误：未指定代码仓库路径')
  log('')
  log('代码仓库路径用于指定在哪个目录中执行开发和 Git 提交操作。')
  log('')

  // 根据当前状态给出更精确的指引
  if (!defaultProject) {
    log('⚠️  当前问题：未找到项目配置')
    log('')
    log('可能的原因：')
    log('  1. 配置文件 ~/.yunzhou/config.json 不存在或解析失败')
    log('  2. 配置文件中没有项目配置')
    log('  3. 指定的项目ID或项目名称不匹配')
    log('')
  } else {
    log(`⚠️  当前问题：项目 "${defaultProject.name}" 未配置代码仓库路径`)
    log('')
  }

  log('解决方法：')
  log('')
  log('方式 1：在配置文件中为项目配置代码仓库路径')
  log('  运行：./setup-yunzhou-config.sh')
  if (defaultProject) {
    log('  选择：2. 修改已有项目')
    log(`  项目：${defaultProject.name}`)
  } else {
    log('  选择：1. 添加新项目 或 2. 修改已有项目')
  }
  log('  然后输入代码仓库的绝对路径（例如：/Users/your-name/projects/your-repo）')
  log('')
  log('方式 2：在调用工作流时指定 codeRepo 参数')
  log('  workflow("devops-automation-loop-yunzhou", {')
  if (defaultProject) {
    log('    projectId: "' + projectId + '",')
  } else {
    log('    projectName: "<your-project-name>",')
  }
  if (taskId) {
    log('    taskId: ' + taskId + ',')
  }
  log('    codeRepo: "/absolute/path/to/your/project"')
  log('  })')
  log('')

  return {
    status: 'failed',
    reason: 'missing_code_repo',
    debug: {
      hasConfig: config !== null,
      hasDefaultProject: defaultProject !== null,
      projectId: projectId,
      configPath: '~/.yunzhou/config.json'
    }
  }
}

log(`✓ 代码仓库配置：${codeRepo}`)
log('')

// 验证代码仓库路径（假设相对路径是相对于当前工作目录）
// 如果是绝对路径直接使用，如果是相对路径则假设已提供完整路径
let absoluteCodeRepo = codeRepo

// 通过 agent 检查代码仓库是否存在且为 Git 仓库
const repoCheckResult = await agent(
  `检查目录 ${absoluteCodeRepo} 是否存在且是 Git 仓库。执行以下命令：
1. 检查目录是否存在：ls -d ${absoluteCodeRepo}
2. 检查是否为 Git 仓库：test -d ${absoluteCodeRepo}/.git && echo "is_git_repo" || echo "not_git_repo"

返回 JSON 格式：{"exists": true/false, "isGitRepo": true/false}`,
  { label: 'check-code-repo' }
)

let repoCheck
try {
  repoCheck = JSON.parse(repoCheckResult)
} catch (e) {
  log(`❌ 错误：无法验证代码仓库状态`)
  return { status: 'failed', reason: 'repo_check_failed' }
}

if (!repoCheck.exists) {
  log(`❌ 错误：代码仓库路径不存在：${absoluteCodeRepo}`)
  log('请检查路径是否正确')
  return { status: 'failed', reason: 'code_repo_not_found', codeRepo: absoluteCodeRepo }
}

if (!repoCheck.isGitRepo) {
  log(`❌ 错误：${absoluteCodeRepo} 不是 Git 仓库`)
  log('请确保该目录已初始化为 Git 仓库：')
  log(`  cd ${absoluteCodeRepo}`)
  log('  git init')
  return { status: 'failed', reason: 'not_a_git_repo', codeRepo: absoluteCodeRepo }
}

log(`✅ 使用代码仓库：${absoluteCodeRepo}`)
log('')

// Schema 定义
const TASK_SCHEMA = {
  type: 'object',
  required: ['id', 'title', 'type', 'description', 'priority'],
  properties: {
    id: { type: 'number' },
    title: { type: 'string' },
    type: { type: 'string', enum: ['feature', 'optimization', 'bug'] },
    description: { type: 'string' },
    priority: { type: 'string', enum: ['urgent', 'high', 'medium', 'low'] },
    acceptanceCriteria: { type: 'string' },
    technicalContext: { type: 'string' },
    columnId: { type: 'string' },
    columnTitle: { type: 'string' },
  }
}

const ANALYSIS_SCHEMA = {
  type: 'object',
  required: ['feasible', 'estimatedComplexity', 'risks', 'recommendation'],
  properties: {
    feasible: { type: 'boolean' },
    estimatedComplexity: { type: 'string', enum: ['trivial', 'simple', 'medium', 'complex', 'epic'] },
    risks: { type: 'array', items: { type: 'string' } },
    missingInfo: { type: 'array', items: { type: 'string' } },
    recommendation: { type: 'string', enum: ['proceed', 'clarify', 'reject'] },
    clarificationNeeded: { type: 'string' },
  }
}

const COMMIT_SCHEMA = {
  type: 'object',
  required: ['branch', 'commitMessage', 'filesChanged', 'testsPassed'],
  properties: {
    branch: { type: 'string' },
    commitMessage: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    testsPassed: { type: 'boolean' },
    prUrl: { type: 'string' },
  }
}

// ============================================================
// Phase 0: 项目匹配预检查（可选）
// ============================================================

// 如果指定了 taskId 但未指定项目，记录警告
let projectMismatchWarning = false
if (taskId && !args.projectId && !args.projectName) {
  log('⚠️  提示：指定任务ID但未指定项目，将使用默认项目')
  log(`   默认项目：${defaultProject ? defaultProject.name : '无'}`)
  log(`   任务ID：${taskId}`)
  log('')
  log('建议：明确指定项目以避免代码提交到错误的仓库')
  log('  workflow("devops-automation-loop-yunzhou", {')
  log('    projectName: "<任务所属项目>",')
  log('    taskId: ' + taskId)
  log('  })')
  log('')
  projectMismatchWarning = true
}

// ============================================================
// Phase 1: 从云舟拉取任务
// ============================================================

phase('Fetch')

const task = await agent(
  [
    `你是云舟 (Flows) 平台集成 Agent。`,
    ``,
    `任务：从云舟拉取待办任务`,
    `Profile：${profile}`,
    projectId ? `项目ID：${projectId}` : ``,
    taskId ? `指定任务ID：${taskId}` : `自动拉取：从${columnId ? '清单' : '我的待办'}中选择一个任务`,
    columnId ? `清单ID：${columnId}` : ``,
    ``,
    `执行步骤：`,
    ``,
    `1. 使用 flows-cli 拉取任务`,
    taskId ? [
      `   - 获取指定任务：`,
      `     flows-cli task get --task-id ${taskId} --profile ${profile} --json`,
    ].join('\n') : columnId ? [
      `   - 从指定清单拉取任务列表：`,
      `     flows-cli task list --column-id ${columnId} --completion open --limit 10 --profile ${profile} --json`,
      `   - 选择优先级最高的未完成任务（优先级顺序：最高 > 较高 > 普通 > 较低）`,
    ].join('\n') : [
      `   - 从"我的待办"拉取任务：`,
      `     flows-cli me tasks --profile ${profile} --json`,
      `   - 选择优先级最高的未完成任务`,
    ].join('\n'),
    ``,
    `2. 解析任务内容，提取以下信息：`,
    `   - 任务类型：根据任务标题和描述判断`,
    `     * feature: 新功能、新特性`,
    `     * optimization: 优化、改进、重构`,
    `     * bug: 缺陷修复、问题修复`,
    `   - 优先级映射：`,
    `     * 最高 → urgent`,
    `     * 较高 → high`,
    `     * 普通 → medium`,
    `     * 较低 → low`,
    `   - 验收标准：从任务描述中提取或标注"未明确"`,
    `   - 技术上下文：从任务描述、评论、附件中提取相关技术信息`,
    `   - 清单信息：记录任务所在清单的 ID 和标题`,
    ``,
    `3. 返回结构化任务信息`,
    ``,
    `重要提示：`,
    `- 所有 flows-cli 命令必须加 --json 参数`,
    `- 先检查退出码，再解析 JSON 中的 ok 字段`,
    `- 如果 API 调用失败，返回 null`,
    `- 任务 ID 是正整数，其他 ID 是不透明字符串`,
  ].join('\n'),
  { label: 'fetch-yunzhou-task', phase: 'Fetch', schema: TASK_SCHEMA }
)

if (!task) {
  log('拉取任务失败，流程终止')
  return { status: 'failed', reason: 'task_fetch_failed' }
}

log(`已拉取任务 #${task.id}：[${task.type}] ${task.title} (优先级: ${task.priority})`)
if (task.columnTitle) {
  log(`任务所在清单：${task.columnTitle}`)
}
log('')

// ============================================================
// 项目匹配校验：确保任务所属项目与配置的代码仓库匹配
// ============================================================

log('【项目匹配校验】')
log('检查任务所属项目是否与代码仓库配置匹配...')
log('')

// 1. 尝试从任务的清单ID推断项目
let taskBelongsToProject = null
if (config && config.projects && task.columnId) {
  taskBelongsToProject = config.projects.find(p =>
    p.columns && p.columns.some(col => col.id === task.columnId)
  )

  if (taskBelongsToProject) {
    log(`✓ 根据清单ID识别任务所属项目：${taskBelongsToProject.name}`)
  } else {
    log(`⚠️  无法从清单ID推断任务所属项目（清单ID: ${task.columnId}）`)
    log(`   提示：运行 ./setup-yunzhou-config.sh 确保项目配置包含完整的清单信息`)
  }
}

// 2. 对比当前使用的项目配置
log(`当前使用的项目配置：${defaultProject ? defaultProject.name : '无'} (${projectId})`)
log(`当前使用的代码仓库：${absoluteCodeRepo}`)
log('')

// 3. 检测项目不匹配
if (taskBelongsToProject && taskBelongsToProject.projectId !== projectId) {
  log('🔴 警告：检测到项目不匹配！')
  log('─────────────────────────────────────')
  log(`任务所属项目：${taskBelongsToProject.name}`)
  log(`当前使用项目：${defaultProject.name}`)
  log('')
  log(`任务的代码仓库应该是：${taskBelongsToProject.codeRepo || '未配置'}`)
  log(`当前使用的代码仓库：${absoluteCodeRepo}`)
  log('')
  log('❌ 风险：如果继续执行，代码将提交到错误的仓库！')
  log('')

  // 检查是否配置了自动切换
  const autoSwitch = config && config.workflow && config.workflow.autoSwitchProject !== false

  if (autoSwitch && taskBelongsToProject.codeRepo) {
    log('✅ 自动切换到任务所属项目（autoSwitchProject: true）')
    log('')

    // 切换项目配置
    defaultProject = taskBelongsToProject
    projectId = taskBelongsToProject.projectId
    const newCodeRepo = taskBelongsToProject.codeRepo

    // 验证新的代码仓库（通过 agent 检查）
    const newRepoCheckResult = await agent(
      `检查目录 ${newCodeRepo} 是否存在且是 Git 仓库。执行以下命令：
1. 检查目录是否存在：ls -d ${newCodeRepo}
2. 检查是否为 Git 仓库：test -d ${newCodeRepo}/.git && echo "is_git_repo" || echo "not_git_repo"

返回 JSON 格式：{"exists": true/false, "isGitRepo": true/false}`,
      { label: 'check-switched-repo' }
    )

    let newRepoCheck
    try {
      newRepoCheck = JSON.parse(newRepoCheckResult)
    } catch (e) {
      log(`❌ 错误：无法验证新代码仓库状态`)
      return { status: 'failed', reason: 'repo_check_failed' }
    }

    if (!newRepoCheck.exists) {
      log(`❌ 错误：任务所属项目的代码仓库路径不存在：${newCodeRepo}`)
      return {
        status: 'failed',
        reason: 'task_project_code_repo_not_found',
        taskProject: taskBelongsToProject.name,
        codeRepo: newCodeRepo
      }
    }

    if (!newRepoCheck.isGitRepo) {
      log(`❌ 错误：${newCodeRepo} 不是 Git 仓库`)
      return {
        status: 'failed',
        reason: 'task_project_not_git_repo',
        taskProject: taskBelongsToProject.name,
        codeRepo: newCodeRepo
      }
    }

    // 切换成功
    absoluteCodeRepo = newCodeRepo
    log(`✅ 已切换代码仓库：${absoluteCodeRepo}`)
    log('')
  } else {
    // 不自动切换，终止流程
    log('解决方法：')
    log('')
    log('方式 1：明确指定正确的项目')
    log('  workflow("devops-automation-loop-yunzhou", {')
    log(`    projectName: "${taskBelongsToProject.name}",`)
    log(`    taskId: ${task.id}`)
    log('  })')
    log('')
    log('方式 2：启用自动项目切换')
    log('  编辑 ~/.yunzhou/config.json，添加：')
    log('  "workflow": {')
    log('    "autoSwitchProject": true')
    log('  }')
    log('')

    return {
      status: 'failed',
      reason: 'project_mismatch',
      task,
      expectedProject: {
        id: taskBelongsToProject.projectId,
        name: taskBelongsToProject.name,
        codeRepo: taskBelongsToProject.codeRepo
      },
      actualProject: {
        id: projectId,
        name: defaultProject.name,
        codeRepo: absoluteCodeRepo
      }
    }
  }
} else if (taskBelongsToProject && taskBelongsToProject.projectId === projectId) {
  log('✅ 项目匹配验证通过')
  log(`   任务和代码仓库都属于项目：${defaultProject.name}`)
  log('')
} else {
  log('⚠️  无法验证项目匹配（缺少清单信息）')
  log('   建议：运行 ./setup-yunzhou-config.sh 更新项目配置')
  log('')

  if (projectMismatchWarning) {
    log('⚠️  由于指定了任务ID但未指定项目，请手动确认：')
    log(`   任务 #${task.id} 是否属于项目：${defaultProject.name}`)
    log(`   代码是否应该提交到：${absoluteCodeRepo}`)
    log('')
  }
}

// ============================================================
// Phase 2: 需求分析
// ============================================================

phase('Analyze')

let analysis = null

if (!skipAnalysis) {
  analysis = await agent(
    [
      `你是需求分析 Agent，评估任务的可行性与复杂度。`,
      ``,
      `任务信息：`,
      JSON.stringify(task, null, 2),
      ``,
      `分析维度：`,
      `1. 需求完整性：描述是否清晰？验收标准是否明确？`,
      `2. 技术可行性：现有技术栈能否支持？有无技术债务阻塞？`,
      `3. 复杂度评估：`,
      `   - trivial: 10分钟内完成的简单修改`,
      `   - simple: 1-2小时的小功能或简单修复`,
      `   - medium: 半天的中等功能或复杂修复`,
      `   - complex: 1-3天的大功能或架构调整`,
      `   - epic: 需要拆分为多个子任务的大型项目`,
      `4. 风险识别：性能风险、安全风险、兼容性风险、数据迁移风险`,
      `5. 缺失信息：哪些信息需要补充才能开工？`,
      ``,
      `建议：`,
      `  - proceed: 可以直接开发`,
      `  - clarify: 需要补充信息后再开发（在 clarificationNeeded 中说明）`,
      `  - reject: 不建议接受（说明原因）`,
      ``,
      `读取相关代码上下文（如有）以辅助判断。`,
    ].join('\n'),
    { label: 'analyze-requirement', phase: 'Analyze', schema: ANALYSIS_SCHEMA }
  )

  log(`需求分析完成：${analysis.recommendation} (复杂度: ${analysis.estimatedComplexity})`)

  if (analysis.recommendation === 'clarify') {
    log(`需要澄清的问题：${analysis.clarificationNeeded}`)

    // 自动回写评论到云舟
    await agent(
      [
        `使用 flows-cli 在任务 ${task.id} 下添加评论：`,
        ``,
        `flows-cli task comment add --task-id ${task.id} \\`,
        `  --content "🤖 需求澄清\\n\\n${analysis.clarificationNeeded}" \\`,
        `  --external-key "devops-loop-clarification-${task.id}" \\`,
        `  --profile ${profile} --json`,
        ``,
        `检查命令执行结果，确保评论添加成功。`,
      ].join('\n')
    )

    return { status: 'blocked', reason: 'clarification_needed', task, analysis }
  }

  if (analysis.recommendation === 'reject') {
    log(`不建议接受此任务`)
    return { status: 'rejected', task, analysis }
  }
} else {
  log('跳过需求分析，直接进入开发')
}

// ============================================================
// Phase 3: OpenSpec 开发流程
// ============================================================

phase('Develop')

const OPENSPEC_LEVEL = {
  trivial: 'L0',
  simple: 'L0',
  medium: 'L1',
  complex: 'L2',
  epic: 'L3',
}

const level = analysis ? OPENSPEC_LEVEL[analysis.estimatedComplexity] : 'L1'
log(`OpenSpec 等级：${level}`)

let developmentResult = null

if (level === 'L0') {
  // 简单任务：直接编码
  developmentResult = await agent(
    [
      `你是编码 Agent，在指定的代码仓库中实现任务。`,
      ``,
      `⚠️  重要：所有开发操作必须在以下目录中执行：`,
      `代码仓库：${absoluteCodeRepo}`,
      ``,
      `任务 #${task.id}：${task.title}`,
      `描述：${task.description}`,
      `验收标准：${task.acceptanceCriteria || '见描述'}`,
      ``,
      `实施步骤：`,
      `1. 切换到代码仓库目录（所有后续操作都在此目录）`,
      `2. 读取项目的 CLAUDE.md、README.md 或 package.json 了解项目结构`,
      `3. 定位相关代码文件`,
      `4. 实现功能逻辑（遵循项目编码规范）`,
      `5. 编写或更新单元测试`,
      `6. 运行测试验证`,
      ``,
      `工作目录：${absoluteCodeRepo}`,
      ``,
      `返回：变更的文件列表、测试结果、是否 ready for commit`,
    ].join('\n'),
    { label: 'direct-coding', phase: 'Develop' }
  )
} else {
  // 中高复杂度：使用 OpenSpec 工作流
  developmentResult = await agent(
    [
      `你是 OpenSpec 工作流执行 Agent。`,
      ``,
      `⚠️  重要：所有开发操作必须在以下目录中执行：`,
      `代码仓库：${absoluteCodeRepo}`,
      ``,
      `任务信息：`,
      `  ID: ${task.id}`,
      `  标题：${task.title}`,
      `  描述：${task.description}`,
      `  验收标准：${task.acceptanceCriteria || '未明确'}`,
      `  复杂度等级：${level}`,
      ``,
      level === 'L1' ? `执行 L1 流程（轻量）：` : level === 'L2' ? `执行 L2 流程（完整评审）：` : `执行 L3 流程（架构评审）：`,
      `1. 需求澄清 (proposal.md)`,
      `2. 技术方案 (design.md)`,
      level === 'L1' ? `3. 编码实施` : `3. 技术评审门禁`,
      level === 'L1' ? `4. 测试验证` : `4. 编码实施`,
      level === 'L1' ? `` : `5. 代码质量评审`,
      level === 'L1' ? `` : `6. 三维验证`,
      ``,
      `工作目录：${absoluteCodeRepo}`,
      ``,
      `使用本项目的 openspec-* skills 或相关工作流完成开发。`,
      `所有文件读写、测试运行都在上述工作目录中执行。`,
      ``,
      `返回：开发摘要、变更文件列表、测试结果`,
    ].join('\n'),
    { label: 'openspec-flow', phase: 'Develop' }
  )
}

if (!developmentResult) {
  log('❌ 开发阶段失败')
  return { status: 'failed', reason: 'development_failed', task }
}

log(`开发完成`)

// ============================================================
// Phase 4: 代码提交
// ============================================================

phase('Commit')

const commitResult = await agent(
  [
    `你是 Git 提交 Agent。`,
    ``,
    `⚠️  重要：所有 Git 操作必须在以下目录中执行：`,
    `代码仓库：${absoluteCodeRepo}`,
    ``,
    `任务信息：`,
    `  ID：${task.id}`,
    `  类型：${task.type}`,
    `  标题：${task.title}`,
    ``,
    `分支命名规则：${task.type}/${task.id}-${task.title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').substring(0, 40)}`,
    `Commit 消息格式：${task.type}(#${task.id}): ${task.title}`,
    ``,
    `提交步骤：`,
    `1. 切换到代码仓库目录`,
    `2. 检查当前分支：git branch --show-current`,
    `3. 如果在 main/master，创建新分支`,
    `4. 暂存变更文件 (git add <files>)`,
    `5. 提交 commit`,
    `6. ⚠️  停止 - 不要执行 git push（需要人工确认）`,
    `7. ⚠️  停止 - 不要创建 PR（需要人工确认）`,
    ``,
    `工作目录：${absoluteCodeRepo}`,
    ``,
    `测试验证：`,
    `  - 提交前运行单元测试`,
    `  - 运行 lint/format 检查`,
    `  - 确保所有测试通过`,
    ``,
    `Commit 消息末尾添加：`,
    `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`,
    ``,
    `⚠️  重要提示：`,
    `- 只执行本地 commit，不推送到远程`,
    `- 不创建 PR`,
    `- 返回分支名和变更文件列表，由用户决定是否推送`,
    ``,
    `返回结构化信息（branch/commitMessage/filesChanged/testsPassed），不包含 prUrl`,
  ].join('\n'),
  { label: 'git-commit', phase: 'Commit', schema: COMMIT_SCHEMA }
)

if (!commitResult) {
  log('❌ 提交阶段失败')
  return { status: 'failed', reason: 'commit_failed', task, development: developmentResult }
}

if (!commitResult.filesChanged || commitResult.filesChanged.length === 0) {
  log('⚠️  警告：没有文件变更')
  return { status: 'failed', reason: 'no_files_changed', task, development: developmentResult }
}

log(`代码已提交：${commitResult.filesChanged.length} 个文件变更`)
log(`分支：${commitResult.branch}`)
log('')
log('📋 下一步操作（需要人工确认）：')
log('')
log('1️⃣  推送代码到远程：')
log(`   cd ${absoluteCodeRepo}`)
log(`   git push -u origin ${commitResult.branch}`)
log('')
log('2️⃣  创建 Pull Request：')
log(`   cd ${absoluteCodeRepo}`)
log(`   gh pr create --title "${task.type}(#${task.id}): ${task.title}" --body "关联云舟任务: #${task.id}"`)
log('')
log('3️⃣  添加云舟评论（可选，使用 flows-role-comment skill）')
log('')

// ============================================================
// Phase 5: 回写状态到云舟（使用 flows-role-comment skill）
// ============================================================

phase('Sync')

log('准备回写状态到云舟...')
log('')

// 检查是否存在 flows-role-comment skill
const skillCheckResult = await agent(
  `检查 flows-role-comment skill 是否存在。执行以下操作：
1. 查找 skills/flows-role-comment/SKILL.md 文件
2. 如果文件存在，返回 "SKILL_EXISTS"
3. 如果文件不存在，返回 "SKILL_NOT_FOUND"`,
  { label: 'check-flows-role-comment-skill' }
)

let commentResult = null

if (skillCheckResult && skillCheckResult.includes('SKILL_EXISTS')) {
  log('✓ 检测到 flows-role-comment skill')
  log('')
  log('⚠️  添加云舟评论需要人工确认')
  log('')
  log('如需添加评论，请执行以下命令：')
  log('')
  log('方式 1：使用 Skill 生成并发布评论')
  log(`   /flows-role-comment`)
  log(`   任务ID: ${task.id}`)
  log(`   Profile: ${profile}`)
  log('')
  log('方式 2：手动构建评论内容')
  log('   构建评论摘要：')
  log(`   - 任务类型：${task.type}`)
  log(`   - 变更文件数：${commitResult.filesChanged.length}`)
  log(`   - 分支：${commitResult.branch}`)
  if (analysis) {
    log(`   - 复杂度：${analysis.estimatedComplexity}`)
    if (analysis.risks && analysis.risks.length > 0) {
      log(`   - 风险：${analysis.risks.join('; ')}`)
    }
  }
  log('')
  log('   然后使用 flows-cli 发布：')
  log(`   flows-cli task comment add --task-id ${task.id} \\`)
  log(`     --content-file <评论文件路径> \\`)
  log(`     --external-key "devops-loop-completed-${task.id}" \\`)
  log(`     --profile ${profile} --json`)
  log('')

  commentResult = {
    status: 'pending_user_confirmation',
    message: '评论准备就绪，等待人工确认后发布',
    skillAvailable: true
  }
} else {
  log('ℹ️  未检测到 flows-role-comment skill，跳过评论生成')
  log('')
  log('如需手动添加评论，可以使用 flows-cli：')
  log(`flows-cli task comment add --task-id ${task.id} \\`)
  log(`  --content "<评论内容>" \\`)
  log(`  --profile ${profile} --json`)
  log('')

  commentResult = {
    status: 'skipped',
    message: 'flows-role-comment skill 不存在，已跳过',
    skillAvailable: false
  }
}

// ============================================================
// 最终返回
// ============================================================

log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
log('✅ 工作流执行完成')
log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
log('')
log(`📦 任务信息：`)
log(`   ID: ${task.id}`)
log(`   标题: ${task.title}`)
log(`   类型: ${task.type}`)
log(`   优先级: ${task.priority}`)
log('')
log(`💻 开发结果：`)
log(`   代码仓库: ${absoluteCodeRepo}`)
log(`   分支: ${commitResult.branch}`)
log(`   变更文件: ${commitResult.filesChanged.length} 个`)
log(`   测试状态: ${commitResult.testsPassed ? '✅ 通过' : '⚠️  待确认'}`)
log('')
log(`⏭️  待完成操作：`)
log(`   □ 推送代码到远程`)
log(`   □ 创建 Pull Request`)
log(`   □ 添加云舟评论（可选）`)
log('')

return {
  status: 'completed',
  task,
  analysis,
  development: developmentResult,
  commit: commitResult,
  comment: commentResult,
  codeRepo: absoluteCodeRepo,
  nextSteps: {
    push: {
      command: `cd ${absoluteCodeRepo} && git push -u origin ${commitResult.branch}`,
      description: '推送代码到远程仓库',
      required: true
    },
    pr: {
      command: `cd ${absoluteCodeRepo} && gh pr create --title "${task.type}(#${task.id}): ${task.title}" --body "关联云舟任务: #${task.id}"`,
      description: '创建 Pull Request',
      required: true
    },
    comment: {
      skill: 'flows-role-comment',
      available: commentResult.skillAvailable,
      description: '添加云舟评论',
      required: false
    }
  },
  summary: `任务 #${task.id} 在 ${absoluteCodeRepo} 中完成开发并提交到分支 ${commitResult.branch}，等待推送和创建 PR`,
}
