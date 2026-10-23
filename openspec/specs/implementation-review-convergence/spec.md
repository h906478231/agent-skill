# implementation-review-convergence Specification

## Purpose
实现评审收敛：Blocker 必须引用固定判据，修复后复跑只评审增量，评审与校验报告原位覆盖并保留累积 finding 台账，apply 之外的代码改动须先登记再复跑。
## Requirements
### Requirement: Implementation review Blockers SHALL cite a fixed criterion

`dual-axis-review.md` SHALL define the only valid Blocker criteria for the dual-axis review:

| Code | Criterion |
|---|---|
| B1 | The change writes wrong data or writes data to the wrong owner, tenant or path. |
| B2 | The change allows cross-tenant or unauthorized access. |
| B3 | A checked task has no implementation. |
| B4 | An existing function fails with normal input and healthy dependencies. |
| B5 | The change swallows an exception and records a failed operation as successful. |

A finding that occurs only when a dependency fails or with boundary input SHALL be Major, not Blocker. The trigger-scenario cell of a Blocker SHALL start with its code, for example `[B4]`. The suggested-fix cell of a Blocker SHALL name the test or Seam that proves the fix.

#### Scenario: Blocker without a criterion code is a structure issue
- **WHEN** a report with rules version 2 has a Blocker row whose trigger scenario does not start with `[B1]` to `[B5]`
- **THEN** `implementation-gate.mjs review` reports a structure issue for that finding

#### Scenario: Dependency-failure-only finding is Major
- **WHEN** a reuse path fails only when the corp-code query service is unavailable
- **THEN** the reviewer records the finding as Major

### Requirement: Re-runs after fixes SHALL review only the delta

The first review round SHALL review the full change diff. Each later round SHALL run both axes on one new baseline whose review scope is the diff from the previous baseline fingerprint to the current fingerprint, plus the closure check of the previous findings. `implementation-gate.mjs baseline --since <previous fingerprint>` SHALL add the line `Delta Since: git-tree:<sha>` and list the changed files. When the previous tree object is missing, the command SHALL fall back to the full scope and print a warning.

Two exceptions SHALL apply to later rounds:

- When `classify` reports every file in the delta as comment-only, the agent SHALL NOT start a new round.
- When `classify` reports every file in the delta that is not comment-only as registered with the class `等价`, the round SHALL run Standards Review only and SHALL carry over Spec Fidelity. The carry-over rule is in the capability `post-implementation-change-tiering`.

#### Scenario: Second round reviews only changed files
- **WHEN** round 1 used fingerprint A and the fix produces fingerprint B that changes two files
- **THEN** `baseline --since A` prints `Delta Since: git-tree:A` and lists only the two files

#### Scenario: Previous tree object is missing
- **WHEN** `baseline --since A` runs and tree A no longer exists in the object database
- **THEN** the baseline uses the full scope and prints a warning

#### Scenario: Comment-only delta does not start a round
- **WHEN** the only change after the last baseline is a corrected SQL header comment
- **THEN** `classify` reports the file as comment-only
- **AND** `/opsx:quality` reports that no new round is needed

#### Scenario: Equivalent delta runs Standards only
- **WHEN** the delta contains three new log statements registered with the class `等价`
- **THEN** the round runs Standards Review only
- **AND** the summary contains `Carried Axis: spec-fidelity`

### Requirement: Review and verification reports SHALL be overwritten in place with a cumulative finding ledger

Each re-run SHALL overwrite `review/standards.md`, `review/spec-fidelity.md`, `review/code-review-summary.md` and `verification.md` in place. Copies such as `*-round1.md` or `verification-round2.md` SHALL NOT be created. Each axis report with rules version 2 SHALL contain a `## Finding 台账` section with the columns `ID | 严重级别 | 首次轮次 | 状态 | 闭环轮次 | 闭环依据`. Ledger rows SHALL NOT be removed across rounds. A closed row SHALL have closure evidence with a `文件:行号` location or a test name.

#### Scenario: Closed finding without closure evidence
- **WHEN** a ledger row has status `closed` and an empty closure-evidence cell
- **THEN** `implementation-gate.mjs review` reports a structure issue

#### Scenario: Open ledger row missing from the findings table
- **WHEN** a ledger row has status `open` and the findings table has no row with that ID
- **THEN** `implementation-gate.mjs review` reports a structure issue

#### Scenario: Reports without rules version 2 keep the old checks
- **WHEN** the baseline block of a report has no `Rules Version: 2` line
- **THEN** the review check does not require criterion codes or a ledger

### Requirement: Code changes outside apply SHALL be registered before a re-run

When the implementation fingerprint differs from the last review baseline and `classify` reports unregistered files, the agent SHALL register the change in the `## 实现后修改登记` table of `tasks.md` with a change class before it starts the next review round. A change with the class `行为` SHALL also get a task that names the commit or the files. Files that changed only in tasks that were added after the last review round and checked through `/opsx:apply` with fresh slice evidence SHALL NOT be registered. That round SHALL run both review axes on a delta baseline.

#### Scenario: Fix committed outside the workflow
- **WHEN** a developer commits a fix for SPEC-06 outside `/opsx:apply`
- **THEN** the next `/opsx:quality` run first registers the commit with the class `行为` and adds a task that references the commit
- **AND** the Spec Fidelity ledger closes SPEC-06 only with a file and line in that commit

#### Scenario: Review fix made in a new task is not registered
- **WHEN** the agent adds task 2.8 for a Spec Fidelity finding and checks it through `/opsx:apply` with fresh slice evidence
- **AND** `classify` lists the files of task 2.8 in `unregistered`
- **THEN** the next `/opsx:quality` run does not register these files
- **AND** the round runs both review axes on a delta baseline

#### Scenario: Log statements committed outside the workflow
- **WHEN** a developer commits three new INFO log statements outside `/opsx:apply`
- **AND** the user confirms the class `等价`
- **THEN** the next `/opsx:quality` run registers the commit with the class `等价` and adds no task
- **AND** the round runs Standards Review only
