# 云舟自动化 Loop 使用指南

> 从云舟任务拉取到开发完成的全流程自动化工作流

## 目录

- [概述](#概述)
- [快速开始](#快速开始)
- [核心功能](#核心功能)
- [配置管理](#配置管理)
- [使用方式](#使用方式)
- [工作流参数](#工作流参数)
- [安全机制](#安全机制)
- [故障排除](#故障排除)
- [最佳实践](#最佳实践)

---

## 概述

`devops-automation-loop-yunzhou` 工作流将云舟任务管理平台与 OpenSpec 开发流程深度集成，实现端到端的自动化开发循环。

### 核心价值

- ✅ **官方支持**：使用云舟 CLI（flows-cli）提供稳定的 API 契约
- ✅ **安全认证**：基于浏览器 session，无需管理 API token
- ✅ **智能匹配**：自动识别任务所属项目，防止代码提交错误
- ✅ **多项目支持**：统一管理多个云舟项目和代码仓库
- ✅ **灵活控制**：支持自动提交、跳过分析等多种模式

### 工作流程

```
云舟待办任务
    ↓
Phase 1: Fetch     - 拉取任务详情
    ↓
Phase 2: Analyze   - 需求分析与可行性评估
    ↓
Phase 3: Develop   - OpenSpec 流程开发（L0/L1/L2/L3）
    ↓
Phase 4: Commit    - Git 代码提交
    ↓
Phase 5: Sync      - 回写状态到云舟
```

---

## 快速开始

### 第一步：安装云舟 CLI

从云舟 Web 的"插件"页面下载 CLI 安装包：

```bash
# 安装 CLI
npm install -g ~/Downloads/flows-cli-1.2.0.tgz

# 验证安装
flows-cli version --json
```

### 第二步：登录云舟

```bash
# 使用浏览器登录（推荐）
flows-cli auth login-web --json

# 验证登录状态
flows-cli auth whoami --json
```

### 第三步：配置项目

运行自动配置脚本：

```bash
./setup-yunzhou-config.sh
```

配置向导会引导你：
1. 选择云舟项目
2. 选择默认清单（用于拉取待办任务）
3. **配置代码仓库路径**（重要）
4. 生成配置文件 `~/.claude/yunzhou-config.json`

### 第四步：运行工作流

```javascript
// 使用默认配置，自动拉取任务
workflow('devops-automation-loop-yunzhou')

// 或指定任务ID
workflow('devops-automation-loop-yunzhou', {
  taskId: 12345
})
```

---

## 核心功能

### 1. 智能项目匹配（v1.2.0 新增）

**问题场景**：在 Lokra 项目工作区执行其他项目的任务，代码会提交到错误的仓库

**解决方案**：自动检测任务所属项目并切换到正确的代码仓库

```javascript
// 任务 #88888 属于前端项目
// 但默认项目是 Lokra

workflow('devops-automation-loop-yunzhou', {
  taskId: 88888
})

// 输出：
// ⚠️  检测到项目不匹配！
// 任务所属项目：前端应用
// 当前使用项目：Lokra
// ✅ 自动切换到任务所属项目
// ✅ 已切换代码仓库：/path/to/frontend-app
```

**两种处理模式**：

- **自动切换模式**（默认）：`autoSwitchProject: true`
  - 自动切换到正确项目，继续执行
  
- **严格模式**：`autoSwitchProject: false`
  - 检测到不匹配时终止流程，提示用户

### 2. 多项目管理

支持配置多个云舟项目，每个项目独立管理：

```json
{
  "projects": [
    {
      "projectId": "project_abc123",
      "name": "Lokra 后端",
      "codeRepo": "/Users/macbook/Documents/ideaProject/agent-skills",
      "defaultColumnId": "column_xyz789",
      "columns": [...]
    },
    {
      "projectId": "project_def456",
      "name": "前端应用",
      "codeRepo": "/Users/macbook/Documents/ideaProject/frontend-app",
      "defaultColumnId": "column_aaa111",
      "columns": [...]
    }
  ],
  "defaultProjectId": "project_abc123"
}
```

### 3. 代码仓库隔离

**问题**：工作流在 agent-skills 目录运行，但业务代码在其他目录

**解决**：为每个项目配置独立的 `codeRepo` 路径

```javascript
// 配置后，工作流会自动在正确的目录执行开发和提交
workflow('devops-automation-loop-yunzhou', {
  projectName: 'Lokra 后端',
  taskId: 12345
})

// 所有开发操作在 /Users/macbook/Documents/ideaProject/agent-skills 执行
```

### 4. 复杂度自适应开发

根据任务复杂度自动选择开发流程：

| 复杂度 | OpenSpec 等级 | 流程 |
|--------|--------------|------|
| trivial / simple | L0 | 直接编码 + 测试 |
| medium | L1 | proposal + design + 编码 + 验证 |
| complex | L2 | L1 + 技术评审门禁 + 代码审查 |
| epic | L3 | L2 + 架构评审 + 分阶段实施 |

---

## 配置管理

### 配置文件结构

配置文件位于 `~/.claude/yunzhou-config.json`：

```json
{
  "version": "1.2.0",
  "yunzhou": {
    "profile": "default"
  },
  "projects": [
    {
      "projectId": "project_xxx",
      "name": "项目名称",
      "codeRepo": "/path/to/code",
      "defaultColumnId": "column_yyy",
      "defaultColumnTitle": "进行中",
      "columns": [
        {"id": "column_yyy", "title": "进行中"},
        {"id": "column_zzz", "title": "待办"}
      ]
    }
  ],
  "defaultProjectId": "project_xxx",
  "workflow": {
    "autoCommit": false,
    "skipAnalysis": false,
    "autoSwitchProject": true
  }
}
```

### 配置向导操作

```bash
./setup-yunzhou-config.sh
```

**主菜单选项**：

1. **添加新项目**
   - 从云舟项目列表中选择
   - 配置默认清单
   - 配置代码仓库路径
   
2. **修改已有项目**
   - 更新默认清单
   - 更新代码仓库路径
   
3. **删除项目**
   - 从配置中移除项目
   
4. **设置默认项目**
   - 将常用项目设为默认
   
5. **查看当前配置**
   - 显示所有项目信息
   
6. **重新生成配置**
   - 备份并重新初始化配置

### 管理多项目

添加第二个项目：

```bash
./setup-yunzhou-config.sh
# 选择：1. 添加新项目
# 按提示配置项目、清单和代码仓库
```

切换默认项目：

```bash
./setup-yunzhou-config.sh
# 选择：4. 设置默认项目
# 从列表中选择新的默认项目
```

---

## 使用方式

### 方式 1：使用默认配置（推荐日常使用）

```javascript
// 从默认项目的默认清单拉取优先级最高的任务
workflow('devops-automation-loop-yunzhou')
```

**前提条件**：
- ✅ 已配置默认项目
- ✅ 默认项目已配置 `codeRepo`
- ✅ 默认项目已配置 `defaultColumnId`

### 方式 2：指定任务ID

```javascript
// 推荐：明确指定项目（最安全）
workflow('devops-automation-loop-yunzhou', {
  projectName: 'Lokra 后端',
  taskId: 12345
})

// 或使用自动匹配（需要 autoSwitchProject: true）
workflow('devops-automation-loop-yunzhou', {
  taskId: 12345
})
```

### 方式 3：指定清单拉取

```javascript
// 从指定清单拉取任务
workflow('devops-automation-loop-yunzhou', {
  projectName: 'Lokra 后端',
  columnId: 'column_xxx'
})
```

### 方式 4：按项目名称切换

```javascript
// 切换到其他项目
workflow('devops-automation-loop-yunzhou', {
  projectName: '前端应用'
})
```

### 方式 5：快速修复模式

```javascript
// 跳过分析，自动提交
workflow('devops-automation-loop-yunzhou', {
  projectName: 'Lokra 后端',
  taskId: 12345,
  skipAnalysis: true,
  autoCommit: true
})
```

### 方式 6：临时覆盖配置

```javascript
// 临时使用不同的代码仓库
workflow('devops-automation-loop-yunzhou', {
  projectName: 'Lokra 后端',
  taskId: 12345,
  codeRepo: '/tmp/test-repo'
})
```

---

## 工作流参数

### 完整参数列表

```typescript
interface WorkflowArgs {
  // === 项目选择（三选一） ===
  projectId?: string;        // 直接指定项目ID
  projectName?: string;      // 按项目名称查找
  // 不指定，使用默认项目

  // === 任务来源（三选一） ===
  taskId?: number;           // 处理指定任务
  columnId?: string;         // 从指定清单拉取
  // 不指定，使用项目默认清单

  // === 代码仓库（可选） ===
  codeRepo?: string;         // 覆盖配置的代码仓库路径

  // === 工作流控制（可选） ===
  profile?: string;          // CLI profile（默认：'default'）
  autoCommit?: boolean;      // 是否自动提交（默认：false）
  skipAnalysis?: boolean;    // 是否跳过分析（默认：false）
}
```

### 参数优先级

```
调用时传入的参数（最高优先级）
    ↓
配置文件中项目的配置
    ↓
配置文件中 workflow 的全局默认值
    ↓
硬编码默认值（最低优先级）
```

### 常用调用模板

```javascript
// 1. 默认配置（最简单）
workflow('devops-automation-loop-yunzhou')

// 2. 指定任务（推荐明确指定项目）
workflow('devops-automation-loop-yunzhou', {
  projectName: 'Lokra 后端',
  taskId: 12345
})

// 3. 从清单选择
workflow('devops-automation-loop-yunzhou', {
  projectName: 'Lokra 后端',
  columnId: 'column_xxx'
})

// 4. 快速修复
workflow('devops-automation-loop-yunzhou', {
  projectName: 'Lokra 后端',
  taskId: 12345,
  skipAnalysis: true,
  autoCommit: true
})

// 5. 临时覆盖配置
workflow('devops-automation-loop-yunzhou', {
  projectName: 'Lokra 后端',
  taskId: 12345,
  codeRepo: '/tmp/test',
  autoCommit: false
})
```

---

## 安全机制

### 1. 项目匹配验证

**Phase 0: 预检查**
- 检测用户是否指定了 `taskId` 但未指定项目
- 提示可能的风险和建议做法

**Phase 1 后: 项目匹配校验**
- 从任务的清单ID推断任务所属项目
- 对比任务所属项目 vs 当前使用的项目配置
- 检测到不匹配时自动切换或终止流程

```javascript
// 示例输出
⚠️  提示：使用默认项目处理任务，请确认项目正确
   默认项目：Lokra 后端
   任务ID：12345

// 如果检测到不匹配
🔴 警告：检测到项目不匹配！
   任务所属项目：前端应用
   当前使用项目：Lokra 后端
   
✅ 自动切换到任务所属项目
✅ 已切换代码仓库：/path/to/frontend-app
✅ 已验证代码仓库是 Git 仓库
```

### 2. 代码仓库验证

**验证规则**：
1. ✅ 检查 `codeRepo` 是否配置
2. ✅ 验证路径存在
3. ✅ 验证是 Git 仓库（检查 `.git` 目录）

**错误提示**：
```
❌ 错误：未指定代码仓库路径

解决方法：
方式 1：在配置文件中为项目配置代码仓库路径
  ./setup-yunzhou-config.sh
  # 选择：2. 修改已有项目

方式 2：在调用工作流时指定 codeRepo 参数
  workflow('devops-automation-loop-yunzhou', {
    taskId: 12345,
    codeRepo: '/path/to/your/project'
  })
```

### 3. 自动提交安全策略

**推荐配置**：

只在以下情况使用 `autoCommit: true`：
- 简单 bug 修复（trivial/simple）
- 紧急且风险低的任务
- 已经过需求分析且无风险提示

**分步执行**（更安全）：
1. 先不自动提交，检查代码变更
2. 人工审查后再推送和创建 PR

### 4. 凭据管理

- ✅ **不存储明文凭据**：所有凭据由 flows-cli 管理
- ✅ **Session 本地存储**：配置文件权限 0600
- ✅ **Profile 隔离**：支持多环境（开发/测试/生产）

---

## 故障排除

### 问题 1：flows-cli 命令未找到

**原因**：CLI 未安装或未加入 PATH

**解决**：
```bash
npm install -g ~/Downloads/flows-cli-*.tgz
which flows-cli  # 验证安装路径
```

### 问题 2：API 调用失败（401 错误）

**原因**：session 过期或未登录

**解决**：
```bash
flows-cli auth logout
flows-cli auth login-web --json
flows-cli auth whoami --json  # 验证登录状态
```

### 问题 3：未指定项目ID

**错误信息**：
```
❌ 错误：未指定项目ID，且未找到默认项目配置
```

**解决**：
```bash
# 方式 1：运行配置向导
./setup-yunzhou-config.sh

# 方式 2：调用时指定项目
workflow('devops-automation-loop-yunzhou', {
  projectName: 'Lokra 后端',
  taskId: 12345
})
```

### 问题 4：未指定代码仓库路径

**错误信息**：
```
❌ 错误：未指定代码仓库路径
```

**解决**：
```bash
# 方式 1：配置文件中添加 codeRepo
./setup-yunzhou-config.sh
# 选择：2. 修改已有项目

# 方式 2：调用时指定
workflow('devops-automation-loop-yunzhou', {
  taskId: 12345,
  codeRepo: '/path/to/your/project'
})
```

### 问题 5：项目不匹配

**错误信息**：
```
🔴 警告：检测到项目不匹配！
❌ 风险：如果继续执行，代码将提交到错误的仓库！
```

**解决**：
```javascript
// 方式 1：明确指定正确项目
workflow('devops-automation-loop-yunzhou', {
  projectName: '前端应用',  // 任务实际所属项目
  taskId: 88888
})

// 方式 2：启用自动切换
// 编辑 ~/.claude/yunzhou-config.json
{
  "workflow": {
    "autoSwitchProject": true
  }
}
```

### 问题 6：无法拉取任务列表

**原因**：项目ID或清单ID错误，或无权限

**解决**：
```bash
# 重新获取项目列表
flows-cli project list --json

# 获取看板信息
flows-cli board show --project-id <project-id> --json

# 检查项目成员权限
flows-cli project members --project-id <project-id> --json
```

### 问题 7：配置文件损坏

**原因**：手动编辑配置文件导致 JSON 格式错误

**解决**：
```bash
# 验证 JSON 格式
cat ~/.claude/yunzhou-config.json | jq

# 如果无法修复，重新生成
./setup-yunzhou-config.sh
# 选择：6. 重新生成配置文件（会先备份）
```

---

## 最佳实践

### 1. 项目配置建议

**明确的项目命名**：
```json
{
  "projects": [
    {"name": "Lokra 后端 - 用户中心"},     // ✅ 清晰
    {"name": "前端 - 管理后台"},          // ✅ 清晰
    {"name": "项目1"}                     // ❌ 不明确
  ]
}
```

**设置常用项目为默认**：
```bash
./setup-yunzhou-config.sh
# 选择：4. 设置默认项目
```

**配置完整的清单信息**：
- 确保每个项目包含完整的 `columns` 数组
- 这样才能支持智能项目匹配

**定期备份配置文件**：
```bash
# 手动备份
cp ~/.claude/yunzhou-config.json ~/.claude/yunzhou-config.backup.$(date +%Y%m%d).json

# 或使用 Git 跟踪（可选）
git add ~/.claude/yunzhou-config.json
git commit -m "chore: 更新云舟项目配置"
```

### 2. 调用建议

**日常开发（单项目）**：
```javascript
// 默认项目是常用项目，直接调用
workflow('devops-automation-loop-yunzhou')
```

**处理特定任务**：
```javascript
// 推荐：明确指定项目（最安全）
workflow('devops-automation-loop-yunzhou', {
  projectName: 'Lokra 后端',
  taskId: 12345
})
```

**快速处理任务（跨项目）**：
```javascript
// 启用 autoSwitchProject 后可以只指定 taskId
// 工作流会自动检测并切换项目
workflow('devops-automation-loop-yunzhou', {
  taskId: 88888
})
```

**批量处理（多项目）**：
```javascript
const tasks = [
  { projectName: 'Lokra 后端', taskId: 11111 },
  { projectName: '前端应用', taskId: 88888 },
]

// 串行处理（避免 Git 冲突）
for (const item of tasks) {
  await workflow('devops-automation-loop-yunzhou', {
    projectName: item.projectName,
    taskId: item.taskId,
    autoCommit: false  // 人工审查每个任务
  })
}
```

### 3. 任务选择策略

- **小步快跑**：优先选择 simple/medium 复杂度的任务
- **明确验收**：确保任务有清晰的验收标准
- **风险可控**：高风险任务建议人工确认每个阶段

### 4. 并发处理

**避免并发处理多个任务**：
```javascript
// ❌ 不推荐：并发处理可能冲突
parallel([
  () => workflow('devops-automation-loop-yunzhou', { taskId: 1 }),
  () => workflow('devops-automation-loop-yunzhou', { taskId: 2 }),
])

// ✅ 推荐：串行处理
await workflow('devops-automation-loop-yunzhou', { taskId: 1 })
await workflow('devops-automation-loop-yunzhou', { taskId: 2 })
```

### 5. 监控与日志

**记录工作流结果**：
```javascript
const result = await workflow('devops-automation-loop-yunzhou', { ... })

// 记录结构化日志
console.log(JSON.stringify({
  timestamp: new Date().toISOString(),
  status: result.status,
  taskId: result.task.id,
  taskTitle: result.task.title,
  complexity: result.analysis?.estimatedComplexity,
  branch: result.commit?.branch,
  prUrl: result.commit?.prUrl,
  codeRepo: result.codeRepo
}, null, 2))
```

---

## 进阶用法

### 定时自动化

使用 `CronCreate` 定时执行：

```javascript
// 每天早上 9 点处理一个待办任务
CronCreate({
  cron: '0 9 * * *',
  prompt: `workflow('devops-automation-loop-yunzhou', {
    projectId: '<project-id>',
    columnId: '<column-id>',
    autoCommit: false
  })`,
  durable: true
})
```

### 集成其他工具

与其他工作流组合：

```javascript
// 1. 从云舟拉取任务并开发
const result = await workflow('devops-automation-loop-yunzhou', {
  projectName: 'Lokra 后端',
  taskId: 12345
})

// 2. 如果开发成功，运行额外的验证
if (result.status === 'completed') {
  await workflow('integration-test-suite', {
    branch: result.commit.branch
  })
  
  // 3. 部署到测试环境
  await workflow('deploy-to-staging', {
    branch: result.commit.branch
  })
}
```

### 批量处理待办任务

```javascript
// 获取多个待办任务
const tasks = await agent(
  'flows-cli task list --column-id <column-id> --completion open --limit 10 --json',
  { schema: { type: 'object', properties: { tasks: { type: 'array' } } } }
)

// 串行处理
for (const task of tasks.tasks) {
  log(`处理任务 #${task.id}: ${task.title}`)
  
  const result = await workflow('devops-automation-loop-yunzhou', {
    projectId: '<project-id>',
    taskId: task.id,
    autoCommit: false
  })
  
  if (result.status !== 'completed') {
    log(`任务 #${task.id} 处理失败: ${result.reason}`)
    break  // 遇到失败停止
  }
}
```

---

## 相关资源

### 文档

- [完整工作流实现](./devops-automation-loop.md) - 详细的技术实现文档
- [集成方案总结](./yunzhou-integration-summary.md) - 云舟 CLI 集成架构
- [多项目管理指南](./yunzhou-multi-project-guide.md) - 多项目配置详解
- [参数完整说明](./yunzhou-workflow-parameters.md) - 所有参数的详细说明
- [项目匹配验证](./yunzhou-project-match-validation.md) - 智能匹配功能说明
- [跨项目问题分析](./yunzhou-cross-project-issue.md) - 问题分析和解决方案
- [代码仓库配置变更](./yunzhou-coderepo-changelog.md) - v1.2.0 变更日志

### 工具

- [工作流源码](../workflow/devops-automation-loop-yunzhou.workflow.js)
- [配置向导脚本](../setup-yunzhou-config.sh)
- [项目编码规范](../CLAUDE.md)

### 支持

遇到问题？
1. 查看本文档的 [故障排除](#故障排除) 章节
2. 运行诊断命令：`flows-cli health check --json`
3. 检查云舟 CLI 日志
4. 联系团队技术支持

---

## 版本信息

- **当前版本**：v1.2.0
- **更新时间**：2026-09-01
- **主要特性**：
  - ✅ 智能项目匹配
  - ✅ 多项目管理
  - ✅ 代码仓库隔离
  - ✅ 自动切换模式
  - ✅ 完整的安全验证

---

**快速链接**：
- [快速开始](#快速开始)
- [配置管理](#配置管理)
- [使用方式](#使用方式)
- [故障排除](#故障排除)
- [最佳实践](#最佳实践)
