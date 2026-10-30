---
name: "OPSX: Archive"
description: Archive a completed change in the experimental workflow
allowed-tools: Bash(openspec:*)
category: Workflow
tags: [workflow, archive, experimental]
---

Archive a completed change in the experimental workflow.

**Store selection:** If the user names a store (a store is a standalone OpenSpec repo registered on this machine) or the work lives in one, run `openspec store list --json` to discover registered store ids, then pass `--store <id>` on the commands that read or write specs and changes (`new change`, `status`, `instructions`, `list`, `show`, `validate`, `archive`, `doctor`, `context`). Other commands do not take the flag. Hints printed by commands already carry the flag; keep it on follow-ups. Without a store, commands act on the nearest local `openspec/` root.

**Input**: Optionally specify a change name after `/opsx:archive` (e.g., `/opsx:archive add-auth`). If omitted, check if it can be inferred from conversation context. If vague or ambiguous you MUST prompt for available changes.

**Steps**

1. **If no change name provided, prompt for selection**

   Run `openspec list --json` to get available changes. Use the **AskUserQuestion tool** to let the user select.

   Show only active changes (not already archived).
   Include the schema used for each change if available.

   **IMPORTANT**: Do NOT guess or auto-select a change. Always let the user choose.

2. **Check artifact completion status**

   Run `openspec status --change "<name>" --json` to check artifact completion.

   Parse the JSON to understand:
   - `schemaName`: The workflow being used
   - `planningHome`, `changeRoot`, `artifactPaths`, and `actionContext`: path and scope context
   - `artifacts`: List of artifacts with their status (`done` or other)

   **If any artifacts are not `done`:**
   - Display warning listing incomplete artifacts
   - Prompt user for confirmation to continue
   - Proceed if user confirms

3. **Check task completion status**

   Read the tasks file (typically `tasks.md`) to check for incomplete tasks.

   Count tasks marked with `- [ ]` (incomplete) vs `- [x]` (complete).

   **If incomplete tasks found:**
   - Display warning showing count of incomplete tasks
   - Prompt user for confirmation to continue
   - Proceed if user confirms

   **If no tasks file exists:** Proceed without task-related warning.

4. **Assess delta spec sync state**

   Use `artifactPaths.specs.existingOutputPaths` from status JSON to check for delta specs. If none exist, proceed without sync prompt.

   **If delta specs exist:**
   - Compare each delta spec with its corresponding main spec at `openspec/specs/<capability>/spec.md`
   - Determine what changes would be applied (adds, modifications, removals, renames)
   - Show a combined summary before prompting

   **Prompt options:**
   - If changes needed: "Sync now (recommended)", "Archive without syncing"
   - If already synced: "Archive now", "Sync anyway", "Cancel"

   If user chooses sync, use Task tool (subagent_type: "general-purpose", prompt: "Use Skill tool to invoke openspec-sync-specs for change '<name>'. Delta spec analysis: <include the analyzed delta spec summary>"). Proceed to archive regardless of choice, but when main specs differ and sync is skipped, require the user to state the reason and record it in the archive summary.

**归档前置校验（本仓自加，非上游原文）**

在 Step 5 移动目录之前必须检查下列项，任一不通过时**拒绝归档**（不是告警后继续）：

- **技术评审签字**：若 `review-summary.md` 存在，必须有 `Technical Review Approved:` 签字行；缺签字或裁决为 BLOCKED 时拒绝。
- **未闭环 Blocker**：`review-summary.md` 的「已确认风险详细清单」中未闭环 Blocker 必须为 0（闭合判定见 skill `openspec-technical-review` 的 `shared/closed-loop-verification.md`）。
- **代码质量评审（历史变更）**：若存在 `review/code-quality.md`，结论不得为「打回」，未闭环 Blocker 必须为 0。
- **双轴评审与切片证据**：运行 skill `openspec-technical-review` 的 `scripts/implementation-gate.mjs archive <changeRoot>`，退出码非 0 即拒绝归档，并列出 `blockers`（任一轴未闭环 Blocker、MVP 与 L2/L3 缺少或不一致的评审报告、缺失 / 不完整 / 失败 / 过期的切片证据）；`notes` 中的不适用理由与待环境补测切片（负责人、补测计划）写入归档摘要，待环境补测不阻断。完整口径见该 skill 的 `shared/implementation-gate-check.md`「Archive」一节，历史变更不追溯。
- **Phase 6 验证**：读取最近一次 `/opsx:verify` 报告 `<changeRoot>/verification.md`，不读对话；没有该文件时拒绝归档，提示先运行 `/opsx:verify`。报告的 CRITICAL 项必须已清零；「评审条件」小节不得有未闭环的条件（条件对应已勾选的任务，或对应写明了该条件的 `<文件>:<行号>`），有未闭环条件时拒绝归档并写出条件编号。`overview.md` 的 `⚠️ 未落地` 行不作为归档依据。
- **验证结论留痕**：把 `verification.md` 的 `Fingerprint` 与 Final Assessment 写入归档摘要。

阶段顺序与门禁口径的唯一事实源见 skill `openspec-technical-review` 的 `shared/phases.md`。

