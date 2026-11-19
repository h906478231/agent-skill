# autopilot-scheduler Specification

## Purpose
托管调度：调度脚本每轮的运行锁、启动前核对设置来源中的允许规则、按进度规则选择动作、headless 运行参数与运行环境检查、运行后重新定位变更、运行结果处理、没有进展时的告警、会话无法恢复时的重跑，以及安装脚本。

## Requirements

### Requirement: The scheduler SHALL run at most one headless process per round

`scheduler.mjs --once` SHALL take the run lock `run.lock` in the autopilot home (`~/.openspec-autopilot/`, or the directory in `OPENSPEC_AUTOPILOT_HOME`) by writing the full JSON to a temporary file and linking it to `run.lock` with `link`, which fails when `run.lock` exists. The lock SHALL hold JSON with `pid`, `bootTime`, `change` and `claudePid`. When the file exists and the lock is not stale, the scheduler SHALL exit with code 0 and SHALL NOT start any process. A lock SHALL be stale when its `bootTime` differs from the current boot time by more than 60 seconds, or when neither `pid` nor `claudePid` is alive. A lock that is not valid JSON SHALL be alive when its modification time is at most 60 seconds old, and stale otherwise. The scheduler SHALL replace a stale lock only after it creates `run.lock.takeover` in the same way, and SHALL read the lock again before it removes it.

After it chooses a change, the scheduler SHALL write the change name to `change` of the lock with a temporary file and rename, then read the autopilot record again. It SHALL start or resume `claude`, or run an exit step, only when `status` and `startedAt` of the record equal the values read before; otherwise it SHALL write a log line and release the lock. When a `transition` after this check and before the start of `claude` returns `false`, the scheduler SHALL end the round without starting `claude`. When the scheduler starts `claude`, it SHALL start it as the leader of a new process group and write its process id to `claudePid`. On `SIGTERM` or an uncaught error, it SHALL send `SIGTERM` to that process group before it exits. It SHALL remove the lock before it exits only when the `pid` of the lock is its own process id. In one round the scheduler SHALL start at most one `claude` process across all configured projects, SHALL handle its result, and SHALL handle changes in the order of `startedAt`.

#### Scenario: Second round waits for the lock
- **WHEN** `run.lock` holds the process id of a live process and the current boot time
- **THEN** `scheduler.mjs --once` exits with code 0 and does not start the `claude` test double

#### Scenario: Stale lock is replaced
- **WHEN** `run.lock` holds the process id of a process that is not alive, `claudePid` `null` and the current boot time, and one change is under autopilot at rule `R6`
- **THEN** the scheduler starts one `claude` process and removes `run.lock` before it exits

#### Scenario: Lock from an earlier boot is replaced
- **WHEN** `run.lock` holds the process id of a live process and a `bootTime` 3600 seconds earlier than the current boot time, and one change is under autopilot at rule `R6`
- **THEN** the scheduler starts one `claude` process

#### Scenario: Lock with a live claude process is kept
- **WHEN** `run.lock` holds the process id of a process that is not alive and the `claudePid` of a live process
- **THEN** `scheduler.mjs --once` exits with code 0 and does not start the `claude` test double

#### Scenario: Two rounds started together run one stage
- **WHEN** two `scheduler.mjs --once` processes start at the same time, one change is under autopilot at rule `R6`, and the `claude` test double sleeps 1 second
- **THEN** the `claude` test double is called once

#### Scenario: Unreadable new lock is kept
- **WHEN** `run.lock` is empty, its modification time is the current time, and one change is under autopilot at rule `R6`
- **THEN** `scheduler.mjs --once` exits with code 0 and does not start the `claude` test double

#### Scenario: Unreadable old lock is replaced
- **WHEN** `run.lock` is empty, its modification time is 120 seconds ago, and one change is under autopilot at rule `R6`
- **THEN** the scheduler starts one `claude` process

#### Scenario: Cancel before the start of claude stops the round
- **WHEN** one change is under autopilot at rule `R6`, the `progressBin` test double sleeps 1 second, and `autopilot.mjs cancel` runs during that sleep
- **THEN** the `claude` test double is not called
- **AND** the autopilot record has `status` `void`

#### Scenario: One stage per round
- **WHEN** change A of project P1 (`startedAt` 10:00) and change B of project P2 (`startedAt` 11:00) are under autopilot at rule `R6`
- **THEN** one round starts `claude` only for change A
- **AND** when change A has a `pending` decision with a `card.messageId`, the next round starts `claude` for change B

### Requirement: The scheduler SHALL choose the action from the progress rule

For each project in the configuration, the scheduler SHALL read `progress.mjs --json` (configuration key `progressBin`). It SHALL handle only changes whose `decisions/autopilot.json` has `status` `active` or `exiting`. Before it reads the rule of a change, it SHALL check the decisions of the change in this order:

