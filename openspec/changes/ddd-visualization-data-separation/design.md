# DDD 可视化数据与视图分离 - 技术设计

## Context

### 当前状态

`ddd-visual-modeling` workflow 目前采用"端到端建模 + 生成"架构：

```
Phase 1: 代码/文档分析 (agent 调用)
  ↓
Phase 2: DDD 建模 (agent 调用)
  ↓
Phase 3: 数据校验 (agent 调用)
  ↓
Phase 4: 模板替换生成完整 HTML (agent 调用)
  ↓
输出：event-storm.html (模板 + 数据烘焙在一起)
```

**核心问题：**
1. 忽略了 `ddd-modeling-workflow` 已产出的 `domain-model.md` 事实来源
2. 4 个 agent 调用造成 30s-2min 等待时间
3. HTML 和数据耦合，无法实现快速迭代

### 约束条件

**技术约束：**
- `domain-model.md` 格式由 `ddd-artifact-contract` 契约定义，是稳定的标准格式
- 现有的 `template-v1.0.0.html` 已在使用，需向后兼容
- 浏览器同源策略限制本地文件加载外部资源

**业务约束：**
- `domain-model.md` 是 DDD 建模的唯一事实来源，不能被绕过
- 用户期望的工作流：建模 → 可视化 → 迭代调整 → 刷新查看

**资源约束：**
- 开发时间目标：3 天完成 MVP
- 维护成本：尽量复用现有组件，避免引入新依赖

### 利益相关者

- **领域建模者**：期望 `domain-model.md` 作为唯一事实来源，避免数据不一致
- **可视化用户**：期望快速迭代（秒级反馈），而非每次等待 30s-2min
- **前端工程师**：期望视图和数据分离，可以独立调整 HTML 模板
- **系统维护者**：期望降低 token 消耗和执行时间

## Goals / Non-Goals

### Goals

1. **数据源统一**：`domain-model.md` 作为唯一事实来源，`ddd-model.json` 从其转换而来
2. **关注点分离**：HTML 模板（视图）、`ddd-model.json`（数据）、转换逻辑（控制器）三者解耦
3. **性能提升**：从 4 个 agent 调用降低到 1 个，执行时间从 30s-2min 降低到 5-10s
4. **快速反馈**：数据变动 → 刷新浏览器 → 查看最新流程图（< 1s）
5. **Git 友好**：`ddd-model.json` 作为纯数据文件，易于 diff 和 review
6. **向后兼容**：保留 `template-v1.0.0.html`，用户可选择使用

### Non-Goals

1. **不实现热更新**：MVP 阶段不实现文件监听 + 自动刷新，用户手动刷新浏览器即可
2. **不支持多格式输入**：MVP 阶段只支持从 `domain-model.md` 转换，不支持从 YAML/JSON 等其他格式导入
3. **不重构现有建模流程**：`ddd-modeling-workflow` 保持不变，只改造可视化 workflow
4. **不引入前端框架**：MVP 阶段保持纯 HTML + Vanilla JS，不引入 Vue/React
5. **不实现多视图支持**：MVP 阶段只支持事件风暴流程图，不扩展到时序图/类图等其他视图

## Decisions

### 决策 1：数据格式 - 选择 JSON 而非 YAML

**候选方案：**
- **方案 A**：JSON 格式（`ddd-model.json`）
- **方案 B**：YAML 格式（`ddd-model.yaml`）
- **方案 C**：保持 Markdown 格式，直接在前端解析

**选择：方案 A - JSON**

**理由：**
1. **浏览器原生支持**：`fetch().then(r => r.json())` 无需额外解析库
2. **类型安全**：JSON 结构清晰，易于校验和 TypeScript 类型定义
3. **生态成熟**：JSON Schema、JSON Diff 工具链完善
4. **传输效率**：相比 Markdown，JSON 更紧凑，无需复杂的表格解析

