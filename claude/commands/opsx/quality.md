---
name: "OPSX: Quality"
description: 实现层代码质量评审（Phase 5.5）- 对本次变更的 diff 查重复率/可读性/死代码/复杂度/设计偏离
allowed-tools: Bash(openspec:*), Bash(git diff:*), Bash(git log:*)
category: Workflow
tags: [workflow, review, quality]
---

在 `/opsx:apply` 编码完成之后、`/opsx:verify` 之前，对本次变更实际产生的代码做质量评审。门禁五维度审的是设计，`/opsx:verify` 查的是一致性，**这里审的是代码本身**。

**IMPORTANT: 本命令不改代码。** 只报告 + 分级 + 留痕，修复动作回 `tasks.md` 加勾选项再做。想直接改用内置 `/simplify`，但那不构成闭环证据。

**Input**: 可指定变更名（如 `/opsx:quality add-auth`）。省略则从对话上下文推断；模糊时用 **AskUserQuestion** 让用户选。始终声明 "Using change: `<name>`"。

## 执行

加载 skill **`opsx-code-quality`**，按其中的前置校验、五项审查清单与输出结构执行，不要在本文件里另行定义规则。

关键约束（详见 skill）：

- 输入是 `git diff`，不是设计文档；diff 为空则中止并提示先完成 `/opsx:apply`。
- finding 格式沿用 skill `opsx-technical-review` 的 `shared/finding-format.md` 七字段（该 skill 的实际安装目录见其 SKILL.md「路径约定：`<SKILL_DIR>`」一节，**不要写死绝对路径**），ID 前缀 `CQ-`，「位置」必须精确到 `文件:行号`。
- 「应复用而未复用」一项**必须实际搜索仓库确认**，不得凭印象下结论。
- L0 变更豁免，L1 及以上都跑。
- **存在未闭环 Blocker 不得 `openspec archive`**；「有条件通过」的条件映射不到 tasks 视同 Blocker。

## 产物

`<changeRoot>/review/code-quality.md` —— 提交 git，随 `openspec archive` 归档。

## 关联

- 上游：`/opsx:apply`
- 下游：`/opsx:verify` → `openspec archive`
- 设计层门禁：`/opsx:review`（skill `opsx-technical-review`）
- 完整流程：`workflow/OpenSpec-AI-研发流程.md`
