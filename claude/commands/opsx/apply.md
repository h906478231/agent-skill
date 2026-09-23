---
name: "OPSX: Apply"
description: Implement tasks from an OpenSpec change (Experimental)
allowed-tools: Bash(openspec:*)
category: Workflow
tags: [workflow, artifacts, experimental]
---

Implement tasks from an OpenSpec change.

**Store selection:** If the user names a store (a store is a standalone OpenSpec repo registered on this machine) or the work lives in one, run `openspec store list --json` to discover registered store ids, then pass `--store <id>` on the commands that read or write specs and changes (`new change`, `status`, `instructions`, `list`, `show`, `validate`, `archive`, `doctor`, `context`). Other commands do not take the flag. Hints printed by commands already carry the flag; keep it on follow-ups. Without a store, commands act on the nearest local `openspec/` root.

**Input**: Optionally specify a change name (e.g., `/opsx:apply add-auth`). If omitted, check if it can be inferred from conversation context. If vague or ambiguous you MUST prompt for available changes.

**Steps**

1. **Select the change**

   If a name is provided, use it. Otherwise:
   - Infer from conversation context if the user mentioned a change
   - Auto-select if only one active change exists
   - If ambiguous, run `openspec list --json` to get available changes and use the **AskUserQuestion tool** to let the user select

   Always announce: "Using change: <name>" and how to override (e.g., `/opsx:apply <other>`).

2. **技术评审门禁校验（BLOCKING —— 写任何代码之前必须做）**

   完整规则见 skill `openspec-technical-review` 的 `shared/apply-gate-check.md`（该 skill 的实际安装目录随 agent 而不同，解析方式见其 SKILL.md「路径约定：`<SKILL_DIR>`」一节；找不到时用 Glob 搜 `**/openspec-technical-review/shared/apply-gate-check.md`），**先读取该文件并严格执行**。要点：无 `review-summary.md` → 放行（该变更未启用门禁）；有 `review-summary.md` 但签字行为空白占位或裁决为 `BLOCKED` → 停止，不写任何实现代码；禁止代替用户签字、禁止修改签字行、禁止劝说跳过。

   Bash 侧的 `PreToolUse` hook 看不到 `/opsx:apply` 这条斜杠命令路径 —— 本步骤是该路径上唯一的检查点，不得跳过。

3. **Check status to understand the schema**
   ```bash
   openspec status --change "<name>" --json
   ```
   Parse the JSON to understand:
   - `schemaName`: The workflow being used (e.g., "spec-driven")
   - `planningHome`, `changeRoot`, and `actionContext`: planning scope and edit constraints
   - Which artifact contains the tasks (typically "tasks" for spec-driven, check status for others)

4. **Get apply instructions**

   ```bash
   openspec instructions apply --change "<name>" --json
   ```

   This returns:
   - `contextFiles`: artifact ID -> array of concrete file paths (varies by schema)
   - Progress (total, complete, remaining)
   - Task list with status
   - Dynamic instruction based on current state

   **Handle states:**
   - If `state: "blocked"` (missing artifacts): show message, suggest using `/opsx:propose` to create the missing artifacts
   - If `state: "all_done"`: congratulate, then suggest `/opsx:quality` (Phase 5.5) → `/opsx:verify` (Phase 6) before archive
   - Otherwise: proceed to implementation

5. **Read context files**

   Read every file path listed under `contextFiles` from the apply instructions output.
   The files depend on the schema being used:
   - **spec-driven**: proposal, specs, design, tasks
   - Other schemas: follow the contextFiles from CLI output

6. **Show current progress**

   Display:
   - Schema being used
   - Progress: "N/M tasks complete"
   - Remaining tasks overview
   - Dynamic instruction from CLI

7. **Implement tasks (loop until done or blocked)**

   **TDD 实施纪律（写第一个测试之前）**：完整规则见 skill `openspec-apply-change` 自己的 `shared/tdd-discipline.md`（skill 目录随 agent 而不同：Claude Code `~/.claude/skills/openspec-apply-change/shared/`、Codex CLI `~/.codex/skills/openspec-apply-change/shared/`、opencode `~/.config/opencode/skills/openspec-apply-change/shared/` 等；找不到时用 Glob 搜 `**/openspec-apply-change/shared/tdd-discipline.md`），**先读取该文件并严格遵守**。要点：只在 design.md「测试 Seam 决策」区块（或口头确认后回记到切片 `Seam:` 行）声明的公共边界写测试；red before green；一次一个切片、切片内一次一个行为；每完成一个任务项跑单测试文件 + 类型检查，全部完成跑完整测试套件；重构不进 red-green 循环，留给 `/opsx:quality`。

   For each pending task:
   - Show which task is being worked on
   - Make the code changes required
   - Keep changes minimal and focused
   - Mark task complete in the tasks file: `- [ ]` → `- [x]`
   - Continue to next task

   **Pause if:**
   - Task is unclear → ask for clarification
   - Implementation reveals a design issue → suggest updating artifacts
   - Error or blocker encountered → report and wait for guidance
   - User interrupts

8. **On completion or pause, show status**

   Display:
   - Tasks completed this session
   - Overall progress: "N/M tasks complete"
   - If all done: suggest `/opsx:quality` (Phase 5.5) → `/opsx:verify` (Phase 6), not archive
   - If paused: explain why and wait for guidance

**Output During Implementation**

```
## Implementing: <change-name> (schema: <schema-name>)

Working on task 3/7: <task description>
[...implementation happening...]
✓ Task complete

Working on task 4/7: <task description>
[...implementation happening...]
✓ Task complete
```

**Output On Completion**

```
## Implementation Complete

**Change:** <change-name>
**Schema:** <schema-name>
**Progress:** 7/7 tasks complete ✓

### Completed This Session
- [x] Task 1
- [x] Task 2
...

All tasks complete! Next: `/opsx:quality` → `/opsx:verify`, then `/opsx:archive`.
```

**Output On Pause (Issue Encountered)**

```
## Implementation Paused

**Change:** <change-name>
**Schema:** <schema-name>
**Progress:** 4/7 tasks complete

### Issue Encountered
<description of the issue>

**Options:**
1. <option 1>
2. <option 2>
3. Other approach

What would you like to do?
```

**Guardrails**
- **技术评审门禁未签字前，绝不写任何实现代码**（Step 2）—— 无例外，不代签
- **遵守 skill `openspec-apply-change` 自己的 `shared/tdd-discipline.md` TDD 纪律**（Step 7）—— seam-first、red before green、重构留给 `/opsx:quality`
- **实现全部完成后进入质量评审与验证，不得直接归档**（本仓自加，非上游原文）—— 依次跑 `/opsx:quality`（Phase 5.5）与 `/opsx:verify`（Phase 6）；任一未通过或存在未闭环 Blocker 时禁止 `/opsx:archive`。阶段顺序见 skill `openspec-technical-review` 的 `shared/phases.md`
- Keep going through tasks until done or blocked
- Always read context files before starting (from the apply instructions output)
- If task is ambiguous, pause and ask before implementing
- If implementation reveals issues, pause and suggest artifact updates
- Keep code changes minimal and scoped to each task
- Update task checkbox immediately after completing each task
- Pause on errors, blockers, or unclear requirements - don't guess
- Use contextFiles from CLI output, don't assume specific file names

**Fluid Workflow Integration**

This skill supports the "actions on a change" model:

- **Can be invoked anytime**: Before all artifacts are done (if tasks exist), after partial implementation, interleaved with other actions
- **Allows artifact updates**: If implementation reveals design issues, suggest updating artifacts - not phase-locked, work fluidly
