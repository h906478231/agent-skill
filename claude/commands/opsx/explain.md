---
name: "OPSX: Explain"
description: 为技术评审的 finding 生成详细的业务场景解析文档 - 包含完整业务场景、代码示例、算法细节、实施步骤
allowed-tools: Bash(openspec:*), Read, Write
category: Workflow
tags: [workflow, review, finding, documentation]
---

为技术评审产出的 finding 生成详细解析文档。技术评审的 finding 表格虽然有 9 个字段，但单元格空间有限，实施人员需要更详细的说明：完整业务场景、代码实现示例、算法细节、分步骤实施指南。

**IMPORTANT: 本命令只生成文档，不改代码。** 产出用于实施阶段深入理解技术方案，或向团队成员解释复杂技术问题。

**Input**: 支持以下参数形式：

```bash
/opsx:explain <change-name> --finding <ID>        # 展开单个 finding
/opsx:explain <change-name> --all-blockers        # 展开所有 Blocker
/opsx:explain <change-name> --all                 # 展开所有 finding
/opsx:explain <change-name> --finding <ID> --audience non-tech  # 面向非技术人员
```

变更名可指定或从对话上下文推断；模糊时用 **AskUserQuestion** 让用户选。始终声明 "Using change: `<name>`"。

## 执行

加载 skill **`openspec-finding-explain`**，按其中的五个步骤执行，不要在本文件里另行定义规则。

关键约束（详见 skill）：

- **前置条件**：变更必须已完成技术评审，存在 `review-summary.md` 或 `review/<role>.md`；指定的 finding ID 必须存在
- **参数解析**：支持 `--finding <ID>`、`--all-blockers`、`--all`、`--audience <type>`（tech/non-tech/new-dev）
- **读取信息**：从 `review-summary.md` 和对应维度的 `review/<role>.md` 读取 finding 的 10 字段信息（含 `闭环状态`），从 `design.md` 读取上下文
- **文档结构**：包含基本信息、业务场景完整描述、技术问题深入分析、解决方案详解（含代码示例）、实施指南（含改动清单、实施步骤、测试用例、回滚方案、监控指标）、相关资源、FAQ
- **批量模式**：`--all-blockers` 或 `--all` 时，额外生成 `review/finding-details-summary.md` 汇总文档

## 产物

- `<changeRoot>/review/finding-details/<ID>.md` —— 单个 finding 的详细解析文档
- `<changeRoot>/review/finding-details-summary.md` —— 批量模式的汇总文档（含目录、按业务功能/改动模块/优先级分类）

产物提交 git，随 `openspec archive` 归档。

## 使用场景

| 场景 | 命令 | 说明 |
|------|------|------|
| 单个复杂 finding 需要展开 | `/opsx:explain <change> --finding CONC-02` | 开发看到 finding 不知道具体怎么做 |
| 批量展开所有 Blocker | `/opsx:explain <change> --all-blockers` | 技术评审后，需要给团队讲解所有 Blocker |
| 向非技术人员解释 | `/opsx:explain <change> --finding SEC-01 --audience non-tech` | 向产品经理解释为什么这个问题严重 |

## 关联

- 上游：`/opsx:review` 产出 `review-summary.md` 和 `review/<role>.md`
- 本命令：读取评审结果，生成详细解析文档
- 下游：`/opsx:apply` 实施修复时，参考详细解析文档
- 完整流程：`workflow/OpenSpec-AI-研发流程.md`

## 两层产出设计

- **第一层**：finding 表格（10 字段，含 `闭环状态`）—— 评审阶段快速判断
- **第二层**：详细解析文档 —— 实施阶段深入理解，按需生成避免信息过载
