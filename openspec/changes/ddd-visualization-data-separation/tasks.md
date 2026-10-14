# Implementation Tasks

## 1. Workflow 核心改造

- [x] 1.1 修改 `workflow/ddd-visual-modeling.workflow.js` - 更新 meta 信息（phases 从 4 个改为 3 个）
- [x] 1.2 移除 Phase 1 的代码/文档分析逻辑（删除 businessDesc agent 调用）
- [x] 1.3 移除 Phase 2 的 DDD 建模逻辑（删除 modelDataJson agent 调用）
- [x] 1.4 移除 Phase 3 的数据校验逻辑（删除 validationResult agent 调用）
- [x] 1.5 实现新 Phase 1：读取 `domain-model.md` 文件（支持 `args.domainModelPath` 参数）
- [x] 1.6 实现新 Phase 1：检测文件不存在时的错误处理和提示
- [x] 1.7 实现新 Phase 2：调用 Markdown → JSON 转换 agent（编写完整 prompt）
- [x] 1.8 实现新 Phase 3：输出 `ddd-model.json` 到指定路径（支持 `args.outputJsonPath` 参数）
- [x] 1.9 实现新 Phase 3：复制 `template-v2.0.0.html` 到输出路径（如果不存在）
- [x] 1.10 实现新 Phase 3：避免覆盖已有模板的逻辑

## 2. 转换 Agent Prompt 设计

- [x] 2.1 编写 agent prompt - Context 部分（角色定义和任务说明）
- [x] 2.2 编写 agent prompt - Parsing Rules 部分（如何解析 Markdown 表格）
- [x] 2.3 编写 agent prompt - Transformation Rules 部分（字符串 → 数组转换规则）
- [x] 2.4 编写 agent prompt - Output Format 部分（JSON 结构示例）
- [x] 2.5 编写 agent prompt - Error Handling 部分（错误场景和提示格式）
- [x] 2.6 添加 agent prompt - 必需章节检查规则（"## 1. 领域事件清单" 等）
- [x] 2.7 添加 agent prompt - 必填字段检查规则（id、name、className 等）

## 3. JSON Schema 校验逻辑

- [x] 3.1 定义 `ddd-model.json` 的 JSON Schema（顶层结构：commands、events、aggregates、policies）
- [x] 3.2 定义 Command 对象的 schema（id、name、className、trigger、input、precondition、aggregate、events）
- [x] 3.3 定义 Event 对象的 schema（id、name、className、meaning、aggregate）
- [x] 3.4 定义 Aggregate 对象的 schema（id、name、description、entities、valueObjects）
- [x] 3.5 定义 Policy 对象的 schema（id、name、className、listenEvents、triggerCommands、rule）
- [x] 3.6 实现引用一致性校验（命令引用的 aggregate 必须存在）
- [x] 3.7 实现引用一致性校验（命令的 events 数组中的事件必须存在）
- [x] 3.8 实现引用一致性校验（Policy 的 listenEvents 中的事件必须存在）
- [x] 3.9 实现引用一致性校验（Policy 的 triggerCommands 中的命令必须存在）
- [x] 3.10 实现校验错误的友好提示（指出具体字段和错误原因）

## 4. 静态 HTML 模板开发

- [x] 4.1 创建 `skills/ddd-event-storm-visualizer/template-v2.0.0.html` 文件
- [x] 4.2 复制 `template-v1.0.0.html` 的 HTML 结构和 CSS 样式
- [x] 4.3 移除模板占位符替换逻辑（`{{MODEL_DATA}}`、`{{DOMAIN_NAME}}`）
- [x] 4.4 实现 JavaScript - 检测 `file://` 协议并显示错误提示
- [x] 4.5 实现 JavaScript - 获取 JSON 路径（支持 URL 参数 `?data=...`）
- [x] 4.6 实现 JavaScript - 使用 `fetch()` 加载外部 JSON（添加缓存破坏参数 `?t=...`）
- [x] 4.7 实现 JavaScript - JSON 加载失败时的错误处理和提示
- [x] 4.8 实现 JavaScript - JSON 格式校验（检查顶层键是否存在）
- [x] 4.9 实现 JavaScript - 调用渲染函数（复用 v1.0.0 的 `renderEventStorm()` 逻辑）
- [x] 4.10 添加 loading 状态显示（"正在加载数据..."）
- [x] 4.11 添加错误提示区域样式（红色背景、清晰的使用指引）

## 5. 数据输出格式化

- [x] 5.1 实现 JSON 输出 - 2 空格缩进格式化
- [x] 5.2 实现 JSON 输出 - 顶层键排序（commands、events、aggregates、policies）
- [x] 5.3 实现 JSON 输出 - 中文字符不转义为 Unicode
- [x] 5.4 实现 JSON 输出 - 文件末尾添加换行符（POSIX 标准）
- [x] 5.5 实现 JSON 输出 - 使用 LF（`\n`）换行符（Unix 标准）
- [x] 5.6 添加 `_meta` 对象（包含 generated、source、version 字段）

## 6. 错误处理和用户提示

- [x] 6.1 实现 workflow - `domain-model.md` 不存在时的错误提示和退出
- [x] 6.2 实现 workflow - 转换 agent 返回错误时的处理逻辑
- [x] 6.3 实现 workflow - JSON 校验失败时的详细错误提示
- [x] 6.4 实现 workflow - 文件写入失败时的错误提示
- [x] 6.5 实现 workflow - 成功执行后的最终提示（包含输出路径）
- [x] 6.6 实现 workflow - 首次成功生成时的使用指引提示
- [x] 6.7 实现 HTML - `file://` 协议错误提示（推荐 VS Code Live Server 或 Python HTTP Server）
- [x] 6.8 实现 HTML - JSON 加载失败错误提示（文件不存在或网络错误）
- [x] 6.9 实现 HTML - JSON 格式错误提示（指出具体字段）