1. A decision with `status` `pending` and no `card.messageId`: send its card again.
2. A decision with `status` `pending` and a `card.messageId`: skip the change in this round.
3. A question decision with `status` `answered`, or a session alert decision with `request.sessionId`, `status` `answered` and the choice `补充说明后继续`: resume its session (Requirement «The scheduler SHALL void a decision that cannot be used»).
4. A session alert decision with `status` `answered` and the choice `回会话处理`: set the alert to `used`, set the autopilot record to `void`, send a notice card, and do not start `claude` (Requirement «The scheduler SHALL stop a change that makes no progress»).
5. An alert decision with `request.exitAction` and `status` `answered`: handle the choice (spec `autopilot-exit-actions`).
6. An exit decision with `status` `answered`: run its exit action (spec `autopilot-exit-actions`).

When the progress entry of the change has no key `reviewStale`, or `reviewStale` is `null`, the scheduler SHALL set the autopilot record to `void`, send a notice card that asks the user to sync the installed copies of `openspec-change-progress` and `openspec-technical-review` together, and SHALL NOT run a stage. Otherwise it SHALL choose the action by the rule of the progress entry:

| Rule | Action |
|---|---|
| `R1`–`R5`, `R10` | set the autopilot record to `void` with the rule and the blockers in `voidReason`, and send a notice card that asks the user to handle the blockers in a session |
| `R6`, `R7` | run skill `openspec-apply-change` |
| `R8` (spec `change-progress-view`: the verdict is not `PASSED`, or `archive.review.stale` is `true`) | run skill `openspec-code-quality` |
| `R9` | run skill `openspec-verify-change` |
| `R11` | write `implSnapshot` to the autopilot record (spec `autopilot-exit-actions`), then run skill `openspec-archive-change` |
| the change is in the `archived` list | run the next exit action (spec `autopilot-exit-actions`) |

When the autopilot record has `rerunStage` `quality` and the rule is `R9` or `R11`, the scheduler SHALL run skill `openspec-code-quality` instead, and SHALL NOT write `implSnapshot`. Before it starts any stage or voids the autopilot, it SHALL remove `rerunStage` from the record with the expected status `active` and the `startedAt` read before the round, whatever the rule is.

The prompt of a new stage SHALL name the skill, the change and the absolute path of the installed skill directory, SHALL tell the agent to use rule files and scripts from that directory and not files of the same name in the project, SHALL state that the run is under autopilot, SHALL give the user name from `git -C <project root> config user.name`, SHALL state that the user name is only for the trace fields (`CONTEXT.md`) and SHALL NOT be written to a sign-off field, and SHALL tell the agent to call `AskUserQuestion` as the only tool call of its turn when it needs a user decision. A notice card SHALL NOT create a decision file.

#### Scenario: Change without autopilot record is not run
- **WHEN** a change is at rule `R6` and has no `decisions/autopilot.json`
- **THEN** the scheduler does not start `claude` for the change

#### Scenario: R6 runs the apply stage
- **WHEN** a change under autopilot is at rule `R6` and has no open decision
- **THEN** the scheduler starts `claude` with a prompt that contains `openspec-apply-change` and the change name

#### Scenario: R8 runs the quality stage
- **WHEN** a change under autopilot is at rule `R8`
- **THEN** the prompt contains `openspec-code-quality`
- **AND** the prompt contains the absolute path of `$HOME/.claude/skills/openspec-code-quality`
- **AND** the prompt contains the user name from `git config user.name` of the project
- **AND** the prompt states that the user name is only for the trace fields and not for a sign-off field

#### Scenario: R9 runs the verify stage
- **WHEN** a change under autopilot is at rule `R9`
- **THEN** the prompt contains `openspec-verify-change`

#### Scenario: R11 runs the archive stage
- **WHEN** a change under autopilot is at rule `R11` and the file `scripts/a.mjs` is changed in the work tree
- **THEN** the prompt contains `openspec-archive-change`
- **AND** before `claude` starts, `implSnapshot` of the autopilot record maps `scripts/a.mjs` to its `git hash-object`

#### Scenario: R5 voids the autopilot
- **WHEN** a change under autopilot is at rule `R5` with the blocker `签字行空白`
- **THEN** the autopilot record has `status` `void` and its `voidReason` contains `R5` and `签字行空白`
- **AND** the `lark-cli` test double receives one notice card, and the scheduler does not start `claude`

#### Scenario: R10 voids the autopilot
- **WHEN** a change under autopilot is at rule `R10` with two blockers
- **THEN** the autopilot record has `status` `void` and the notice card lists both blockers

#### Scenario: Progress entry without reviewStale voids the autopilot
- **WHEN** the `progressBin` test double writes an entry of the change without the key `reviewStale`
- **THEN** the autopilot record has `status` `void`, one notice card names both skills, and the scheduler does not start `claude`

#### Scenario: Pending decision blocks the change
- **WHEN** a change under autopilot is at rule `R6` and has a `pending` decision with a `card.messageId`
- **THEN** the scheduler does not start `claude` for the change

#### Scenario: Answered question resumes the session
- **WHEN** `decisions/D-0003.json` is an `answered` question decision with `request.sessionId` `s1`
- **THEN** the scheduler starts `claude` with `--resume s1` and without a prompt
- **AND** when the result is not deferred on the same `request.toolUseId`, `D-0003.json` has `status` `used`

### Requirement: The scheduler SHALL check the loaded permission rules before it starts a run

