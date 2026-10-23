# post-implementation-change-tiering Specification

## Purpose
实现后修改分档：不在未勾选任务内进行的代码修改按修改档位（`非行为`、`等价`、`行为`）写入 tasks.md 的实现后修改登记表，每档对应固定的最少动作；门禁脚本 `classify` 判定只有注释差异的文件与登记状态，Spec Fidelity 只在非行为或等价修改后沿用，verify 在已登记的低风险修改后只复跑脚本检查。
## Requirements
### Requirement: Post-implementation changes SHALL be registered with a change class

A post-implementation change is a code change that is not made inside an unchecked task of `/opsx:apply`. Examples are a change after all tasks of its slice are checked, a change after a review round, and a commit made outside the workflow. The agent SHALL register each post-implementation change in the `## 实现后修改登记` table of `tasks.md` before the next review round or the next verify run. The table SHALL have the columns `编号 | 文件 | 提交 | 登记指纹 | 档位 | 判定依据 | 验证 | 判定人 | 日期`. The `文件` cell SHALL list every changed file. The `登记指纹` cell SHALL contain the output of `implementation-gate.mjs fingerprint` after the change and its verification. When a registered file changes again, the agent SHALL write a new row with the new fingerprint. The `档位` cell SHALL be one of the following values:

| Value | Definition |
|---|---|
| `非行为` | `implementation-gate.mjs classify` reports every changed file as comment-only. |
| `等价` | The change keeps inputs, outputs, data writes, external calls and exception paths unchanged. Examples are a new log statement, an extracted method and a static-analysis suppression annotation. |
| `行为` | Any other change. |

When the agent is not certain about the class, it SHALL use the higher class. The agent SHALL ask the user to confirm a `等价` class before it writes the row. The table SHALL be outside every slice and SHALL NOT contain checkboxes.

#### Scenario: Comment fix after the slice is checked is registered as non-behavioral
- **WHEN** the developer corrects two Javadoc comments after all tasks of the slice are checked
- **AND** `classify` reports both files as comment-only
- **THEN** the agent writes one row with the class `非行为`
- **AND** the task progress of `tasks.md` does not change

#### Scenario: Uncertain class is raised
- **WHEN** the agent cannot decide whether a refactor keeps the exception paths unchanged
- **THEN** the agent registers the change with the class `行为`

#### Scenario: Equivalent class needs user confirmation
- **WHEN** the agent proposes the class `等价` for three new INFO log statements
- **THEN** the agent asks the user to confirm the class before it writes the row

### Requirement: Each change class SHALL require a fixed minimum set of actions

The workflow SHALL require the following actions for each class. It SHALL NOT require more actions for `非行为` and `等价` changes.

| Class | Verification | Slice evidence | Dual-axis review | Overview |
|---|---|---|---|---|
| `非行为` | Compile or the equivalent static check | Stays current through the comment-only rule | No new round | Not refreshed |
| `等价` | Full test suite of each affected module, and compile | Refreshed for the slices that the suite covers; other slices follow the existing exemption rule | Standards Review only; Spec Fidelity is carried over | Not refreshed |
| `行为` | Existing apply rules: a task, slice evidence and the full test suite | Refreshed | Both axes on a delta baseline | Not refreshed by this rule |

A `行为` change that changes `design.md` SHALL go through `/opsx:update` before the code change.

#### Scenario: Non-behavioral change does not start a review round
- **WHEN** the only change since the last review baseline is registered with the class `非行为`
- **THEN** `/opsx:quality` does not start a new round
- **AND** `/opsx:verify` does not report the review baseline as out of date

#### Scenario: Equivalent change runs only Standards Review
- **WHEN** a change registered with the class `等价` extracts one method
- **THEN** the agent runs the full test suite of the affected module
- **AND** `/opsx:quality` runs a delta round with Standards Review only

#### Scenario: Behavioral change keeps the full chain
- **WHEN** a change registered with the class `行为` deletes one method call
- **THEN** the agent adds a task, refreshes the slice evidence and runs both review axes on a delta baseline

### Requirement: The gate script SHALL detect comment-only differences

`implementation-gate.mjs classify <changeRoot> --from <fingerprint> [--to <fingerprint>]` SHALL compare two implementation fingerprints. `--to` SHALL default to the current fingerprint. The command SHALL output a JSON object with the lists `commentOnly`, `other`, `registered`, `unregistered` and `issues`:

- A file SHALL be in `commentOnly` only when it exists in both trees, its type is supported, and the two versions are equal after the script removes comments and blank lines and normalizes the whitespace that the language ignores.
- The supported types SHALL be Java, Kotlin, SQL, XML and properties files. Added, deleted, renamed, binary and unsupported files SHALL be in `other`.
- The script SHALL treat as code the text inside string literals, Java and Kotlin text blocks, XML CDATA sections, MySQL hints `/*+ */` and MySQL executable comments `/*! */`.
- A valid ledger row SHALL be a row with a valid class and a valid registered fingerprint. The script SHALL NOT use a row with an invalid class or an empty or invalid registered fingerprint, and SHALL write the row ID and the reason in `issues`.
- A file in `other` SHALL be in `registered` when at least one valid row with a class other than `非行为` lists it and the file has only comment-only differences or no differences between the registered fingerprint of that row and `--to`. Its class SHALL be the highest class of all valid rows that list it. A row with the class `非行为` SHALL NOT make a file in `other` registered.
- `unregistered` SHALL list every other file in `other`. When a valid row lists a file in `unregistered`, and the file changed again after that row, the registered fingerprint of that row has no tree object, or the row has the class `非行为`, the script SHALL write the file, the row ID and the reason in `issues`.