## 7. 测试用例准备

- [ ] 7.1 准备测试数据 - 标准的 `domain-model.md` 文件（包含所有必需章节）
- [ ] 7.2 准备测试数据 - 缺少必需章节的 `domain-model.md`（测试错误处理）
- [ ] 7.3 准备测试数据 - 表格格式错误的 `domain-model.md`（测试格式校验）
- [ ] 7.4 准备测试数据 - 包含多子域的 `domain-model.md`（测试多子域支持）
- [ ] 7.5 准备测试数据 - 引用不一致的 `domain-model.md`（测试引用校验）

## 8. 单元测试

- [ ] 8.1 测试 workflow Phase 1 - 成功读取 `domain-model.md`
- [ ] 8.2 测试 workflow Phase 1 - `domain-model.md` 不存在时返回错误
- [ ] 8.3 测试 workflow Phase 2 - 成功转换标准格式的 Markdown
- [ ] 8.4 测试 workflow Phase 2 - 转换过程中的错误处理
- [ ] 8.5 测试 workflow Phase 3 - 成功输出 `ddd-model.json`
- [ ] 8.6 测试 workflow Phase 3 - 成功复制 HTML 模板
- [ ] 8.7 测试 JSON Schema 校验 - 引用一致性检查通过
- [ ] 8.8 测试 JSON Schema 校验 - 引用不一致时报错
- [ ] 8.9 测试 HTML 模板 - 成功加载和渲染 JSON 数据
- [ ] 8.10 测试 HTML 模板 - `file://` 协议检测和错误提示
- [ ] 8.11 测试 HTML 模板 - JSON 加载失败时的错误提示
- [ ] 8.12 测试 HTML 模板 - JSON 格式错误时的错误提示

## 9. 集成测试

- [ ] 9.1 端到端测试 - 运行 `ddd-modeling-workflow` 生成 `domain-model.md`
- [ ] 9.2 端到端测试 - 运行 `ddd-visual-modeling` 生成 `ddd-model.json` 和 HTML
- [ ] 9.3 端到端测试 - 使用 VS Code Live Server 打开 HTML 并验证渲染
- [ ] 9.4 端到端测试 - 使用 Python HTTP Server 打开 HTML 并验证渲染
- [ ] 9.5 端到端测试 - 通过 `file://` 打开 HTML 并验证错误提示
- [ ] 9.6 端到端测试 - 修改 `domain-model.md` → 重新转换 → 刷新浏览器 → 验证更新
- [ ] 9.7 端到端测试 - 测试 URL 参数 `?data=custom-path.json` 功能
- [ ] 9.8 端到端测试 - 测试多子域的 `domain-model.md` 转换和渲染

## 10. 性能验证

- [ ] 10.1 测量 workflow 执行时间（目标 < 10s）
- [ ] 10.2 测量 workflow token 消耗（目标降低 75%）
- [ ] 10.3 测量大规模数据渲染性能（100+ 命令和事件，目标 < 2s）
- [ ] 10.4 测量 JSON 文件大小（典型场景目标 < 50KB）
- [ ] 10.5 验证浏览器内存占用（确保无明显内存泄漏）

## 11. 文档编写

- [x] 11.1 编写 README - 快速开始指南（如何使用新 workflow）
- [x] 11.2 编写 README - 工作流说明（建模 → 可视化的两步流程）
- [x] 11.3 编写 README - 故障排查指南（常见错误和解决方案）
- [x] 11.4 编写 README - 使用指引（如何启动 HTTP 服务器）
- [x] 11.5 编写迁移指南 - v1.0.0 → v2.0.0 的差异说明
- [x] 11.6 编写迁移指南 - 何时选择 v1.0.0 vs v2.0.0
- [ ] 11.7 更新 `ddd-visual-modeling` skill 的 SKILL.md（更新 description 和 phases）
- [x] 11.8 添加 `ddd-model.json` 格式规范文档（JSON Schema 说明）
- [ ] 11.9 添加示例文件（`examples/ddd-model.json` 和对应的 `domain-model.md`）

## 12. 向后兼容性保障

- [x] 12.1 保留 `template-v1.0.0.html` 文件（不删除或修改）
- [x] 12.2 添加版本选择提示（workflow 输出时提示用户可选择版本）
- [x] 12.3 测试 v1.0.0 模板仍能正常工作
- [ ] 12.4 添加 .gitignore 规则（`ddd-model.json` 是生成文件但需要追踪）
- [x] 12.5 添加 .gitattributes 规则（标记 `ddd-model.json` 为 linguist-generated）

## 13. 代码审查和优化

- [ ] 13.1 代码审查 - workflow 代码（逻辑清晰、错误处理完善）
- [ ] 13.2 代码审查 - agent prompt（清晰、完整、无歧义）
- [ ] 13.3 代码审查 - HTML 模板（代码质量、兼容性、可读性）
- [ ] 13.4 代码审查 - JSON Schema（完整性、严格性）
- [ ] 13.5 优化 - agent prompt 精简（减少不必要的上下文）
- [ ] 13.6 优化 - HTML 模板性能（虚拟 DOM、懒加载等，如果需要）
- [ ] 13.7 优化 - JSON 输出稳定性（确保多次运行输出一致）

## 14. 发布准备

- [ ] 14.1 更新 CHANGELOG（记录本次变更的内容和影响）
- [ ] 14.2 打标签版本（如 `v2.0.0`）
- [ ] 14.3 准备发布说明（面向用户的变更摘要）
- [ ] 14.4 准备迁移通知（发送给现有用户）
- [ ] 14.5 更新相关文档链接（确保所有引用都指向最新版本）