Before it starts or resumes `claude` for a project, the scheduler SHALL read `permissions.allow`, `permissions.additionalDirectories`, `hooks.PreToolUse`, `hooks.PermissionRequest` and `disableAllHooks` of `$HOME/.claude/settings.json` and `<project root>/.claude/settings.json`. Each allow entry SHALL be `Read`, `Grep`, `Glob`, a rule that starts with `mcp__autopilot__`, or a rule in `allowedCommands` of the project.

The scheduler SHALL also read `allowed-tools`, `hooks` and `disable-model-invocation` in the front matter (the first block between `---` lines) of `$HOME/.claude/skills/*/SKILL.md`, `$HOME/.claude/skills/synced/*/SKILL.md`, `$HOME/.claude/commands/**/*.md`, `$HOME/.claude/agents/**/*.md`, `<project root>/.claude/skills/*/SKILL.md`, `<project root>/.claude/commands/**/*.md`, `<project root>/.claude/agents/**/*.md`, and `**/.claude/skills/*/SKILL.md` under the project root without `node_modules`, `.git` and `.claude/worktrees`. The scan SHALL follow symbolic links and SHALL visit each real directory once. Each item of `allowed-tools` SHALL be in the same list as the allow entries, except in a file with `disable-model-invocation` `true`.

The check SHALL fail when an allow entry or an `allowed-tools` item is outside the list, a settings file or a front matter has a `PreToolUse` or `PermissionRequest` hook, a scanned skill directory has a `.claude-plugin/` directory, `permissions.additionalDirectories` is not empty, `disableAllHooks` is `true`, or a file cannot be parsed. Then the scheduler SHALL NOT start or resume `claude` for any change of the project in this round, SHALL keep the autopilot records unchanged, and SHALL send a notice card that lists each entry, directory, hook or front matter item with its file. It SHALL store the list in `rule-check.json` in the autopilot home and SHALL send the card again only when the list changes. A missing file, or a file without these keys, SHALL pass.

#### Scenario: Extra allow rule stops the round
- **WHEN** `$HOME/.claude/settings.json` has the allow entry `Bash(curl:*)` and a change of the project is under autopilot at rule `R6`
- **THEN** the scheduler does not start `claude`, and the autopilot record has `status` `active`
- **AND** the notice card contains `Bash(curl:*)` and the path of the file

#### Scenario: Same rule list sends one card
- **WHEN** two rounds run and `$HOME/.claude/settings.json` has the same allow entry `Bash(curl:*)` in both rounds
- **THEN** the `lark-cli` test double receives one notice card

#### Scenario: Hook in project settings stops the round
- **WHEN** `<project root>/.claude/settings.json` has a `PreToolUse` hook and a change of the project is under autopilot at rule `R6`
- **THEN** the scheduler does not start `claude`, and the notice card names the hook and the file

#### Scenario: Skill front matter with an extra allowed tool stops the round
- **WHEN** `$HOME/.claude/skills/x/SKILL.md` has `allowed-tools: Bash(curl *)` and a change of the project is under autopilot at rule `R6`
- **THEN** the scheduler does not start `claude`
- **AND** the notice card contains `Bash(curl *)` and the path of the file

#### Scenario: Skill that the model cannot invoke passes
- **WHEN** `$HOME/.claude/skills/x/SKILL.md` has `allowed-tools: Bash(curl *)` and `disable-model-invocation: true`, and a change of the project is under autopilot at rule `R6`
- **THEN** the scheduler starts `claude`

#### Scenario: Hook in a project skill stops the round
- **WHEN** `<project root>/.claude/skills/y/SKILL.md` has a `PreToolUse` hook in its front matter and a change of the project is under autopilot at rule `R6`
- **THEN** the scheduler does not start `claude`, and the notice card names the file

#### Scenario: Additional directories stop the round
- **WHEN** `$HOME/.claude/settings.json` has `permissions.additionalDirectories` with one directory and a change of the project is under autopilot at rule `R6`
- **THEN** the scheduler does not start `claude`, and the notice card names the directory and the file

#### Scenario: Disabled hooks stop the round
- **WHEN** `<project root>/.claude/settings.json` has `disableAllHooks` `true` and a change of the project is under autopilot at rule `R6`
- **THEN** the scheduler does not start `claude`, and the notice card names `disableAllHooks` and the file

#### Scenario: Linked skill directory is scanned
- **WHEN** `$HOME/.claude/skills/x` is a symbolic link to a directory whose `SKILL.md` has `allowed-tools: Bash(curl *)`, and a change of the project is under autopilot at rule `R6`
- **THEN** the scheduler does not start `claude`, and the notice card contains `Bash(curl *)`

#### Scenario: Subagent in a subdirectory is scanned
- **WHEN** `$HOME/.claude/agents/review/x.md` has a `PreToolUse` hook in its front matter and a change of the project is under autopilot at rule `R6`
- **THEN** the scheduler does not start `claude`, and the notice card names the file

#### Scenario: Skill directory with a plugin manifest stops the round
- **WHEN** `$HOME/.claude/skills/z/.claude-plugin/plugin.json` exists and a change of the project is under autopilot at rule `R6`
- **THEN** the scheduler does not start `claude`, and the notice card names the directory