**权衡：**
- ❌ JSON 可读性不如 YAML（但 `domain-model.md` 已经是人类可读的版本）
- ❌ JSON 不支持注释（可在 `domain-model.md` 中注释，转换时保留到 `description` 字段）

### 决策 2：转换逻辑 - Agent 解析 vs 正则表达式

**候选方案：**
- **方案 A**：Agent 解析（LLM 理解 Markdown 并输出 JSON）
- **方案 B**：正则表达式 + 手写解析器
- **方案 C**：Markdown AST 解析（使用 remark/unified 等库）

**选择：方案 A - Agent 解析**

**理由：**
1. **鲁棒性**：Agent 能容忍格式的微小变化（如空格、换行差异）
2. **语义理解**：Agent 能理解 "E1, E2" → `["E1", "E2"]` 的语义转换
3. **快速实现**：无需编写复杂的解析器代码，prompt 即可
4. **错误处理**：Agent 能给出自然语言的错误提示（"第 X 行的事件名称缺失"）

**权衡：**
- ❌ Agent 调用有成本（但 1 次 agent 调用 << 4 次 agent 调用）
- ❌ Agent 输出不如代码解析器稳定（通过 schema validation 缓解）

**未来优化路径：**
- 当 `domain-model.md` 格式完全稳定后，可替换为正则表达式解析器
- 短期内 Agent 解析更灵活，适合 MVP 阶段

### 决策 3：模板架构 - 静态模板 + 外部加载 vs SPA 框架

**候选方案：**
- **方案 MVP**：静态 HTML + Vanilla JS，`fetch()` 加载外部 JSON
- **方案 A**：Vite + Vue/React 前端框架
- **方案 B**：服务端渲染（SSR）

**选择：方案 MVP - 静态模板**

**理由：**
1. **零依赖**：无需 `npm install`，一个 HTML 文件即可运行
2. **向后兼容**：复用 `template-v1.0.0.html` 的渲染逻辑，只改数据加载方式
3. **部署简单**：直接用 VS Code Live Server 或 `python -m http.server` 即可
4. **满足需求**：当前不需要组件化、状态管理等复杂功能

**权衡：**
- ❌ 扩展性受限（未来需要多视图时可能需要重构）
- ❌ 无热更新（需要手动刷新浏览器）

**升级路径：**
```
MVP (静态模板)
  ↓ (需要热更新时)
方案 B (本地 Server + WebSocket)
  ↓ (需要组件化/多视图时)
方案 A (前端框架)
```

### 决策 4：文件组织 - 单文件 vs 多文件

**候选方案：**
- **方案 A**：单文件 `ddd-model.json`（所有数据在一个 JSON）
- **方案 B**：多文件结构（`commands.json`、`events.json`、`aggregates.json`、`policies.json`）

**选择：方案 A - 单文件**

**理由：**
1. **原子性**：单次转换输出一个完整的数据快照
2. **部署简单**：只需复制一个 JSON 文件
3. **版本管理**：Git diff 一个文件即可看到所有变更
4. **浏览器加载**：一次 `fetch()` 请求即可获取所有数据

**权衡：**
- ❌ 大规模数据时文件可能较大（但实际场景中单个子域的 DDD 模型通常 < 100KB）
- ❌ 部分更新不如多文件灵活（但 MVP 阶段完全重新生成更简单）

### 决策 5：Workflow 路径选择 - 检测降级 vs 强制依赖

**候选方案：**
- **方案 A**：检测 `domain-model.md` 存在 → 转换路径；不存在 → 重新建模路径（双轨制）
- **方案 B**：强制依赖 `domain-model.md`，不存在则报错
- **方案 C**：智能推荐（检测到不存在时提示用户选择）

**选择：方案 B - 强制依赖**

**理由：**
1. **职责清晰**：建模和可视化完全分离，避免职责混淆
2. **维护简单**：只需维护一条转换路径，不需要兼容两套逻辑
3. **强制最佳实践**：确保 `domain-model.md` 作为唯一事实来源
4. **降低复杂度**：避免双轨制的路径选择逻辑和测试成本

