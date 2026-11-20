# gate-trace-read Specification

## Purpose
定义门禁脚本 `trace` 命令的只读输出、输入校验，以及其输出与 `review` 读取结果的一致性。

## Requirements

### Requirement: The trace command SHALL print the records that the gate reads

`implementation-gate.mjs trace <changeRoot>` SHALL read the change directory with the reading functions of the gate and print one JSON object to standard output. It SHALL NOT read git and SHALL NOT compare runs; the only judgment it prints is the result of the gate's own open-Blocker rule for each Findings row. It SHALL exit with code 0, and with code 2 when the change directory does not exist. The object SHALL have these keys:

- `command`: `trace`; `change`: the name of the change directory; `traceVersion`: `1`, increased when a key or the meaning of a key changes.
- `findings`: one item for each row of a finding in `review/standards.md` and `review/spec-fidelity.md`, with `file`, `id`, `source`, `status` and, for `source` `findings`, `severity` and `openBlocker`. Rows with `source` `findings` SHALL be the rows that the command `review` reads as findings: the rows of all tables of the report after the sections `Finding 台账` and `上轮闭环验证` are removed, whose `ID` matches `^[A-Z]+-\d+$`. Rows with `source` `ledger` SHALL be the rows of the tables of the section `Finding 台账` whose `ID` matches the same pattern. `status` SHALL be the `闭环状态` (for `findings`) or the `状态` (for `ledger`) cell, cleaned as the gate cleans a cell and in lower case; `severity` SHALL be the cleaned `严重级别` cell, with its case unchanged; `openBlocker` SHALL be `true` when the command `review` counts the row as an open Blocker, and `false` otherwise. A missing cell SHALL be an empty string.
- `rulesVersion`: for each of the two reports, the value of `Rules Version` in its baseline section, or `null` when the report or the line does not exist.
- `sonar`: one item for each row of the tables of the sections `本次修改行上的问题` and `质量门` of `review/sonar.md`, with `table`, `key` (the `规则` cell, or the `条件` cell), `location` (the `位置` cell, or an empty string) and `handling` (the `处理` cell), each cleaned as the gate cleans a cell.
- `slices`: one item for each slice of `tasks.md` that the gate reads, with `id`, `environment` (the value of `Environment:`, or an empty string), `done` and `total` (the checked tasks and the tasks of the slice, as the gate counts them). For a slice with an `Environment:` value whose evidence file exists, the item SHALL also have `evidence` (the evidence file), `fingerprint` (the `Fingerprint` of the evidence, read as the gate reads the head of the evidence) and `deferred` (whether the `待环境补测` table has a row for that fingerprint with a non-empty `确认人`, and whether it has one with an empty `确认人`).
- `signOff.approval`: for each Markdown file of the change directory that has a signature line, the text of the last signature line, located as the gate locates the signature line of `review-summary.md`.
- `signOff.storyboard`: for each Markdown file of the change directory that has a storyboard line, the value of the first line outside fenced code blocks that matches `^\s*Storyboard Approved:`, with the fence rules of `video.mjs`: a fence opens with at least three backticks or tildes, and closes with a line of the same character that is not shorter and has no word after the fence, where a word is text without spaces and backticks (the regular expression `FENCE` of `video.mjs` and its closing condition). The gate SHALL read this line with a function of its own that uses the same regular expression and closing condition, and SHALL NOT use the fence rule of the open-question count.
- `signOff.changeHead`: the text of the block of `tasks.md` that the gate reads as the change head, or `null` when there is no block.
- `signOff.pendingEnvironment`: for each `evidence/*.md`, for each `登记指纹` of the rows of the tables of the section `待环境补测`, the list of the cleaned `确认人` cells of these rows.

Sections, tables, cells, the Findings rows, the ledger rows, the slices, the change head block, the last signature line and the pending environment rows SHALL be located and read by the same functions that the commands `review`, `evidence`, `facts` and `archive` use, and `openBlocker` by the same function that `review` uses, so that a change of the reading rules or of the closed statuses changes the output of `trace` in the same way. The Sonar rows and the storyboard line are the exceptions: no other command of the gate reads them, and the gate reads each of them with one function of its own. The command SHALL NOT change the output or the exit code of the other commands.

For this command, Markdown inputs SHALL be regular files whose ownership in the verified change directory can be established. The slice evidence reference SHALL resolve to the declared slice's `evidence/slice-<id>.md`. The reader SHALL NOT follow symbolic links at input boundaries or accept multiply linked inputs. It SHALL read the same verified open file and fail if the object or its directory identity cannot be confirmed. A confirmed missing optional file SHALL keep its default. Unverified input, invalid type or I/O error SHALL exit with code 2 and leave standard output empty. Standard error SHALL name only the input category and failure category, not file contents, an external path or an underlying error message. This rule SHALL NOT change the input contract of another command.

#### Scenario: Unverified trace input produces no snapshot
- **WHEN** ownership of a report, a sign-off input, or slice evidence cannot be established in the verified change directory
- **THEN** `trace` exits with code 2 without standard output and reports only the input and failure categories
- **AND** the same request with a verified local input prints the gate fields

