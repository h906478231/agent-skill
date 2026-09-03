# DevOps Automation Loop 与 OpenSpec 工作流集成重构

## Problem Statement

当前存在两套并行的需求分析和方案设计流程：

1. **devops-automation-loop-yunzhou.workflow.js** 的 Analyze 步骤执行需求完整性检查、技术可行性评估、复杂度评估和风险识别
2. **OpenSpec 工作流**的 Phase 1-2 执行需求澄清（含第一性原理分析）和方案探索（含候选方案四维对比矩阵）

这导致：
- 功能重复：相同的分析工作被执行两次，浪费计算资源和时间
- 维护负担：两套规则需要同步维护，容易产生不一致
- 流程混乱：开发者不清楚应该信任哪一套分析结果

用户原本使用 OpenSpec 工作流（vibecoding 方式），后来为了接入云舟任务管理系统实现自动化（自动拉取任务、评论、提交），引入了 devops-automation-loop，但没有正确地将两者集成。

## Solution

将 devops-automation-loop 重新定位为**自动化编排层**，OpenSpec 工作流作为**标准研发流程执行层**：

- **devops-loop** 负责：云舟任务拉取、快速路由决策、人工门禁等待、结果回写
- **OpenSpec** 负责：所有深度需求分析、方案设计、技术评审、代码实施和验证

具体改进：
1. 将 devops-loop 的 `Analyze` 步骤精简为 `Route` 步骤，仅做复杂度快速分类（5分钟内完成）
2. 所有任务都调用 OpenSpec Explore（Phase 1-2）进行深度需求澄清和方案设计
3. 根据复杂度自动决定技术门禁级别（L0/L1/L2/L3）
4. 人工门禁确认后，自动继续执行 OpenSpec Apply → Verify，并回写云舟

## User Stories

1. 作为开发者，我希望云舟任务被自动拉取并分析，这样我不需要手动轮询任务列表
2. 作为开发者，我希望简单任务（typo、配置调整）能快速识别并豁免技术门禁，这样不会被流程拖慢
3. 作为开发者，我希望所有任务都经过 OpenSpec 的需求澄清和方案设计，这样确保方向正确
4. 作为开发者，我希望复杂任务自动执行五维度技术评审，这样不会遗漏安全、性能、并发等风险
5. 作为开发者，我希望中等复杂度任务只执行必要的评审维度，这样节省时间
6. 作为架构师，我希望在代码实施前有明确的人工确认点，这样可以对关键决策负责
7. 作为开发者，我希望人工签字后流程自动继续，这样不需要手动触发后续步骤
8. 作为开发者，我希望验证完成后结果自动回写到云舟任务，这样任务状态保持同步
9. 作为团队负责人，我希望每个任务的分析、评审、实施产物都被归档，这样可以追溯决策过程
10. 作为开发者，我希望任务信息不完整时能自动回复评论要求补充，这样减少人工沟通成本
11. 作为开发者，我希望明显不合理的任务能被自动拒绝并说明理由，这样避免浪费资源
12. 作为开发者，我希望 L0 豁免的任务也有记录留痕，这样符合审计要求
13. 作为开发者，我希望路由决策只需要快速分类，深度分析交给 OpenSpec，这样避免重复劳动
14. 作为项目经理，我希望能从云舟任务直接追溯到 OpenSpec 变更文档，这样了解每个任务的技术细节
15. 作为开发者，我希望工作流能自动映射云舟任务到 OpenSpec 变更 ID，这样不需要手动管理映射关系

## Implementation Decisions

### 架构决策

**AD-1: 两层架构模型**
- **编排层**（devops-automation-loop）：负责外部系统集成（云舟 API）、任务路由、流程编排、人工门禁等待
- **执行层**（OpenSpec workflows）：负责研发流程的核心逻辑（需求分析、方案设计、技术评审、代码实施）
- 理由：职责分离，OpenSpec 保持独立可用（可手动触发），devops-loop 作为自动化包装层

**AD-2: 变更 ID 映射规则**
- 云舟任务 ID → OpenSpec 变更 ID 的映射规则：`yunzhou-${taskId}`
- 例如：云舟任务 `12345` → OpenSpec 变更目录 `openspec/changes/yunzhou-12345/`
- 理由：保持可追溯性，避免 ID 冲突

**AD-3: 门禁分级自动决策**
- 复杂度到门禁级别的映射：
  - `trivial` → `L0`（豁免，记录理由）
  - `simple` → `L1`（database + security 两维度）
  - `medium` → `L2`（architecture + database + security + performance 四维度）
  - `complex` → `L3`（全部五维度）
  - `epic` → `L3`（全部五维度）
