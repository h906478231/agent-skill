# autopilot-decisions Specification

## Purpose
托管决策：提问 hook 的 `defer` 与回复填回、对托管文件的写入保护、权限宿主、决策卡片的生成、桥接脚本对点选的核对与记录，以及 quality 对未闭环 finding 的处理询问与留痕字段的写入（见 ADR-0011）。

## Requirements

### Requirement: The autopilot hook SHALL defer a question until its answer is recorded

`autopilot-hook.mjs` SHALL run as a `PreToolUse` hook with the matcher `AskUserQuestion`. It SHALL read the change root from `OPENSPEC_AUTOPILOT_CHANGE_ROOT` and look for decisions in `<change root>/decisions/`. When that directory does not exist, it SHALL look in `decisions/` of the directory in `<parent of change root>/archive/` whose name matches `^\d{4}-\d{2}-\d{2}-<base name of change root>$`. It SHALL find the decision whose `request.toolUseId` equals the `tool_use_id` of the hook input. It SHALL return `permissionDecision` `allow` with `updatedInput` (the original `tool_input` and an `answers` object) only when all of these are true:

- the decision has `status` `answered`;
- `answer.operatorId` equals `ownerOpenId` of the configuration;
- the fingerprint of the `tool_input` equals `request.fingerprint`.

When the `tool_use_id` equals `request.deferredToolUseId` of a session alert decision of the change with `status` `answered`, `answer.operatorId` equal to `ownerOpenId` and the choice `补充说明后继续`, it SHALL return `permissionDecision` `deny` with the reason `用户说明：<answer.text>。按说明处理后重新调用 AskUserQuestion。`. Otherwise it SHALL return `permissionDecision` `defer`. When `OPENSPEC_AUTOPILOT_CHANGE_ROOT` is not set, it SHALL return `permissionDecision` `deny` with a reason that names the variable.

#### Scenario: Question without an answer is deferred
- **WHEN** the hook input is an `AskUserQuestion` call and no decision has its tool use id
- **THEN** the hook writes `permissionDecision` `defer`

#### Scenario: Recorded answer is filled in
- **WHEN** an `answered` decision has the tool use id, the matching fingerprint, the owner as `answer.operatorId`, and the answer `新增任务（推荐）` for the question `STD-01 没有对应任务，怎么处理？`
- **THEN** the hook writes `permissionDecision` `allow`
- **AND** `updatedInput.answers` maps `STD-01 没有对应任务，怎么处理？` to `新增任务（推荐）` and `updatedInput.questions` equals the original questions

#### Scenario: Answer from another operator is not used
- **WHEN** an `answered` decision has the tool use id and an `answer.operatorId` that is not the owner
- **THEN** the hook writes `permissionDecision` `defer`

#### Scenario: Alert text is delivered by a denied question
- **WHEN** the session alert decision `D-0004` has `status` `answered`, the owner as `answer.operatorId`, the choice `补充说明后继续`, the text `把 STD-02 改回 open` and `request.deferredToolUseId` `T2`, and the hook input is `AskUserQuestion` with `tool_use_id` `T2`
- **THEN** the hook returns `permissionDecision` `deny` with a reason that contains `把 STD-02 改回 open`

#### Scenario: Changed question is deferred
- **WHEN** an `answered` decision has the tool use id but its `request.fingerprint` differs from the fingerprint of the hook input
- **THEN** the hook writes `permissionDecision` `defer`

#### Scenario: Answer in the archive directory is filled in
- **WHEN** `<change root>` does not exist, and `archive/2026-11-06-<name>/decisions/D-0005.json` beside it is an `answered` decision with the tool use id, the matching fingerprint and the owner as `answer.operatorId`
- **THEN** the hook writes `permissionDecision` `allow`

#### Scenario: Archive fallback matches the full change name
- **WHEN** the change root `<changes>/loop` does not exist, and `<changes>/archive/2026-10-01-add-autopilot-loop/decisions/D-0001.json` is an `answered` decision with the tool use id, the matching fingerprint and the owner as `answer.operatorId`
- **THEN** the hook writes `permissionDecision` `defer`

### Requirement: The autopilot hook SHALL deny agent writes to autopilot files

