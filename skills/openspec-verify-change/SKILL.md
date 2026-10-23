---
name: openspec-verify-change
description: Verify implementation matches change artifacts before archiving (交叉验证 III - 实现与设计交叉核对). Use when the user wants to validate that implementation is complete, correct, and coherent before archiving.
allowed-tools: Bash(openspec:*)
license: MIT
compatibility: Requires openspec CLI.
metadata:
  author: openspec
  version: "1.0"
  generatedBy: "1.6.0"
tags: [cross-validation]
---

Verify that an implementation matches the change artifacts (specs, tasks, design).

**核心机制：交叉验证 III - 实现与设计交叉核对**。确保代码实现与设计意图一致，并回溯验证是否解决了第一性原理分析中识别的底层问题。

**Store selection:** If the user names a store (a store is a standalone OpenSpec repo registered on this machine) or the work lives in one, run `openspec store list --json` to discover registered store ids, then pass `--store <id>` on the commands that read or write specs and changes (`new change`, `status`, `instructions`, `list`, `show`, `validate`, `archive`, `doctor`, `context`). Other commands do not take the flag. Hints printed by commands already carry the flag; keep it on follow-ups. Without a store, commands act on the nearest local `openspec/` root.

**Input**: Optionally specify a change name. If omitted, check if it can be inferred from conversation context. If vague or ambiguous you MUST prompt for available changes.

**Steps**

1. **If no change name provided, prompt for selection**

   Run `openspec list --json` to get available changes. Use the **AskUserQuestion tool** to let the user select.

   Show changes that have implementation tasks (tasks artifact exists).
   Include the schema used for each change if available.
   Mark changes with incomplete tasks as "(In Progress)".

   **IMPORTANT**: Do NOT guess or auto-select a change. Always let the user choose.

2. **Check status to understand the schema**
   ```bash
   openspec status --change "<name>" --json
   ```
   Parse the JSON to understand:
   - `schemaName`: The workflow being used (e.g., "spec-driven")
   - `planningHome`, `changeRoot`, `artifactPaths`, and `actionContext`: path and scope context
   - Which artifacts exist for this change

3. **Get planning context and load artifacts**

   ```bash
   openspec instructions apply --change "<name>" --json
   ```

   This returns the change directory and `contextFiles` (artifact ID -> array of concrete file paths). Read all available artifacts from `contextFiles`.