### Requirement: The scheduler SHALL start headless runs with the autopilot settings

The scheduler SHALL start `claude` (configuration key `claudeBin`) in the project root with only these environment variables: `HOME`, `PATH`, `USER`, `LANG`, `OPENSPEC_AUTOPILOT_HOME` and `OPENSPEC_AUTOPILOT_CHANGE_ROOT`. `OPENSPEC_AUTOPILOT_CHANGE_ROOT` SHALL be the change directory located by Requirement «The scheduler SHALL locate the change again after each run». It SHALL pass `-p`, `--model` with the configured `model`, `--setting-sources user,project`, `--settings` with `settings.json` in the autopilot home, `--mcp-config` with `mcp.json` in the autopilot home, `--strict-mcp-config`, `--permission-prompt-tool mcp__autopilot__approve`, `--permission-mode acceptEdits`, `--allowedTools` with the `allowedCommands` of the project and the read rules of the skill directories, `--disallowedTools WebFetch WebSearch`, `--max-budget-usd` with the configured `maxBudgetUsd`, and `--output-format json`. Standard input SHALL be closed. Before each run the scheduler SHALL write these two files from `templates/autopilot-settings.json` and `templates/autopilot-mcp.json`, with the placeholder `<SKILL_DIR>` replaced by the absolute path of the skill directory and `<AUTOPILOT_HOME>` replaced by the absolute path of the autopilot home, and `<ALLOWED_COMMANDS>` replaced by the command prefixes inside the parentheses of the project's `allowedCommands`, joined with `、`.

The read rules of the skill directories SHALL be `Read(//<path>/**)`, `Grep(//<path>/**)` and `Glob(//<path>/**)`, without duplicates, for each of these paths: `$HOME/.claude/skills`, its real path when it differs, and the real path of each skill entry in `$HOME/.claude/skills` and in `$HOME/.claude/skills/synced`. A skill entry SHALL be an entry whose real path is a directory that contains `SKILL.md`. For any other entry the scheduler SHALL write no rule and a log line with the entry name, and SHALL NOT exit. The environment check and the read rules SHALL use one listing of the entries.

At the start of each round the scheduler SHALL exit with code 2 before it starts any process when one of these is true:

- the configuration has no `model`, no `ownerOpenId` or no `projects`;
- `node`, `claudeBin` or `larkBin` cannot run with the current `PATH`;
- the real path of the skill directory, of `progressBin`, or of the gate script that `progressBin` runs, is inside the real path of a project root;
- an item of `allowedCommands` is not of the form `Bash(<prefix>)`: it does not start with `Bash(`, does not end with `)`, is empty inside the parentheses, or starts with `*` inside them;
- the real path of a project root differs from the output of `git rev-parse --show-toplevel` in that root;
- a project root has no directory `openspec/changes` (the autopilot supports only the default layout of openspec);
- the real path of an entry in `$HOME/.claude/skills` or `$HOME/.claude/skills/synced` is `$HOME`, a parent directory of `$HOME`, or `/`.

It SHALL write a log line with the reason. When `larkBin` can run and `ownerOpenId` is set, it SHALL send one notice card for each new reason (`rule-check.json`).

#### Scenario: Headless run uses a clean environment
- **WHEN** the scheduler runs with `CLAUDE_CODE_ENTRYPOINT` set in its own environment
- **THEN** the `claude` test double receives no variable whose name starts with `CLAUDE_CODE_`
- **AND** its arguments contain `--model`, `--setting-sources user,project`, `--disallowedTools WebFetch WebSearch`, `--permission-prompt-tool mcp__autopilot__approve` and `--max-budget-usd`

#### Scenario: Config without model is rejected
- **WHEN** the configuration has no `model`
- **THEN** `scheduler.mjs --once` exits with code 2 and does not start `claude`

#### Scenario: Settings point to the installed hook
- **WHEN** the scheduler starts a stage
- **THEN** `settings.json` in the autopilot home has no `<SKILL_DIR>` and no `<AUTOPILOT_HOME>`, and its hook command is the absolute path of `autopilot-hook.mjs`
- **AND** `mcp.json` in the autopilot home has no `<ALLOWED_COMMANDS>`

#### Scenario: Skill directories are readable through both paths
- **WHEN** `$HOME/.claude/skills/demo` is a symbolic link to `<tmp>/store/demo` and the scheduler starts a stage
- **THEN** the `--allowedTools` value contains `Read(//<HOME>/.claude/skills/**)` and `Read(//<tmp>/store/demo/**)`, and the same two paths for `Grep` and `Glob`
- **AND** it contains no rule for `<tmp>/store`

#### Scenario: Skill entry that links to the home directory is rejected
- **WHEN** `$HOME/.claude/skills/demo` is a symbolic link to `$HOME`
- **THEN** `scheduler.mjs --once` exits with code 2, does not start any process, and its log line names `demo`