The exit code SHALL be `0` when `unregistered` is empty, `1` when it is not empty, and `2` for argument errors, environment errors or a tree object that no longer exists.

#### Scenario: Java comment change is comment-only
- **WHEN** only a `//` comment and one Javadoc line change in a Java file
- **THEN** `classify` lists the file in `commentOnly`
- **AND** the exit code is 0

#### Scenario: Comment marker inside a string is code
- **WHEN** the string literal `"http://a"` changes to `"http://b"` in a Java file
- **THEN** `classify` lists the file in `other`

#### Scenario: MySQL hint is code
- **WHEN** `/*+ INDEX(t idx_a) */` changes to `/*+ INDEX(t idx_b) */` in a SQL file
- **THEN** `classify` lists the file in `other`

#### Scenario: Unsupported file type is code
- **WHEN** only a comment changes in a `.mjs` file
- **THEN** `classify` lists the file in `other`

#### Scenario: Unregistered behavioral file fails the command
- **WHEN** a Java statement changes and no ledger row lists the file
- **THEN** `classify` lists the file in `unregistered`
- **AND** the exit code is 1

#### Scenario: File changed again after registration is unregistered
- **WHEN** row M2 registers `Job.java` with the class `等价` at fingerprint B
- **AND** a later change deletes one method call in `Job.java`, produces fingerprint C, and adds no ledger row
- **THEN** `classify --to C` lists `Job.java` in `unregistered`
- **AND** `issues` names M2 and the reason
- **AND** the exit code is 1

#### Scenario: Non-behavioral row does not register a changed file
- **WHEN** row M1 registers `Job.java` with the class `等价` at fingerprint B
- **AND** a later change deletes one method call in `Job.java` and adds no ledger row
- **AND** row M2 then registers a comment fix in `Job.java` with the class `非行为` at fingerprint D
- **THEN** `classify --to D` lists `Job.java` in `unregistered`
- **AND** `issues` names M1 and M2 with their reasons

### Requirement: Spec Fidelity SHALL be carried over only after non-behavioral or equivalent changes

A delta round MAY run Standards Review only. In that round, `review/code-review-summary.md` SHALL contain the line `Carried Axis: spec-fidelity`, and `review/spec-fidelity.md` SHALL keep its previous baseline block. `implementation-gate.mjs review` SHALL accept the carried report only when every file that changed between the carried baseline fingerprint and the current baseline fingerprint is comment-only, or is in the `registered` list of `classify` with the class `等价`. `review` SHALL NOT accept the carried report when the ledger has a row with an invalid class or an invalid registered fingerprint, also when that row lists none of the changed files. Open Blockers of the carried report SHALL still count in the verdict. The baseline identity check SHALL apply to the Standards report and the summary.

#### Scenario: Standards-only round with a registered delta passes
- **WHEN** the Spec Fidelity baseline is fingerprint A and the new baseline is fingerprint B
- **AND** the only file changed between A and B is listed in a ledger row with the class `等价`
- **THEN** `review` accepts the carried Spec Fidelity report
- **AND** `review` computes the verdict from both reports

#### Scenario: Unregistered file breaks the carry-over
- **WHEN** one file changed between A and B is not comment-only and `classify` does not report it as registered with the class `等价`
- **THEN** `review` reports a structure issue that names the file and the reason

#### Scenario: Invalid ledger row breaks the carry-over
- **WHEN** the only file changed between A and B is registered in row M1 with the class `等价`
- **AND** row M2 lists another file and has the class `等效`
- **THEN** `review` reports a structure issue that names M2 and the reason

#### Scenario: Carried open Blocker still blocks
- **WHEN** the carried Spec Fidelity report has an open Blocker
- **THEN** the review verdict is `BLOCKED`

### Requirement: Verify SHALL re-check only script results after registered low-risk changes

`verification.md` SHALL record the verified implementation fingerprint in the field `Fingerprint`. When verify runs again, the previous `verification.md` has no CRITICAL issue, and `classify --from <that fingerprint>` reports an empty `unregistered` list and no `registered` file with the class `行为`, verify SHALL rerun only the gate script checks (`evidence`, `review`, `hygiene`), the STE check and the change-model check. In that case verify SHALL carry over the completeness, correctness and coherence conclusions, the `评审条件` section and the manual check of step 9, and SHALL record the new fingerprint. In every other case verify SHALL run all checks.

#### Scenario: Static-analysis refactor after a passed verify
- **WHEN** verify passed at fingerprint A
- **AND** a refactor registered with the class `等价` produces fingerprint B
- **THEN** verify reruns only the script checks
- **AND** `verification.md` records fingerprint B and the carried conclusions

#### Scenario: Behavioral change after verify runs all checks
- **WHEN** a ledger row with the class `行为` lists a file that changed after fingerprint A
- **THEN** verify runs all checks