#### Scenario: Status with code marks is printed cleaned
- **WHEN** the Findings row of `STD-02` in `review/standards.md` has the `闭环状态` `` `Risk-Accepted` ``
- **THEN** the `findings` item of `STD-02` with `source` `findings` has `status` `risk-accepted`

#### Scenario: Severity in upper case is printed unchanged and is not an open Blocker
- **WHEN** the Findings row of `STD-02` in `review/standards.md` has the `严重级别` `BLOCKER` and the `闭环状态` `open`
- **THEN** the `findings` item of `STD-02` with `source` `findings` has `severity` `BLOCKER` and `openBlocker` `false`
- **AND** the command `review` does not count `STD-02` as an open Blocker

#### Scenario: Open Blocker is marked
- **WHEN** the Findings row of `STD-02` in `review/standards.md` has the `严重级别` `Blocker` and the `闭环状态` `open`
- **THEN** the `findings` item of `STD-02` with `source` `findings` has `openBlocker` `true`

#### Scenario: Output has the trace version
- **WHEN** `implementation-gate.mjs trace` runs on a change directory
- **THEN** the output has `traceVersion` `1`

#### Scenario: Slice with an environment prints the deferred registration
- **WHEN** Slice 02 of `tasks.md` has `Environment: MQ`, `evidence/slice-02.md` has the `Fingerprint` `git-tree:abc`, and its `## 待环境补测` table has a row with the `登记指纹` `git-tree:abc` and an empty `确认人`
- **THEN** the `slices` item of `02` has `environment` `MQ`, `fingerprint` `git-tree:abc`, and a `deferred` value with an unconfirmed row and no confirmed row

#### Scenario: Slice prints its task counts
- **WHEN** Slice 02 of `tasks.md` has three tasks and two of them are checked
- **THEN** the `slices` item of `02` has `done` `2` and `total` `3`

#### Scenario: Row below a subheading is printed
- **WHEN** `## Findings` of `review/standards.md` has the heading `### 附录`, and the row of `STD-02` is below it
- **THEN** `findings` has an item of `STD-02` with `source` `findings`

#### Scenario: Row that the gate does not read is not printed
- **WHEN** the Findings table of `review/standards.md` has no separator row
- **THEN** `findings` has no item with `source` `findings` for the IDs of that table
- **AND** the command `review` does not count these IDs as findings

#### Scenario: Missing rules version is printed as null
- **WHEN** `review/standards.md` has no line `Rules Version`
- **THEN** `rulesVersion` of `review/standards.md` is `null`

#### Scenario: Storyboard line inside a tilde fence is not read
- **WHEN** `storyboard.md` has a line `Storyboard Approved: tigger` inside a fence opened by `~~~~` and closed by `~~~~`, and the line `Storyboard Approved: ____` after the fence
- **THEN** `signOff.storyboard` of `storyboard.md` is `____`

#### Scenario: Tilde fence closed before a backtick is closed as video.mjs closes it
- **WHEN** `storyboard.md` has a fence opened by `~~~` with the line `Storyboard Approved: ____` inside it, then a line of `~~~` followed by a backtick and `x`, and then the line `Storyboard Approved: tigger`
- **THEN** `signOff.storyboard` of `storyboard.md` is `tigger`

#### Scenario: Two rows of one fingerprint are both printed
- **WHEN** the `## 待环境补测` table of `evidence/slice-02.md` has two rows with the `登记指纹` `git-tree:abc`, one with the `确认人` `tigger` and one empty
- **THEN** `signOff.pendingEnvironment` of `evidence/slice-02.md` for `git-tree:abc` has the two values `tigger` and an empty string

#### Scenario: Missing change directory exits with code 2
- **WHEN** the change directory does not exist
- **THEN** `implementation-gate.mjs trace` exits with code 2 and prints the directory to standard error

### Requirement: The trace output SHALL agree with the review command

For each report in the shared samples of the gate tests, the IDs that the command `review` reports as open Blockers SHALL be the IDs whose `findings` items with `source` `findings` in the output of `trace` have `openBlocker` `true`. The test SHALL NOT list the closed statuses itself. The shared samples SHALL include a status with code marks, a status in upper case, a row below a level-3 heading, a row in another level-2 section, a row moved into the section `上轮闭环验证`, a table without the trailing pipes, a table without the separator row, a separator row without the leading pipe, a second `闭环状态` column, a renamed `严重级别` column, a heading `待环境补测` with two spaces after `##`, two rows of one `登记指纹`, a `严重级别` in upper case, a `严重级别` in lower case, and two rows of one ID with their `严重级别` values swapped. For the two samples of `待环境补测`, the `确认人` that the command `evidence` prints in `pendingEnvironment` of the slice SHALL be among the values of `signOff.pendingEnvironment` of `trace` for that `登记指纹`.

#### Scenario: Review and trace agree on every sample
- **WHEN** the gate test runs `review` and `trace` on each shared sample
- **THEN** for each sample the open Blocker IDs of `review` equal the open Blocker IDs computed from the output of `trace`