#### Scenario: Entry without SKILL.md gets no read rule
- **WHEN** `$HOME/.claude/skills/cc` is a symbolic link to `<tmp>/cc-switch`, which has no `SKILL.md`, and `$HOME/.claude/skills/demo` links to `<tmp>/store/demo`, which has `SKILL.md`
- **THEN** the scheduler starts the stage, and the `--allowedTools` value contains `Read(//<tmp>/store/demo/**)` and no rule for `<tmp>/cc-switch`
- **AND** the log has a line that names `cc`

#### Scenario: Skill directory inside a project is rejected
- **WHEN** `progressBin` points to a file inside a configured project root
- **THEN** `scheduler.mjs --once` exits with code 2 and does not start `claude`

#### Scenario: Missing command is rejected
- **WHEN** `claudeBin` points to a path that does not exist
- **THEN** `scheduler.mjs --once` exits with code 2, does not start any process, and its log line names `claudeBin`

#### Scenario: Tool name in allowedCommands is rejected
- **WHEN** `allowedCommands` of a project has the item `Write`
- **THEN** `scheduler.mjs --once` exits with code 2, does not start any process, and its log line names `Write`

#### Scenario: Project root below the repository root is rejected
- **WHEN** `projects[].root` is a subdirectory of a git repository
- **THEN** `scheduler.mjs --once` exits with code 2 and does not start any process

### Requirement: The scheduler SHALL locate the change again after each run

Before it starts or resumes `claude`, the scheduler SHALL locate the change directory by the change name in the progress view: `<project root>/openspec/changes/<name>` for an entry in `active`, and `<project root>/openspec/changes/archive/<date>-<name>` for an entry in `archived`. After `claude` returns, and before it writes any file, the scheduler SHALL read the progress view again, locate the change directory again, and read the autopilot record in it. When the record `status` or `startedAt` differs from the value read before the run, the scheduler SHALL NOT create a decision, SHALL NOT send a card, and SHALL write a log line. When the change is neither in `active` nor in `archived`, it SHALL write a log line and send a notice card, and SHALL NOT write a decision. Decisions SHALL be written in the located directory. The scheduler SHALL NOT create `decisions/` directories. After it creates a decision file, the scheduler SHALL read the autopilot record again. When `status` or `startedAt` differs from the value read before the run, it SHALL set the new decision to `void` with `voidReason` `托管已撤回` and SHALL NOT send its card.

#### Scenario: Alert after archive moves the directory is written in the archive directory
- **WHEN** an archive run moves the change to `openspec/changes/archive/2026-11-06-<name>` and returns `is_error` `true` with the subtype `error_max_budget_usd`
- **THEN** the alert decision is in `openspec/changes/archive/2026-11-06-<name>/decisions/`
- **AND** `openspec/changes/<name>` does not exist

#### Scenario: Cancelled autopilot gets no card after the run
- **WHEN** the autopilot record is set to `void` while the `claude` test double runs, and the run returns `tool_deferred` on `AskUserQuestion`
- **THEN** no decision file is created and the `lark-cli` test double receives no card

#### Scenario: Late result after a new handover gets no card
- **WHEN** the autopilot record is set to `void` and then to `active` with a new `startedAt` while the `claude` test double runs, and the run returns `tool_deferred` on `AskUserQuestion`
- **THEN** no decision file is created and the `lark-cli` test double receives no card

#### Scenario: Decision created after a cancel is voided
- **WHEN** the run returns `tool_deferred` on `AskUserQuestion`, and `autopilot.mjs cancel` sets the record to `void` after the scheduler reads the record after the run and before it creates the decision (the `progressBin` test double runs the cancel on its second call)
- **THEN** the new decision has `status` `void` with `voidReason` `托管已撤回`
- **AND** the `lark-cli` test double receives no card

### Requirement: The scheduler SHALL turn a deferred question into a pending decision

When a result has `stop_reason` `tool_deferred` and `deferred_tool_use.name` `AskUserQuestion`, the scheduler SHALL create `decisions/D-<next four digits>.json` with `kind` `question`, `status` `pending`, `stage`, and `request` with `sessionId`, `toolUseId`, `fingerprint` (the first 12 hexadecimal characters of the SHA-256 of the JSON text of `deferred_tool_use.input`) and `questions`. It SHALL send the decision card to `ownerOpenId` through `lark-cli` (configuration key `larkBin`) as the bot, and SHALL write the returned message id to `card.messageId`. When the card cannot be sent, `card.messageId` SHALL stay `null`. When the deferred tool is not `AskUserQuestion`, the scheduler SHALL create a session alert decision.

#### Scenario: Deferred question becomes a card
- **WHEN** the `claude` test double returns `tool_deferred` with an `AskUserQuestion` input of one question and two options
- **THEN** `decisions/D-0001.json` has `status` `pending`, the session id, the tool use id and a 12-character fingerprint
- **AND** the `lark-cli` test double receives one card whose text contains the question and both option labels

#### Scenario: Failed card send is retried
- **WHEN** the `lark-cli` test double fails on the first send
- **THEN** the decision has `status` `pending` and `card.messageId` `null`
- **AND** the next round sends the card again and does not start `claude`

### Requirement: The scheduler SHALL void a decision that cannot be used

