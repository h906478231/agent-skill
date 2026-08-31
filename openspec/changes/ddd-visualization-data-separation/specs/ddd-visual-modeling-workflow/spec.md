# DDD Visual Modeling Workflow Specification

## MODIFIED Requirements

### Requirement: 从 domain-model.md 生成可视化文件

workflow 必须从已有的 `domain-model.md` 文件生成可视化文件，而不是重新进行代码分析和领域建模。

#### Scenario: 检测 domain-model.md 存在

- **WHEN** workflow 启动且 `domain-model.md` 文件存在于 `docs/ddd/` 目录
- **THEN** workflow 跳过代码分析和建模阶段，直接进入转换阶段

#### Scenario: domain-model.md 不存在时的提示

- **WHEN** workflow 启动且 `domain-model.md` 文件不存在
- **THEN** workflow 返回错误信息："未找到 domain-model.md，请先运行 ddd-modeling-workflow 完成建模"，并终止执行

#### Scenario: 支持自定义 domain-model.md 路径

- **WHEN** 用户通过 `args.domainModelPath` 指定 `domain-model.md` 的路径
- **THEN** workflow 从指定路径读取文件

### Requirement: 三阶段执行流程

workflow 必须按照"解析 → 转换 → 生成"三个阶段执行。

#### Scenario: 阶段 1 - 解析 domain-model.md

- **WHEN** workflow 进入阶段 1
- **THEN** 系统读取 `domain-model.md` 文件内容，解析 Markdown 结构

#### Scenario: 阶段 2 - 转换为 JSON

- **WHEN** workflow 进入阶段 2
- **THEN** 系统调用转换 agent，将 Markdown 数据转换为 `ddd-model.json` 格式

#### Scenario: 阶段 3 - 生成输出文件

- **WHEN** workflow 进入阶段 3
- **THEN** 系统输出 `ddd-model.json` 文件和静态 HTML 模板（如果不存在）

### Requirement: 性能优化

workflow 必须显著减少执行时间和资源消耗。

#### Scenario: 单 agent 调用

- **WHEN** workflow 执行转换阶段
- **THEN** 系统仅调用 1 个 agent（Markdown → JSON 转换），而不是原来的 4 个 agent

#### Scenario: 执行时间目标

- **WHEN** workflow 完整执行一次
- **THEN** 总执行时间不超过 10 秒（vs 原来的 30s-2min）

#### Scenario: Token 消耗目标

- **WHEN** workflow 完整执行一次
- **THEN** 总 token 消耗降低至原来的 25% 以下

### Requirement: 输出文件管理

workflow 必须支持配置输出文件的路径和名称。

#### Scenario: 默认输出路径

- **WHEN** 用户未指定输出路径参数
- **THEN** workflow 输出 `ddd-model.json` 到项目根目录，输出 `event-storm.html` 到项目根目录

#### Scenario: 自定义输出路径

- **WHEN** 用户通过 `args.outputJsonPath` 和 `args.outputHtmlPath` 指定路径
- **THEN** workflow 输出文件到指定路径

#### Scenario: 静态模板复制

- **WHEN** 目标路径不存在 `template-v2.0.0.html`
- **THEN** workflow 从 `~/.claude/skills/ddd-event-storm-visualizer/template-v2.0.0.html` 复制模板文件

#### Scenario: 避免覆盖已有模板

- **WHEN** 目标路径已存在 `template-v2.0.0.html`
- **THEN** workflow 跳过模板复制，仅更新 `ddd-model.json`

### Requirement: 错误处理和回退

workflow 必须在转换失败时提供清晰的错误信息和回退机制。

#### Scenario: 转换 agent 失败

- **WHEN** Markdown → JSON 转换过程中 agent 返回错误或无效 JSON
- **THEN** workflow 捕获错误，显示详细错误信息（包括哪个章节、哪个字段有问题），并终止执行

#### Scenario: JSON 校验失败

- **WHEN** 转换后的 JSON 不符合 `ddd-model.json` 格式规范（如缺少顶层键）
- **THEN** workflow 显示校验错误信息，指出缺失或错误的字段，并终止执行

#### Scenario: 文件写入失败

- **WHEN** 系统无法写入 `ddd-model.json` 或 HTML 文件（如权限不足、磁盘空间不足）
- **THEN** workflow 显示文件系统错误信息，并终止执行

### Requirement: 用户体验优化

workflow 必须提供清晰的进度提示和执行结果反馈。

#### Scenario: 阶段进度提示

- **WHEN** workflow 执行每个阶段
- **THEN** 系统显示当前阶段名称和进度（如 "✅ 阶段 1: 解析完成"）

#### Scenario: 成功执行的最终提示

- **WHEN** workflow 成功完成所有阶段
- **THEN** 系统显示成功消息："✅ 已从 domain-model.md 生成可视化文件。刷新浏览器查看最新内容。"

#### Scenario: 输出文件路径提示

- **WHEN** workflow 成功生成文件
- **THEN** 系统显示输出文件的完整路径（如 "💾 ddd-model.json: /path/to/project/ddd-model.json"）

#### Scenario: 使用指引

- **WHEN** workflow 首次成功生成文件
- **THEN** 系统显示简短的使用指引："使用 VS Code Live Server 或 `python -m http.server` 打开 HTML 文件查看流程图"

## REMOVED Requirements

### Requirement: 代码和文档分析阶段

**Reason**: 该阶段与 `ddd-modeling-workflow` 重复，导致资源浪费。`domain-model.md` 已经是建模的最终产物，无需重复分析。

**Migration**: 用户应先运行 `ddd-modeling-workflow` 完成代码分析和领域建模，生成 `domain-model.md`，然后运行 `ddd-visual-modeling` workflow 进行可视化。

### Requirement: DDD 建模阶段

**Reason**: 该阶段与 `ddd-modeling-workflow` 重复，且忽略了已有的 `domain-model.md` 事实来源。

**Migration**: 使用 `ddd-modeling-workflow` 的建模结果（`domain-model.md`），通过转换逻辑直接生成可视化数据。

### Requirement: 数据校验阶段（作为独立阶段）

**Reason**: 数据校验合并到转换阶段中，作为转换逻辑的一部分，无需独立阶段。

**Migration**: 转换 agent 在生成 JSON 时自动进行数据校验，确保引用一致性和字段完整性。

### Requirement: 模板占位符替换逻辑

**Reason**: 新架构采用静态模板 + 外部 JSON 加载，不再需要模板占位符替换。

**Migration**: 使用 `template-v2.0.0.html` 静态模板，该模板通过 JavaScript 从外部加载 `ddd-model.json` 并动态渲染。
