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

5. **Verify Completeness**

   **Task Completion**:
   - If `contextFiles.tasks` exists, read every file path in it
   - Parse checkboxes: `- [ ]` (incomplete) vs `- [x]` (complete)
   - Count complete vs total tasks
   - If incomplete tasks exist:
     - Add CRITICAL issue for each incomplete task
     - Recommendation: "Complete task: <description>" or "Mark as done if already implemented"

   **Spec Coverage**:
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
   - 缺失 / 不完整 / 失败 / 过期的切片证据，双轴评审 `BLOCKED` 或报告不完整 → CRITICAL；证据过期按 `changedSinceEvidence` 决定重跑或登记豁免
   - 脚本返回「不适用」时把理由原样写进报告，不得把缺证据静默当作通过；历史变更不追溯补证据

6. **Verify Correctness**

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

   **Summary Scorecard**:
   ```
   ## Verification Report: <change-name>

   ### Summary
   | Dimension    | Status           |
   |--------------|------------------|
   | Completeness | X/Y tasks, N reqs|
   | Correctness  | M/N reqs covered |
   | Coherence    | Followed/Issues  |
   | Evidence     | N/M slices fresh (or 不适用: reason) |
   | Review       | PASSED/BLOCKED (or 不适用: reason)   |
   ```

   **Issues by Priority**:

   1. **CRITICAL** (Must fix before archive):
      - Incomplete tasks
      - Missing requirement implementations
      - Missing / incomplete / failed / stale slice evidence; dual-axis review BLOCKED or incomplete (本仓自加)
      - Each with specific, actionable recommendation

   2. **WARNING** (Should fix):
      - Spec/design divergences
      - Missing scenario coverage
      - Each with specific recommendation

   3. **SUGGESTION** (Nice to fix):
      - Pattern inconsistencies
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
   - **评审条件闭环**：先跑 `/opsx:overview` 刷新条件矩阵，逐条核对 `review-summary.md` 的「有条件通过」条件
   - **设计阶段可测试性 / 运维成本**：关键路径测试覆盖、mock 可行性、新增的运维成本与监控告警

   逐项判据与「不通过视同 Blocker」的处理规则见该文件。

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
