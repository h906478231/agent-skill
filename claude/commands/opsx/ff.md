---
name: "OPSX: Fast Forward"
description: Create a change and generate all artifacts needed for implementation in one go
allowed-tools: Bash(openspec:*)
category: Workflow
tags: [workflow, artifacts, experimental]
---

Fast-forward through artifact creation - generate everything needed to start implementation.

**Store selection:** If the user names a store (a store is a standalone OpenSpec repo registered on this machine) or the work lives in one, run `openspec store list --json` to discover registered store ids, then pass `--store <id>` on the commands that read or write specs and changes (`new change`, `status`, `instructions`, `list`, `show`, `validate`, `archive`, `doctor`, `context`). Other commands do not take the flag. Hints printed by commands already carry the flag; keep it on follow-ups. Without a store, commands act on the nearest local `openspec/` root.

**Input**: The argument after `/opsx:ff` is the change name (kebab-case), OR a description of what the user wants to build.

**Steps**

1. **If no input provided, ask what they want to build**

   Use the **AskUserQuestion tool** (open-ended, no preset options) to ask:
   > "What change do you want to work on? Describe what you want to build or fix."

   From their description, derive a kebab-case name (e.g., "add user authentication" → `add-user-auth`).

   **IMPORTANT**: Do NOT proceed without understanding what the user wants to build.

2. **Create the change directory**
   ```bash
   openspec new change "<name>"
   ```
   This creates a scaffolded change in the planning home resolved by the CLI.

3. **Get the artifact build order**
   ```bash
   openspec status --change "<name>" --json
   ```
   Parse the JSON to get:
   - `applyRequires`: array of artifact IDs needed before implementation (e.g., `["tasks"]`)
   - `artifacts`: list of all artifacts with their status and dependencies
   - `planningHome`, `changeRoot`, `artifactPaths`, and `actionContext`: path and scope context. Use these instead of assuming repo-local paths.

4. **Create artifacts in sequence until apply-ready**

   Use the **TodoWrite tool** to track progress through the artifacts.

   Loop through artifacts in dependency order (artifacts with no pending dependencies first):

   a. **For each artifact that is `ready` (dependencies satisfied)**:
      - Get instructions:
        ```bash
        openspec instructions <artifact-id> --change "<name>" --json
        ```
      - The instructions JSON includes:
        - `context`: Project background (constraints for you - do NOT include in output)
        - `rules`: Artifact-specific rules (constraints for you - do NOT include in output)
        - `template`: The structure to use for your output file
        - `instruction`: Schema-specific guidance for this artifact type
        - `resolvedOutputPath`: Resolved path or pattern to write the artifact
        - `dependencies`: Completed artifacts to read for context
      - Read any completed dependency files for context
      - Create the artifact file using `template` as the structure and write it to `resolvedOutputPath`
      - Apply `context` and `rules` as constraints - but do NOT copy them into the file
      - Show brief progress: "✓ Created <artifact-id>"

   b. **Continue until all `applyRequires` artifacts are complete**
      - After creating each artifact, re-run `openspec status --change "<name>" --json`
      - Check if every artifact ID in `applyRequires` has `status: "done"` in the artifacts array
      - Stop when all `applyRequires` artifacts are done

   c. **If an artifact requires user input** (unclear context):
      - Use **AskUserQuestion tool** to clarify
      - Then continue with creation

5. **Show final status**
   ```bash
   openspec status --change "<name>"
   ```

**Output**

After completing all artifacts, summarize:
- Change name and location
- List of artifacts created with brief descriptions
- What's ready: "All artifacts created! Ready for implementation."
- Prompt: "Run `/opsx:apply` to start implementing."
- **门禁提示（本仓自加，非上游原文）**：在 Prompt 之前先给出下一步，按 skill `openspec-technical-review` 的 `shared/gate-levels.md` 判定等级（skill 目录随 agent 而不同；找不到时用 Glob 搜 `**/openspec-technical-review/shared/gate-levels.md`）：「L1–L3，或 MVP 且命中升级信号 → 先 `/opsx:review`，人工签字后再 `/opsx:apply`；L0，或 MVP 且未命中信号 → 可直接 `/opsx:apply`，但要在 `overview.md` 开头写一行分级结论（判定人与日期）。拿不准就升一级。」缺 `review-summary.md` 时 apply 按设计放行，这条提示是 apply 之前唯一的门禁提醒，不得省略。