- 理由：遵循 OpenSpec 文档的分级规则，避免过度评审或评审不足

**AD-4: 人工门禁的实现方式**
- 采用轮询检查 `review-summary.md` 是否包含签字行（非占位符）
- 未签字时工作流暂停并返回，提示开发者签字
- 签字后可重新运行工作流，自动从 Apply 阶段继续
- 理由：符合 OpenSpec 的人工门禁设计，保持流程一致性

### 模块修改决策

**MD-1: 重命名 Analyze phase 为 Route phase**
- 原 `phase('Analyze')` → 新 `phase('Route')`
- 职责变更：从"深度分析"变为"快速路由决策"
- 输出 schema 简化：移除技术可行性、详细风险等字段，只保留 decision/complexity/reasoning

**MD-2: 新增 OpenSpec 工作流调用**
- 在 Route 之后添加三个新 phase：
  - `phase('OpenSpec Explore')`：调用 `workflow('openspec-explore')`
  - `phase('Gate Decision')`：根据复杂度决定评审级别，可能调用 `workflow('openspec-review')`
  - `phase('Human Gate')`：等待人工签字确认
- 传递参数：`{ change: changeId, taskInfo: task, complexity: routing.complexity }`

**MD-3: 修改 Implement phase 的实现方式**
- 原方案：devops-loop 内部实现代码生成
- 新方案：调用 `workflow('openspec-apply', { change: changeId })`
- 理由：统一代码实施流程，遵循 OpenSpec 的标准

**MD-4: 增强 Verify phase**
- 在现有项目测试之前，先调用 `workflow('openspec-verify', { change: changeId })`
- 执行 OpenSpec 的三维校验（Completeness/Correctness/Coherence）
- 理由：确保实现与设计一致性

**MD-5: L0 豁免记录生成**
- 当 `gateLevel === 'L0'` 时，自动创建 `review-summary.md` 记录豁免理由
- 包含字段：变更、豁免级别、豁免理由、豁免人、豁免时间
- 理由：符合审计要求，所有变更都有评审记录（即使是豁免）

### 接口契约

**IC-1: Route phase 输出 schema**
```typescript
{
  decision: 'proceed' | 'clarify' | 'reject',
  complexity: 'trivial' | 'simple' | 'medium' | 'complex' | 'epic',
  reasoning: string,  // 1-2句话的简短理由
  missingInfo?: string  // 仅当 decision='clarify' 时必填
}
```

**IC-2: OpenSpec workflow 调用参数**
```typescript
// openspec-explore
{
  change: string,           // 变更 ID，格式 yunzhou-${taskId}
  taskInfo: object,         // 云舟任务完整信息
  complexity: string        // Route 阶段判定的复杂度
}

// openspec-review
{
  change: string,
  roles: string[]           // 需要评审的维度，如 ['database', 'security']
}

// openspec-apply, openspec-verify
{
  change: string
}
```

**IC-3: 云舟 API 调用契约**
- 使用 `flows-cli` 命令行工具
- 添加评论：`flows-cli task comment add --task-id <id> --content <text> --external-key <key> --profile <profile> --json`
- 必须指定 `--external-key` 避免重复评论
- 必须检查命令执行结果确保成功

### 数据流决策

**DF-1: 任务信息传递**
- 云舟任务信息在整个流程中向下传递，不回传修改
- Route → OpenSpec Explore → Review → Apply → Verify
- 每个阶段的产物写入 `openspec/changes/${changeId}/` 目录

**DF-2: 状态持久化**
- 工作流状态不持久化（每次重新运行从头开始）
- 依赖文件系统状态判断进度（如检查 review-summary.md 是否存在签字）
- 理由：简化实现，文件系统已是可靠的状态存储

## Testing Decisions

### 测试原则
- 测试外部行为，不测试内部实现细节
- 每个 phase 的输出作为测试验证点
- 使用 workflow 执行结果的返回值和文件系统产物进行断言

### 测试模块

**TM-1: Route phase 测试**
- 测试场景：
  - 任务信息完整 → decision='proceed'
  - 任务缺少关键字段 → decision='clarify' 且 missingInfo 非空
  - 任务明显不合理 → decision='reject'
  - 不同任务描述 → 正确分类为 trivial/simple/medium/complex/epic
- 验证点：输出 schema 符合契约，reasoning 字段非空