After it resumes the session of an `answered` question decision or session alert decision, the scheduler SHALL handle the run in this order: locate the change again and read the autopilot record (Requirement «The scheduler SHALL locate the change again after each run»); run the check of Requirement «The scheduler SHALL check the trace records and the sign-off fields around each run»; set the resumed decision to its final status; create at most one new decision; read the autopilot record again. The final status and the new decision SHALL follow the answer and the result in this order:

- An answer of a question decision is the option label `回会话处理`, whatever the result is: set the decision to `used`, set the autopilot record to `void` with a `voidReason` that contains the question, send a notice card that also lists the failed items of the check, and SHALL NOT create a decision for the result.
- The result of a question decision is deferred again on the same `request.toolUseId`: set the decision to `void` with `voidReason` `提问已变化`, create a new `pending` decision for the deferred input, and send its card.
- The result has `stop_reason` `tool_deferred_unavailable`, or the result is an error because the session cannot be found: set the decision to `void` with `voidReason` `会话无法恢复`, and send a notice card that says the stage runs again. When the `stage` of the decision is `quality`, the scheduler SHALL first write `rerunStage` `quality` to the autopilot record, and SHALL set the decision to `void` only after that write succeeds. The next round SHALL choose the action by the rule (Requirement «The scheduler SHALL choose the action from the progress rule»).
- Otherwise: set the decision to `used`. When the check fails, create a session alert decision for the failed items and no other decision. Otherwise handle the result as for a new run. When the result is deferred on another `AskUserQuestion` call (the next batch of questions of one stage), the scheduler SHALL set the decision to `used` before it creates the new decision (Requirement «The scheduler SHALL turn a deferred question into a pending decision»), so that a change has at most one decision with `status` `pending` or `answered`.

#### Scenario: Changed question gets a new card
- **WHEN** the resumed run returns `tool_deferred` on the same tool use id with a different question
- **THEN** the old decision has `status` `void` and `voidReason` `提问已变化`
- **AND** a new `pending` decision exists with the new question and its card is sent

#### Scenario: Expired session is run again
- **WHEN** the resumed run returns `tool_deferred_unavailable`
- **THEN** the decision has `status` `void` and `voidReason` `会话无法恢复`
- **AND** the next round starts a new stage by the rule of the change

#### Scenario: Quality interrupted by an expired session runs again
- **WHEN** the resumed run of the quality question decision `D-0003` returns `tool_deferred_unavailable`, and in the next round the progress entry of the change is at rule `R9`
- **THEN** `D-0003.json` has `status` `void` and the autopilot record has `rerunStage` `quality` after the first round
- **AND** the next round starts a stage whose prompt contains `openspec-code-quality`, and the autopilot record has no `rerunStage`

#### Scenario: Resumed alert that stops on a question is used first
- **WHEN** the session alert decision `D-0005` is answered with `补充说明后继续` and the text `只改 scripts 目录`, and the resumed run returns `tool_deferred` on `AskUserQuestion`
- **THEN** `D-0005.json` has `status` `used`, and `D-0006.json` has `status` `pending`
- **AND** when the `lark-cli` test double receives the card of `D-0006`, `D-0005.json` already has `status` `used`

#### Scenario: Next batch after a resume gets a new card
- **WHEN** `D-0003` is an `answered` question decision, and the resumed run returns `tool_deferred` on `AskUserQuestion` with another tool use id
- **THEN** `D-0003.json` has `status` `used`, and `D-0004.json` has `status` `pending` with the new tool use id
- **AND** when the `lark-cli` test double receives the card of `D-0004`, `D-0003.json` already has `status` `used`

#### Scenario: Return to session answer voids the autopilot after the run
- **WHEN** `D-0003` answers `回会话处理` to one question and `risk accepted` to another, and the resumed run returns `tool_deferred` on another `AskUserQuestion` call
- **THEN** `D-0003.json` has `status` `used`, the autopilot record has `status` `void` with a `voidReason` that contains the question, and no new decision file exists
- **AND** the `lark-cli` test double receives one notice card

### Requirement: The scheduler SHALL stop a change that makes no progress

For runs of the apply, quality, verify and archive stages and for resumed sessions, the scheduler SHALL compute a progress digest before and after each run: the SHA-256 of the `stage`, `rule`, `tasks`, `blockers` and `warnings` of the progress entry, the output of `git status --porcelain=v1 -z --untracked-files=all` and `git diff HEAD` in the project with the pathspec `-- . ':(exclude)openspec/changes'` (the default layout of openspec), the `git hash-object` of each untracked file in that output, and the relative path and SHA-256 of each file in the change directory. When a run ends without a deferred tool, without an error, and with the same digest, the scheduler SHALL create a session alert decision with `request.sessionId` and the first 500 characters of `result`. When a run ends with `is_error` `true` or with a `subtype` that starts with `error`, the scheduler SHALL create a session alert decision with the error text. When the output of a run is not JSON or has no `session_id`, the scheduler SHALL create a session alert decision with the first 500 characters of the output, without `request.sessionId`, and with `request.options` that contain only `回会话处理`. A session alert card SHALL be one form with one text input and two submit buttons named `补充说明后继续` and `回会话处理` (spec `autopilot-decisions`). When a session alert is answered with `补充说明后继续`, the scheduler SHALL resume the session with the prompt `用户补充说明：<input text>`, and SHALL set the alert to `used` after the run (Requirement «The scheduler SHALL void a decision that cannot be used»). When it is answered with `回会话处理`, the scheduler SHALL set the alert to `used`, set the autopilot record to `void`, and SHALL NOT resume the session. Draft runs of exit actions SHALL NOT use this check (spec `autopilot-exit-actions`).