**权衡：**
- ❌ 用户需要两步操作（先建模再可视化）
- ✅ 但这符合"关注点分离"原则，用户体验更清晰

**错误提示设计：**
```
❌ 未找到 domain-model.md，请先运行 ddd-modeling-workflow 完成建模。

提示：
1. 运行 workflow: ddd-modeling-workflow
2. 生成 domain-model.md 后，再运行 ddd-visual-modeling
```

### 决策 6：数据校验 - 转换时校验 vs 运行时校验

**候选方案：**
- **方案 A**：转换时校验（Agent 输出后立即校验）
- **方案 B**：运行时校验（浏览器加载 JSON 时校验）
- **方案 C**：双重校验（转换时 + 运行时都校验）

**选择：方案 C - 双重校验**

**理由：**
1. **转换时校验**：确保生成的 JSON 符合规范，避免写入错误数据
2. **运行时校验**：防御性编程，处理手动编辑 JSON 或版本不兼容的情况
3. **快速失败**：转换时失败 → 阻止生成；运行时失败 → 友好错误提示

**校验规则：**
- **引用一致性**：命令引用的 aggregate 必须存在、事件 ID 必须存在
- **必填字段**：`id`、`name`、`className` 不能为空
- **数组格式**：`events`、`listenEvents`、`triggerCommands` 必须是数组
- **递归风险**：Policy 不能形成循环依赖（未来扩展）

### 决策 7：模板版本管理 - 独立版本 vs 覆盖升级

**候选方案：**
- **方案 A**：独立版本（`template-v2.0.0.html`，保留 `template-v1.0.0.html`）
- **方案 B**：覆盖升级（直接替换 `template-v1.0.0.html`）

**选择：方案 A - 独立版本**

**理由：**
1. **向后兼容**：已有用户的 `template-v1.0.0.html` 继续可用
2. **渐进迁移**：用户可以自主选择何时切换到新版本
3. **回退能力**：如果 v2.0.0 有问题，用户可以回退到 v1.0.0

**版本策略：**
- v1.0.0：数据烘焙模式（`{{MODEL_DATA}}` 占位符）
- v2.0.0：外部加载模式（`fetch('./ddd-model.json')`）
- 未来 v3.0.0：可能引入 WebSocket 热更新、多视图支持等

## Risks / Trade-offs

### 风险 1：Markdown 表格解析不稳定

**风险：** Agent 解析 Markdown 表格时可能因为格式差异（空格、换行）导致解析失败或数据错误。

**缓解措施：**
1. **Schema 校验**：转换后的 JSON 通过 JSON Schema 校验，不符合规范立即报错
2. **详细错误提示**：Agent prompt 要求输出详细的错误位置（"第 X 行的事件名称缺失"）
3. **格式规范化**：在 `ddd-artifact-contract` 中明确 Markdown 表格的格式要求
4. **未来优化**：当格式稳定后，替换为正则表达式解析器

### 风险 2：浏览器同源策略限制

**风险：** 用户通过 `file:///` 协议直接打开 HTML 文件时，浏览器阻止 `fetch()` 加载外部 JSON。

**缓解措施：**
1. **明确提示**：HTML 检测到 `file://` 协议时，显示清晰的错误提示和解决方案
2. **使用指引**：workflow 成功执行后，提示用户使用 VS Code Live Server 或 `python -m http.server`
3. **降级方案**：提供 v1.0.0 模板作为备选（数据烘焙模式不受同源策略限制）

**错误提示设计：**
```html
<div class="error-notice" style="display: none;">
  检测到 file:// 协议，无法加载 JSON 数据。

  请使用以下方式之一：
  1. VS Code Live Server: 右键点击 HTML → "Open with Live Server"
  2. Python HTTP Server: `python -m http.server`
  3. 其他 IDE 内置服务器
</div>
```

### 风险 3：domain-model.md 格式不符合契约

**风险：** 用户的 `domain-model.md` 可能不符合 `ddd-artifact-contract` 契约（如列名错误、章节缺失）。