`autopilot-hook.mjs` SHALL also run with the matcher `Edit|Write|MultiEdit|NotebookEdit`. It SHALL resolve the target path (`file_path` or `notebook_path`) to an absolute path and resolve its parent directory with `realpath`. When the result is inside one of the two decision directories of Requirement «The autopilot hook SHALL defer a question until its answer is recorded», or inside the autopilot home, it SHALL return `permissionDecision` `deny` with a reason. For other paths it SHALL exit with code 0 and write no output. `templates/autopilot-settings.json` SHALL register both matchers with `onFailure` `block`, SHALL have the deny rules `Edit(**/decisions/autopilot.json)`, `Edit(**/decisions/D-*.json)` and `Edit(//<AUTOPILOT_HOME>/**)`, and SHALL set `syncClaudeAiSkills` and `syncClaudeAiPlugins` to `false`.

#### Scenario: Write to decisions is denied
- **WHEN** the hook input is a `Write` call to `<change root>/decisions/D-0001.json`
- **THEN** the hook writes `permissionDecision` `deny`

#### Scenario: Write to a source file passes
- **WHEN** the hook input is an `Edit` call to `<project root>/scripts/a.mjs`
- **THEN** the hook exits with code 0 and writes no output

#### Scenario: Path with parent segments is denied
- **WHEN** the hook input is a `Write` call to `<change root>/specs/../decisions/D-0001.json`
- **THEN** the hook writes `permissionDecision` `deny`

#### Scenario: Autopilot settings deny edits to autopilot files
- **WHEN** the scheduler writes `settings.json` in the autopilot home for a stage
- **THEN** its `permissions.deny` contains `Edit(**/decisions/D-*.json)` and an `Edit` rule with the absolute path of the autopilot home
- **AND** both hook matchers have `onFailure` `block`, and `syncClaudeAiSkills` and `syncClaudeAiPlugins` are `false`

### Requirement: The permission host SHALL deny every prompt with a reason

`perm-host.mjs` SHALL be an MCP server over standard input and output with one tool, `approve`. Every call SHALL return `behavior` `deny`. For `AskUserQuestion` the message SHALL tell the agent to call `AskUserQuestion` as the only tool call of its turn. For `Bash` the message SHALL start with `托管不允许这条命令：` and the first 120 characters of the command, state `Bash 没有被整体禁用`, list the allowed command prefixes from the environment variable `AUTOPILOT_ALLOWED_COMMANDS`, ask for one command per call without `cd`, pipes, `;` or `&&`, point to `Read`, `Grep` and `Glob` for files, and end with `不要因为这条拒绝询问用户。`. For other tools the message SHALL be `托管不允许：<tool_name> <path>。不要因为这条拒绝询问用户，换一种允许的方式继续。`, where `<path>` is the first 120 characters of `file_path`, `notebook_path` or `path`, or empty. Each call SHALL be appended to the log in the autopilot home with at most the first 200 characters of the command.

#### Scenario: Parallel question is denied with a retry hint
- **WHEN** `approve` is called with `tool_name` `AskUserQuestion`
- **THEN** the result has `behavior` `deny` and a message that asks for `AskUserQuestion` as the only tool call of the turn

#### Scenario: Command outside the allowed list is denied with the allowed prefixes
- **WHEN** `approve` is called with `tool_name` `Bash` and the command `git push origin main`, and `AUTOPILOT_ALLOWED_COMMANDS` is `node、git status`
- **THEN** the result has `behavior` `deny` and the message starts with `托管不允许这条命令：git push origin main`
- **AND** the message contains `Bash 没有被整体禁用`, `node、git status` and `不要因为这条拒绝询问用户。`

#### Scenario: Read outside the allowed directories is denied with the path
- **WHEN** `approve` is called with `tool_name` `Read` and `file_path` `/Users/u/.ssh/config`
- **THEN** the result has `behavior` `deny` and the message `托管不允许：Read /Users/u/.ssh/config。不要因为这条拒绝询问用户，换一种允许的方式继续。`

### Requirement: Decision cards SHALL show the questions without rewriting them