#### Scenario: Stage without progress sends an alert
- **WHEN** the `claude` test double ends with the result `我无法确定要修改的范围。` and changes no file, and the progress entry is the same
- **THEN** an alert decision with `status` `pending` contains that text, and one alert card is sent

#### Scenario: Change in an untracked file counts as progress
- **WHEN** an apply run changes only the content of an untracked file and checks no task
- **THEN** no alert decision is created

#### Scenario: New file of another change is not progress
- **WHEN** an apply run changes no file except a new file `openspec/changes/other-change/proposal.md`, and the progress entry is the same
- **THEN** an alert decision with `status` `pending` is created

#### Scenario: Reply text resumes the session
- **WHEN** a session alert decision is answered with `补充说明后继续` and the text `只改 scripts 目录`
- **THEN** the scheduler starts `claude` with `--resume` and the prompt `用户补充说明：只改 scripts 目录`
- **AND** after the run the alert decision has `status` `used`, and the next round does not resume the session again with the same text

#### Scenario: Return to session voids the autopilot
- **WHEN** a session alert decision is answered with `回会话处理`
- **THEN** the autopilot record has `status` `void`, the alert decision has `status` `used`, and the scheduler does not start `claude`

#### Scenario: Output without a session gets an alert with one option
- **WHEN** the `claude` test double exits with code 1 and writes the text `Your organization has disabled access` that is not JSON
- **THEN** a session alert decision without `request.sessionId` is created, its `request.options` are `回会话处理` only, and its card has one submit button

#### Scenario: Budget limit sends an alert
- **WHEN** the `claude` test double returns `is_error` `true` with the subtype `error_max_budget_usd`
- **THEN** an alert decision is created with the error text and its card is sent

### Requirement: The scheduler SHALL check the trace records and the sign-off fields around each run

Before and after each start or resume of `claude` for the apply, quality, verify and archive stages, the scheduler SHALL record two snapshots of the change directory. Draft runs of exit actions SHALL NOT use this check.

- The trace snapshot: for each finding ID of `review/standards.md` and `review/spec-fidelity.md`, the `状态` in the `## Finding 台账`, and the `闭环状态` and `严重级别` in the Findings table, read as the gate command `review` reads them; the `处理` of each row of the issue table (rule and location) and of the quality-gate table (condition) of `review/sonar.md`. A finding or a row that does not exist before the run SHALL count as `open`.
- The sign-off snapshot (`CONTEXT.md`): the last line that matches `^[-*>\s]*Technical Review Approved:` and the last line that matches `^[-*>\s]*Storyboard Approved:` in each Markdown file of the change directory; the block of `tasks.md` from `^##\s+变更终点\s*$` to the next level-2 heading; and, for each data row of the `## 待环境补测` table of each `evidence/*.md`, the `确认人` cell keyed by the `登记指纹` cell. Header rows and separator rows SHALL NOT be recorded.

The trace check SHALL fail for each item in these cases:

1. the ledger `状态` or the Findings `闭环状态` of a finding became `risk-accepted` or `false-positive`, or the `处理` of a Sonar row became `误报` or `接受`, and no matching question decision exists;
2. after the run, the ledger `状态` and the Findings `闭环状态` of one finding ID differ;
3. the `严重级别` of a finding was lowered from `Blocker` or `Major`;
4. a finding ID or a Sonar row that existed before the run does not exist after it.

A matching question decision SHALL be a decision in `decisions/` of the change with `status` `answered` or `used` and `answer.operatorId` equal to `ownerOpenId`, with a question whose `header` equals the finding ID (for an issue row: the rule, and the question text contains the `file:line` of the row; for a quality-gate row: the condition), and whose `answer.selected` for that question is the matching option label (`risk accepted`, `误报` or `接受`). An answer with only a free text SHALL NOT match.

The sign-off check SHALL fail when the signature line, the storyboard line or the change-head block changed, when the `确认人` of a `待环境补测` row changed from empty to a value or from one value to another, and when a row with a non-empty `确认人` was removed. A new row with an empty `确认人` SHALL pass.

When the check fails, the scheduler SHALL create a session alert decision with `request.sessionId` and `request.checkFailures` (for each item: the file, the finding ID or the field, and the values before and after the run), SHALL show these items on the card, and SHALL NOT create a question decision or another alert for the result of the run. When the run ended with `tool_deferred` on `AskUserQuestion`, the alert SHALL have `request.deferredToolUseId` with the id of the deferred tool use. When the user answers `补充说明后继续`, the scheduler SHALL resume the session with the text, and the next check SHALL compare with the snapshots taken before that resume, so the same items are not reported again. When the user answers `回会话处理`, the autopilot SHALL be voided (Requirement «The scheduler SHALL stop a change that makes no progress»).

