# change-head Specification

## Purpose
变更终点：用户在 tasks.md 写出变更实现的最后一个提交，评审基线、classify 与评审陈旧提醒以它为界，切片证据仍按当前实现判定，归档摘要写出变更终点（决策见 docs/adr/0008-change-head-bounds-review-scope.md）。
## Requirements
### Requirement: The user SHALL declare the change head in tasks.md

A change MAY declare a change head in the section `## 变更终点` of `tasks.md`. The section SHALL contain the fields `提交`, `判定人`, `日期` and `依据`. `提交` SHALL be the full SHA of the last commit of the implementation of the change. Only the user SHALL fill `判定人`. The agent SHALL NOT write or change the section.

`implementation-gate.mjs` SHALL treat the change head as valid only when all of these are true:

- `提交` is a full SHA.
- `提交` resolves to a commit.
- The commit is HEAD or an ancestor of HEAD.
- `判定人` is not empty.

When the section exists and the change head is not valid, `baseline`, `classify`, `review` and `archive` SHALL exit with code `2` and SHALL write the reason. When `tasks.md` has no such section, these commands SHALL keep their behavior from before this change. `evidence` SHALL NOT read the section.

#### Scenario: Valid change head is reported by classify
- **WHEN** `tasks.md` declares the merge commit of the change as `提交`, the commit is an ancestor of HEAD, and `判定人` is `tigger`
- **THEN** `classify --from <fingerprint>` exits with code 0 or 1 according to `unregistered`
- **AND** the output contains `changeHead.commit` with the full SHA

#### Scenario: Change head that HEAD does not contain
- **WHEN** `提交` names a commit on a branch that HEAD does not contain
- **THEN** `classify` exits with code 2
- **AND** the message names the commit and states that it is not an ancestor of HEAD

#### Scenario: Change head without a decider
- **WHEN** the section `## 变更终点` has an empty `判定人`
- **THEN** `archive` exits with code 2
- **AND** the message states that `判定人` is empty

#### Scenario: No change head keeps the old comparison
- **WHEN** `tasks.md` has no section `## 变更终点`
- **THEN** `classify --from <fingerprint>` without `--to` compares with the current fingerprint
- **AND** the output has no `changeHead`

### Requirement: The fingerprint command SHALL compute the fingerprint of a commit

`implementation-gate.mjs fingerprint <changeRoot> --rev <commit>` SHALL compute a fingerprint from the tree of the commit. It SHALL use the same algorithm as the current fingerprint: the planning directory SHALL be removed and the output SHALL be `git-tree:<sha>`. The uncommitted changes in the workspace SHALL NOT affect the output. A value that does not resolve to a commit SHALL exit with code `2`.

#### Scenario: Clean workspace gives the same fingerprint
- **WHEN** the workspace has no change compared with HEAD
- **THEN** `fingerprint --rev HEAD` gives the same output as `fingerprint`

#### Scenario: Commit fingerprint ignores later commits
- **WHEN** commit A is followed by commit B that changes only `src/b.mjs`
- **THEN** `classify --from <fingerprint --rev A> --to <fingerprint>` lists only `src/b.mjs` in `other`

#### Scenario: Unknown revision
- **WHEN** `--rev` names a value that does not resolve to a commit
- **THEN** `fingerprint` exits with code 2

### Requirement: The review baseline SHALL end at the change head

When `tasks.md` declares a valid change head, `baseline` SHALL:

- Write `Fingerprint` as the fingerprint of the change head.
- Write `Review Scope` as `<short SHA of the base commit>..<short SHA of the change head>` with the excluded planning directory.
- Add the line `Change Head: <full SHA>`. This line SHALL be an optional identity field, and the two axis reports and the summary report SHALL have the same value.
- Exit with code `2` when the base commit is the change head or is not an ancestor of the change head. A base commit equal to the change head gives an empty review scope.
- With `--since`, list in `Delta Files` the files that differ between the previous fingerprint and the fingerprint of the change head.

Both axes SHALL review `git diff <Base Commit> <Change Head>`, not the diff from the base commit to the workspace.

#### Scenario: Late review of a merged change
- **WHEN** commit C of the change modifies 2 files, a later commit D of another change modifies 3 other files, and `tasks.md` declares C as the change head
- **THEN** `baseline --base C^` writes `Review Scope` as `<C^>..<C>`
- **AND** `Fingerprint` is the output of `fingerprint --rev C`
- **AND** the block contains `Change Head: <full SHA of C>`

