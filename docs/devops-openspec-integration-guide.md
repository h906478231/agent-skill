# DevOps-OpenSpec 集成工作流使用指南

## 概述

本文档说明云舟任务自动化工作流（`devops-automation-loop-yunzhou`）与 OpenSpec 研发流程的集成方式。

**唯一事实源**：`workflow/devops-automation-loop-yunzhou.workflow.js`。本文档描述的是该源码的**当前实现**；旧版集成方案（`openspec-*` 子工作流调用、`CONFIG` 配置对象、Sync 回写阶段等）已被替换，见[与旧架构的差异](#与旧架构的差异)。

## 实际流程图

阶段清单以源码 `meta.phases` 为准（`devops-automation-loop-yunzhou.workflow.js:22`）：

```
┌─────────────────────────────────────────────────────────────┐
│ Fetch（只读拉取指定云舟任务与项目配置，确认仓库绝对路径）      │
└────────────────────┬────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────────────┐
│ Route（只读检查 change / 产物 / 批准 / 风险）                 │
│ - 输出 action：explore | grill | propose | update | gate |    │
│   apply | quality | verify | done                             │
│ - 输出 gateLevel（L0/L1/L2/L3）、changeRoot、fingerprint      │
│ - 输出 approvalValid、artifactsReady（布尔）                  │
└────────────────────┬────────────────────────────────────────┘
                     ↓
      ┌──────── 按状态循环，最多 6 轮 ────────┐
      │                                       │
      │  Explore  只调查路由列出的关键未知      │
      │  Grill    列出当前 frontier 决策问题    │
      │  Plan     生成/更新正式规划产物         │
      │  Gate     技术评审门禁                  │
      │  GateCheck 独立复核门禁与人工签字       │
      │                                       │
      └───────────────────────────────────────┘
                     ↓（批准有效且 intent=implement）
┌─────────────────────────────────────────────────────────────┐
│ Apply（按已批准方案实施，Seam-first TDD）                     │
└────────────────────┬────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────────────┐
│ Quality（对完整 diff 做代码质量评审）                         │
└────────────────────┬────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────────────┐
│ Verify（criticalCount=0、testsPassed=true 且有测试证据）      │
└────────────────────┬────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────────────┐
│ Commit（仅当显式传入 autoCommit: true 时执行本地 commit）     │
└─────────────────────────────────────────────────────────────┘
```

> **没有 Sync 阶段**：工作流不发布评论、不归档、不关闭云舟任务。返回值中的 `externalActions` 明确写为"未推送、未发 PR、未发布评论、未归档、未关闭任务；这些操作需另行授权"（`workflow.js:229`）。

## 核心改进

### 1. 按状态编排而不是全量串行

- Route 每轮重新读取实际状态（change、产物、批准、风险），据此决定下一步；
- explore / propose / update / gate 完成后回到 Route 重新判定，不把"调用成功"等同于"已具备实施条件"；
- 连续两轮 action 与 fingerprint 相同时立即停止，避免空转。

### 2. 门禁分级由风险判定

- 级别由 Route 根据实际风险等级给出，不按工时或固定复杂度映射；
- 命中 MQ/异步、并发、幂等、分布式一致性、状态机、新表或字段类型变化、万条以上批量、外网接口/上传、权限/租户/敏感数据等任一信号时，至少 L3；
- 命中新风险会重新分级，不确定时不默认 L0。

### 3. 批准独立复核

- Route 报告的 `approvalValid` 不被直接相信；
- GateCheck 阶段独立读取门禁文件，核对裁决、未闭环 Blocker、条件映射、评审输入版本与人工签字；
- 模型署名不算人工批准，禁止代签。

### 4. 副作用分别授权

- 默认不提交；只有本次调用显式传入 `autoCommit: true` 才授权本地 commit；
- 即使授权提交，也只允许本地 commit，禁止 `git add .`、amend、push、PR；
- 评论、归档、关闭任务等外部动作不在工作流内执行。

## 与旧架构的差异

以下能力在**当前源码中不存在**，属于已被替换的旧方案，不要按旧描述实施：

| 旧文档描述 | 当前实现 |
|-----------|---------|
| `CONFIG.GATE_LEVEL_MAP`（trivial/simple/medium/complex/epic → L0/L1/L2/L3） | **不存在**。源码中没有 `CONFIG` 对象；门禁级别由 Route 每轮按风险判定 |
| `CONFIG.CHANGE_ID_PREFIX`（可自定义前缀） | **不存在**。变更 ID 由源码内联为 `` `yunzhou-${input.taskId}` ``，不可配置（`workflow.js:58`） |
| `CONFIG.YUNZHOU_PROFILE` | **不存在**。源码不读取该配置；profile 由 flows-cli 侧管理 |
| `CONFIG.REVIEW_ROLES` | 角色映射存在，但它是源码顶层的 `const REVIEW_ROLES`，不是 `CONFIG` 的字段（`workflow.js:32-36`） |
| `workflow('openspec-explore', {...})` / `workflow('openspec-review')` / `workflow('openspec-apply')` / `workflow('openspec-verify')` | **不存在**。当前实现通过 agent **加载 skill**：`openspec-explore`、`openspec-propose`、`openspec-update-change`、`openspec-technical-review`、`openspec-apply-change`、`openspec-code-quality`、`openspec-verify-change`、`openspec-grill`（`workflow.js:152、154、165、196`） |
| `Sync` 阶段（回写云舟评论） | **不存在**。无评论、无归档、无关闭任务 |
| `Analyze` 阶段、`Develop` 阶段 | **不存在**。对应职责拆为 Fetch / Route / Explore / Grill / Plan |
| Route 输出 `decision`（proceed/clarify/reject）、`complexity` | **不存在**。Route 输出 `action`、`gateLevel`、`changeRoot`、`fingerprint`、`approvalValid`、`artifactsReady` |
| 参数 `skipAnalysis`（跳过分析/路由） | **不存在**。参数校验只接受 `taskId`、`intent`、`autoCommit`、`codeRepo` |
| 参数 `projectName` / `projectId` / `columnId` / `profile` | **不被工作流读取**。任务与仓库的匹配在 Fetch 阶段通过 `codeRepo` 参数或项目配置确认 |
| L0 也需要在 `review-summary.md` 签字 | **不需要**。L0 需返回 `verdict=EXEMPT` 且 `exemptionValid=true`，只记录真实豁免理由（`workflow.js:176-178`） |
| 变更 ID 前缀 `yunzhou-` 可配置 | **不可配置**，见上 |

## 门禁分级与评审角色

源码中的角色定义（`workflow.js:32-36`）：

```javascript
const REVIEW_ROLES = {
  L0: [],
  L1: ['database', 'security'],
  L2: ['architecture', 'database', 'security', 'performance'],
  L3: ['architecture', 'concurrency', 'performance', 'database', 'security'],
}
```

| 级别 | 评审角色 | 人工签字 | 完成条件 |
|------|---------|---------|---------|
| L0 | 无 | 不需要 | `verdict=EXEMPT` 且 `exemptionValid=true` |
| L1 | database + security | 需要 | `verdict=READY_FOR_HUMAN_APPROVAL` 且 `humanApproved=true` |
| L2 | architecture + database + security + performance | 需要 | 同上 |
| L3 | architecture + concurrency + performance + database + security | 需要 | 同上 |

GateCheck 还会要求 `blockerCount=0`、`conditionsMapped=true`、`inputsCurrent=true`（`workflow.js:170-182`）。

## 使用方式

> 当前实现要求显式传入 `taskId`（正安全整数）与 `intent`（`discuss|investigate|plan|implement`），否则直接返回 `blocked`。

### 基本用法

```javascript
// 生成正式规划，完成后暂停等待实施授权
workflow('devops-automation-loop-yunzhou', {
  taskId: 12345,
  intent: 'plan',
})
```

### 完整实施

```javascript
// 规划 → 门禁 → 实施 → 质量评审 → 验证（默认不提交）
workflow('devops-automation-loop-yunzhou', {
  taskId: 12345,
  intent: 'implement',
})
```

### 授权本地提交

```javascript
workflow('devops-automation-loop-yunzhou', {
  taskId: 12345,
  intent: 'implement',
  autoCommit: true,   // 仅授权本地 commit；推送与 PR 仍需人工执行
})
```

### 覆盖代码仓库

```javascript
workflow('devops-automation-loop-yunzhou', {
  taskId: 12345,
  intent: 'plan',
  codeRepo: '/path/to/repo',
})
```

## 常见问题

### Q1: 工作流在需要决策或人工门禁处暂停了，如何继续？

**A**:
1. 查看返回的 `status` 与 `reason`，以及 `history` 中各阶段的证据与未决项；
2. 需要决策时，按 Grill 阶段列出的问题给出结论；已有 change 时未决项写入 `discussion-log.md`；
3. 需要人工批准时，审阅 `review-summary.md`，在文件末尾的"人工确认区"填写签字（L0 除外，L0 不需要签字）；
4. 用**相同参数**重新调用工作流；Route 会依据文件系统与产物状态重新判定，从合适的位置继续。

### Q2: 如何重新运行工作流？

**A**: 使用相同参数再次调用：

```javascript
workflow('devops-automation-loop-yunzhou', {
  taskId: 12345,
  intent: 'implement',
})
```

Route 会读取已有 change、`CONTEXT.md`、ADR 与 `discussion-log.md`，恢复时不覆盖已有的有效设计与评审签字。

### Q3: 如何查看 OpenSpec 产物？

**A**: 变更目录为 `openspec/changes/yunzhou-<task-id>/`。具体的产物清单以 `openspec status` / `openspec instructions` 给出的 CLI schema 依赖为准；评审产物（各维度报告、`review-summary.md`）由 Gate 阶段产出。工作流不会在 `docs/proposals` 另建规划目录。

### Q4: L0 豁免的任务也需要签字吗？

**A**: 不需要。L0 由 GateCheck 核对 `verdict=EXEMPT` 与 `exemptionValid=true`，只需记录真实的豁免理由，不生成人工签字要求。

### Q5: 如何调整某个任务的门禁级别？

**A**: 级别由 Route 每轮根据实际风险重新判定，没有可配置的复杂度映射表。

- 若命中升级信号，级别会自动提升到 L3；
- 若希望降低级别，只能修改**事实与范围**（例如收敛变更范围、去掉高危动作），并补充依据，让 Route 重新判定；
- 手工在 `review-summary.md` 里标注级别**不会**改变 Route 的 `gateLevel`，GateCheck 仍按该级别核对。

### Q6: 工作流失败了怎么办？

**A**: 查看返回的 `reason`。当前源码可能返回的原因包括：

| reason | 含义 |
|--------|------|
| `需要显式 taskId 和有效 intent；默认 intent=plan，不自动编码` | 参数校验不通过 |
| `任务与仓库未确认` | Fetch 结果与输入任务不符，或 `codeRepo` 不是绝对路径 |
| `路由字段不完整` | Route 返回的 action / gateLevel / fingerprint 不合法 |
| `无新证据或决策进展，停止重复调用` | 连续两轮 action 与 fingerprint 相同 |
| `讨论或调查范围已收口，未获规划/实施授权` | `intent` 为 discuss / investigate 且已收口 |
| `规划完成，等待实施授权` | `intent=plan`，需改用 `intent=implement` |
| `必要产物或实际 changeRoot 未确认` | 缺少 `artifactsReady` 或 `changeRoot` 非法 |
| `独立门禁校验未通过或批准已失效` | GateCheck 未通过 |
| `达到调查轮次上限` | 超过 6 轮仍未定案 |
| `实施完成或批准证据不足` | Apply 后核对 tasks / 批准失败 |
| `缺少验证通过证据` | Verify 未返回 `criticalCount=0`、`testsPassed=true` 或非空 `testsEvidence` |
| `本次未完成验证` | 收口时未取得有效验证结论 |
| `提交结果未验证` | 授权提交后未取得合法 `commitSha` |

修复对应问题后重新调用即可。

### Q7: 如何跳过某些步骤？

**A**:

- 跳过实施/验证：使用 `intent: 'discuss'`、`investigate` 或 `plan`；
- 跳过技术评审或人工门禁：**不支持**（安全关键点，源码无对应分支）；
- 源码中**没有** `skipAnalysis` 参数。

如确实需要绕开编排，可直接使用 `/opsx:*` 命令手动执行各阶段。

### Q8: 变更 ID 的命名规则是什么？

**A**: 固定为 `yunzhou-<task-id>`，例如 `yunzhou-12345`。该规则由源码内联生成，不可配置（`workflow.js:58`）。

## 故障排查

### 问题：门禁相关阶段反复返回未通过

**原因**：未闭环 Blocker、条件未映射到 `tasks.md`、评审输入版本已变化，或缺少真实人工签字。

**解决**：按 Gate / GateCheck 返回的 `evidence` 与 `blockers` 逐项闭环；修改 `design.md` 后需重走门禁。禁止代签或覆盖已有报告。

### 问题：人工签字后重新运行仍提示未通过

**原因**：签字为占位符、签名主体是模型而非人工，或评审输入版本与当前产物不一致。

**解决**：确认签字行格式正确且不是占位符（如 `Technical Review Approved: 张三  2026-09-03`）；确认 `design.md` / specs 等评审输入在上次签字后没有变化。

### 问题：工作流运行很慢

**原因**：L3 多角色评审本身耗时较长，或网络影响云舟 API 调用。

**解决**：
- L3 全量评审耗时属正常；
- 检查网络与 flows-cli 配置。

## 变更记录

- **2026-09-16**：按当前源码重写，删除已不存在的 `CONFIG` 配置项、`workflow(...)` 子工作流调用与 Sync 阶段描述。
- **2026-09-03**：初始版本。

## 相关文档

- [OpenSpec AI 研发流程](../workflow/OpenSpec-AI-研发流程.md)
- [集成规格文档（历史设计稿）](./specs/devops-openspec-integration.md)
- [云舟自动化 Loop 使用指南](./yunzhou-automation-loop-readme.md)
