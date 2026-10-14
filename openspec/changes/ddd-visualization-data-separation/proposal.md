# DDD 可视化数据与视图分离

## Why

当前 DDD 流程图工作流（`ddd-visual-modeling`）每次执行都会重新进行完整的代码分析和领域建模（Phase 1-3），即使代码逻辑只有微小变动。这导致两个核心问题：

1. **重复建模浪费**：`ddd-modeling-workflow` 已经产出了 `domain-model.md` 作为领域模型的事实来源，但可视化工作流忽略了这个产物，重新执行建模逻辑，造成 4 个 agent 调用的资源浪费和 30s-2min 的等待时间。

2. **数据视图耦合**：HTML 模板和领域模型数据烘焙在一起生成完整的 HTML 文件。当领域模型数据变动时，必须重新生成整个 HTML，无法实现"改数据 → 刷新页面"的快速反馈循环。

这两个问题的本质是：**关注点未分离** —— 领域模型（数据）、数据格式转换（逻辑）、可视化呈现（视图）三者耦合在一起。

## 第一性原理分析

### 表面需求 vs 底层问题

| 表面需求 | 底层问题 |
|---------|----------|
| "每次都重新生成" | **重复建模**：忽略了已有的 `domain-model.md` 事实来源 |
| "只是数据内容变" | **关注点耦合**：视图（HTML）和数据（model）未分离 |
| "刷新就生效" | **快速反馈循环缺失**：开发者需要秒级的调整-验证周期 |

### 基本约束

**业务约束：**
- `domain-model.md` 是 DDD 建模的唯一事实来源（由 `ddd-artifact-contract` 契约定义）
- 数据格式必须标准化（commands/events/aggregates/policies）
- 向后兼容：现有的工作流和模板仍需支持

**物理约束：**
- 浏览器同源策略：`file:///` 协议下 `fetch()` 受限，需要本地 HTTP 服务器或相对路径同目录部署

**资源约束：**
- 开发时间：方案不能太复杂
- 用户学习成本：使用方式要简单

### 必要性验证

**不做会怎样？**
- ❌ 每次小改动 → 4 个 agent 调用 → 等待 30s-2min
- ❌ 数据无法追溯：HTML 里的数据难以 diff 和版本管理
- ❌ 无法并行工作：视图工程师和数据工程师互相阻塞

**做了能带来什么？**
- ✅ **10x 速度提升**：改数据 → 刷新浏览器（< 1s）
- ✅ **Git 友好**：`ddd-model.json` 纯数据，易于 diff 和 review
- ✅ **关注点分离**：前端工程师改视图，领域专家改模型，互不干扰
- ✅ **可组合性**：同一个 model 可以用多个视图呈现

## What Changes

### 核心架构变更

**当前架构（耦合）：**
```
Workflow (每次运行) 
  → Phase 1: 分析代码/文档
  → Phase 2: DDD 建模
  → Phase 3: 校验
  → Phase 4: 生成完整 HTML（模板+数据烘焙）
  → 输出：event-storm.html（完整文件）
```

**目标架构（解耦）：**
```
domain-model.md (唯一事实来源)
  ↓
Workflow (轻量转换)
  → Phase 1: 读取 domain-model.md
  → Phase 2: 转换为 ddd-model.json
  → Phase 3: 生成静态 HTML 模板 + JSON 文件
  ↓
输出：
  - ddd-model.json（纯数据，Git 可追踪）
  - template.html（静态模板，从外部加载 JSON）

用户体验：
  代码逻辑变 → 重跑 ddd-modeling-workflow → 更新 domain-model.md
  → 运行转换 workflow → 更新 ddd-model.json
  → 刷新浏览器 → 看到最新流程图（< 1s）
```

### 具体变更清单

1. **新增能力**：
   - Markdown 到 JSON 的转换逻辑（解析 `domain-model.md` 表格 → 输出标准 JSON）
   - 静态 HTML 模板（从外部 JSON 加载数据并渲染）
   - `ddd-model.json` 作为独立的数据文件输出

