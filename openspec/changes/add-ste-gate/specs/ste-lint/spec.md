## ADDED Requirements

### Requirement: The STE check SHALL only scan the artifacts of the current change

The STE check SHALL scan `proposal.md`, `design.md`, `tasks.md` and `specs/**/*.md` under the given change root. It SHALL NOT scan `openspec/specs/`, `openspec/changes/archive/`, `review/`, `evidence/` or derived files such as `overview.md`.

#### Scenario: Archived change is not scanned
- **WHEN** an archived change contains a forbidden alias
- **THEN** the check of the current change does not report it

### Requirement: Findings SHALL be graded as blocking or warning

The check SHALL report forbidden aliases, non-approved general words and vague words in artifacts as blocking findings. It SHALL report noun clusters, passive voice, sentence length, procedure steps and safety notes as warnings. The process SHALL exit with code 1 when at least one blocking finding exists, code 0 when only warnings or no findings exist, and code 2 on argument or environment errors.

#### Scenario: Forbidden alias blocks
- **WHEN** CONTEXT.md lists `退单` under `_Avoid_` of `取消` and `design.md` line 12 contains `退单`
- **THEN** the check exits with code 1 and reports file `design.md`, line 12, rule ID, the word `退单` and the replacement `取消`

#### Scenario: Long sentence only warns
- **WHEN** a descriptive sentence in `proposal.md` has 55 characters and no blocking finding exists
- **THEN** the check exits with code 0 and reports one sentence-length warning

#### Scenario: Missing change root
- **WHEN** the given change root does not exist
- **THEN** the check exits with code 2

### Requirement: Findings SHALL be machine-readable

The check SHALL print one JSON object with the verdict, the list of blocking findings, the list of warnings and the count of exemptions used. Each finding SHALL contain the file path relative to the change root, the line number, the rule ID, the matched text and, when one exists, the replacement. Environment warnings (rule ID `ENV`, such as a missing glossary) do not belong to a file line, so their file path and line number SHALL be `null`.

#### Scenario: JSON output
- **WHEN** the check finishes without an environment error
- **THEN** stdout contains exactly one JSON object with the fields `verdict`, `blocking`, `warnings` and `exemptions`

### Requirement: The STE check SHALL check plain text from stdin

The check script SHALL provide a `text` subcommand that reads text from stdin and applies the artifact-level rules and grading. It SHALL print the same JSON object and use the same exit codes as the change check. Line numbers in findings SHALL refer to lines of the input text, and the `file` field SHALL be `<stdin>`. When the project has no CONTEXT.md, it SHALL degrade in the same way as the change check. Other skills SHALL use this subcommand to check text that is not an artifact file, such as change-model fields and storyboard narration.

#### Scenario: Forbidden alias in stdin text
- **WHEN** the input text has `用户退单` on line 3 and `退单` is a forbidden alias of `取消`
- **THEN** the subcommand exits with code 1 and reports file `<stdin>`, line 3, the word `退单` and the replacement `取消`

#### Scenario: Clean stdin text
- **WHEN** the input text contains no blocking finding
- **THEN** the subcommand exits with code 0 and prints a JSON object with an empty `blocking` list

### Requirement: Code, paths and explicit exemptions SHALL be excluded

The check SHALL skip fenced code blocks, inline code, URLs, file paths and identifiers. A file path is a token that either contains `/` with an ASCII path segment before the first `/` and at least one ASCII letter, or ends with a file extension. Slash-separated Chinese words, such as `取消/退单`, are not file paths. An identifier is an ASCII token with camel case, an underscore or a dot call. A line that contains `<!-- term-allow: <word> -->` SHALL NOT report `<word>` on that line. Exemptions SHALL be counted in the output.

#### Scenario: Old name in inline code
- **WHEN** a migration note writes "原 `退单` 接口改名为取消"
- **THEN** the check does not report `退单`

#### Scenario: Explicit exemption
- **WHEN** a line contains `退单` and `<!-- term-allow: 退单 -->`
- **THEN** the check does not report `退单` on that line and increments the exemption count

### Requirement: A match inside a longer glossary term SHALL NOT be reported

When a forbidden alias or non-approved word appears only as part of a longer term defined in CONTEXT.md, the check SHALL NOT report it.

#### Scenario: Alias is part of a defined term
- **WHEN** `单子` is a forbidden alias and CONTEXT.md defines the term `单子编号规则`
- **THEN** the text `单子编号规则` does not produce a finding for `单子`

### Requirement: The check SHALL degrade explicitly when the glossary is missing

When the project root has no CONTEXT.md, the check SHALL skip the forbidden-alias rule, SHALL still apply the other rules, and SHALL add the warning `未建立术语表，一词一义无法校验`. When `CONTEXT-MAP.md` exists, the check SHALL read only the root CONTEXT.md and SHALL add a warning that multiple glossaries are not supported.

#### Scenario: No CONTEXT.md
- **WHEN** the project has no CONTEXT.md and the artifacts contain the vague word `适当`
- **THEN** the check reports `适当` as blocking and adds the missing-glossary warning

### Requirement: OpenSpec workflow SHALL run the STE check at four points

The `openspec-propose` and `openspec-update-change` skills SHALL run the check after writing artifacts and SHALL fix blocking findings before they report completion. The `openspec-apply-change` skill SHALL run the check before implementation starts and SHALL stop when blocking findings exist. The `openspec-verify-change` skill SHALL report each blocking finding as CRITICAL. When the `openspec-ste` skill is not installed, these skills SHALL state in their output that the STE check was skipped.

#### Scenario: Propose fixes blocking findings
- **WHEN** `/opsx:propose` writes `design.md` that contains a forbidden alias
- **THEN** the skill replaces the alias, runs the check again and reports completion only after the check exits with code 0

#### Scenario: Apply stops on blocking findings
- **WHEN** `/opsx:apply` starts and the check exits with code 1
- **THEN** the skill lists the findings and does not start any task

#### Scenario: STE skill not installed
- **WHEN** `/opsx:verify` cannot find `openspec-ste`
- **THEN** the verification report contains the line that the STE check was skipped and why