**Artifact Creation Guidelines**

- Follow the `instruction` field from `openspec instructions` for each artifact type
- The schema defines what each artifact should contain - follow it
- Read dependency artifacts for context before creating new ones
- Use `template` as the structure for your output file - fill in its sections
- **IMPORTANT**: `context` and `rules` are constraints for YOU, not content for the file
  - Do NOT copy `<context>`, `<rules>`, `<project_context>` blocks into the artifact
  - These guide what you write, but should never appear in the output

**本仓自加的产物规则（非上游原文）**

生成 `proposal` / `design` / `tasks` 三类 artifact 时，除 schema 的 `instruction` 外还必须满足本仓规则（规则文件在对应 skill 的 `shared/` 下；skill 目录随 agent 而不同，找不到时用 Glob 搜 `**/openspec-explore/shared/<file>.md` 或 `**/openspec-propose/shared/<file>.md`）：

- **云舟任务关联**：变更来自云舟任务时，`proposal.md` 第一行写 `云舟任务：<taskId>`，空一行后再写 `## Why`。判据满足一条即可：变更名为 `yunzhou-<taskId>`（云舟自动化工作流的命名）；用户的请求给出了本变更对应的云舟任务号或任务链接（从链接中取任务号）。`<taskId>` 只写数字任务号，不写链接。拿不准某个编号是不是本变更的云舟任务时，用 AskUserQuestion 确认，不猜。变更不来自云舟任务时不写这一行，也不询问。archive 按这一行判断归档后是否询问完成云舟任务（skill `openspec-archive-change` 的 `shared/yunzhou-task-completion.md`）。
- **已有讨论记录**：变更目录已有 `discussion-log.md` 时（grill 写入的用户决策、子 agent 回流的结论与未采纳记录），生成 proposal 与 design 之前先读取：已定决策写入 proposal「第一性原理分析」区块与 design 的方案选择，弃掉的方案写入「为什么不选其他方案」，不再向用户重复问已定决策。
- **proposal（Phase 1）**：必须包含「第一性原理分析」区块（表面需求 vs 底层问题 / 基本约束 / 必要性验证），见 `openspec-explore` 的 `shared/first-principles.md`。
- **design（Phase 2）**：必须包含「候选方案交叉验证矩阵」（L2/L3：至少 2 个有实质差异的方案 × 成本/性能/复杂度/风险四维，并回答「为什么不选其他方案」；L0/L1 允许单一方案 + 不选其他方案的理由）；L2/L3 变更还必须包含「测试 Seam 决策」区块。见 `openspec-explore` 的 `shared/cross-validation.md` 与 `shared/seam-decisions.md`。
- **tasks**：必须按垂直切片 + 阻塞 DAG 组织并保持 checkbox 兼容（`/opsx:apply` 与 `/opsx:verify` 依赖 `- [ ]` 解析进度）；勾选项只写归档前能完成的工作，按「排除清单」逐项自查；Migration Plan 有在生产环境执行的步骤，或 Risk Accepted 写了上线后的复查条件，或「测试 Seam 决策」有 e2e 测试时，写一项编写 `deployment.md` 的任务（见 `openspec-apply-change` 的 `shared/deployment-document.md`）。见 `openspec-propose` 的 `shared/task-slicing.md`。

上述区块缺失时，不得宣称本变更已 ready for implementation。

**Guardrails**
- Create ALL artifacts needed for implementation (as defined by schema's `apply.requires`)
- Always read dependency artifacts before creating a new one
- If context is critically unclear, ask the user - but prefer making reasonable decisions to keep momentum
- If a change with that name already exists, ask if user wants to continue it or create a new one
- Verify each artifact file exists after writing before proceeding to next
