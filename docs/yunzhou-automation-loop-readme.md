# 云舟自动化 Loop 使用指南

> 从云舟任务拉取到开发完成的状态化编排工作流

本文档描述 `devops-automation-loop-yunzhou` 的**当前实现**。

**唯一事实源**：`workflow/devops-automation-loop-yunzhou.workflow.js`。本文档与源码不一致时，以源码为准。

## 目录

- [概述](#概述)
- [快速开始](#快速开始)
- [工作流参数](#工作流参数)
- [阶段与行为](#阶段与行为)
- [门禁分级](#门禁分级)
- [安全机制](#安全机制)
- [返回结构](#返回结构)
- [配置管理](#配置管理)
- [故障排除](#故障排除)
- [最佳实践](#最佳实践)

---

## 概述

`devops-automation-loop-yunzhou` 把云舟任务接到 OpenSpec 研发流程：先确认任务与仓库，再按**实际状态**在调查 / 决策 / 规划 / 门禁之间循环（最多 6 轮），门禁通过独立复核后进入实施、质量评审与验证；提交等副作用单独授权。

### 核心价值

- ✅ **官方支持**：使用云舟 CLI（flows-cli）提供稳定的 API 契约
- ✅ **安全认证**：基于浏览器 session，无需管理 API token
- ✅ **按状态编排**：不是把阶段全部串行跑一遍，而是按未决项、产物与批准状态决定下一步
- ✅ **门禁不可代签**：人工批准由独立阶段复核，不只相信路由结论
- ✅ **副作用分离授权**：默认不提交、不推送、不发 PR、不评论、不归档、不关闭云舟任务

### 工作流程

阶段清单来自源码 `meta.phases`（`workflow/devops-automation-loop-yunzhou.workflow.js:22`）：

```
Fetch      拉取指定云舟任务与项目配置，确认仓库绝对路径
   ↓
Route      只读检查 change、产物、批准与风险，输出 action / gateLevel / fingerprint
   ↓
┌──────────────── 按状态循环（最多 6 轮）────────────────┐
│ Explore    只调查路由列出的关键未知（加载 openspec-explore）│
│ Grill      列出当前 frontier 的决策问题并暂停（openspec-grill）│
│ Plan       生成或更新正式产物（openspec-propose / openspec-update-change）│
│ Gate       技术评审门禁（openspec-technical-review）      │
│ GateCheck  独立读取门禁文件，复核批准是否真实有效          │
└───────────────────────────────────────────────────────┘
   ↓
Apply      按批准方案实施（openspec-apply-change）
   ↓
Quality    对完整 diff 做代码质量评审（openspec-code-quality）
   ↓
Verify     独立验证，须 criticalCount=0、testsPassed=true 且有测试证据（openspec-verify-change）
   ↓
Commit     仅当显式授权 autoCommit: true 时执行本地提交
```

> 工作流**没有** Sync / 回写阶段：源码在返回值的 `externalActions` 中明确写为"未推送、未发 PR、未发布评论、未归档、未关闭任务；这些操作需另行授权"（`devops-automation-loop-yunzhou.workflow.js:229`）。

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

运行仓库内的配置脚本（位于 `scripts/` 目录）：

```bash
./scripts/setup-yunzhou-config.sh
```

配置向导会引导你：
1. 选择云舟项目
2. 选择默认清单
3. **配置代码仓库路径**（`codeRepo`，重要）
4. 生成配置文件 `~/.yunzhou/config.json`

### 第四步：运行工作流

`taskId` 与 `intent` 都是必填参数：

```javascript
// 只讨论，不产出正式规划
workflow('devops-automation-loop-yunzhou', {
  taskId: 12345,
  intent: 'discuss',
})

// 生成正式规划与管理产物，完成后暂停等待实施授权
workflow('devops-automation-loop-yunzhou', {
  taskId: 12345,
  intent: 'plan',
})

// 走完规划、门禁、实施、质量评审与验证（默认不提交）
workflow('devops-automation-loop-yunzhou', {
  taskId: 12345,
  intent: 'implement',
})
```

---

## 工作流参数

### 参数列表

源码实际校验并使用的参数如下（`devops-automation-loop-yunzhou.workflow.js:57-62、93`）：

```typescript
interface WorkflowArgs {
  // === 必填 ===
  taskId: number;            // 云舟任务 ID，必须为正安全整数（Number.isSafeInteger 且 > 0）
  intent: 'discuss' | 'investigate' | 'plan' | 'implement';
                             // 本次调用的授权意图，必填

  // === 可选 ===
  codeRepo?: string;         // 覆盖匹配到的项目仓库路径（Fetch 阶段使用）
  autoCommit?: boolean;      // 是否授权本地 commit，默认 false；只有显式 true 才授权
}
```

### 参数校验规则

不满足校验时，工作流**不会执行任何阶段**，直接返回：

```javascript
{
  status: 'blocked',
  reason: '需要显式 taskId 和有效 intent；默认 intent=plan，不自动编码'
}
```

（`devops-automation-loop-yunzhou.workflow.js:93-95`）

- `taskId`：必须显式传入，且必须是正安全整数。**不传 taskId 不会自动拉取待办任务**——源码没有"挑选一个任务"的分支，Fetch 阶段也明确"不自动挑选另一个任务"。
- `intent`：取值必须是 `discuss`、`investigate`、`plan`、`implement` 之一。
- 源码内部对 `intent` 有 `input.intent || 'plan'` 的兜底，**但兜底只作用于已通过校验的调用**，不能替代显式传入。

### intent 取值含义

| intent | 行为 | 结束位置 |
|--------|------|---------|
| `discuss` | 允许调查查证，不允许生成正式规划或写业务代码 | 路由给出除 `explore` 外的动作时收口返回（`workflow.js:147-149`） |
| `investigate` | 同上，用于事实未知的定向查证 | 同上 |
| `plan` | 允许 explore / grill / propose / update | 规划完成后返回"规划完成，等待实施授权"（`workflow.js:159`） |
| `implement` | 允许走完门禁与 Apply → Quality → Verify | 验证通过后按 `autoCommit` 决定是否提交 |

### 代码仓库（codeRepo）

任务与仓库的对应关系由 Fetch 阶段确认：

- 使用调用时传入的 `codeRepo` 参数，或匹配到的项目配置；
- **无法确认任务所属项目与仓库时直接 `blocked`**，不会猜测路径（`workflow.js:100-105`）。

---

## 阶段与行为

| 阶段 | 加载的能力 skill | 关键约束 |
|------|-----------------|---------|
| Fetch | 无 | 只读拉取任务与配置，返回已验证的绝对路径 `codeRepo` |
| Route | 无（使用 `openspec status/instructions`） | 只读；返回 `action`、`gateLevel`、`changeRoot`、`fingerprint`、`approvalValid`、`artifactsReady` |
| Explore | `openspec-explore` | 只查路由列出的关键未知，不创建或修改正式规划产物，不写业务代码 |
| Grill | `openspec-grill` | 只列出当前 frontier 的问题与依据，返回 `needs_decision`，**不模拟用户回答** |
| Plan | `openspec-propose` / `openspec-update-change` | 按 CLI schema 生成或更新正式产物，不另建 `docs/proposals` |
| Gate | `openspec-technical-review` | 按 `gateLevel` 指定评审角色；已有有效评审不得重写；不代签 |
| GateCheck | 无 | 独立读取门禁文件，复核签字与输入版本，不复述路由的布尔值 |
| Apply | `openspec-apply-change` | 只在批准方案内实施，遵循 Seam-first TDD，不提前执行被阻塞切片 |
| Quality | `openspec-code-quality` | 对完整 diff（含暂存/未暂存/新增）评审，有未闭环阻断项即 `blocked` |
| Verify | `openspec-verify-change` | 必须返回 `criticalCount=0`、`testsPassed=true` 与非空 `testsEvidence` |
| Commit | 无 | 只授权本地 commit；禁止 `git add .`、amend、push、PR |

补充规则：

- 阶段返回必须包含非空 `evidence` 且 `blockers` 为空，才算 `completed`；缺少完成证据会被判为无效结果（`workflow.js:44-55`）。
- 路由最多 6 轮；如果连续两轮 action 与 fingerprint 完全相同，立即 `blocked`，避免无进展的空转（`workflow.js:135-137`）。
- 只有 Apply 阶段允许修改业务代码与测试（`workflow.js:77`）。

---

## 门禁分级

门禁级别由 Route 阶段根据**实际风险**判定，不是按工时或固定复杂度映射。源码中的评审角色定义（`workflow.js:32-36`）：

```javascript
const REVIEW_ROLES = {
  L0: [],
  L1: ['database', 'security'],
  L2: ['architecture', 'database', 'security', 'performance'],
  L3: ['architecture', 'concurrency', 'performance', 'database', 'security'],
}
```

| 级别 | 适用场景（Route 判定规则要点） | 评审角色 | 是否需要人工签字 |
|------|------------------------------|---------|-----------------|
| L0 | 无业务行为变化的文案/注释/格式整理；配置或依赖变化须确认不改变安全和运行行为 | 无 | 不需要；须返回 `verdict=EXEMPT` 与有效的 `exemptionValid`（`workflow.js:176-178`） |
| L1 | 无升级信号的单表 CRUD、非核心字段、小范围扩展 | database + security | 需要 |
| L2 | 新业务流程、跨模块、缓存、批量操作 | architecture + database + security + performance | 需要 |
| L3 | 命中任一升级信号：MQ/异步、并发、重试/幂等、分布式一致性、状态机；新表/字段类型/唯一索引；万条及以上批量；外网接口/上传；权限、租户、敏感数据 | architecture + concurrency + performance + database + security | 需要 |

人工批准规则：

- L1-L3 的人工签字写在 `review-summary.md`；**模型署名不算人工批准**，GateCheck 会独立核对签字与评审输入版本（`workflow.js:170-182`）。
- 即使 Route 已报告 `approvalValid=true`，也必须通过 GateCheck 独立复核，复核不通过即 `blocked`。
- **L0 不需要人工签字**，但必须留下真实豁免理由。

> 源码中**不存在** `GATE_LEVEL_MAP` 配置对象，也**不支持**通过配置把某个复杂度批量映射到固定门禁级别；级别由 Route 每轮重新判定，命中新风险时重新分级，不确定时不默认 L0。

---

## 安全机制

### 1. 任务与仓库确认

- Fetch 阶段核实任务所属项目与仓库，并要求 `task.id === input.taskId`、`codeRepo` 是绝对路径；
- 不自动挑选另一个任务，不打印密钥或完整配置（`workflow.js:100-105`）。

### 2. 批准与门禁独立复核

- Route 只读检查产物、批准与风险；
- Gate 阶段执行技术评审；
- GateCheck 阶段独立读取门禁文件，核对 `verdict`、`blockerCount=0`、`conditionsMapped`、`inputsCurrent` 与人工签字。

### 3. 副作用分离授权

- **AutoCommit 默认关闭**：只有本次调用显式传入 `autoCommit: true` 才授权本地 commit，不从用户全局配置继承（`workflow.js:60-61`）。
- 即便授权提交，也只允许本地 commit：禁止 `git add .`、amend、push、创建 PR；且必须核对 `commitSha` 格式（`workflow.js:222-226`）。
- 评论、归档、关闭云舟任务等外部动作**一律不在本工作流内执行**。

### 4. 凭据管理

- ✅ **不存储明文凭据**：所有凭据由 flows-cli 管理
- ✅ **Session 本地存储**：配置文件权限 0600
- ✅ **Profile 隔离**：支持多环境（开发/测试/生产）

---

## 返回结构

正常完成：

```javascript
{
  status: 'completed',
  changeId: 'yunzhou-<taskId>',   // 变更 ID 由源码内联生成，不可配置
  codeRepo: '/abs/path/to/repo',
  verified: true,
  commit: { status: 'not_authorized' },   // 或提交成功后的 commitSha 信息
  history: [ /* 各阶段已校验的结果 */ ],
  externalActions: '未推送、未发 PR、未发布评论、未归档、未关闭任务；这些操作需另行授权'
}
```

未完成 / 需要决策 / 失败：

```javascript
{
  status: 'blocked' | 'needs_decision' | 'needs_investigation' | 'failed',
  reason: '...',
  changeId: 'yunzhou-<taskId>',
  history: [ /* ... */ ]
}
```

`status` 的合法取值集合为 `completed`、`needs_decision`、`needs_investigation`、`blocked`、`failed`（`workflow.js:28`）。

---

## 配置管理

配置文件由 `scripts/setup-yunzhou-config.sh` 生成在 `~/.yunzhou/config.json`，结构如下（脚本 `init_config` 与实际写入字段）：

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
      "defaultColumnId": "column_yyy",
      "defaultColumnTitle": "进行中",
      "codeRepo": "/path/to/code",
      "columns": [
        { "id": "column_yyy", "title": "进行中" }
      ]
    }
  ],
  "defaultProjectId": "project_xxx",
  "workflow": {
    "autoCommit": false,
    "skipAnalysis": false
  }
}
```

> 说明：`workflow` 块由配置脚本写入，但**当前工作流源码只读取调用时传入的 `taskId` / `intent` / `autoCommit` / `codeRepo`**，不读取该块中的 `skipAnalysis` 等字段。请以调用参数为准。

常用操作：

```bash
# 添加 / 修改项目、设置默认项目、查看配置
./scripts/setup-yunzhou-config.sh

# 查看配置
cat ~/.yunzhou/config.json | jq
```

---

## 故障排除

### 问题 1：flows-cli 命令未找到

```bash
npm install -g ~/Downloads/flows-cli-*.tgz
which flows-cli  # 验证安装路径
```

### 问题 2：API 调用失败（401 错误）

```bash
flows-cli auth logout
flows-cli auth login-web --json
flows-cli auth whoami --json  # 验证登录状态
```

### 问题 3：返回"需要显式 taskId 和有效 intent"

**原因**：`taskId` 缺失/非正安全整数，或 `intent` 不在 `discuss|investigate|plan|implement` 中。

**解决**：显式传入两者，例如：

```javascript
workflow('devops-automation-loop-yunzhou', {
  taskId: 12345,
  intent: 'plan',
})
```

### 问题 4：返回"任务与仓库未确认"

**原因**：任务 ID 与拉取结果不一致，或无法确定仓库绝对路径。

**解决**：
- 在配置中为项目设置 `codeRepo`（`./scripts/setup-yunzhou-config.sh`）；
- 或调用时传入 `codeRepo`：

```javascript
workflow('devops-automation-loop-yunzhou', {
  taskId: 12345,
  intent: 'plan',
  codeRepo: '/path/to/your/project',
})
```

### 问题 5：返回"独立门禁校验未通过或批准已失效"

**原因**：`review-summary.md` 缺人工签字、裁决为 `BLOCKED`、存在未闭环 Blocker、条件未映射到 `tasks.md`，或评审输入版本已变化。

**解决**：按 Gate 阶段的证据逐项闭环；改回 `design.md` 后需重新评审，签字不可由模型代签。

### 问题 6：返回"无新证据或决策进展，停止重复调用"

**原因**：连续两轮路由给出相同的 action 与 fingerprint。

**解决**：补充新证据（调查结论、决策结论或产物），再重新调用，而不是原样重跑。

### 问题 7：返回"缺少验证通过证据"

**原因**：Verify 阶段未返回 `criticalCount=0`、`testsPassed=true` 或非空 `testsEvidence`。

**解决**：修复验证问题后重新调用；确实不适用测试的场景需按 Verify 指令记录原因与替代验证方式。

### 问题 8：无法拉取任务列表

```bash
# 重新获取项目列表
flows-cli project list --json

# 获取看板信息
flows-cli board show --project-id <project-id> --json

# 检查项目成员权限
flows-cli project members --project-id <project-id> --json
```

---

## 最佳实践

### 1. 按意图分步调用

```javascript
// 第一步：只讨论，确认方向
await workflow('devops-automation-loop-yunzhou', { taskId: 12345, intent: 'discuss' })

// 第二步：生成正式规划并人工确认
await workflow('devops-automation-loop-yunzhou', { taskId: 12345, intent: 'plan' })

// 第三步：授权实施（仍不自动提交）
await workflow('devops-automation-loop-yunzhou', { taskId: 12345, intent: 'implement' })
```

### 2. 提交授权单独给

- 先在 `autoCommit` 关闭的情况下检查代码变更；
- 确认无误后，再显式传入 `autoCommit: true`；
- 推送与 PR 始终在工作流之外人工完成。

### 3. 串行处理任务

```javascript
// ✅ 推荐：串行处理，避免同一仓库并发修改
await workflow('devops-automation-loop-yunzhou', { taskId: 11111, intent: 'implement' })
await workflow('devops-automation-loop-yunzhou', { taskId: 88888, intent: 'implement' })

// ❌ 不推荐：并发处理同一仓库可能冲突
```

### 4. 读取结构化结果

```javascript
const result = await workflow('devops-automation-loop-yunzhou', {
  taskId: 12345,
  intent: 'implement',
})

console.log(JSON.stringify({
  timestamp: new Date().toISOString(),
  status: result.status,
  changeId: result.changeId,
  codeRepo: result.codeRepo,
  verified: result.verified,
  commit: result.commit,
}, null, 2))
```

---

## 相关资源

### 文档

- [DevOps-OpenSpec 集成使用指南](./devops-openspec-integration-guide.md)
- [集成规格文档（历史设计稿）](./specs/devops-openspec-integration.md)
- [文档中心](./README-yunzhou.md)

### 工具

- [工作流源码](../workflow/devops-automation-loop-yunzhou.workflow.js)
- [配置向导脚本](../scripts/setup-yunzhou-config.sh)
- [项目编码规范](../CLAUDE.md)

### 支持

遇到问题？
1. 查看本文档的 [故障排除](#故障排除) 章节
2. 运行诊断命令：`flows-cli health check --json`
3. 检查云舟 CLI 日志
4. 联系团队技术支持
