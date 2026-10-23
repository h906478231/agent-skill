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

   **STE 检查（BLOCKING，本仓自加，非上游原文）** —— 开始任何任务前，先运行 `openspec status --change "<name>" --json` 取 `changeRoot`（Step 3 运行同一命令，可复用结果），再运行 `node <STE> check <changeRoot>`（`<STE>` = skill `openspec-ste` 的 `scripts/ste-lint.mjs`，skill 目录随 agent 而不同；找不到时用 Glob 搜 `**/openspec-ste/scripts/ste-lint.mjs`），按该 skill 的 `shared/gate-check.md` 的「Apply」列处理结果（存在阻断项时停止，不开始任何任务）；找不到脚本时输出「STE 检查已跳过：未找到 openspec-ste（<原因>）」后继续，不得静默跳过。

   **变更模型检查（BLOCKING，本仓自加，非上游原文）** —— STE 检查放行后、开始任何任务前运行 `node <CM> check <changeRoot>`（`<CM>` = skill `openspec-change-overview` 的 `scripts/change-model.mjs`，skill 目录随 agent 而不同；找不到时用 Glob 搜 `**/openspec-change-overview/scripts/change-model.mjs`），退出码按 skill `openspec-ste` 的 `shared/gate-check.md` 的「Apply」列处理，与 STE 检查相同；存在阻断项时逐项列出（`design.md:行号`、规则、`text`、`detail`）并**停止**，不开始任何任务；修正方式见 skill `openspec-change-overview` 的 `shared/change-model.md`「6 项检查」。找不到脚本时输出「变更模型检查已跳过：未找到 openspec-change-overview（<原因>）」后继续，不得静默跳过。

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

   **基线任务数（本仓自加）** —— 首次 apply 时在 `tasks.md` 一级标题后写 `基线任务数：N（YYYY-MM-DD 首次 apply）`（非 checkbox，之后不改）；已有该行时，新增任务 > N × 50% 或新增能力 / 顶层模块，按 skill `openspec-update-change`「范围扩展拆分提示」询问用户并记录到 `discussion-log.md`。

7. **Implement tasks (loop until done or blocked)**

   **TDD 实施纪律（写第一个测试之前）**：完整规则见 skill `openspec-apply-change` 自己的 `shared/tdd-discipline.md`（skill 目录随 agent 而不同：Claude Code `~/.claude/skills/openspec-apply-change/shared/`、Codex CLI `~/.codex/skills/openspec-apply-change/shared/`、opencode `~/.config/opencode/skills/openspec-apply-change/shared/` 等；找不到时用 Glob 搜 `**/openspec-apply-change/shared/tdd-discipline.md`），**先读取该文件并严格遵守**。要点：只在 design.md「测试 Seam 决策」区块（或口头确认后回记到切片 `Seam:` 行）声明的公共边界写测试；red before green；一次一个切片、切片内一次一个行为；每完成一个任务项跑单测试文件 + 类型检查，全部完成跑完整测试套件；测试按运行依赖分单元测试、集成测试、e2e 测试，分类决定在哪里运行、是否阻断归档（见该文件「测试分类」）；重构不进 red-green 循环，留给 `/opsx:quality`。

   **切片新鲜证据（本仓自加，非上游原文）**：切片声明了 `Evidence:` 行时，勾选任务前必须先写证据。完整规则见 skill `openspec-apply-change` 的 `shared/slice-evidence.md`（skill 目录随 agent 而不同；找不到时用 Glob 搜 `**/openspec-apply-change/shared/slice-evidence.md`），**先读取该文件并严格遵守**。要点：运行任务相关的单个测试文件 + 类型检查 / 编译（按项目约定选命令）→ 用 skill `openspec-technical-review` 的 `scripts/implementation-gate.mjs fingerprint <changeRoot>` 取实现指纹 → 创建或更新 `evidence/slice-<id>.md` → `Result: PASS` 后才勾选。未运行的命令不得写 PASS。`Environment:` 切片的集成测试在本地无法运行时，按「待环境补测」登记，用户确认后不阻断归档。

   For each pending task:
   - Show which task is being worked on
   - Make the code changes required
   - Keep changes minimal and focused
   - Run the task's single test file + type check / compile, then update the slice evidence record (when the slice declares `Evidence:`)
   - Mark task complete in the tasks file: `- [ ]` → `- [x]` —— only after the evidence shows `Result: PASS`
   - Continue to next task

   All tasks done → run the full test suite once and refresh every slice's evidence fingerprint, so earlier slices are not left stale by later ones.

   **完整套件存在失败时（本仓自加）** —— 用 `regress` 与基线失败清单比较：`introduced` 为空记 `PASS_WITH_BASELINE`，不为空记 `FAIL` 并新增修复任务。结论只写「本次引入的失败：N」。规则见 skill `openspec-apply-change` 的 `shared/slice-evidence.md`「基线失败清单」。

   **实现后修改登记（本仓自加，非上游原文）** —— 不在某个未勾选任务内进行的代码修改（切片任务全部勾选之后、评审之后、门禁外提交；`state: "all_done"` 之后再改代码也属于这种情况），按 skill `openspec-apply-change` 的 `shared/post-implementation-changes.md`（skill 目录随 agent 而不同；找不到时用 Glob 搜 `**/openspec-apply-change/shared/post-implementation-changes.md`）在下一次 `/opsx:quality` 或 `/opsx:verify` 之前登记到 `tasks.md` 的 `## 实现后修改登记`，**先读取该文件并严格遵守**。要点：先运行 skill `openspec-technical-review` 的 `scripts/implementation-gate.mjs classify <changeRoot> --from <修改前的指纹>`；`commentOnly` 中的文件登记为 `非行为`；其他文件判定为 `等价`（不改输入、输出、数据写入、外部调用与异常路径，**用户确认后**才写入）或 `行为`（照常新增任务）；拿不准时取较高档位。每行写登记指纹（修改与验证完成后 `fingerprint` 的输出），同一文件再次修改时新增一行。登记不改变任务进度。

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
- **STE 检查存在阻断项时不开始任何任务**（Step 2，本仓自加）—— 修正产物走 `/opsx:update`，不在 apply 中顺手改
- **遵守 skill `openspec-apply-change` 自己的 `shared/tdd-discipline.md` TDD 纪律**（Step 7）—— seam-first、red before green、重构留给 `/opsx:quality`
- **证据先于勾选**（本仓自加）—— 切片声明了 `Evidence:` 时，按该 skill 的 `shared/slice-evidence.md` 先记录绑定当前实现指纹的验证证据再勾选；不伪造结果、不为历史变更补造证据
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