**缓解措施：**
1. **契约加载**：转换前加载 `ddd-artifact-contract` 进行格式预校验
2. **格式检测**：Agent prompt 明确列出必需的章节和列名
3. **修复建议**：错误提示中给出修复建议（"缺少 '## 1. 领域事件清单' 章节，请检查 domain-model.md"）

### 风险 4：性能目标未达成

**风险：** 转换 agent 调用时间可能超过预期，无法实现 5-10s 的目标。

**缓解措施：**
1. **Prompt 优化**：精简 agent prompt，只传递必要的上下文
2. **增量转换**：未来扩展支持只转换变更部分（通过 Git diff 检测）
3. **缓存机制**：未来扩展支持缓存未变更的转换结果

**降级方案：** 即使转换时间为 15-20s，仍比原来的 30s-2min 有显著提升。

### 风险 5：JSON 文件冲突

**风险：** 多人协作时，`ddd-model.json` 可能产生 Git 冲突。

**缓解措施：**
1. **生成文件标记**：在 JSON 文件头部添加注释（通过包装对象实现）
   ```json
   {
     "_meta": {
       "generated": "2026-08-30T10:00:00Z",
       "source": "domain-model.md",
       "version": "2.0.0"
     },
     "commands": { ... }
   }
   ```
2. **冲突解决策略**：发生冲突时，重新运行转换 workflow 生成最新版本
3. **.gitattributes 配置**：标记 `ddd-model.json` 为生成文件
   ```
   ddd-model.json linguist-generated=true
   ```

### Trade-off 1：两步操作 vs 一键生成

**权衡：** 用户需要先运行 `ddd-modeling-workflow`，再运行 `ddd-visual-modeling`，不如原来的"一键生成"方便。

**收益：** 关注点分离带来的架构清晰度、复用性、可维护性远超过操作步骤增加的成本。

**未来优化：** 可以提供一个封装 workflow，内部串联调用两个 workflow。

### Trade-off 2：手动刷新 vs 自动热更新

**权衡：** 用户需要手动刷新浏览器（F5），不如自动热更新流畅。

**收益：** MVP 阶段避免引入文件监听、WebSocket 等复杂机制，降低实现成本和维护负担。

**未来优化：** 方案 B（本地 Server + WebSocket）可以实现热更新。

## Architecture Diagram

### 整体数据流

```
┌─────────────────────────────────────────────────────────┐
│  Phase 1: DDD 建模（ddd-modeling-workflow）            │
│                                                         │
│  代码 + 文档 → 分析 → 建模 → domain-model.md          │
│                                  │                      │
│                                  │ (唯一事实来源)       │
└──────────────────────────────────┼─────────────────────┘
                                   │
                                   │
┌──────────────────────────────────▼─────────────────────┐
│  Phase 2: 可视化生成（ddd-visual-modeling）            │
│                                                         │
│  ┌──────────────┐    ┌──────────────┐                 │
│  │ Read         │    │ Parse        │                 │
│  │ domain-model │───▶│ Markdown     │                 │
│  │ .md          │    │ Tables       │                 │
│  └──────────────┘    └──────┬───────┘                 │
│                             │                          │
│                             ▼                          │
│                      ┌──────────────┐                 │
│                      │ Agent        │                 │
│                      │ Convert to   │                 │
│                      │ JSON         │                 │
│                      └──────┬───────┘                 │
│                             │                          │
│                             ▼                          │
│                      ┌──────────────┐                 │
│                      │ Validate     │                 │
│                      │ JSON Schema  │                 │
│                      └──────┬───────┘                 │
│                             │                          │
│                   ┌─────────┴─────────┐               │
│                   ▼                   ▼               │
│            ┌─────────────┐     ┌─────────────┐       │
│            │ Write       │     │ Copy        │       │
│            │ ddd-model   │     │ template-   │       │
│            │ .json       │     │ v2.0.0.html │       │
│            └─────────────┘     └─────────────┘       │
└─────────────────────────────────────────────────────┘
                   │                   │
                   │                   │
                   ▼                   ▼
            ┌─────────────────────────────────┐
            │  Deployment (本地 HTTP Server)  │
            │                                 │
            │  template-v2.0.0.html           │
            │  ddd-model.json                 │
            └────────────┬────────────────────┘
                         │
                         ▼
            ┌─────────────────────────┐
            │  Browser                │
            │                         │
            │  1. Load HTML           │
            │  2. Fetch JSON          │
            │  3. Render Flow Chart   │
            └─────────────────────────┘
```

