---
name: openspec-apply-change
description: Implement tasks from an OpenSpec change. Use when the user wants to start implementing, continue implementation, or work through tasks.
allowed-tools: Bash(openspec:*)
license: MIT
compatibility: Requires openspec CLI.
metadata:
  author: openspec
  version: "1.0"
  generatedBy: "1.6.0"
---

Implement tasks from an OpenSpec change.

**Store selection:** If the user names a store (a store is a standalone OpenSpec repo registered on this machine) or the work lives in one, run `openspec store list --json` to discover registered store ids, then pass `--store <id>` on the commands that read or write specs and changes (`new change`, `status`, `instructions`, `list`, `show`, `validate`, `archive`, `doctor`, `context`). Other commands do not take the flag. Hints printed by commands already carry the flag; keep it on follow-ups. Without a store, commands act on the nearest local `openspec/` root.

**Input**: Optionally specify a change name. If omitted, check if it can be inferred from conversation context. If vague or ambiguous you MUST prompt for available changes.

**Steps**

1. **Select the change**

   If a name is provided, use it. Otherwise:
   - Infer from conversation context if the user mentioned a change
   - Auto-select if only one active change exists
   - If ambiguous, run `openspec list --json` to get available changes and use the **AskUserQuestion tool** to let the user select

   Always announce: "Using change: <name>" and how to override (e.g., `/opsx:apply <other>`).

2. **Technical Review Gate check (BLOCKING — do this before writing any code)**

   Full rules live in the sibling skill `openspec-technical-review`, file `../openspec-technical-review/shared/apply-gate-check.md` relative to this SKILL.md (all skills sit flat under one skills root). **Do not hardcode an absolute path** — the skills root differs per agent (`~/.claude/skills/`, `~/.codex/skills/`, `~/.config/opencode/skills/`, `~/.cursor/skills/`, a project-level `.claude/skills/`, …). If the relative path does not resolve, Glob for `**/openspec-technical-review/shared/apply-gate-check.md`. **Read that file and follow it exactly.** In short: no `review-summary.md` → ALLOW (change has no gate enabled); has `review-summary.md` but blank sign-off placeholder or verdict `BLOCKED` → STOP, write no implementation code. Never sign on the user's behalf, edit the sign-off line, or talk the user into skipping this.

   The `PreToolUse` hook cannot see skill/slash-command invocations — this step is the only check on that path, so do not skip it.

   **STE 检查（BLOCKING，本仓自加，非上游原文）** —— 开始任何任务前，先运行 `openspec status --change "<name>" --json` 取 `changeRoot`（Step 3 运行同一命令，可复用结果），再运行 `node <STE> check <changeRoot>`（`<STE>` = `../openspec-ste/scripts/ste-lint.mjs`，相对本 SKILL.md 解析；读不到时 Glob 搜 `**/openspec-ste/scripts/ste-lint.mjs`），按 `../openspec-ste/shared/gate-check.md` 的「Apply」列处理结果（存在阻断项时停止，不开始任何任务）；找不到脚本时输出「STE 检查已跳过：未找到 openspec-ste（<原因>）」后继续，不得静默跳过。

   **变更模型检查（BLOCKING，本仓自加，非上游原文）** —— STE 检查放行后、开始任何任务前运行 `node <CM> check <changeRoot>`（`<CM>` = `../openspec-change-overview/scripts/change-model.mjs`，相对本 SKILL.md 解析；读不到时 Glob 搜 `**/openspec-change-overview/scripts/change-model.mjs`），退出码按 `../openspec-ste/shared/gate-check.md` 的「Apply」列处理，与 STE 检查相同；存在阻断项时逐项列出（`design.md:行号`、规则、`text`、`detail`）并**停止**，不开始任何任务；修正方式见 `../openspec-change-overview/shared/change-model.md`「6 项检查」。找不到脚本时输出「变更模型检查已跳过：未找到 openspec-change-overview（<原因>）」后继续，不得静默跳过。

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
   - `contextFiles`: artifact ID -> array of concrete file paths (varies by schema - could be proposal/specs/design/tasks or spec/tests/implementation/docs)
   - Progress (total, complete, remaining)
   - Task list with status
   - Dynamic instruction based on current state

   **Handle states:**
   - If `state: "blocked"` (missing artifacts): show message, suggest using openspec-continue-change
   - If `state: "all_done"`: congratulate, then suggest `/opsx:quality` (Phase 5.5; required for L2/L3, recommended for L0/L1) → `/opsx:verify` (Phase 6) before archive
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

   **基线任务数（本仓自加，非上游原文）** —— 首次 apply（`tasks.md` 还没有任何 `- [x]`，且开头没有基线行）时，在 `tasks.md` 一级标题之后写一行 `基线任务数：N（YYYY-MM-DD 首次 apply）`，N 为当前 checkbox 总数。该行不是 checkbox，不影响进度解析，之后不修改。已有该行时，比较当前 checkbox 总数与 N：新增任务 > N × 50%，或新增能力、新增顶层模块，按 `../openspec-update-change/SKILL.md`「范围扩展拆分提示」询问用户并记录到 `discussion-log.md`。