4. **Initialize verification report structure**

   Create a report structure with three dimensions:
   - **Completeness**: Track tasks and spec coverage
   - **Correctness**: Track requirement implementation and scenario coverage
   - **Coherence**: Track design adherence and pattern consistency

   Each dimension can have CRITICAL, WARNING, or SUGGESTION issues.

   **增量复核（本仓自加，非上游原文）** —— 上一份 `<changeRoot>/verification.md` 存在时，先判定本次的 `Verify Mode`（`<GATE>` = `../openspec-technical-review/scripts/implementation-gate.mjs`）：
   - 下列 3 项全部满足时为 `增量`：
     1. 上一份 `verification.md` 写有 `Fingerprint`，并且没有 CRITICAL；
     2. `node <GATE> classify <changeRoot> --from <上一份的 Fingerprint>` 的 `unregistered` 为空（退出码 0）；
     3. `registered` 中没有档位为 `行为` 的行。
   - `增量` 时只重跑第 5 步的「切片证据与双轴评审闭环」（`evidence`、`review`、`hygiene`）、Sonar 扫描核对、STE 检查与变更模型检查。三维结论、「评审条件」与第 9 步的人工核对沿用上一份报告，报告写明沿用依据（上一份的 `Fingerprint` 与 `classify` 结论）。脚本检查出现新的 CRITICAL 时照常阻断。
   - 其他情况为 `全量`，运行全部步骤：没有上一份报告、`classify` 退出码为 1 或 2、`registered` 中有 `行为` 档位。
   - 登记与档位规则见 `../openspec-apply-change/shared/post-implementation-changes.md`。

   **复用 Spec Fidelity 结论（本仓自加，非上游原文）** —— `全量` 时先判定本次的 `Spec Fidelity Reuse`。双轴评审已经逐条核对需求、场景与设计偏离，verify 不再逐条搜代码（边界见 `../openspec-code-quality/shared/dual-axis-review.md`「与既有阶段的职责去重」）：
   - `复用`：下列 3 项全部满足。
     1. `<changeRoot>/review/spec-fidelity.md` 存在；运行 `node <GATE> review <changeRoot>`，`verdict` 不是 `INCOMPLETE`，并且 `issues` 为空（第 5 步可以直接使用这次的输出）；
     2. `node <GATE> classify <changeRoot> --from <spec-fidelity.md 的 Fingerprint>` 的退出码为 0；
     3. `registered` 中没有档位为 `行为` 的行。
   - `部分复用`：满足第 1 项，`classify` 退出码为 0 或 1，并且 `registered` 中有 `行为` 档位的行，或 `unregistered` 不为空。只对这些文件自己核对：规格覆盖矩阵中「实现位置」或「验证证据」列出这些文件的行，以及这些文件中矩阵没有列出的行为；其他行复用。这些文件按登记规则处理，`行为` 档要回 `/opsx:quality` 跑两轴增量。
   - `不复用`：没有 `spec-fidelity.md`（如 L0/L1 没有运行 quality），或 `classify` 退出码为 2。第 5–7 步照常执行。
   - `增量` 时三维结论沿用上一份报告，不判定本项，报告写 `不适用（增量复核）`。

   `复用` 与 `部分复用` 时，第 5 步 Spec Coverage、第 6 步与第 7 步 Design Adherence 读取 `spec-fidelity.md`（部分复用中自己核对的行除外），严重级别仍按本 skill 的规则：
   - 规格覆盖矩阵中 Requirement 行没有实现位置 → CRITICAL；有实现位置，但状态写明部分实现或与需求不符 → WARNING。
   - Scenario 行没有验证证据 → WARNING。
   - 设计偏离清单中的行：`design.md` 已写入该项，或对应的 SPEC finding 已闭环，才算处理完；其他行 → WARNING。

   勾选统计、切片证据与双轴评审闭环、STE 检查、变更模型检查、Code Pattern Consistency 与第 9 步的人工核对不受本项影响，照常执行。