### 转换 Agent Prompt 结构

```
┌─────────────────────────────────────────────┐
│  Agent Prompt                               │
├─────────────────────────────────────────────┤
│                                             │
│  Context:                                   │
│  - 你是 Markdown 到 JSON 的转换专家         │
│  - 输入：domain-model.md 内容              │
│  - 输出：标准 ddd-model.json               │
│                                             │
│  Parsing Rules:                             │
│  1. 从 "## 1. 领域事件清单" 提取 events    │
│  2. 从 "## 2. 领域命令清单" 提取 commands  │
│  3. 从 "## 3. Policy 清单" 提取 policies   │
│  4. 从 "## 4. 聚合设计" 提取 aggregates    │
│                                             │
│  Transformation Rules:                      │
│  - "E1, E2" → ["E1", "E2"]                 │
│  - "监听事件" → listenEvents (plural)      │
│  - "触发命令" → triggerCommands (plural)   │
│                                             │
│  Output Format:                             │
│  {                                          │
│    "commands": { "C1": {...}, ... },       │
│    "events": { "E1": {...}, ... },         │
│    "aggregates": { "Order": {...}, ... },  │
│    "policies": { "P1": {...}, ... }        │
│  }                                          │
│                                             │
│  Error Handling:                            │
│  - 缺少必需章节 → 返回错误 + 章节名称       │
│  - 必填字段为空 → 返回错误 + 行号 + 字段名 │
│  - 表格列名错误 → 返回错误 + 期望格式       │
└─────────────────────────────────────────────┘
```

### template-v2.0.0.html 结构

```html
<!DOCTYPE html>
<html>
<head>
  <title>DDD Event Storm - {{DOMAIN_NAME}}</title>
  <style>
    /* 复用 v1.0.0 的 CSS */
    /* 新增：错误提示样式 */
  </style>
</head>
<body>
  <div id="app">
    <div class="loading">正在加载数据...</div>
    <div class="error" style="display:none;"></div>
    <div class="content" style="display:none;">
      <!-- 流程图渲染区域 -->
    </div>
  </div>

  <script>
    // 1. 检测协议
    if (window.location.protocol === 'file:') {
      showError('检测到 file:// 协议...');
      return;
    }

    // 2. 获取 JSON 路径（支持 URL 参数）
    const params = new URLSearchParams(window.location.search);
    const dataPath = params.get('data') || './ddd-model.json';

    // 3. 加载 JSON
    fetch(dataPath + '?t=' + Date.now())
      .then(r => {
        if (!r.ok) throw new Error('无法加载 ' + dataPath);
        return r.json();
      })
      .then(data => {
        // 4. 校验 JSON 格式
        if (!data.commands || !data.events) {
          throw new Error('JSON 格式错误：缺少顶层键');
        }
        // 5. 渲染流程图
        renderEventStorm(data);
      })
      .catch(err => {
        showError(err.message);
      });

    function renderEventStorm(data) {
      // 复用 v1.0.0 的渲染逻辑
      // ...
    }

    function showError(message) {
      // 显示友好的错误提示
      // ...
    }
  </script>
</body>
</html>
```

## Migration Plan

### 阶段 1：实现核心转换逻辑（1 天）

**任务：**
1. 修改 `workflow/ddd-visual-modeling.workflow.js`
   - 移除 Phase 1-3 的建模逻辑
   - 新增 Phase 1：读取 `domain-model.md`
   - 新增 Phase 2：调用转换 agent
   - 新增 Phase 3：输出 JSON 和 HTML