5. **Perform the archive**

   Create an `archive` directory under `planningHome.changesDir` if it doesn't exist:
   ```bash
   mkdir -p "<planningHome.changesDir>/archive"
   ```

   Generate target name using current date: `YYYY-MM-DD-<change-name>`

   **Check if target already exists:**
   - If yes: Fail with error, suggest renaming existing archive or using different date
   - If no: Move `changeRoot` to the archive directory

   ```bash
   mv "<changeRoot>" "<planningHome.changesDir>/archive/YYYY-MM-DD-<name>"
   ```

6. **Display summary**

   Show archive completion summary including:
   - Change name
   - Schema that was used
   - Archive location
   - Spec sync status (synced / sync skipped / no delta specs)
   - Implementation gate result: passed, or the "不适用" reasons from `archive` notes（本仓自加）
   - Note about any warnings (incomplete artifacts/tasks)

7. **归档后：完成清单（本仓自加，非上游原文）**

   只在第 5 步移动目录成功之后执行；归档前置校验拒绝归档时不生成完成清单。按 skill `openspec-change-recap` 的「生成：一个子 agent」为刚归档的变更生成 `<archive>/YYYY-MM-DD-<name>/recap.md`（读取 skill `openspec-change-recap` 的 `SKILL.md`，skill 目录随 agent 而不同；找不到时用 Glob 搜 `**/openspec-change-recap/SKILL.md`；格式与内容来源见该 skill 的 `shared/recap-format.md`）：

   - 由一个子 agent 生成，主会话只接收结论。子 agent 只创建或覆盖该变更归档目录中的 `recap.md`，归档目录中的其他文件只读，除 `recap.mjs list` 外不运行命令，不运行 git 命令，不向用户提问。修正一次、主会话直接生成时范围相同。
   - 主会话运行 `node <RECAP> check <recap.md 的路径>`（`<RECAP>` = skill `openspec-change-recap` 的 `scripts/recap.mjs`；找不到时用 Glob 搜 `**/openspec-change-recap/scripts/recap.mjs`），在第 6 步的总结之后显示 `recap.md` 的路径与输出 JSON 中 `header.summary` 的摘要，不读取 `recap.md` 全文。退出码为 `1` 时把 `blocking` 交给同一个子 agent 修正一次。
   - 子 agent 失败，或修正一次后 `check` 退出码仍为 `1` 时，**不回退归档**，变更留在归档目录：显示告警与 `/opsx:recap <name>`，提示用户重新生成。
   - git 边界：本步不执行 `git add` 或 `git commit`。项目 `.gitignore` 忽略 `openspec/` 时，不得用 `git add -f` 加入产物。是否提交由用户决定。`check` 的 `warnings` 中的 git 告警只原样显示建议规则，不修改 `.gitignore`。
   - 本步不阻断归档，也不改变第 6 步的门禁结论。

8. **归档后：云舟任务（本仓自加，非上游原文）**

   归档成功、并且变更关联了云舟任务时（变更名为 `yunzhou-<taskId>`，或 `proposal.md` 有一行 `云舟任务：<taskId>`），读取 skill `openspec-archive-change` 的 `shared/yunzhou-task-completion.md`（skill 目录随 agent 而不同；找不到时用 Glob 搜 `**/openspec-archive-change/shared/yunzhou-task-completion.md`），按其步骤执行：用户确认后才把任务标记为完成，并回读确认。没有关联时跳过本步，不询问。

**Output On Success**

```
## Archive Complete

**Change:** <change-name>
**Schema:** <schema-name>
**Archived to:** the archive path derived from `planningHome.changesDir`/YYYY-MM-DD-<name>/
**Specs:** ✓ Synced to main specs

All artifacts complete. All tasks complete.
```

**Output On Success (No Delta Specs)**

```
## Archive Complete

**Change:** <change-name>
**Schema:** <schema-name>
**Archived to:** the archive path derived from `planningHome.changesDir`/YYYY-MM-DD-<name>/
**Specs:** No delta specs

All artifacts complete. All tasks complete.
```

**Output On Success With Warnings**

```
## Archive Complete (with warnings)

**Change:** <change-name>
**Schema:** <schema-name>
**Archived to:** the archive path derived from `planningHome.changesDir`/YYYY-MM-DD-<name>/
**Specs:** Sync skipped (user chose to skip)

**Warnings:**
- Archived with 2 incomplete artifacts
- Archived with 3 incomplete tasks
- Delta spec sync was skipped (user chose to skip)

Review the archive if this was not intentional.
```

**Output On Error (Archive Exists)**

```
## Archive Failed

**Change:** <change-name>
**Target:** the archive path derived from `planningHome.changesDir`/YYYY-MM-DD-<name>/

Target archive directory already exists.

**Options:**
1. Rename the existing archive
2. Delete the existing archive if it's a duplicate
3. Wait until a different date to archive
```

**Guardrails**
- Always prompt for change selection if not provided
- Use artifact graph (openspec status --json) for completion checking
- Don't block archive on warnings (incomplete artifacts/tasks, skipped delta sync) - just inform and confirm
- **门禁类问题必须阻断，不得只告警**（本仓自加）—— 见上方「归档前置校验」
- Preserve .openspec.yaml when moving to archive (it moves with the directory)
- Show clear summary of what happened
- If sync is requested, use the Skill tool to invoke `openspec-sync-specs` (agent-driven)
- If delta specs exist, always run the sync assessment and show the combined summary before prompting