7. **Implement tasks (loop until done or blocked)**

   **TDD 实施纪律（写第一个测试之前，读取 `shared/tdd-discipline.md` 并遵守）** —— 本 skill 目录下的规则文件（相对本 SKILL.md 解析，装了 openspec-apply-change 就一定存在）；读不到时用 Glob 搜 `**/openspec-apply-change/shared/tdd-discipline.md`。要点：只在 design.md「测试 Seam 决策」区块（或口头确认后回记到切片 `Seam:` 行）声明的公共边界写测试，未声明的边界先问；red before green；一次一个切片、切片内一次一个行为（一个失败测试 → 最小实现 → 下一个）；每完成一个任务项跑单个测试文件 + 类型检查，全部完成跑一次完整测试套件；测试按运行依赖分单元测试、集成测试、e2e 测试，分类决定在哪里运行、是否阻断归档（见该文件「测试分类」）；重构不进 red-green 循环，留给 `/opsx:quality`。

   **切片新鲜证据（本仓自加，非上游原文）** —— 切片声明了 `Evidence:` 行时，勾选任务前必须先写证据：读取本 skill 的 `shared/slice-evidence.md`（相对本 SKILL.md 解析；读不到时 Glob 搜 `**/openspec-apply-change/shared/slice-evidence.md`）并遵守。要点：运行任务相关的单个测试文件 + 类型检查 / 编译（按项目约定选命令）→ 用 `node <GATE> fingerprint <changeRoot>` 取实现指纹（`<GATE>` = `../openspec-technical-review/scripts/implementation-gate.mjs`）→ 创建或更新 `evidence/slice-<id>.md` → `Result: PASS` 后才勾选。未运行的命令不得写 PASS。`Environment:` 切片的集成测试在本地无法运行时，按「待环境补测」登记，用户确认后不阻断归档。

   For each pending task:
   - Show which task is being worked on
   - Make the code changes required
   - Keep changes minimal and focused
   - Run the task's single test file + type check / compile, then update the slice evidence record (when the slice declares `Evidence:`)
   - Mark task complete in the tasks file: `- [ ]` → `- [x]` —— only after the evidence shows `Result: PASS`
   - Continue to next task

   All tasks done → run the full test suite once and refresh every slice's evidence fingerprint (see `shared/slice-evidence.md`「生成时机」), so earlier slices are not left stale by later ones.

   **完整套件存在失败时（本仓自加）** —— 把实际失败整理为清单，运行 `node <GATE> regress --baseline <基线失败清单> --actual <实际失败清单>`（清单格式与生成方法见 `shared/slice-evidence.md`「基线失败清单」）：`introduced` 为空记 `PASS_WITH_BASELINE`，并写 `Baseline List` 与 `Introduced Failures: 0`；不为空记 `FAIL`，点名每个引入的测试并在 `tasks.md` 新增修复任务。结论只写「本次引入的失败：N」，不列出基线失败。

   **实现后修改登记（本仓自加，非上游原文）** —— 不在某个未勾选任务内进行的代码修改（切片任务全部勾选之后、评审之后、门禁外提交；`state: "all_done"` 之后再改代码也属于这种情况），读取本 skill 的 `shared/post-implementation-changes.md`（相对本 SKILL.md 解析；读不到时 Glob 搜 `**/openspec-apply-change/shared/post-implementation-changes.md`）并遵守，在下一次 `/opsx:quality` 或 `/opsx:verify` 之前登记到 `tasks.md` 的 `## 实现后修改登记`。要点：先运行 `node <GATE> classify <changeRoot> --from <修改前的指纹>`；`commentOnly` 中的文件登记为 `非行为`；其他文件判定为 `等价`（不改输入、输出、数据写入、外部调用与异常路径，**用户确认后**才写入）或 `行为`（照常新增任务）；拿不准时取较高档位。每行写登记指纹（修改与验证完成后 `fingerprint` 的输出；声明了变更终点时写 `fingerprint --rev <变更终点>` 的输出，见事实源「变更终点」），同一文件再次修改时新增一行。登记不改变任务进度。

   **Pause if:**
   - Task is unclear → ask for clarification
   - Implementation reveals a design issue → suggest updating artifacts
   - Error or blocker encountered → report and wait for guidance
   - User interrupts

8. **On completion or pause, show status**

   Display:
   - Tasks completed this session
   - Overall progress: "N/M tasks complete"
   - If all done: suggest the implementation-stage checks — `/opsx:quality` (Phase 5.5, dual-axis review; required for L2/L3, recommended for L0/L1) then `/opsx:verify` (Phase 6); do not suggest archive before verify passes and any dual-axis review that was run is PASSED
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

All tasks complete! Next: `/opsx:quality` (Phase 5.5; required for L2/L3, recommended for L0/L1) → `/opsx:verify` (Phase 6). Archive after verify passes and any dual-axis review that was run is PASSED.
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
- **Never implement before the Technical Review Gate is signed off** (Step 2) when the project uses it — no exceptions, no signing on the user's behalf
- **STE 检查存在阻断项时不开始任何任务**（Step 2，本仓自加）—— 修正产物走 `/opsx:update`，不在 apply 中顺手改
- **Follow the TDD discipline in `shared/tdd-discipline.md`** (Step 7) — seam-first, red before green, refactoring is deferred to `/opsx:quality`, never on the red-green path
- **证据先于勾选**（本仓自加）—— 切片声明了 `Evidence:` 时，按 `shared/slice-evidence.md` 先记录绑定当前实现指纹的验证证据再勾选；不伪造结果、不为历史变更补造证据
- **实现全部完成后进入质量评审与验证，不得直接归档**（本仓自加，非上游原文）—— 依次跑 `/opsx:quality`（Phase 5.5，产出 `review/code-review-summary.md`；L2/L3 必需，L0/L1 推荐，等级取 `overview.md` 分级行，读不到时按 L2/L3）与 `/opsx:verify`（Phase 6，三维校验 + 评审条件核对）；verify 未通过、L2/L3 缺少双轴评审报告，或已生成的双轴评审存在未闭环 Blocker 时禁止 `/opsx:archive`。阶段顺序与门禁口径的唯一事实源见 `../openspec-technical-review/shared/phases.md`
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