2. 编写转换 agent 的 prompt
3. 编写 JSON Schema 校验逻辑

**验证：**
- 输入标准的 `domain-model.md` → 输出正确的 `ddd-model.json`
- 缺少必需章节 → 清晰的错误提示
- 表格格式错误 → 指出具体行号和字段

### 阶段 2：实现静态模板（1 天）

**任务：**
1. 创建 `template-v2.0.0.html`
   - 实现 `fetch()` 加载 JSON
   - 实现 file:// 协议检测和错误提示
   - 实现 JSON 格式校验
   - 复用 v1.0.0 的渲染逻辑
2. 添加 URL 参数支持（`?data=...`）
3. 添加缓存破坏机制（`?t=...`）

**验证：**
- 通过 HTTP Server 打开 HTML → 成功渲染流程图
- 通过 file:// 打开 HTML → 显示清晰的错误提示
- 修改 JSON 后刷新 → 显示最新数据（无缓存问题）

### 阶段 3：集成测试和文档（1 天）

**任务：**
1. 端到端测试
   - 运行 `ddd-modeling-workflow` → 生成 `domain-model.md`
   - 运行 `ddd-visual-modeling` → 生成 `ddd-model.json` 和 HTML
   - 打开浏览器 → 验证流程图正确渲染
2. 编写使用文档
   - 快速开始指南
   - 故障排查指南
   - 迁移指南（v1.0.0 → v2.0.0）
3. 性能测试
   - 测量执行时间（目标 < 10s）
   - 测量 token 消耗（目标降低 75%）

**验证：**
- 所有测试用例通过
- 文档完整且易读
- 性能目标达成

### 回退策略

**如果新架构出现严重问题：**
1. 用户可以继续使用 `template-v1.0.0.html`（数据烘焙模式）
2. 可以暂时禁用新的 workflow，回退到旧版本
3. `domain-model.md` 仍然是事实来源，不会丢失数据

**回退触发条件：**
- 转换成功率 < 90%（一周内）
- 用户反馈严重的可用性问题
- 性能未达到目标（> 30s）

## Open Questions

### Q1: 是否需要支持增量转换？

**背景：** 当 `domain-model.md` 只有部分聚合变动时，是否需要只转换变动部分，而保留 `ddd-model.json` 中未变动的数据？

**选项：**
- **选项 A**：MVP 阶段完全重新生成（简单）
- **选项 B**：支持增量转换（复杂，需要 diff 检测）

**建议：** MVP 阶段选择 A，未来根据用户反馈决定是否实现 B。

### Q2: JSON Schema 版本管理策略？

**背景：** `ddd-model.json` 的格式可能随时间演进（如新增字段、废弃字段）。

**选项：**
- **选项 A**：在 JSON 中添加 `_meta.version` 字段
- **选项 B**：通过文件名版本化（`ddd-model.v2.json`）
- **选项 C**：不显式版本化，依赖向后兼容设计

**建议：** 选择 A，在 `_meta` 对象中记录版本号，方便未来迁移。

### Q3: 是否需要支持多子域的独立 JSON 文件？

**背景：** 如果 `domain-model.md` 包含多个子域，是否应该生成多个独立的 JSON 文件（`order-domain.json`、`user-domain.json`）？

**选项：**
- **选项 A**：单文件，子域作为嵌套对象
- **选项 B**：多文件，每个子域一个 JSON

**建议：** MVP 阶段选择 A（单文件），未来根据实际需求扩展 B。

### Q4: 是否需要实现 JSON → domain-model.md 的反向转换？

**背景：** 用户是否需要从 JSON 反向生成 Markdown（如手动编辑 JSON 后同步回 Markdown）？

**选项：**
- **选项 A**：不支持反向转换，`domain-model.md` 是唯一事实来源
- **选项 B**：支持反向转换，允许双向同步

**建议：** 选择 A，保持单向数据流，避免同步冲突和复杂性。