5. **Verify Completeness**

   **Task Completion**:
   - If `contextFiles.tasks` exists, read every file path in it
   - Parse checkboxes: `- [ ]` (incomplete) vs `- [x]` (complete)
   - Count complete vs total tasks
   - If incomplete tasks exist:
     - Add CRITICAL issue for each incomplete task
     - Recommendation: "Complete task: <description>" or "Mark as done if already implemented"

   **Spec Coverage**:
   - `Spec Fidelity Reuse` 为 `复用` 或 `部分复用` 时，按第 4 步「复用 Spec Fidelity 结论」处理，不逐条搜代码（本仓自加）
   - If delta specs exist in `contextFiles.specs`:
     - Extract all requirements (marked with "### Requirement:")
     - For each requirement:
       - Search codebase for keywords related to the requirement
       - Assess if implementation likely exists
     - If requirements appear unimplemented:
       - Add CRITICAL issue: "Requirement not found: <requirement name>"
       - Recommendation: "Implement requirement X: <description>"

   **切片证据与双轴评审闭环（本仓自加，非上游原文）**：
   - 读取 `../openspec-technical-review/shared/implementation-gate-check.md`（相对本 SKILL.md 解析；读不到时 Glob 搜 `**/openspec-technical-review/shared/implementation-gate-check.md`），按其「Verify」一节执行
   - 运行 `node <GATE> evidence <changeRoot>` 与 `node <GATE> review <changeRoot>`（`<GATE>` = `../openspec-technical-review/scripts/implementation-gate.mjs`）
   - 缺失 / 不完整 / 失败 / 过期的切片证据，双轴评审 `BLOCKED` 或报告不完整 → CRITICAL；证据过期按 `changedSinceEvidence` 决定重跑或登记豁免；`pending-environment`（待环境补测）→ WARNING，写出切片、负责人与补测计划
   - `evidence` 输出的 `taskIssues`（未勾选任务要求运行阶段命令或执行 `git commit` / `git push`）→ 每条记 CRITICAL，写出任务编号、`kind` 与命中文本；修正方式是改写任务，把内容移到 `../openspec-propose/shared/task-slicing.md`「排除清单」的去处，不是等阶段动作完成或执行 git 命令；切片证据不适用时同样处理
   - 脚本返回「不适用」时把理由原样写进报告，不得把缺证据静默当作通过；历史变更不追溯补证据
   - 运行 `node <GATE> hygiene <changeRoot>`：每条 `warnings` 记为一条 SUGGESTION（文件路径 + `reason`），建议把补充材料移到 `evidence/attachments/`、删除 `-roundN` 副本；不阻断归档
   - 完整回归结论只写本次引入的失败数：`PASS_WITH_BASELINE`（本次引入的失败：0）记为通过；**禁止在报告中列出基线失败的测试名或数量**。本次引入的失败不为 0 → 每个测试记一条 CRITICAL，写明测试名与修复任务（规则见 `../openspec-apply-change/shared/slice-evidence.md`「结果取值」）

   **Sonar 扫描核对（本仓自加，非上游原文）** —— 读取 `../openspec-code-quality/shared/sonar-scan.md`（相对本 SKILL.md 解析；读不到时 Glob 搜 `**/openspec-code-quality/shared/sonar-scan.md`），按其「Verify 核对」执行：`review/sonar.md`「本次修改行上的问题」与「质量门」中，处理不是「误报」「接受」的行，以及「说明」或「决策人」为空的行，每行记 CRITICAL；项目配置了 Sonar 却没有 `review/sonar.md`、`Quality Gate: 无法运行`、扫描之后代码有非注释修改时，记 WARNING；项目没有配置 Sonar 时，报告写「Sonar：不适用（<原因>）」。

   **STE 检查（本仓自加，非上游原文）** —— 运行 `node <STE> check <changeRoot>`（`<STE>` = `../openspec-ste/scripts/ste-lint.mjs`，相对本 SKILL.md 解析；读不到时 Glob 搜 `**/openspec-ste/scripts/ste-lint.mjs`），按 `../openspec-ste/shared/gate-check.md` 的「Verify」列记录结果（每个阻断项记为 CRITICAL）；找不到脚本时在报告中写明「STE 检查已跳过：未找到 openspec-ste（<原因>）」，不得静默跳过。

   **变更模型检查（本仓自加，非上游原文）** —— STE 检查之后、同一阶段运行 `node <CM> check <changeRoot>`（`<CM>` = `../openspec-change-overview/scripts/change-model.mjs`，相对本 SKILL.md 解析；读不到时 Glob 搜 `**/openspec-change-overview/scripts/change-model.mjs`），退出码按 `../openspec-ste/shared/gate-check.md` 的「Verify」列处理，与 STE 检查相同；每个阻断项记为 CRITICAL；修正方式见 `../openspec-change-overview/shared/change-model.md`「6 项检查」。找不到脚本时在报告中写明「变更模型检查已跳过：未找到 openspec-change-overview（<原因>）」，不得静默跳过。

6. **Verify Correctness**

   `Spec Fidelity Reuse` 为 `复用` 或 `部分复用` 时，按第 4 步「复用 Spec Fidelity 结论」处理（本仓自加）。

   **Requirement Implementation Mapping**:
   - For each requirement from delta specs:
     - Search codebase for implementation evidence
     - If found, note file paths and line ranges
     - Assess if implementation matches requirement intent
     - If divergence detected:
       - Add WARNING: "Implementation may diverge from spec: <details>"
       - Recommendation: "Review <file>:<lines> against requirement X"

   **Scenario Coverage**:
   - For each scenario in delta specs (marked with "#### Scenario:"):
     - Check if conditions are handled in code
     - Check if tests exist covering the scenario
     - If scenario appears uncovered:
       - Add WARNING: "Scenario not covered: <scenario name>"
       - Recommendation: "Add test or implementation for scenario: <description>"

7. **Verify Coherence**

   **Design Adherence**:
   - `Spec Fidelity Reuse` 为 `复用` 或 `部分复用` 时，按第 4 步「复用 Spec Fidelity 结论」处理（本仓自加）
   - If `contextFiles.design` exists:
     - Extract key decisions (look for sections like "Decision:", "Approach:", "Architecture:")
     - Verify implementation follows those decisions
     - If contradiction detected:
       - Add WARNING: "Design decision not followed: <decision>"
       - Recommendation: "Update implementation or revise design.md to match reality"
   - If no design.md: Skip design adherence check, note "No design.md to verify against"

   **Code Pattern Consistency**:
   - Review new code for consistency with project patterns
   - Check file naming, directory structure, coding style
   - If significant deviations found:
     - Add SUGGESTION: "Code pattern deviation: <details>"
     - Recommendation: "Consider following project pattern: <example>"