**TM-2: Gate Decision 逻辑测试**
- 测试场景：
  - trivial 复杂度 → L0 豁免，创建 review-summary.md 包含豁免记录
  - simple 复杂度 → L1 评审，roles=['database', 'security']
  - medium 复杂度 → L2 评审，roles=['architecture', 'database', 'security', 'performance']
  - complex 复杂度 → L3 评审，roles 包含全部五个维度
- 验证点：workflow 调用参数正确，文件系统产物存在

**TM-3: 集成测试**
- 端到端场景：
  - 简单任务流程：Route(simple) → Explore → L1 Review → Human Gate → Apply → Verify → Report
  - 复杂任务流程：Route(complex) → Explore → L3 Review → Human Gate → Apply → Verify → Report
  - L0 豁免流程：Route(trivial) → Explore → 跳过 Review → Human Gate → Apply → Verify → Report
- 验证点：
  - 每个阶段的产物文件存在且内容正确
  - 云舟评论被正确添加
  - 人工门禁未签字时工作流正确暂停

### 测试参考

**现有测试模式**
- workflow 测试位于 `workflow/*.test.js`（如果存在）
- 使用 mock 数据模拟云舟任务和 workflow 调用
- 文件系统操作使用临时目录

**测试工具**
- 使用项目现有的测试框架（需确认是否为 Jest/Vitest）
- workflow 调用可通过 stub 方式模拟返回值
- 文件系统断言使用 `fs.existsSync()` 和 `fs.readFileSync()`

## Out of Scope

以下内容不在本次重构范围内：

1. **OpenSpec 工作流本身的修改**：OpenSpec explore/review/apply/verify 的内部逻辑保持不变，本次只做集成
2. **云舟 API 的增强**：flows-cli 工具的能力和接口保持现状，不扩展新功能
3. **人工门禁的 UI 改进**：仍然通过手动编辑文件签字，不开发独立的审批界面
4. **实时通知机制**：人工门禁等待期间不发送邮件/钉钉通知，开发者需主动检查
5. **多仓库支持**：当前仅支持单个代码仓库，不考虑跨仓库变更场景
6. **历史任务迁移**：已存在的云舟任务不自动迁移到新流程，仅对新任务生效
7. **性能优化**：暂不优化 workflow 调用的性能（如并行执行多个 phase）
8. **错误恢复机制**：工作流中断后需手动重新运行，不实现自动断点续传
9. **权限控制**：不在 workflow 层面实现签字人权限校验，依赖团队自觉

## Further Notes

### 向后兼容性
- 旧的 `/openspec:explore` 等手动触发方式仍然可用
- devops-loop 是可选的自动化层，不影响纯 OpenSpec 工作流的使用
- 已存在的 OpenSpec 变更目录不受影响

### 迁移路径
1. 先修改 devops-automation-loop-yunzhou.workflow.js 文件
2. 验证单个任务的完整流程（从拉取到回写）
3. 在小范围试运行 1-2 周
4. 收集反馈后调整门禁分级规则
5. 正式推广到所有云舟任务

### 配置项
建议在 workflow 文件开头添加配置常量：
```javascript
const CONFIG = {
  // 复杂度到门禁级别的映射（可调整）
  GATE_LEVEL_MAP: {
    trivial: 'L0',
    simple: 'L1',
    medium: 'L2',
    complex: 'L3',
    epic: 'L3'
  },
  
  // 门禁级别到评审维度的映射
  REVIEW_ROLES: {
    L0: [],
    L1: ['database', 'security'],
    L2: ['architecture', 'database', 'security', 'performance'],
    L3: ['architecture', 'concurrency', 'performance', 'database', 'security']
  },
  
  // 云舟相关配置
  YUNZHOU_PROFILE: process.env.YUNZHOU_PROFILE || 'default',
  
  // 变更 ID 前缀
  CHANGE_ID_PREFIX: 'yunzhou-'
}
```

### 监控和可观测性
建议在每个关键 phase 添加日志：
- Route 决策结果和理由
- OpenSpec workflow 调用的参数和返回值
- 门禁级别和评审维度
- 人工门禁等待状态
- 云舟 API 调用的成功/失败

### 已知限制
- 人工门禁等待采用轮询方式，效率较低（未来可改为文件监听）
- workflow 调用失败时错误信息可能不够详细（依赖 OpenSpec workflow 的错误处理）
- 复杂度分类依赖 LLM 判断，可能存在误判（建议人工在 review-summary.md 中可以调整门禁级别）
