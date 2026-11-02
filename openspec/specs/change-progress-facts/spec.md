# change-progress-facts Specification

## Purpose
门禁脚本的 `facts` 子命令输出一个变更的事实 JSON，供进度视图读取。JSON 包含分级、评审裁决、签字、verify 报告指纹、待决定条数与归档阻断项。
## Requirements
### Requirement: The facts command SHALL report the facts of one change as JSON

`implementation-gate.mjs facts <changeRoot> [--repo <dir>]` SHALL write one JSON object with the fields `command` (`facts`), `change`, `tier`, `technicalReview`, `verification`, `openQuestions`, `currentFingerprint` and `archive`. `tier` SHALL use the same reading as the `archive` command: `L0`, `L1`, `L2`, `L3`, `MVP` or `null`. `archive` SHALL contain the same `ok`, `blockers`, `warnings`, `notes`, `review` and `evidence` that the `archive` command writes for the same change root. The command SHALL exit with code `0` when it writes the facts, also when `archive.ok` is `false`. It SHALL exit with code `2` on the same argument and environment errors as the other commands. It SHALL NOT write files in the change directory.

#### Scenario: Facts of a change with blockers
- **WHEN** a change has a slice whose evidence fingerprint differs from the current fingerprint
- **THEN** `facts` exits with code 0
- **AND** `archive.ok` is `false` and `archive.blockers` contains the same text as the output of the `archive` command

#### Scenario: Tier from the tier line
- **WHEN** `overview.md` starts with the line `> 分级：L2 标准 ｜ 判定人：tigger ｜ 日期：2026-10-30 ｜ 依据：新增业务流程`
- **THEN** `tier` is `L2`

#### Scenario: Change root that does not exist
- **WHEN** `facts` is run with a path that is not a directory
- **THEN** the command exits with code 2 and writes the reason

### Requirement: The facts command SHALL read the technical review verdict and the signature line with the rules of the approval hook

`technicalReview.exists` SHALL be `true` only when `review-summary.md` exists. `technicalReview.gateVerdict` SHALL be the first word of ASCII letters and underscores after the last `Gate-Verdict:` on the first line that matches `^[-*>\s]*Gate-Verdict:`. It SHALL be `null` when the file, the line or such a word does not exist. `technicalReview.approval` SHALL be:

- `missing` when the file does not exist or has no line with `Technical Review Approved:`;
- `blank` when the value after `Technical Review Approved:` and before `签署人`, without white space, is empty, has only underscores (`_` or the full-width `＿`), starts with `__` or `＿＿`, or contains `<签名>` or `＜签名＞`;
- `signed` in all other cases.

These rules SHALL give the same result as `skills/openspec-technical-review/hooks/check-review-approval.sh` for each verdict line and each signature line in the shared samples `scripts/lib/review-approval-samples.mjs`. In the C locale the hook treats only ASCII white space as white space, and it also removes U+3000 from the signature value. So verdict lines with non-ASCII white space before `Gate-Verdict:`, and signature values with non-ASCII white space other than U+3000, are outside this requirement (design.md risk R2).

#### Scenario: Blocked verdict
- **WHEN** `review-summary.md` contains the line `Gate-Verdict: BLOCKED`
- **THEN** `technicalReview.gateVerdict` is `BLOCKED`

#### Scenario: Verdict followed by a full-width note
- **WHEN** `review-summary.md` contains the line `Gate-Verdict: BLOCKED（未闭环）`
- **THEN** `technicalReview.gateVerdict` is `BLOCKED`

#### Scenario: Verdict value without an ASCII word
- **WHEN** `review-summary.md` contains the line `Gate-Verdict: 待定`
- **THEN** `technicalReview.gateVerdict` is `null`

#### Scenario: Signature line with a placeholder and a note
- **WHEN** the signature line is `Technical Review Approved: __________ （签字 / 日期）`
- **THEN** `technicalReview.approval` is `blank`

#### Scenario: Signed review
- **WHEN** the signature line is `Technical Review Approved: tigger 2026-10-30`
- **THEN** `technicalReview.approval` is `signed`

#### Scenario: Legacy summary without a verdict line
- **WHEN** `review-summary.md` exists and has no `Gate-Verdict` line
- **THEN** `technicalReview.exists` is `true` and `technicalReview.gateVerdict` is `null`

### Requirement: The facts command SHALL compare the fingerprint of the verify report with the fingerprint that verify writes

`verification.exists` SHALL be `true` only when `verification.md` exists. `verification.fingerprint` SHALL be the value of the first `Fingerprint` field line when the value is `git-tree:` followed by 40 or 64 lowercase hexadecimal characters. A list marker, bold markers and a full-width colon SHALL be allowed in the field line, and backticks and asterisks around the value SHALL be removed. It SHALL be `null` in all other cases, including a value with text after the fingerprint. `verification.expectedFingerprint` SHALL be the change head fingerprint (the output of `fingerprint <changeRoot> --rev <change head>`) when `tasks.md` has a `## 变更终点` section, and `currentFingerprint` in all other cases. `verification.current` SHALL be `true` when the fingerprint equals `verification.expectedFingerprint`, `false` when it differs, and `null` when there is no fingerprint. When the `## 变更终点` section is not valid, the command SHALL exit with code `2` and write the reason, as the other commands do. The command SHALL NOT read whether the report has CRITICAL issues.

#### Scenario: Verify report for the current implementation
- **WHEN** `verification.md` contains `- Fingerprint: <current fingerprint>`
- **THEN** `verification.current` is `true`

#### Scenario: Verify report before a later code change
- **WHEN** `verification.md` contains a fingerprint and a source file changes after the report
- **THEN** `verification.current` is `false`

#### Scenario: Verify report at the change head
- **WHEN** `tasks.md` has a valid `## 变更终点` section, a commit after the change head changes a source file, and `verification.md` contains the change head fingerprint
- **THEN** `verification.expectedFingerprint` is the change head fingerprint and differs from `currentFingerprint`
- **AND** `verification.current` is `true`

### Requirement: The facts command SHALL count the open questions of design.md without new markers

`openQuestions.total` SHALL be the number of items in the section `## Open Questions` of `design.md`, from that heading (case-insensitive) to the next level-1 or level-2 heading or the end of the file. Lines in fenced code blocks SHALL NOT start items. Each `### ` heading SHALL be one item, and list items below it SHALL be part of its text. Each top-level list item (`- `, `* ` or `<number>. ` at the start of the line) that is not below a `### ` heading in the section SHALL be one item. `openQuestions.pending` SHALL be the number of items whose text does not contain `结论`. Both numbers SHALL be `0` when `design.md` or the section does not exist, or when the section has no items.

#### Scenario: Questions with headings and option lists
- **WHEN** the section has the headings `### Q1` to `### Q4`, each with an option list and the word `建议`, and none contains `结论`
- **THEN** `openQuestions` is `{ "pending": 4, "total": 4 }`

#### Scenario: Questions with conclusions
- **WHEN** the section has three list items and each contains `**结论（2026-10-07）**`
- **THEN** `openQuestions` is `{ "pending": 0, "total": 3 }`

#### Scenario: No open questions
- **WHEN** the section contains only `无。`
- **THEN** `openQuestions` is `{ "pending": 0, "total": 0 }`