8. **Generate Verification Report**

   报告必须写入 `<changeRoot>/verification.md`，每次重跑**原地覆盖**，禁止生成 `verification-round2.md` 这类副本（本仓自加；规则见 `../openspec-code-quality/shared/dual-axis-review.md`「原地覆盖与 Finding 台账」）。archive 与下一次 verify 的增量复核只读这个文件，不读对话，因此 archive 可以在新会话中执行；只在对话中输出报告不算完成本步。

   **Summary Scorecard**:
   ```
   ## Verification Report: <change-name>

   - Fingerprint: git-tree:<sha>
   - Verify Mode: 全量 / 增量（沿用依据：上一份 Fingerprint、classify 结论）
   - Spec Fidelity Reuse: 复用（基线 git-tree:<sha>）/ 部分复用（自查文件：<文件>）/ 不复用（<原因>）/ 不适用（增量复核）

   ### Summary
   | Dimension    | Status           |
   |--------------|------------------|
   | Completeness | X/Y tasks, N reqs|
   | Correctness  | M/N reqs covered |
   | Coherence    | Followed/Issues  |
   | Evidence     | N/M slices fresh (or 不适用: reason) |
   | Regression   | PASS / PASS_WITH_BASELINE（本次引入的失败：0）/ FAIL（本次引入：<测试名>） |
   | Review       | PASSED/BLOCKED (or 不适用: reason)   |
   | STE          | PASS/BLOCKED/ERROR (or 已跳过: reason) |
   | Change Model | PASS/BLOCKED/ERROR (or 已跳过: reason) |
   | Sonar        | PASSED/FAILED/无法运行 (or 不适用: reason) |
   | Deployment   | 见 deployment.md（or 不需要: reason / 缺少: WARNING） |

   ### 评审条件
   | 条件 | 映射任务或行号 | 状态 |
   |------|---------------|------|
   | C1 | 任务 3.2 / design.md:120 | 已闭环 / 未闭环 |
   ```

   报告字段（本仓自加，非上游原文）：
   - `Fingerprint` 取 `node <GATE> fingerprint <changeRoot>` 的输出，是下一次判定增量复核的起点。
   - `Spec Fidelity Reuse` 按第 4 步「复用 Spec Fidelity 结论」填写。
   - 「评审条件」按第 9 步「评审条件闭环」填写，archive 读取本小节。没有 `review-summary.md` 时写「不适用：该变更未经技术评审」。存在完整版 overview 时，在小节下写出它的「最近生成」日期与「依据轮次」，不要求刷新。

   **Issues by Priority**:

   1. **CRITICAL** (Must fix before archive):
      - Incomplete tasks
      - Missing requirement implementations
      - Missing / incomplete / failed / stale slice evidence; dual-axis review BLOCKED or incomplete (本仓自加)
      - STE check blocking findings, one CRITICAL per finding; STE check exit code 2 (environment error) as one CRITICAL (本仓自加)
      - Change-model check blocking findings (CM-1~CM-6), one CRITICAL per finding; change-model check exit code 2 as one CRITICAL (本仓自加)
      - Sonar issues on changed lines and failed quality-gate conditions that the user has not marked 误报 / 接受 with a reason, one CRITICAL each (本仓自加)
      - Each with specific, actionable recommendation

   2. **WARNING** (Should fix):
      - Spec/design divergences
      - Missing scenario coverage
      - Each with specific recommendation

   3. **SUGGESTION** (Nice to fix):
      - Pattern inconsistencies
      - Artifacts outside the allowlist (`hygiene` warnings, 本仓自加)
      - Minor improvements
      - Each with specific recommendation

   **Final Assessment**:
   - If CRITICAL issues: "X critical issue(s) found. Fix before archiving."
   - If only warnings: "No critical issues. Y warning(s) to consider. Ready for archive (with noted improvements)."
   - If all clear: "All checks passed. Ready for archive."