#### Scenario: Base commit after the change head
- **WHEN** `tasks.md` declares C as the change head and `--base` names commit D, which is a descendant of C
- **THEN** `baseline` exits with code 2

#### Scenario: Base commit equal to the change head
- **WHEN** `tasks.md` declares C as the change head, HEAD is C, and `baseline` runs without `--base`
- **THEN** `baseline` exits with code 2
- **AND** the message states that the review scope is empty and names `--base`

#### Scenario: Fix branched from the change head
- **WHEN** fix commit E has the parent C and modifies only `a.mjs`
- **AND** E is merged into HEAD after commit D of another change
- **AND** the user changes the change head from C to E
- **THEN** `baseline --since <fingerprint --rev C>` lists only `a.mjs` in `Delta Files`

### Requirement: Review and registration checks SHALL compare with the change head

When `tasks.md` declares a valid change head:

- `classify` without `--to` SHALL compare `--from` with the fingerprint of the change head. When `--to` is given, `classify` SHALL use the given value.
- `classify` SHALL output `changeHead` with the fields `commit`, `fingerprint`, `afterHead` and `uncommitted`. `afterHead` SHALL list the files that differ between the fingerprint of the change head and the current fingerprint. `uncommitted` SHALL list the files that differ between the fingerprint of HEAD and the current fingerprint. These two lists SHALL NOT change `unregistered` or the exit code.
- `review` SHALL compare the baseline `Fingerprint` with the fingerprint of the change head to decide the stale baseline warning.
- The registered fingerprint of a ledger row and the `Fingerprint` of `verification.md` SHALL be the output of `fingerprint --rev <change head>`.

#### Scenario: Commits of other changes after the change head are not unregistered
- **WHEN** the review baseline fingerprint is the fingerprint of the change head C
- **AND** a later commit D of another change modifies 3 files, and the change also modified one of the 3 files before C
- **THEN** `classify --from <fingerprint of C>` has empty `other` and `unregistered`, and exits with code 0
- **AND** `changeHead.afterHead` lists the 3 files

#### Scenario: Modification of the change before the change head is unregistered
- **WHEN** the review baseline has fingerprint R, and commit C modifies `a.mjs` after the review
- **AND** `tasks.md` declares C as the change head and no ledger row lists `a.mjs`
- **THEN** `classify --from R` lists `a.mjs` in `unregistered`
- **AND** the exit code is 1

#### Scenario: Fix committed after commits of other changes
- **WHEN** fix commit F follows commit D of another change on the same line, and the user changes the change head from C to F
- **THEN** `classify --from <fingerprint of C>` lists the files of D and of F in `other`

#### Scenario: Uncommitted modification is listed
- **WHEN** a valid change head is declared and the workspace has an uncommitted modification of `b.mjs`
- **THEN** `changeHead.uncommitted` and `changeHead.afterHead` list `b.mjs`
- **AND** `b.mjs` is not in `unregistered`

#### Scenario: Review baseline at the change head has no stale warning
- **WHEN** the baseline `Fingerprint` is the fingerprint of the change head and commits of other changes follow the change head
- **THEN** `review` writes no stale baseline warning

### Requirement: Slice evidence SHALL stay judged against the current implementation

A change head SHALL NOT change the freshness check of slice evidence. `evidence`, and the evidence part of `archive`, SHALL compare the evidence fingerprint with the current fingerprint. When commits after the change head change the current fingerprint, the evidence SHALL be stale until the slice verification runs again or an exemption chain holds.

#### Scenario: Commits after the change head make evidence stale
- **WHEN** the evidence of slice 01 has the fingerprint of the change head C, and commit D follows C
- **THEN** `evidence` reports slice 01 as `stale`
- **AND** after the slice verification runs again and the evidence has the current fingerprint, `evidence` reports slice 01 as `fresh`

### Requirement: Archive SHALL report the change head

When `tasks.md` declares a valid change head, `archive` SHALL write in `notes` the commit of the change head, the decider and the number of files in `afterHead`. When `uncommitted` is not empty, `archive` SHALL write a warning that lists those files. `archive` SHALL NOT block the archive for uncommitted files.

#### Scenario: Uncommitted file does not block the archive
- **WHEN** the review and the evidence pass, a valid change head is declared, and the workspace has an uncommitted file `c.mjs`
- **THEN** `archive` exits with code 0
- **AND** `notes` contain the commit of the change head and the decider
- **AND** `warnings` list `c.mjs`