`lib/card.mjs` SHALL build a card with `schema` `2.0`. For every question decision, also for one question with `multiSelect` `false`, the card SHALL have one form with, for each question, a `select_static` (or `multi_select_static` when `multiSelect` is `true`) whose options are the option labels, an `input` named for the free text `其他（自填）`, and one submit button. Question text and option labels SHALL be copied without change. The header SHALL show the change name and the stage. A session alert card SHALL be one form with one `input` and one submit button for each label in `request.options` (`补充说明后继续` and `回会话处理`, or only `回会话处理` when the alert has no `request.sessionId`). Every button outside a form SHALL carry `d` (the decision id) and `change` in its callback value; a form submit SHALL be matched to its decision by `message_id`.

#### Scenario: Single question uses a form with free text
- **WHEN** a question decision has one question with the options `红` and `蓝`
- **THEN** the card has one form with one `select_static` with the options `红` and `蓝`, one `input` and one submit button
- **AND** the card has no button outside the form

#### Scenario: Multiple questions use a form
- **WHEN** a question decision has two questions and the second has `multiSelect` `true`
- **THEN** the card has one form with one `select_static`, one `multi_select_static`, two `input` elements and one submit button

#### Scenario: Session alert uses a form
- **WHEN** the scheduler creates a session alert decision
- **THEN** the card has one form with one `input` and two submit buttons named `补充说明后继续` and `回会话处理`
- **AND** the card has no button outside the form

### Requirement: The bridge SHALL record a click only after five checks

`bridge.mjs` SHALL start `<larkBin> event consume card.action.trigger --as bot`, keep its standard input open, and read one JSON event per line. For each event it SHALL check:

1. `operator_id` equals `ownerOpenId`;
2. `event_id` is not in `events.jsonl` in the autopilot home;
3. `message_id` equals `card.messageId` of exactly one decision with `status` `pending`, among the active and archived changes of the configured projects, and the autopilot record of that change has `status` `active` or `exiting`;
4. when the callback value has `d`, it equals the id of that decision;
5. the selection is valid: for a question decision, each question has an option label or a non-empty free text, and when the free text of a question is not empty it is the answer of that question, except when the selected option is `回会话处理`: then the answer is `回会话处理` and the free text is written to `answer.notes`; for a session alert decision, the choice is the `choice` in the callback value of the event, or the `action_name` of the event when the callback value has no `choice`, and is one of `request.options`, the text is the value of the `input` in `form_value`, and the text is not empty when the choice is `补充说明后继续`; for an exit decision or an exit alert, the choice is one of the options of the decision.

When all checks pass, the bridge SHALL write `answer` (`operatorId`, `eventId`, `answeredAt`, and for a question decision `answers`, `selected` (the selected option label of each question that has a selected option; a question without a selected option has no key) and `text` (the free text of each question); for another decision `choice` and `text`) and set `status` to `answered`, with the expected status `pending`. It SHALL append the `event_id` to `events.jsonl`, update the card with the event `token` to a recorded card that shows the selection, and start `scheduler.mjs --once` as a detached process. When a check fails, the bridge SHALL append the `event_id` to `events.jsonl` and write a log line without the `token` and without form values. When check 3 fails because the decision has `status` `void`, it SHALL update the card to an expired card. When check 3 fails because the decision has `status` `answered` or `used`, it SHALL update the card with the event `token` to the recorded card that shows the recorded selection, and SHALL NOT change the decision.

#### Scenario: Owner click is recorded
- **WHEN** the owner submits the form of the `pending` decision `D-0001` with `蓝` selected and an empty free text
- **THEN** `D-0001.json` has `status` `answered` and `answer.answers` maps the question to `蓝`
- **AND** the card is updated to the recorded card and `scheduler.mjs --once` is started

#### Scenario: Free text is the answer
- **WHEN** the owner submits the form of the `pending` decision `D-0001` with `蓝` selected and the free text `都不要`
- **THEN** `D-0001.json` has `status` `answered` and `answer.answers` maps the question to `都不要`
- **AND** `answer.selected` maps the question to `蓝` and `answer.text` maps it to `都不要`

#### Scenario: Return to session with free text keeps the option
- **WHEN** the owner submits the form of the `pending` question decision `D-0002` with `回会话处理` selected and the free text `我在会话里改`
- **THEN** `answer.answers` maps the question to `回会话处理` and `answer.notes` contains `我在会话里改`