2. **修改能力**：
   - `ddd-visual-modeling` workflow 从"完整建模 + 生成"改为"转换 + 输出"
   - 移除 Phase 1-3 的重复建模逻辑
   - Phase 4 从"模板替换"改为"复制静态模板 + 输出 JSON"

3. **兼容性处理**：
   - 检测 `domain-model.md` 是否存在，不存在时给出明确提示
   - 保留 `template-v1.0.0.html` 作为历史版本，新建 `template-v2.0.0.html` 支持外部数据加载

## Capabilities

### New Capabilities

- `domain-model-parser`：解析 `domain-model.md` 的 Markdown 表格，提取领域事件、命令、聚合、Policy 的结构化数据
- `json-data-output`：输出标准化的 `ddd-model.json` 文件，作为可视化的数据源
- `static-template-rendering`：静态 HTML 模板，支持从外部 JSON 文件加载数据并动态渲染事件风暴流程图

### Modified Capabilities

- `ddd-visual-modeling-workflow`：从"端到端建模 + 生成"改为"转换 + 输出"，依赖 `domain-model.md` 作为输入

## Impact

### 影响范围

**代码层面：**
- `workflow/ddd-visual-modeling.workflow.js`：重构 Phase 1-4 逻辑
- `skills/ddd-event-storm-visualizer/template-v2.0.0.html`：新增支持外部 JSON 加载的模板
- 新增：`ddd-model.json` 输出文件（项目根目录或指定路径）

**依赖关系：**
- **强依赖**：`domain-model.md` 必须存在且符合 `ddd-artifact-contract` 契约
- **弱依赖**：现有的 `template-v1.0.0.html` 仍可使用（向后兼容）

**系统影响：**
- 用户工作流变化：需要先运行 `ddd-modeling-workflow` 生成 `domain-model.md`，再运行 `ddd-visual-modeling` 生成可视化
- 性能提升：从 4 个 agent 调用（30s-2min）降低到 1 个 agent 调用（5-10s）
- 存储：新增 `ddd-model.json` 文件（通常 < 50KB），需要纳入 Git 管理

**破坏性变更：**
- 无。现有的 `ddd-visual-modeling` workflow 仍可工作，但会显示警告提示建议迁移到新架构

### 后续扩展可能性

1. **多视图支持**：同一个 `ddd-model.json` 可以被多个可视化工具消费（时序图、类图、状态机图）
2. **实时预览**：配合文件监听，实现 `domain-model.md` 变动 → 自动转换 → 浏览器热更新
3. **代码生成**：从 `ddd-model.json` 生成聚合骨架代码、命令/事件类定义
4. **文档生成**：从 `ddd-model.json` 生成 API 文档、用户手册

## 风险与权衡

### 技术风险

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| Markdown 表格解析不稳定 | 转换失败 | 提供详细错误提示，指出 `domain-model.md` 中的格式问题 |
| `domain-model.md` 格式不标准 | 转换失败 | 加载 `ddd-artifact-contract` 进行格式校验 |
| 浏览器同源策略限制 | 本地文件无法加载 JSON | 提供使用指引（VS Code Live Server / Python HTTP Server） |

### 接受的权衡

| 权衡项 | 说明 |
|--------|------|
| 需要两步操作 | 用户需要先建模（`ddd-modeling-workflow`）再可视化（`ddd-visual-modeling`），但这符合关注点分离原则 |
| 格式标准化要求 | `domain-model.md` 必须符合 `ddd-artifact-contract` 契约，但这本身就是既定规范 |
| 本地服务器要求 | 需要 HTTP 服务器才能在浏览器中查看，但开发者通常已有此工具（VS Code / IDE 内置） |

## 成功指标

1. **性能提升**：从 30s-2min 降低到 5-10s（80%+ 提升）
2. **复用率**：100% 复用 `domain-model.md`，0% 重复建模
3. **可追溯性**：`ddd-model.json` 纳入 Git，可 diff 和 review
4. **用户反馈**：快速迭代体验改善（目标：< 1s 从数据变动到视图更新）