#### Scenario: Matching answer passes the check
- **WHEN** the resumed quality run changes the ledger row and the Findings row of `STD-05` from `open` to `risk-accepted`, and the resumed decision `D-0003` was answered by the owner with `risk accepted` selected for the question whose `header` is `STD-05`
- **THEN** no session alert decision is created, and `D-0003.json` has `status` `used`

#### Scenario: Risk accepted without a matching answer sends an alert
- **WHEN** the resumed quality run changes the ledger row and the Findings row of `STD-02` from `open` to `risk-accepted`, and the answer of `D-0003` for the question whose `header` is `STD-02` is `修复`
- **THEN** a session alert decision with `status` `pending` has a `request.checkFailures` item that names `review/standards.md` and `STD-02`
- **AND** no question decision is created for the result of the run, and the alert card shows `STD-02`

#### Scenario: Finding closed only in the Findings table sends an alert
- **WHEN** a quality run changes the `闭环状态` of the Blocker `SPEC-02` in the Findings table of `review/spec-fidelity.md` to `risk-accepted`, and the ledger row of `SPEC-02` stays `open`
- **THEN** a session alert decision has a `request.checkFailures` item that names `SPEC-02`

#### Scenario: Lowered severity sends an alert
- **WHEN** a quality run changes the `严重级别` of `STD-04` in the Findings table from `Blocker` to `Minor`
- **THEN** a session alert decision has a `request.checkFailures` item that names `STD-04`

#### Scenario: Answer to another finding does not match
- **WHEN** the question of `D-0003` whose `header` is `STD-05` mentions `STD-03` in its text and has the answer `risk accepted`, the question whose `header` is `STD-03` has the answer `修复`, and the run changes `STD-03` to `risk-accepted`
- **THEN** a session alert decision has a `request.checkFailures` item that names `STD-03`

#### Scenario: Free text answer is listed for the user
- **WHEN** the answer of `D-0003` for the question whose `header` is `SPEC-04` has no selected option and the free text `这不是误报，按修复处理`, and the run changes `SPEC-04` to `false-positive`
- **THEN** a session alert decision has a `request.checkFailures` item that names `SPEC-04`, and the alert card shows the free text

#### Scenario: Confirmer filled in a pending environment row sends an alert
- **WHEN** an apply run adds a data row to the `## 待环境补测` table of `evidence/slice-02.md` whose `确认人` cell is `tigger`
- **THEN** a session alert decision has a `request.checkFailures` item that names `evidence/slice-02.md` and the `登记指纹` of the row

#### Scenario: New pending environment row without a confirmer passes
- **WHEN** an apply run adds a data row to the `## 待环境补测` table of `evidence/slice-02.md` whose `确认人` cell is empty
- **THEN** no session alert decision is created for the sign-off fields

#### Scenario: Evidence file with an exemption table header passes
- **WHEN** an apply run writes a new `evidence/slice-01.md` with the exemption table header that contains `判定人`
- **THEN** no session alert decision is created for the sign-off fields

#### Scenario: Continue after a check alert does not report the same items
- **WHEN** the alert of the scenario «Risk accepted without a matching answer sends an alert» is answered with `补充说明后继续` and a text, and the resumed run changes no ledger row
- **THEN** no new session alert decision is created for `STD-02`

### Requirement: The install script SHALL write the local files without starting them

`install.mjs` SHALL print the files that it would write: the configuration template in the autopilot home (without secrets), `com.openspec.autopilot.scheduler.plist` (runs `scheduler.mjs --once` at the interval `intervalSeconds`) and `com.openspec.autopilot.bridge.plist` (keeps `bridge.mjs` alive with `ThrottleInterval` 30) in `~/Library/LaunchAgents/`. In both launchd files the first item of `ProgramArguments` SHALL be the absolute path of the running node (`process.execPath`), the second item SHALL be the absolute path of the script, and `EnvironmentVariables.PATH` SHALL contain the directories of node, `claudeBin` and `larkBin`, followed by `/usr/bin:/bin:/usr/sbin:/sbin`. With `--write` it SHALL create the autopilot home with mode `0o700`, write the configuration with mode `0o600`, write both launchd files, and SHALL NOT overwrite an existing configuration file. It SHALL NOT run `launchctl`. It SHALL print the `launchctl` commands that load and unload the two files.

#### Scenario: Install prints the files by default
- **WHEN** `install.mjs` runs without arguments
- **THEN** it prints three target paths and writes no file

#### Scenario: Install keeps an existing configuration
- **WHEN** `install.mjs --write` runs and the configuration file already exists
- **THEN** the configuration file is unchanged and both launchd files are written

#### Scenario: Launchd files carry the node path and PATH
- **WHEN** `install.mjs --write` runs with `HOME` set to a temporary directory
- **THEN** in both launchd files the first item of `ProgramArguments` equals the `process.execPath` of the install run
- **AND** `EnvironmentVariables.PATH` contains the directory of that node and ends with `/usr/bin:/bin:/usr/sbin:/sbin`