#### Scenario: Session alert form records the choice and the text
- **WHEN** the owner submits the form of the `pending` session alert decision `D-0005` with the button `补充说明后继续` and the input text `只改 scripts 目录`
- **THEN** `D-0005.json` has `status` `answered`, `answer.choice` `补充说明后继续` and `answer.text` `只改 scripts 目录`

#### Scenario: Continue without text is rejected
- **WHEN** the owner submits the form of the `pending` session alert decision with the button `补充说明后继续` and an empty input
- **THEN** the decision stays `pending`

#### Scenario: Click by another user is ignored
- **WHEN** an event has an `operator_id` that is not the owner
- **THEN** the decision stays `pending` and the card is not updated

#### Scenario: Repeated event is ignored
- **WHEN** an event has an `event_id` that is already in `events.jsonl`
- **THEN** the decision is unchanged and the scheduler is not started

#### Scenario: Click on a void decision marks the card expired
- **WHEN** the owner clicks a card whose decision has `status` `void`
- **THEN** the decision is unchanged and the card is updated to the expired card

#### Scenario: Second click keeps the recorded card
- **WHEN** the owner submits the form with `蓝` selected twice and two events with different `event_id` arrive
- **THEN** after the second event the decision has `status` `answered` with the answer `蓝`
- **AND** the card is updated to the recorded card for both events and never to the expired card

#### Scenario: Unknown option is rejected
- **WHEN** an exit decision has the options `推送` and `暂不处理` and the event choice is `强制推送`
- **THEN** the decision stays `pending`

### Requirement: The bridge SHALL run as one instance and exit when the event stream stops

`bridge.mjs` SHALL write a log line and exit with code 2 when `larkBin` cannot run. It SHALL take `bridge.lock` in the autopilot home in the same way as the run lock of spec `autopilot-scheduler`. When another live bridge holds the lock, it SHALL write a log line, exit with code 1, and SHALL NOT start `lark-cli`. When the `lark-cli` process exits, `bridge.mjs` SHALL release the lock and exit with code 1 so that launchd starts it again. It SHALL write the stderr lines of `lark-cli`, including the ready marker `[event] ready`, to its log.

#### Scenario: Bridge exits with the event consumer
- **WHEN** the `lark-cli` test double writes the ready marker and one event, then exits
- **THEN** `bridge.mjs` handles the event and exits with code 1

#### Scenario: Second bridge exits
- **WHEN** `bridge.lock` holds the process id of a live bridge and the current boot time
- **THEN** a second `bridge.mjs` exits with code 1 and does not start the `lark-cli` test double

### Requirement: Quality SHALL ask how to handle each open finding and record the answer

Skill `openspec-code-quality` SHALL do this in sessions and under autopilot. Before `/opsx:quality` ends, it SHALL call `AskUserQuestion` for these items:

- each Blocker and Major with `状态` `open` in the `## Finding 台账` of either axis, also when the verdict is `PASSED`;
- each row of `review/sonar.md` whose `处理` is not `误报` or `接受`.

It SHALL NOT ask about a Minor finding. It SHALL skip an item when an unchecked task in `tasks.md` names its finding ID (for a Sonar row, its rule and location). When the fix of an item changes only one line of a planning artifact and that line already has the fix, it SHALL set the ledger row to `closed` with that `file:line` and SHALL NOT ask. It SHALL also ask when `classify` reports only comment changes and no new round runs. It SHALL order the items Blocker, Major, Sonar, put at most 4 items in one call, and write the records of one batch before it asks the next batch. Each question SHALL be at most 300 characters and SHALL contain the finding ID, the `file:line`, the problem, a drafted reason and review threshold for `risk accepted`, and a drafted reason for `误报`. The options SHALL be `修复`, `risk accepted` and `误报` for a finding, and `修复`, `误报` and `接受` for a Sonar row. When the fix changes more than one line of the planning artifacts or a Requirement of the specs, `回会话处理` SHALL replace `修复`.

For each answer it SHALL write:

- `修复` with a code fix: an unchecked task in `tasks.md` that names the finding ID and the location; the ledger row stays `open`.
- `修复` with a one-line planning fix: that line changed to the text of the question, then the STE check and the change model check; the ledger row set to `closed` with that `file:line`.
- `risk accepted` or `误报` for a finding: the record of `gate-policy.md` section 4 in the report of the axis, with the user name as `接受人` or `驳回人` and the line `> 来源：AskUserQuestion，交互会话` or `> 来源：AskUserQuestion，托管决策 D-<number>`; the ledger row set to `risk-accepted` or `false-positive`.
- `误报` or `接受` for a Sonar row: the choice in `处理`, the reason in `说明`, and `<user name>（AskUserQuestion，交互会话）` or `<user name>（AskUserQuestion，托管决策 D-<number>）` in `决策人`. The user does not mark the issue in SonarQube, and the agent SHALL NOT call a write API of SonarQube.
- free text: the handling that the text names; when the text names none, nothing, and the item is asked again in the next batch.
- `回会话处理`: nothing for the item; in a session, quality stops after it writes the other answers of the batch and tells the user to run `/opsx:update`.

The user name SHALL be `git config user.name` of the project; under autopilot it SHALL be the user name of the stage prompt. Under autopilot the decision number SHALL be the id of the decision with `status` `answered` whose `request.questions` contain the finding ID. After it writes the records, quality SHALL update the open Blocker counts, the open Major counts and the verdict of `review/code-review-summary.md` and run `implementation-gate.mjs review`. The agent SHALL NOT write a sign-off field (`CONTEXT.md`) from an answer.

#### Scenario: Open Major after a passed verdict is asked
- **WHEN** the verdict is `PASSED`, the Standards ledger has `STD-03` with `Major` and `open`, and no unchecked task names `STD-03`
- **THEN** quality calls `AskUserQuestion` with a question that contains `STD-03` and its `file:line`
- **AND** the options of that question are `修复`, `risk accepted` and `误报`

#### Scenario: Item with an open task is not asked
- **WHEN** the ledger has `STD-03` with `Major` and `open`, and an unchecked task in `tasks.md` names `STD-03`
- **THEN** no question of quality contains `STD-03`

#### Scenario: Five items are asked in two batches
- **WHEN** the ledgers have two open Blockers and two open Majors, and `review/sonar.md` has one row without handling
- **THEN** the first `AskUserQuestion` call has four questions about the two Blockers and the two Majors
- **AND** the records of the first answers are written before the second call, which has one question about the Sonar row

#### Scenario: Comment-only change still asks
- **WHEN** `classify` reports `other` empty and the Spec Fidelity ledger has `SPEC-02` with `Major` and `open`
- **THEN** quality prints `无需新一轮` and writes no new baseline
- **AND** quality asks about `SPEC-02`

#### Scenario: Risk accepted under autopilot writes the trace fields
- **WHEN** under autopilot the answer for `STD-03` is `risk accepted`, the decision `D-0003` has `status` `answered` with that question, and the stage prompt gives the user name `tigger`
- **THEN** `review/standards.md` has a risk accepted record for `STD-03` with `接受人：tigger` and the line `> 来源：AskUserQuestion，托管决策 D-0003`
- **AND** the ledger row of `STD-03` has `状态` `risk-accepted`

#### Scenario: Code fix answer adds a task
- **WHEN** the answer for `SPEC-02` is `修复` and the fix changes code
- **THEN** `tasks.md` has a new unchecked task that names `SPEC-02`
- **AND** the ledger row of `SPEC-02` stays `open`

#### Scenario: One-line planning fix is written by quality
- **WHEN** the question for `SPEC-11` shows `tasks.md:82` with the new text `删除`, and the answer is `修复`
- **THEN** `tasks.md:82` contains `删除`, and the STE check and the change model check run
- **AND** the ledger row of `SPEC-11` has `状态` `closed` with `tasks.md:82`

#### Scenario: Fix in several planning artifacts offers return to session
- **WHEN** the fix of `SPEC-04` changes `design.md` and a Requirement of the specs
- **THEN** the options for `SPEC-04` are `回会话处理`, `risk accepted` and `误报`

#### Scenario: Sonar false positive in a session
- **WHEN** in a session the answer for a Sonar row is `误报`, and `git config user.name` of the project is `tigger`
- **THEN** the row has `处理` `误报`, a reason in `说明`, and `决策人` `tigger（AskUserQuestion，交互会话）`
- **AND** quality calls no write API of SonarQube