9. **交叉验证 III：人工核对清单（超出自动校验范围）**

   以下人工核对清单的**规则与条目以 skill `openspec-technical-review` 的 `../openspec-technical-review/shared/phase6-verification.md` 为唯一事实源**（本文件不复制条目）：
   - **回溯第一性原理**：实现是否解决 `proposal.md` 的底层问题；是否引入未识别的新约束
   - **方案选择一致性**：实现是否与 `design.md` 推荐方案一致；偏离是否已回填 `design.md`
   - **评审条件闭环**：直接读取 `review-summary.md` 的「有条件通过」条件，逐条核对：映射到任务时，任务已勾选、实现存在；映射到 `<文件>:<行号>` 时，该行存在并写明了条件。结果写进报告「评审条件」小节。不运行 `/opsx:overview`
   - **设计阶段可测试性 / 运维成本**：关键路径测试覆盖、mock 可行性、新增的运维成本与监控告警

   逐项判据与「不通过视同 Blocker」的处理规则见该文件。

   **排除清单核对（本仓自加，不属于上述清单，不视同 Blocker）**：逐项核对 `tasks.md` 的任务是否写入了 `../openspec-propose/shared/task-slicing.md`「排除清单」中的内容（E1–E9）。`taskIssues` 已报出的任务按上文记 CRITICAL；其余命中清单的任务每项记 WARNING，写出类别编号与去处。例如已勾选的「确认回滚语义不变」没有对应测试 → WARNING，类别 E9，去处是一个测试，或写进可能影响回滚语义的任务的完成标准。

   **验收部署文档核对（本仓自加，不视同 Blocker）**：按 `../openspec-apply-change/shared/deployment-document.md`「Verify 核对」执行。存在 `deployment.md` 时，逐项核对负责人，以及通过条件或达标条件，缺少时每项记 WARNING，写出小节与条目；命中创建条件（`design.md` 的 Migration Plan 有在生产环境执行的步骤，或 Risk Accepted 写了上线后的复查条件，或「测试 Seam 决策」有 e2e 测试）却没有该文件时，记 WARNING；都没有命中时不报出问题。报告只在 Summary 写一行指向 `deployment.md`，不重复列出条目。

   **人工核对建议**：
   - 在完成自动校验后，逐项核对以上清单
   - 不通过的项视同 **Blocker**，需补充实现或更新文档
   - 完成人工核对后再执行 `/opsx:archive`

**Verification Heuristics**

- **Completeness**: Focus on objective checklist items (checkboxes, requirements list)
- **Correctness**: Use keyword search, file path analysis, reasonable inference - don't require perfect certainty
- **Coherence**: Look for glaring inconsistencies, don't nitpick style
- **False Positives**: When uncertain, prefer SUGGESTION over WARNING, WARNING over CRITICAL
- **Actionability**: Every issue must have a specific recommendation with file/line references where applicable

**Graceful Degradation**

- If only tasks.md exists: verify task completion only, skip spec/design checks
- If tasks + specs exist: verify completeness and correctness, skip design
- If full artifacts: verify all three dimensions
- Always note which checks were skipped and why

**Output Format**

Use clear markdown with:
- Table for summary scorecard
- Grouped lists for issues (CRITICAL/WARNING/SUGGESTION)
- Code references in format: `file.ts:123`
- Specific, actionable recommendations
- No vague suggestions like "consider reviewing"
- **交叉验证 III 人工核对清单**（在自动校验报告之后）

**完整的交叉验证链条**

| 阶段 | 验证类型 | 防止的问题 | 执行位置 |
|------|---------|-----------|---------|
| Phase 1 | 第一性原理分析 | 解决错误的问题 | `/opsx:explore` |
| Phase 2 | 候选方案交叉验证 | 方案选择无依据 | `/opsx:explore` |
| Phase 3 | 多维度交叉验证（维度数按分级） | 方案存在盲区 | `/opsx:review` |
| Phase 5.5 | 实现后双轴独立评审（Standards + Spec Fidelity） | 工程规范问题 / 实现偏离需求与设计 | `/opsx:quality` |
| Phase 6 | 实现与设计交叉验证（当前阶段） | 实现偏离设计意图 | `/opsx:verify` + 人工核对 |

参考完整质量保障体系：`workflow/OpenSpec-AI-研发流程.md`
