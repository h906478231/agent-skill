## Why

开发者阅读 AI 产出的方案与对话回复时，同一概念常出现多种叫法，表述也常含 `适当`、`相关`、`优化` 等不可度量的词。读者会把一个概念误读为多个概念，或无法判断方案的具体边界。当前 CONTEXT.md 的 `_Avoid_` 只是约定，没有任何检查。本变更以 ASD-STE100 为骨架，创建 STE 规则与确定性检查，让产物与对话回复做到一词一义。

## 第一性原理分析

### 表面需求 vs 底层问题

- **用户提出的需求**：用 ASD-STE100 约束 AI 输出的文字，不要对同一概念使用多种描述。
- **真正要解决的问题**：开发者要看懂 AI 给出的方案。一词多义与模糊表述让读者产生误读，误读在实现阶段才暴露，返工成本高。
- **是否存在需求误解**：STE100 是英文标准，官方词典不能分发。不能照搬 STE100，必须把规则改写为中文，并用 CONTEXT.md 承接 STE 的技术名词与技术动词扩展（见 ADR-0005）。

### 基本约束

| 约束类型 | 具体约束 | 影响 |
|---|---|---|
| 业务约束 | 项目要求全部输出使用中文 | STE 规则必须改写为中文，保留原规则编号 |
| 法律约束 | ASD-STE100 Issue 9 复制或发布需 ASD 书面授权；本仓库为 Apache-2.0 | 不能分发官方约 900 词的词典，通用受控词表必须自行编写 |
| 技术约束 | skill 安装到多种 agent，目标项目不一定执行 `npm install` | 检查脚本只能依赖 Node.js 内置模块与随 skill 内置的库 |
| 技术约束 | 只有 Claude Code 提供 Stop hook | 对话回复只在 Claude Code 中能阻断，其他 agent 只能用规则约束 |
| 技术约束 | 中文没有分词，名词串、被动语态等规则只能启发式判断 | 启发式规则只告警，不阻断 |

### 必要性验证

- **不做会怎样**：`_Avoid_` 继续只靠 AI 自觉遵守。同一变更中「取消 / 退单 / 撤单」并存时，没有任何步骤能发现。读者只能逐句核对上下文。
- **做了能带来什么**：产物中的禁用别名、非受控通用词与模糊词在 propose、update、apply、verify 四个卡点被机械拦截。Claude Code 对话回复中的禁用别名被 Stop hook 拦截。
- **是否有更简单的替代方案**：只在 `config.yaml` 的 `rules` 中写入 STE 规则，成本最低。但它只是提示词，AI 不遵守时没有任何后果，不能保证一词一义。本变更保留 `rules` 注入作为生成侧约束，再加确定性检查作为阻断侧约束。
- **必要性结论**：必须做。它也是后续变更 `add-change-model-visualization` 的术语校验前置。

## What Changes

- 新增 skill `openspec-ste`：
  - STE 规则表：逐条对应 ASD-STE100 原规则编号，英文专属规则不采纳。
  - 通用受控词表：按 STE 原则自行编写，第一版 100～200 条，并附模糊词清单。
  - 检查脚本 `ste-lint.mjs`：检查变更产物与对话回复，输出 JSON 与退出码；提供 `text` 子命令，从 stdin 读取纯文本并检查，供变更模型检查与分镜检查调用。
  - 项目覆盖文件 `openspec/ste.yaml`：项目可增删词表条目与阈值。
- 产物检查分级：
  - 禁用别名、非受控通用词、模糊词：阻断。
  - 名词串、被动语态、句长、程序步骤、安全提示：告警。
- 对话回复检查：禁用别名阻断；非受控通用词与模糊词告警。Claude Code 用 Stop hook 执行，最多重试 1 次。
- 豁免语法：行内 `<!-- term-allow: 词 -->` 或代码格式引用。代码块、文件路径、标识符不检查。
- 在 `/opsx:propose`、`/opsx:update`、`/opsx:apply`、`/opsx:verify` 中接入检查。
- 修改 `openspec-grill/shared/context-format.md`：
  - **BREAKING**：`_Avoid_` 从约定升级为禁用别名，出现即阻断（ADR-0003）。
  - 术语增加可选类别标注 `技术名词` / `技术动词`。

## Capabilities

### New Capabilities

- `ste-rules`: STE 规则表、通用受控词表、模糊词清单、项目覆盖文件与 `config.yaml` 规则注入片段。
- `ste-lint`: 对当前变更产物与纯文本执行 STE 检查，按阻断与告警分级输出结果，并在 OpenSpec 四个卡点调用。
- `ste-reply-guard`: 对 AI 对话回复执行禁用别名检查；Claude Code 用 Stop hook 阻断，其他 agent 用共享规则约束。

### Modified Capabilities

- 无。`openspec/specs/` 当前没有主规格。

## Impact

- **新增**：`skills/openspec-ste/`（SKILL.md、shared/、scripts/ste-lint.mjs、vendor/ 内置 YAML 解析库）、`scripts/test-ste-lint.mjs`。
- **修改**：`openspec-propose`、`openspec-update-change`、`openspec-apply-change`、`openspec-verify-change` 的 SKILL.md；`openspec-grill/shared/context-format.md`；本仓库 `openspec/config.yaml`、`CLAUDE.md`、`package.json` 测试脚本；`README.md` 登记 `openspec-ste`；`claude/commands/opsx/` 下 propose、update、apply、verify 四个命令文件同步接入卡点。
- **使用方项目**：已有 CONTEXT.md 的项目启用后，新变更中出现 `_Avoid_` 词会被阻断。历史变更、主规格目录与 archive 目录不检查。
- **依赖**：Node.js ≥ 16；内置 YAML 解析库（MIT 许可证）；不新增 npm 运行期依赖。
- **关联决策**：ADR-0003（禁用别名阻断）、ADR-0005（STE 规则基线）。
