# autopilot-scheduler Specification

## Purpose
托管调度：调度脚本每轮的运行锁、启动前核对设置来源中的允许规则、按进度规则选择动作、headless 运行参数与运行环境检查、运行后重新定位变更、运行结果处理、没有进展时的告警、会话无法恢复时的重跑，以及安装脚本。

## Requirements

### Requirement: The scheduler SHALL run at most one headless process per round

`scheduler.mjs --once` SHALL take the run lock `run.lock` in the autopilot home (`~/.openspec-autopilot/`, or the directory in `OPENSPEC_AUTOPILOT_HOME`) by writing the full JSON to a temporary file and linking it to `run.lock` with `link`, which fails when `run.lock` exists. The lock SHALL hold JSON with `pid`, `bootTime`, `change` and `claudePid`, plus `projectRoot`, `startedAt` and a unique `runId` when claimed. When the file exists and the lock is not stale, the scheduler SHALL exit with code 0 and SHALL NOT start any process. A lock SHALL be stale when its `bootTime` differs from the current boot time by more than 60 seconds, or when neither `pid` nor `claudePid` is alive. A lock that is not valid JSON SHALL be alive when its modification time is at most 60 seconds old, and stale otherwise. The scheduler SHALL replace a stale lock only after it creates `run.lock.takeover` in the same way, and SHALL read the lock again before it removes it.

After it chooses a change, the scheduler SHALL write the real project root, change name, batch `startedAt` and a fresh `runId` to the lock with a temporary file and rename, then read the autopilot record again. It SHALL start or resume `claude`, or run an exit step, only when `status` and `startedAt` of the record equal the values read before; otherwise it SHALL write a log line and release the lock. When a `transition` after this check and before the start of `claude` returns `false`, the scheduler SHALL end the round without starting `claude`. When the scheduler starts `claude`, it SHALL start it as the leader of a new process group and write its process id to `claudePid`. On `SIGTERM` or an uncaught error, it SHALL send `SIGTERM` to that process group before it exits. Before the stage can write the checkout, the scheduler SHALL publish a verifiable process instance for its `runId`; an unacknowledged stage SHALL NOT write and SHALL be stopped when publication fails. The scheduler SHALL compare the lock instance before publishing a process id or acting on a stop request. Normal termination SHALL confirm that the entire process group has exited before releasing its running-writer identity or reading the post-run snapshot. The actual stage SHALL be carried with the run, its result and its verified decisions; unknown stage provenance SHALL NOT authorize the archive path. If the scheduler exits without that proof, the pending check SHALL retain the identity, and recovery SHALL NOT read the comparison, transfer a decision, or clear the entry until it proves the earlier group exited or was never released to write. A new lock or a matching PID number alone is not proof. The scheduler SHALL remove only its own lock instance. In one round the scheduler SHALL start at most one `claude` process across all configured projects, SHALL handle its result, and SHALL handle changes in the order of `startedAt`.

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

#### Scenario: An unconfirmed writer blocks recovery
- **WHEN** the scheduler is interrupted and the previous stage instance may still be writing its checkout
- **THEN** the next process preserves the original start and blocks that name without reading a comparison, transferring a decision, or clearing the entry until the previous writer is proved stopped

#### Scenario: A normal return waits for the writing group to stop
- **WHEN** the main stage process returns but another process of its writing group has not yet exited
- **THEN** the scheduler does not read the post-run snapshot or hand off the result until it proves the group has exited
- **AND** if it cannot prove exit, the original start is retained

#### Scenario: Stage publication fails before it can write
- **WHEN** the stage has been started behind the startup handshake but publishing its process instance fails
- **THEN** the stage is not released to write and the scheduler stops it without treating the run as checked

### Requirement: The scheduler SHALL choose the action from the progress rule

For each project in the configuration, the scheduler SHALL read `progress.mjs --json` (configuration key `progressBin`). It SHALL apply the original-start recovery requirement before normal candidate or action selection. It SHALL check terminal return-to-session handoffs before filtering normal candidates. Normal candidate handling SHALL require an `active` or `exiting` record and apply the same-batch early-archive guard. An early-archive block SHALL permit only the return-to-session handoff, not an existing exit decision or another continuation. For a batch not blocked by either requirement it SHALL check the decisions in this order:

1. A decision with `status` `pending` and no `card.messageId`: send its card again.
2. A decision with `status` `pending` and a `card.messageId`: skip the change in this round.
3. A question decision with `status` `answered`, or a session alert decision with `request.sessionId`, `status` `answered` and the choice `补充说明后继续`: resume its session (Requirement «The scheduler SHALL void a decision that cannot be used»).
4. A session alert decision with `status` `answered` and the choice `回会话处理`: finish the same-batch return-to-session protocol below and do not start `claude`.
5. An alert decision with `request.exitAction` and `status` `answered`: handle the choice (spec `autopilot-exit-actions`).
6. An exit decision with `status` `answered`: run its exit action (spec `autopilot-exit-actions`).

For a verified ordinary or early-archive return-to-session answer, the scheduler SHALL write `void` and the decision ID in `returnHandoff` in the same record replacement under project protection. It SHALL verify that record before setting the decision to `used`. After interruption, the terminal handoff check SHALL use the shared batch-identity scan and read the saved decision ID directly under the same protection. Only a verified session alert of that batch with the return-to-session answer and state `answered` may be changed to `used`; a verified `used` decision is already complete. If ownership, state or the referenced decision cannot be verified, retain the record and report the cause. This path SHALL create no decision, run no stage, and perform no exit action. The scheduler SHALL read back the batch's `void` and that alert's `used` before sending the completion notice with its stable key. A failed notice SHALL NOT undo the terminal states.

When the progress entry of the change has no key `reviewStale`, or `reviewStale` is `null`, the scheduler SHALL set the autopilot record to `void`, send a notice card that asks the user to sync the installed copies of `openspec-change-progress` and `openspec-technical-review` together, and SHALL NOT run a stage. Otherwise it SHALL choose the action by the rule of the progress entry:

| Rule | Action |
|---|---|
| `R1`–`R5`, `R10` | set the autopilot record to `void` with the rule and the blockers in `voidReason`, and send a notice card that asks the user to handle the blockers in a session |
| `R6`, `R7` | run skill `openspec-apply-change` |
| `R8` (spec `change-progress-view`: the verdict is not `PASSED`, or `archive.review.stale` is `true`) | run skill `openspec-code-quality` |
| `R9` | run skill `openspec-verify-change` |
| `R11` | write `implSnapshot` to the autopilot record (spec `autopilot-exit-actions`), then run skill `openspec-archive-change` |
| the change is in the `archived` list | run the next exit action only after the same-batch guard of spec `autopilot-exit-actions` passes |

When the autopilot record has `rerunStage` `quality` and the rule is `R9` or `R11`, the scheduler SHALL run skill `openspec-code-quality` instead, and SHALL NOT write `implSnapshot`. Before it starts any stage or voids the autopilot, it SHALL remove `rerunStage` from the record with the expected status `active` and the `startedAt` read before the round, whatever the rule is.

The prompt of a new stage SHALL name the skill, the change and the absolute path of the installed skill directory, SHALL tell the agent to use rule files and scripts from that directory and not files of the same name in the project, SHALL state that the run is under autopilot, SHALL give the user name from `git -C <project root> config user.name`, SHALL state that the user name is only for the trace fields (`CONTEXT.md`) and SHALL NOT be written to a sign-off field, and SHALL tell the agent to call `AskUserQuestion` as the only tool call of its turn when it needs a user decision. A notice card SHALL NOT create a decision file.

#### Scenario: Return to the session finishes once after interruption
- **WHEN** the verified ordinary or early-archive alert is answered with `回会话处理` and the process stops after it writes the batch as `void` but before it writes the alert as `used`
- **THEN** the next process finishes that decision using the saved handoff ID without enabling the old batch or creating a second decision
- **AND** the handoff is checked before the normal candidate filter excludes `void`, and the notice follows read-back of both records

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
- the real path of the skill directory, of `progressBin`, or of the gate script (configuration key `gateBin`, default: `../openspec-technical-review/scripts/implementation-gate.mjs` beside the skill directory of the real path of `progressBin`) is inside the real path of a project root, where a real path keeps the case of the names on disk;
- `gateBin` is set and is not an absolute path, the gate script does not exist, or its usage text, printed when it runs without arguments, has no word `trace` in standard output and standard error together;
- an item of `allowedCommands` is not of the form `Bash(<prefix>)`: it does not start with `Bash(`, does not end with `)`, is empty inside the parentheses, or starts with `*` inside them;
- the real path of a project root differs from the output of `git rev-parse --show-toplevel` in that root;
- a project root has no directory `openspec/changes` (the autopilot supports only the default layout of openspec);
- the real path of an entry in `$HOME/.claude/skills` or `$HOME/.claude/skills/synced` is `$HOME`, a parent directory of `$HOME`, or `/`.

It SHALL write a log line with the reason. When `larkBin` can run and `ownerOpenId` is set, it SHALL send one notice card for each new reason (`rule-check.json`). For a gate script without `trace`, the card SHALL ask the user to sync the installed copy of `openspec-technical-review`. The scheduler SHALL run `progressBin` with `--gate` and the real path of the gate script, so that the progress view and the trace check read one gate script.

When resuming a tool question, the scheduler SHALL bind the hook's read-only context to the verified project, batch, run instance and decision ID. The hook SHALL supply a reply only from that verified batch and decision, including a verified move to its archive; otherwise it SHALL keep the question deferred. The bridge SHALL prove that the incoming message identifies exactly one decision of a verified batch across projects. It SHALL check that the decision is still pending and belongs to that batch under project protection before writing. It SHALL preserve the existing card updates for verified decisions that are no longer pending. When it cannot prove ownership and uniqueness, it SHALL NOT write the decision or update its card. Both paths SHALL preserve the checks of `autopilot-decisions` and SHALL NOT disclose unverified content.

#### Scenario: A reply without verified batch ownership is not delivered
- **WHEN** the hook cannot confirm the original batch of a reply or the bridge finds no unique verified pending decision for a message
- **THEN** the hook keeps the question deferred or the bridge leaves the decision and card unchanged
- **AND** a verified reply for the same batch still follows the normal answer path

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

#### Scenario: Gate script inside a project is rejected
- **WHEN** `gateBin` points to a file inside a configured project root
- **THEN** `scheduler.mjs --once` exits with code 2 and does not start `claude`

#### Scenario: Gate script that links into a project is rejected
- **WHEN** `gateBin` is a symbolic link outside the project roots to a file inside a configured project root
- **THEN** `scheduler.mjs --once` exits with code 2 and does not start `claude`

#### Scenario: Relative gate path is rejected
- **WHEN** `gateBin` is `skills/openspec-technical-review/scripts/implementation-gate.mjs`
- **THEN** `scheduler.mjs --once` exits with code 2 and its log line names `gateBin`

#### Scenario: Progress view uses the gate script of the check
- **WHEN** the scheduler runs `progressBin`
- **THEN** the arguments of the `progressBin` test double contain `--gate` and the real path of the gate script

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

Before it starts or resumes `claude`, the scheduler SHALL locate the change directory from the progress view and read its autopilot record. The identity of a managed batch SHALL be the real project root, the change name and the `startedAt` read before the run. After the run, before it writes a file in the change, it SHALL locate that same batch again. The candidates SHALL be the directory used before the run, `<project root>/openspec/changes/<name>`, and every archive directory whose name matches the full pattern `YYYY-MM-DD-<name>` through `archivedDirNames`. It SHALL deduplicate the real paths and read every candidate record, not select the first archive or prefer archives without checking the batch. A directory without a record SHALL NOT count as a managed batch. An existing record that cannot be read or has invalid content SHALL prevent a unique match from being proved.

The shared scan SHALL verify ownership before deduplication or reads. The actual active and archive roots SHALL belong to the real project. A candidate SHALL be a direct child of the corresponding root and match its expected name. `decisions/` SHALL be the actual direct child of that change directory and the record and decision paths SHALL be regular files with the expected names. A symbolic link at any of these boundaries or an object that fails ownership or type verification SHALL be an invalid candidate, not an absent record. Reads, writes, and the check before sending a card SHALL stay attached to the verified batch and directory identity. If that identity cannot be kept across an operation, the scheduler SHALL stop, keep the original start and neither write nor send a decision card.

When exactly one record has the original `startedAt` and no candidate record is unreadable or invalid, the scheduler SHALL use its directory and then compare its `status` with the status read before the run. An older archive with another `startedAt` SHALL NOT hide the current active directory. When more than one record matches the original identity, the scheduler SHALL NOT select one. When the original directory has a valid record with a new `startedAt`, a complete scan finds no original batch, and no candidate record is unreadable or invalid, it SHALL treat the original batch as superseded and SHALL NOT write its result to the new batch. A record of another batch in any other directory SHALL NOT prove cancellation. When the matching record has status `void`, it SHALL end handling as cancelled without creating a decision or sending a result card. When identity is ambiguous, the record is missing, or a record read fails, it SHALL write a log line and send a notice with the candidate paths, the reason and the unchecked-run warning. It SHALL keep the original comparison start under Requirement «The scheduler SHALL persist and recover an unfinished trace check», SHALL NOT recreate an autopilot record, SHALL NOT create a decision, and SHALL NOT continue the run result or any exit action.

When the progress view cannot be read after the run, the scheduler SHALL use the same candidate scan and identity rule on the file system and SHALL NOT send the notice that the change is no longer handled. When a readable view lists the change neither in `active` nor in `archived`, it SHALL send that notice, write no decision and keep the unfinished check. When the current batch matches an archive record and the original active directory also exists as a different directory, it SHALL check the archive and add `原位置出现同名目录` with both paths to `request.checkFailures`, together with all trace and sign-off failures. A current active batch beside historical archives SHALL still be checked in the active directory and SHALL NOT get this recreated-directory failure merely because the archives exist.

Each archived candidate in later rounds SHALL carry its concrete archive directory and `startedAt`; the scheduler SHALL re-read that record before processing and SHALL NOT route it through an active-first name lookup. A changed location SHALL require the same identity scan, never selection of another batch. Decisions SHALL be written only in the existing `decisions/` of the matched batch. Before sending a new decision card, the scheduler SHALL locate the same batch again and re-read its record. Cancellation SHALL void the new decision with `voidReason` `托管已撤回`; a read failure or ambiguity SHALL keep the unfinished comparison and send no decision card. The scheduler SHALL NOT create `decisions/` directories.

#### Scenario: Candidate ownership must be proved before record handling
- **WHEN** a candidate or an existing decision path cannot be verified as belonging to the expected project and batch
- **THEN** no candidate record is used to prove a unique batch, no decision is written or sent, and the saved comparison start remains unchanged

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

#### Scenario: Cancel before a decision write prevents a new decision
- **WHEN** the run returns `tool_deferred` on `AskUserQuestion` and withdrawal changes the batch to `void` before the final project-protected decision write
- **THEN** the scheduler creates no decision and does not send a decision card

#### Scenario: Decision created after a cancel is voided
- **WHEN** a `tool_deferred` decision was written for the original batch, and withdrawal changes that batch to `void` before the final check for sending the card
- **THEN** the written decision is `void` and is not sent
- **AND** the card send check does not write to a different batch

#### Scenario: Unreadable progress view after the run still checks the run
- **WHEN** the `progressBin` test double exits with code 1 after the run, and the run changed the ledger row and the Findings row of `STD-02` to `risk-accepted` without a matching question decision
- **THEN** no notice card says that the autopilot no longer handles the change
- **AND** a session alert decision in the change directory has a `request.checkFailures` item that names `STD-02`

#### Scenario: Original directory recreated after archive still checks the archive
- **WHEN** a run changes the ledger row and the Findings row of `STD-02` to `risk-accepted` without a matching question decision, moves the change into its archive directory, and writes `notes.md` at the original change path, so that the progress view lists the name in both `active` and `archived`
- **THEN** a session alert in the archive directory has `request.checkFailures` items for `STD-02` and `原位置出现同名目录`, with both directory paths
- **AND** no decision is written in the recreated directory, and no exit action is drafted

#### Scenario: Unreadable progress with a recreated directory still checks the archive
- **WHEN** the run of the scenario «Original directory recreated after archive still checks the archive» ends and the `progressBin` test double exits with code 1
- **THEN** the scheduler locates the archive directory on the file system, and the session alert there lists `STD-02` and `原位置出现同名目录`

#### Scenario: Missing autopilot record sends a notice instead of a silent return
- **WHEN** the located change directory exists after the run but its autopilot record file does not exist
- **THEN** one notice card names the change, the directory and the missing record, and asks the user to review the unchecked changes in the session
- **AND** no decision is created, no autopilot record is recreated, and no exit action is started in this handling

#### Scenario: Invalid autopilot record sends a notice
- **WHEN** the autopilot record in the located change directory cannot be read or has invalid content after the run
- **THEN** one notice card names the change, the directory and the read failure, and no decision is created or exit action started in this handling

#### Scenario: Archived candidate uses the archive despite a recreated active directory
- **WHEN** an archived change has an active autopilot record and a pending session alert, and a directory with only `notes.md` exists at the original path of the change
- **THEN** the next round reads the archived candidate's record and pending alert in the archive directory, without skipping them because the recreated directory has no record
- **AND** it does not draft an exit action while the alert is pending

#### Scenario: Change missing from a readable progress view sends a notice card
- **WHEN** the `progressBin` test double lists the change neither in `active` nor in `archived` after the run
- **THEN** the `lark-cli` test double receives one notice card that names the change, and no decision file is created

#### Scenario: Historical archive does not hide the current batch
- **WHEN** the original directory still contains the current `active` batch with `startedAt` T2 after the run, a historical archive contains a `void` batch T1, and the run changed `STD-02` to `risk-accepted` without an answer
- **THEN** the scheduler checks the original T2 directory and creates its session alert naming `STD-02`, without treating T1 as a cancellation
- **AND** the same assertion holds when the progress view cannot be read

#### Scenario: Matching batch is not the first sorted archive
- **WHEN** three fully matched archive directory names exist and only the last directory has the original `startedAt`
- **THEN** the scheduler checks that directory, not the first directory, with both a readable and an unreadable progress view

#### Scenario: Duplicate batch records block result handling
- **WHEN** two different candidate directories contain records with the original `startedAt`
- **THEN** the scheduler lists both paths in a notice, keeps the original pending trace, and creates no decision or exit draft

#### Scenario: Unreadable candidate prevents a claimed unique match
- **WHEN** one candidate matches the original `startedAt` but another candidate has an unreadable or invalid existing record
- **THEN** the scheduler reports the unresolved candidate and retains the pending trace without selecting a batch

### Requirement: The scheduler SHALL turn a deferred question into a pending decision

When a result has `stop_reason` `tool_deferred` and `deferred_tool_use.name` `AskUserQuestion`, the scheduler SHALL create `decisions/D-<next four digits>.json` only when the allocator in the unfinished-check requirement returns a legal unused ID with `kind` `question`, `status` `pending`, `stage`, and `request` with `sessionId`, `toolUseId`, `fingerprint` (the first 12 hexadecimal characters of the SHA-256 of the JSON text of `deferred_tool_use.input`) and `questions`. It SHALL send the decision card to `ownerOpenId` through `lark-cli` (configuration key `larkBin`) as the bot, and SHALL write the returned message id to `card.messageId`. When the card cannot be sent, `card.messageId` SHALL stay `null`. When the deferred tool is not `AskUserQuestion`, the scheduler SHALL create a session alert decision.

#### Scenario: Deferred question becomes a card
- **WHEN** the `claude` test double returns `tool_deferred` with an `AskUserQuestion` input of one question and two options
- **THEN** `decisions/D-0001.json` has `status` `pending`, the session id, the tool use id and a 12-character fingerprint
- **AND** the `lark-cli` test double receives one card whose text contains the question and both option labels

#### Scenario: Failed card send is retried
- **WHEN** the `lark-cli` test double fails on the first send
- **THEN** the decision has `status` `pending` and `card.messageId` `null`
- **AND** the next round sends the card again and does not start `claude`

#### Scenario: No decision is created after the final four-digit ID
- **WHEN** a batch needs to reserve a new decision and a legal file name already occupies `D-9999`
- **THEN** no five-digit file is created, no history is replaced, and the exhaustion rules of the unfinished-check requirement apply

### Requirement: The scheduler SHALL void a decision that cannot be used

After it resumes the session of an `answered` question decision or session alert decision, the scheduler SHALL handle the run in this order: locate the change again and read the autopilot record (Requirement «The scheduler SHALL locate the change again after each run»); run the check of Requirement «The scheduler SHALL check the trace records and the sign-off fields around each run»; set the resumed decision to its final status; create at most one new decision; read the autopilot record again. The final status and the new decision SHALL follow the answer and the result in this order:

- An answer of a question decision is the option label `回会话处理`, whatever the result is: set the decision to `used`, set the autopilot record to `void` with a `voidReason` that contains the question, send a notice card that also lists the failed items of the check, and SHALL NOT create a decision for the result.
- The result of a question decision is deferred again on the same `request.toolUseId`: set the decision to `void` with `voidReason` `提问已变化`, create a new `pending` decision for the deferred input, and send its card.
- The result has `stop_reason` `tool_deferred_unavailable`, or the result is an error because the session cannot be found: set the decision to `void` with `voidReason` `会话无法恢复`. When the check of the run failed, create a session alert decision with only the option `回会话处理` that lists the failed items (Requirement «The scheduler SHALL check the trace records and the sign-off fields around each run»), and SHALL NOT send the notice card of this case; otherwise send a notice card that says the stage runs again. When the `stage` of the decision is `quality`, the scheduler SHALL first write `rerunStage` `quality` to the autopilot record, and SHALL set the decision to `void` only after that write succeeds. The next round SHALL choose the action by the rule (Requirement «The scheduler SHALL choose the action from the progress rule»).
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

#### Scenario: Expired session with failed check items gets an alert instead of a notice
- **WHEN** the resumed run returns `tool_deferred_unavailable`, and the check of the run lists `STD-02`
- **THEN** the decision has `status` `void` and `voidReason` `会话无法恢复`, and a session alert decision with only the option `回会话处理` names `STD-02`
- **AND** the `lark-cli` test double receives no notice card that says the stage runs again

### Requirement: The scheduler SHALL stop a change that makes no progress

For runs of the apply, quality, verify and archive stages and for resumed sessions, the scheduler SHALL compute a progress digest before and after each run: the SHA-256 of the `stage`, `rule`, `tasks`, `blockers` and `warnings` of the progress entry, the output of `git status --porcelain=v1 -z --untracked-files=all` and `git diff HEAD` in the project with the pathspec `-- . ':(exclude)openspec/changes'` (the default layout of openspec), the `git hash-object` of each untracked file in that output, and the relative path and SHA-256 of each file in the change directory. The after-run digest SHALL use the entry and matched batch directory at that time, not the before-run progress entry. A move from active to archived by the actual archive stage counts as progress. A resumed session already in an archive SHALL still compare the digests. An early archive SHALL follow the separate exit block. When a run ends without a deferred tool, without an error, and with the same digest, the scheduler SHALL create a session alert decision with `request.sessionId` and the first 500 characters of `result`. When a run ends with `is_error` `true` or with a `subtype` that starts with `error`, the scheduler SHALL create a session alert decision with the error text. When the output of a run is not JSON or has no `session_id`, the scheduler SHALL create a session alert decision with the first 500 characters of the output, without `request.sessionId`, and with `request.options` that contain only `回会话处理`. A session alert card SHALL be one form with one text input and a submit button for each permitted label in `request.options` (spec `autopilot-decisions`). When a session alert is answered with `补充说明后继续`, the scheduler SHALL resume the session with the prompt `用户补充说明：<input text>`, and SHALL set the alert to `used` after the run (Requirement «The scheduler SHALL void a decision that cannot be used»). When it is answered with `回会话处理`, the scheduler SHALL follow the same-batch return-to-session protocol of the action selection requirement and SHALL NOT resume the session. Draft runs of exit actions SHALL NOT use this check (spec `autopilot-exit-actions`).

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

Before and after each start or resume of `claude` for the apply, quality, verify and archive stages, the scheduler SHALL run `implementation-gate.mjs trace <change directory>` (spec `gate-trace-read`) with a timeout of 60 seconds and keep its output as the snapshot of the run. The scheduler SHALL NOT parse the Markdown files of the change directory itself: the records it compares are the records that the gate reads. Draft runs of exit actions SHALL NOT use this check. The read SHALL fail when `trace` exits with a code other than 0, does not end within the timeout, prints no JSON, prints a `traceVersion` other than the version of the scheduler, or lacks a key of spec `gate-trace-read` or has a key of another type (`findings`, `sonar` and `slices` are arrays, `rulesVersion` is an object, and `signOff` has its four keys). Before a start, the scheduler SHALL run `trace` before it writes the autopilot record: before it clears `rerunStage` and before it writes the implementation snapshot. When the read before a start or resume fails, the scheduler SHALL NOT start or resume `claude`, SHALL keep the autopilot record and the decisions unchanged, and SHALL write a log line. It SHALL send a notice card only when the reason or the `startedAt` of the autopilot record differs from the last value of the change, which it keeps as `{ startedAt, reason }` in `traceErrors` of `rule-check.json` and removes after a read that succeeds; the other writes of `rule-check.json` SHALL keep `traceErrors`. The card SHALL show the reason and the two actions of the user: fix the cause and wait for the next round, or run `autopilot.mjs cancel`; it SHALL say that after `cancel` the autopilot no longer compares with the start kept in the resumed alert, and that the user should review the changes of the agent in the session. When the read after the run fails, the check SHALL fail with one item that says the records cannot be read and that the changes cannot be listed; the alert SHALL ask the user to fix the cause and answer `补充说明后继续`, and SHALL say that after `回会话处理` the autopilot no longer lists the changes of this run and that the user should review the changes of the agent in the session. The alert SHALL keep the start actually used in this check in `request.traceBefore` and record `comparisonState` `unread`. The caller SHALL treat an unverified trace input as a read failure and SHALL NOT pass unchecked contents or untrusted error text to the notice or alert. Before resume, both the saved original start and any selected continuation boundary SHALL have the current `traceVersion`. When either version differs, the scheduler SHALL NOT compare or resume. It SHALL transfer the original alert under the version-handoff rule of Requirement «The scheduler SHALL persist and recover an unfinished trace check». The replacement alert SHALL explain the version difference and offer only `回会话处理`.

The decisions of a comparison SHALL be the decisions resumed after its start. For a new stage there are none. For a fresh pre-run snapshot or a saved post-run boundary only the newly resumed decision is added. When continuing a check for which comparison was not completed, retain the original `resumedDecisionIds` and add the newly resumed decision. An alert reply is not a matching question decision. `request.traceBefore` SHALL be the output of `trace` with the added key `resumedDecisionIds`, the list of the IDs of the decisions of the comparison.

The scheduler SHALL compare the two snapshots by groups:

- a finding group: the `file`, `id` and `source` of the `findings` items; the scheduler compares the sorted list of their `status` values, the number of items with `openBlocker` `true`, and the highest `severity` of the group (`Blocker` above `Major` above `Minor`, compared with the case as the gate compares it; any other value below `Minor`);
- a Sonar group: the `table`, `key` and `location` of the `sonar` items, compared by the sorted list of their `handling` values;
- a pending environment group: the `file` and the `登记指纹` of `signOff.pendingEnvironment`, compared by the set of non-empty `确认人` values.

A group that does not exist before the run SHALL count as `open`. A Findings group that does not exist after the run, or that has fewer items with `openBlocker` `true` after the run, SHALL be an allowed close only in one of these cases: the ledger group of the same file and ID exists after the run and all its `status` values are `closed`; the number of items with an accepted value increased by at least the decrease and by at least one, and a matching question decision exists for the accepted value; or the Findings group does not exist after the run, none of its `status` values before the run is `open` (an empty value counts as `open`), and the ledger group of the same file and ID exists after the run with the same sorted list of `status` values as before the run. The decrease SHALL be the number of items with `openBlocker` `true` that the group lost (all of them when the group does not exist after the run). The items with an accepted value SHALL be counted in the Findings group when it exists after the run, otherwise in the ledger group of the same file and ID. The trace check SHALL fail for each item in these cases:

1. the list of a finding group or a Sonar group after the run differs from the list before the run and contains an accepted value (`risk-accepted`, `false-positive`, `接受` or `误报`), and no matching question decision exists; a change from one accepted value to another also counts;
2. after the run, the ledger group and the Findings group of one finding ID both exist and have different sets of `status` values, with an empty value counted as `open`, and the list of at least one of the two groups differs from the list before the run;
3. a finding group exists before and after the run, and its highest `severity` was `Blocker` or `Major` before the run and is lower after it;
4. a ledger group, a Sonar group or a pending environment group that existed before the run does not exist after it, or a Findings group that existed before the run does not exist after it and is not an allowed close;
5. a value of `rulesVersion` that was not `null` before the run is different after it, including `null`;
6. a Findings group has fewer items with `openBlocker` `true` after the run than before it, and it is not an allowed close.

A matching question decision SHALL be a decision of the comparison with `status` `answered` or `used` and `answer.operatorId` equal to `ownerOpenId`, with a question whose `header` equals the finding ID (for an issue row: the rule, and the question text contains the `file:line` of the row; for a quality-gate row: the condition), and whose `answer.selected` for that question is the option label of the accepted value (`risk-accepted`: `risk accepted`; `false-positive`: `误报`; `接受`: `接受`; `误报`: `误报`). When several decisions of the comparison answer the same finding ID, only the one with the highest decision number SHALL count. An answer with only a free text SHALL NOT match. An answer with a selected option and a non-empty free text for that question SHALL NOT match, and the item SHALL show the free text.

The sign-off check SHALL fail when a value of `signOff.approval`, `signOff.storyboard` or `signOff.changeHead` changed; when a pending environment group has a non-empty `确认人` after the run that it did not have before the run; when a non-empty `确认人` of a group was removed; and when a group that existed before the run does not exist after it. It SHALL also fail when a slice had a non-empty `environment` before the run and has an empty or another `environment` after it, when a slice had an unconfirmed row in `deferred` before the run and has neither an unconfirmed row nor a confirmed row after it, and when a slice had a non-empty `environment` before the run and, after the run, the gate reads no slice with its `id`, or its `total` is lower, or its `done` was greater than `0` before the run and is `0` after it, or its `done` was equal to its `total` (greater than `0`) before the run and is lower than its `total` after it. A new group with only empty `确认人` values SHALL pass.

When the check fails, the scheduler SHALL create a session alert decision with `request.checkFailures` and `request.sessionId` when continuation is permitted (for each item: the file, the finding ID or the field, and the values before and after the run), SHALL show these items on a full card or use the bounded summary when required, and SHALL NOT create a question decision or another alert for the result of the run. When the result of the run has no `session_id`, the alert SHALL have only the option `回会话处理`. When the run ended with `tool_deferred` on `AskUserQuestion`, the alert SHALL have `request.deferredToolUseId` with the id of the deferred tool use. A complete check alert SHALL retain the original `request.traceBefore` for handoff and use `comparisonState` `listed` with `request.comparisonBoundary` equal to the snapshot for the reported result. On `补充说明后继续`, it SHALL compare from that boundary, including changes made while waiting for the reply. An `unread` alert SHALL continue from the saved original start. A legacy alert with an original start but no type SHALL NOT treat that check as already listed. A normal stage alert SHALL carry the verified post-run boundary if it permits continuation. A resumable session alone is not sufficient: before offering continuation and again before launch, the scheduler SHALL check the selected boundary after adding the reserved or actual resumed ID against the trace limits. It SHALL NOT replace or trim the original start to make it fit. If an existing continuation reply cannot be used because of size, leave its original evidence and reply intact, start no session, and use a deduplicated no-ID notice for withdrawal and manual handling. An alert displayed only as a summary SHALL NOT offer continuation. When the resumed session cannot be resumed and the check of the run failed, the scheduler SHALL handle it as Requirement «The scheduler SHALL void a decision that cannot be used» says. When the user answers `回会话处理`, the autopilot SHALL be voided (Requirement «The scheduler SHALL stop a change that makes no progress»).

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

#### Scenario: Severity written in upper case sends an alert
- **WHEN** a quality run changes the `严重级别` of the Blocker `STD-02` in the Findings table from `Blocker` to `BLOCKER`, the `闭环状态` stays `open`, and the ledger row stays `open`
- **THEN** a session alert decision has a `request.checkFailures` item that names `STD-02`

#### Scenario: Swapped severities of two rows send an alert
- **WHEN** `review/standards.md` has two Findings rows of `STD-02` before a quality run, one `Minor` with `risk-accepted` and one `Blocker` with `open`, the decision `D-0002` with `status` `used` answered `risk accepted` for `STD-02`, and the run swaps their `严重级别` values
- **THEN** a session alert decision has a `request.checkFailures` item that names `STD-02`

#### Scenario: Accepted again after a reopen sends an alert
- **WHEN** `D-0002` with `status` `used` answered `risk accepted` for `STD-03`, a later quality run changed the ledger row and the Findings row of `STD-03` back to `open`, and the next quality run, which resumes no decision, changes both rows to `risk-accepted`
- **THEN** a session alert decision has a `request.checkFailures` item that names `STD-03`

#### Scenario: Second row accepted with an earlier answer sends an alert
- **WHEN** `review/standards.md` has two Findings rows of `STD-02` before a quality run, one `Minor` with `risk-accepted` and one `Blocker` with `open`, `D-0002` with `status` `used` answered `risk accepted` for `STD-02`, and the run changes the `Blocker` row and its ledger row to `risk-accepted`
- **THEN** a session alert decision has a `request.checkFailures` item that names `STD-02`

#### Scenario: Finding closed in the ledger passes
- **WHEN** a quality run moves the Findings row of the Blocker `SPEC-01` of `review/spec-fidelity.md` into the section `上轮闭环验证` and changes its ledger row to `closed`
- **THEN** no session alert decision is created for `SPEC-01`

#### Scenario: Finding moved out with an open ledger row sends an alert
- **WHEN** a quality run moves the Findings row of the Blocker `SPEC-01` of `review/spec-fidelity.md` into the section `上轮闭环验证`, and its ledger row stays `open`
- **THEN** a session alert decision has a `request.checkFailures` item that names `SPEC-01`

#### Scenario: Lowered severity sends an alert
- **WHEN** a quality run changes the `严重级别` of `STD-04` in the Findings table from `Blocker` to `Minor`
- **THEN** a session alert decision has a `request.checkFailures` item that names `STD-04`

#### Scenario: Empty status with an open ledger row passes
- **WHEN** a quality run writes the Findings row of the Blocker `STD-05` with an empty `闭环状态` and its ledger row with `open`
- **THEN** no session alert decision is created for `STD-05`

#### Scenario: Earlier mismatch is not reported again
- **WHEN** the ledger row of `STD-02` is `risk-accepted` and its Findings row is `open` before an apply run, and the run does not change `review/standards.md`
- **THEN** no session alert decision is created for `STD-02`

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

#### Scenario: Listed changes do not hide changes made while waiting
- **WHEN** a delivered check alert listed a change and the records change again before its continuation
- **THEN** the next comparison includes the later change from the saved post-run boundary but does not repeat the unchanged listed difference

#### Scenario: Continuation does not replace an oversized original start
- **WHEN** adding the resumed ID to the selected boundary exceeds the 4 MiB snapshot limit
- **THEN** no session resumes and the original start and existing reply remain intact
- **AND** a new card does not offer that continuation, or an existing answered card gets the no-ID manual notice

#### Scenario: Status written with code marks is read as the gate reads it
- **WHEN** a quality run changes the ledger row and the Findings row of the Blocker `STD-02` from `open` to `` `Risk-Accepted` ``, and no matching question decision exists
- **THEN** a session alert decision has a `request.checkFailures` item that names `STD-02`

#### Scenario: Findings row moved below a subheading is still read
- **WHEN** a quality run adds the heading `### 附录` inside `## Findings` of `review/standards.md`, moves the row of the Blocker `STD-02` below it, and changes its `闭环状态` to `risk-accepted`, and no matching question decision exists
- **THEN** a session alert decision has a `request.checkFailures` item that names `STD-02`

#### Scenario: Findings row that the gate no longer reads sends an alert
- **WHEN** a quality run removes the separator row of the Findings table of `review/standards.md`, so that the gate no longer reads the row of the Blocker `STD-02`, and the ledger row of `STD-02` stays `open`
- **THEN** a session alert decision has a `request.checkFailures` item that names `STD-02`

#### Scenario: Duplicate status column sends an alert
- **WHEN** a quality run adds a second `闭环状态` column to the Findings table of `review/standards.md` with the value `risk-accepted` for the Blocker `STD-02`, and no matching question decision exists
- **THEN** a session alert decision has a `request.checkFailures` item that names `STD-02`

#### Scenario: Removed rules version sends an alert
- **WHEN** a quality run removes the line `Rules Version: 2` from `review/standards.md`
- **THEN** a session alert decision has a `request.checkFailures` item that names `review/standards.md` and `Rules Version`

#### Scenario: Accepted risk changed to a false positive sends an alert
- **WHEN** the ledger row and the Findings row of `STD-03` are `risk-accepted` before a quality run, the run changes both to `false-positive`, and no question decision has `误报` selected for `STD-03`
- **THEN** a session alert decision has a `request.checkFailures` item that names `STD-03`

#### Scenario: Second Findings row of one ID is compared
- **WHEN** `review/standards.md` has two Findings rows of `STD-04` before a quality run, one `risk-accepted` and one `open`, and the run changes the second row to `risk-accepted` without a matching question decision
- **THEN** a session alert decision has a `request.checkFailures` item that names `STD-04`

#### Scenario: Later answer replaces an earlier answer
- **WHEN** `D-0003` answered `risk accepted` for `SPEC-04`, the later `D-0005` answered `修复` for `SPEC-04`, and the run changes `SPEC-04` to `risk-accepted`
- **THEN** a session alert decision has a `request.checkFailures` item that names `SPEC-04`

#### Scenario: Selected option with a free text does not match
- **WHEN** the answer of `D-0003` for the question whose `header` is `SPEC-04` has `risk accepted` selected and the free text `不接受，按修复处理`, and the run changes `SPEC-04` to `risk-accepted`
- **THEN** a session alert decision has a `request.checkFailures` item that names `SPEC-04`, and the alert card shows the free text

#### Scenario: Storyboard line above the placeholder sends an alert
- **WHEN** `storyboard.md` has the line `Storyboard Approved: ____`, and an apply run adds the line `Storyboard Approved: tigger` above it outside the code blocks
- **THEN** a session alert decision has a `request.checkFailures` item that names `storyboard.md`

#### Scenario: Second row with the same fingerprint sends an alert
- **WHEN** the `## 待环境补测` table of `evidence/slice-02.md` has a row with the `登记指纹` `git-tree:abc` and an empty `确认人`, and an apply run adds a row above it with the same `登记指纹` and the `确认人` `tigger`
- **THEN** a session alert decision has a `request.checkFailures` item that names `evidence/slice-02.md` and `git-tree:abc`

#### Scenario: Removed pending environment row sends an alert
- **WHEN** the `## 待环境补测` table of `evidence/slice-02.md` has a row with the `登记指纹` `git-tree:abc` and an empty `确认人`, and an apply run removes the row
- **THEN** a session alert decision has a `request.checkFailures` item that names `evidence/slice-02.md` and `git-tree:abc`

#### Scenario: Pending environment heading with extra spaces is still read
- **WHEN** the heading of the table in `evidence/slice-02.md` is `##  待环境补测`, and an apply run fills the `确认人` of a row with `tigger`
- **THEN** a session alert decision has a `request.checkFailures` item that names `evidence/slice-02.md`

#### Scenario: Removed environment declaration sends an alert
- **WHEN** Slice 02 of `tasks.md` has `Environment: MQ`, `evidence/slice-02.md` has a `## 待环境补测` row for its `Fingerprint` with an empty `确认人`, and an apply run removes the line `Environment: MQ`
- **THEN** a session alert decision has a `request.checkFailures` item that names `tasks.md` and Slice `02`

#### Scenario: Evidence recorded again without a registration sends an alert
- **WHEN** Slice 02 of `tasks.md` has `Environment: MQ`, `evidence/slice-02.md` has a `## 待环境补测` row for its `Fingerprint` with an empty `确认人`, and an apply run writes a new `Fingerprint` in `evidence/slice-02.md` without a row for it
- **THEN** a session alert decision has a `request.checkFailures` item that names `evidence/slice-02.md`

#### Scenario: Renamed slice heading sends an alert
- **WHEN** Slice 02 of `tasks.md` has `Environment: MQ`, `evidence/slice-02.md` has a `## 待环境补测` row for its `Fingerprint` with an empty `确认人`, and an apply run changes the heading `## Slice 02:` to `## 切片 02:`
- **THEN** a session alert decision has a `request.checkFailures` item that names `tasks.md` and Slice `02`

#### Scenario: First quality run writes the rules version
- **WHEN** `review/standards.md` and `review/spec-fidelity.md` do not exist before a quality run, and the run writes both with `Rules Version: 2`
- **THEN** no session alert decision names `Rules Version`

#### Scenario: Accepted row moved out in a later quality run passes
- **WHEN** the Findings row and the ledger row of `STD-02` are `risk-accepted` before a quality run that resumes no decision, and the run removes the Findings row and keeps the ledger row
- **THEN** no session alert decision is created for `STD-02`

#### Scenario: Open Major row removed from a report without a ledger sends an alert
- **WHEN** `review/standards.md` has no section `Finding 台账` and has a Findings row of `STD-06` with `Major` and `open` before an apply run, and the run removes the row
- **THEN** a session alert decision has a `request.checkFailures` item that names `STD-06`

#### Scenario: Slice that has not started passes
- **WHEN** Slice 03 of `tasks.md` has `Environment: MQ` and no checked task, and an apply run checks only tasks of Slice 01
- **THEN** no session alert decision names Slice `03`

#### Scenario: Unchecked task in a complete slice sends an alert
- **WHEN** Slice 02 of `tasks.md` has `Environment: MQ` and all its tasks checked, `evidence/slice-02.md` has a `## 待环境补测` row for its `Fingerprint` with an empty `确认人`, and an archive run changes `- [x] 2.3` to `- [ ] 2.3`
- **THEN** a session alert decision has a `request.checkFailures` item that names `tasks.md` and Slice `02`

#### Scenario: Check alert without a session id offers only the return to the session
- **WHEN** a quality run changes the ledger row and the Findings row of `STD-02` to `risk-accepted` without a matching question decision, and the `claude` test double prints a text that is not JSON
- **THEN** a session alert decision with only the option `回会话处理` has a `request.checkFailures` item that names `STD-02`

#### Scenario: Unreadable trace before the run does not start the run
- **WHEN** the gate script exits with code 1 when the scheduler runs `trace` before a quality run
- **THEN** the `claude` test double is not started, the decisions of the change are unchanged, and the `lark-cli` test double receives one notice card
- **AND** a second round with the same reason sends no second notice card

#### Scenario: Unreadable trace before a rerun keeps rerunStage
- **WHEN** the autopilot record has `rerunStage` `quality`, and the gate script exits with code 1 when the scheduler runs `trace` before the stage
- **THEN** the `claude` test double is not started, and the record still has `rerunStage` `quality`

#### Scenario: Unreadable trace after the run keeps the snapshot before the run
- **WHEN** a quality run changes the ledger row and the Findings row of the Blocker `STD-02` to `risk-accepted` without a matching question decision and writes `review/sonar.md` as a directory, so that `trace` after the run fails; the user removes the directory and answers the alert with `补充说明后继续`; and the resumed run changes no file
- **THEN** the first alert has `request.traceBefore`
- **AND** a new session alert decision has a `request.checkFailures` item that names `STD-02`

#### Scenario: Two unreadable traces keep the first start
- **WHEN** the resumed run of the scenario «Unreadable trace after the run keeps the snapshot before the run» writes `review/sonar.md` as a directory again, the user removes it and answers the second alert with `补充说明后继续`, and the run resumed after it changes no file
- **THEN** `request.traceBefore` of the second alert has the `findings` of `request.traceBefore` of the first alert
- **AND** a new session alert decision has a `request.checkFailures` item that names `STD-02`

#### Scenario: Answered question still matches after an unreadable trace
- **WHEN** the resumed decision `D-0003` answered `risk accepted` for `STD-05`, the resumed run changes the ledger row and the Findings row of `STD-05` to `risk-accepted` and writes `review/sonar.md` as a directory, the user removes it and answers the alert with `补充说明后继续`, and the run resumed after it changes no file
- **THEN** `request.traceBefore.resumedDecisionIds` of the alert contains `D-0003`
- **AND** no session alert decision names `STD-05` after that run

#### Scenario: Session that cannot be resumed still lists the check failures
- **WHEN** the alert of the scenario «Unreadable trace after the run keeps the snapshot before the run» is answered with `补充说明后继续`, and the `claude` test double prints `No conversation found` when it is resumed
- **THEN** a session alert decision with only the option `回会话处理` has a `request.checkFailures` item that names `STD-02`

#### Scenario: Same reason after a new handover sends the notice card again
- **WHEN** the scenario «Unreadable trace before the run does not start the run» has sent its notice card, the user runs `autopilot.mjs cancel` and starts the autopilot again, and `trace` before the next run fails with the same reason
- **THEN** the `lark-cli` test double receives a second notice card

#### Scenario: Start of another trace version is not compared
- **WHEN** the alert of the scenario «Unreadable trace after the run keeps the snapshot before the run» has `request.traceBefore.traceVersion` `0`, and the user answers it with `补充说明后继续`
- **THEN** the `claude` test double is not resumed and the saved snapshots are not compared
- **AND** only after the pending replacement reservation is persisted may the original alert become `used` and the replacement alert offer only `回会话处理`

#### Scenario: Trace output of another version fails the read
- **WHEN** the gate script prints a `traceVersion` of `2` after a quality run
- **THEN** a session alert decision has one `request.checkFailures` item that says the records cannot be read

#### Scenario: Gate without the trace command stops the round
- **WHEN** the gate script prints a usage text without `trace`
- **THEN** `scheduler.mjs --once` exits with code 2, does not start `claude`, and the notice card asks the user to sync `openspec-technical-review`

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

### Requirement: The scheduler SHALL persist and recover an unfinished trace check

The scheduler SHALL keep unfinished run checks in `pending-trace.json` in the autopilot home, separate from `rule-check.json.traceErrors`. The version 1 file SHALL contain `entries` keyed by JSON tuples of real project root, change name and `startedAt`, and MAY contain `cursor`. A stage entry SHALL contain the original directory and location class, actual stage, running-writer identity, comparison start `traceBefore` including `resumedDecisionIds`, and the consumed decision ID when present. A `version-handoff` entry SHALL use the same batch key and the fields in the version-handoff rule below. It SHALL use the comparison start selected by the trace check rule, without replacing it on read failure. After the run it SHALL save only the required session and deferred-question metadata, not output or complete session text.

Before starting or resuming a stage, after the trace read succeeds and before clearing `rerunStage` or writing the implementation snapshot, it SHALL persist the entry. It SHALL NOT overwrite an existing unfinished entry for the batch. Write failure SHALL stop the start or resume and leave the record and decisions unchanged. Only the scheduler holding `run.lock` SHALL mutate this file. Writes SHALL use a temporary file with mode `600` and atomic rename. A missing file SHALL mean no entries; an existing unreadable, malformed or unsupported-version file SHALL stop all stages and exit actions in the round, remain unchanged and cause a notice, not be treated as empty state.

At the start of each round, before normal candidate or decision handling and every exit path, the scheduler SHALL recover saved entries. It SHALL prove the previous process group has stopped for a stage entry under the run-lock requirement. It SHALL locate the same batch under the shared scan and check early archive before ordinary alerts and decision handling. A version handoff starts no writer and does not establish that another writer has stopped. Unfinished entries SHALL block every new stage and exit path of their own name. An invalid pending file SHALL stop the round; shared capacity exhaustion SHALL prevent another name from starting a stage that needs a new entry, but SHALL NOT bypass a pending check. Missing or invalid records and failed updates SHALL retain the original start without rebuilding the record or creating a decision.

The recovery branch SHALL measure a 120000 ms budget with a monotonic clock from before its first pending-file read. It SHALL reserve the last 1000 ms for at most one cursor replacement and start no other recovery operation in that interval. Every external wait SHALL use the smaller of its own timeout and the remaining recovery time before that interval. A timed-out external operation SHALL NOT delay recovery through a wait for process exit or cause a late state commit. An already-started local bounded-input step MAY finish; the scheduler SHALL check the clock after each step. It SHALL check candidate and decision lists in bounded steps, including one directory entry or one bounded file read at a time. An incomplete scan SHALL NOT prove unique ownership or absence. It SHALL restart that scan on the next visit and SHALL NOT reuse a previous proof of ownership. No fixed overrun is promised for exceptional local I/O. The scheduler SHALL process sorted keys after `cursor` with wraparound, even if the cursor key was deleted. It SHALL advance only after a safe attempt, including a bounded timeout that kept the original start and did not commit late results. It SHALL NOT advance past unvisited entries. Cursor write failure SHALL keep the previous cursor. After the budget, unrelated candidates MAY proceed; unvisited and unfinished names remain blocked.

To check for another open decision, the scheduler SHALL verify decision files one at a time and retain only necessary state and referenced decisions. Management counts SHALL also scan one at a time and direct handoff SHALL read only the stored ID file. An input file SHALL be bounded to 32 MiB on the same open file before parsing. Incomplete scans, invalid data and oversized files SHALL NOT count as absent. The scheduler SHALL apply the same per-file limit to new writes. When full check details cannot be stored safely, keep the original start and any already stored post-run snapshot and issue the bounded manual notice, not a pass. Historical files SHALL NOT be rewritten to fit; users may examine them in a session.

The scheduler SHALL limit each `traceBefore` and optional `traceAfter` to 4 MiB of canonical UTF-8 JSON, at most 32 entries, and the entire stored compact UTF-8 JSON file including its final LF to 64 MiB. It SHALL enforce these rules on each read and each proposed replacement, including updates, cursor and removal; reading SHALL be limited before parsing using the same opened file. An invalid file SHALL be kept and the round stopped. A candidate beyond the limits SHALL NOT replace the previous file; a refused new entry SHALL stop that start and report the limit. The management readers SHALL share validation.

Admission and updates SHALL charge 16 KiB for the global envelope, and 16 KiB per entry including key and separators, plus the actual embedded UTF-8 bytes of its snapshots. Keys and the cursor value SHALL each fit in 8 KiB of serialized JSON. Both reads and replacements SHALL verify each metadata envelope and the charged size; it SHALL NOT exceed 64 MiB. The reserved envelope SHALL cover mandatory identity, cursor, recovery and decision-reservation metadata; the scheduler SHALL check required identity at admission and discard oversized optional session data by recording the session as unavailable. If `traceAfter` cannot fit, it SHALL NOT create the normal question, SHALL retain `traceBefore`, and SHALL use the reserved space to persist a recovery handoff. It SHALL NOT remove other unfinished entries to fit a write.

Before writing a normal decision, the scheduler SHALL reserve its ID and kind, and for a question SHALL also save the accepted `traceAfter`. A normal question SHALL contain `request.pendingTraceKey` and `request.pendingTraceDigest` (`{ version: 1, algo: 'sha256', value }`); `value` is the lowercase SHA-256 hex of canonical compact UTF-8 JSON of `traceBefore`, with recursively code-point-sorted object keys and unchanged array order including `resumedDecisionIds`; string and number encoding follow JSON and numeric-looking object keys still follow code-point order. A question SHALL NOT contain the full start. A normal stage alert, a normal check alert, a recovery alert, and an early-archive alert SHALL retain `request.pendingTraceKey` and full `request.traceBefore`; a digest SHALL NOT substitute for that start. The reservation SHALL distinguish `question`, `stage-alert`, `check-alert`, `recovery-alert` and `early-archive-alert`. A check or recovery alert SHALL carry its `comparisonState`. If an alert has a continuation boundary it SHALL use a digest of that boundary in the reservation and verify it against the full value in the eligible decision. A stage alert describes a stage error or no progress, not a failed check. Early-archive alerts and alerts without a trusted session SHALL NOT permit continuation. A normal question SHALL transfer only when a fresh trace equals the saved `traceAfter`. If it has changed, the scheduler SHALL void that question before recovery using the original start. A failed read retains the entry. Transfer SHALL read the exact saved decision ID without reading historical contents, check the same batch, ID, kind, key, eligible status and type-specific fields, verify the digest for a question or the full start and any continuation boundary for an alert, and recheck identity before its card. The scheduler SHALL distinguish confirmed absence from read, parse, ownership and identity failures. Only confirmed absence permits the missing-file recovery path. Verification that the same recheck voided the original question permits the separate transition defined below.

For a saved version mismatch, while holding `run.lock` the scheduler SHALL verify the source batch, original alert ID, `answered` state and `补充说明后继续` choice under project protection. Before updating the source alert, it SHALL atomically admit one entry with `mode` `version-handoff`, the verified batch and directory, `sourceDecisionId`, one unique replacement `alertId`, and the complete original `traceBefore`. The entry SHALL use the same capacity, recovery-budget and same-name blocking rules. It SHALL preserve the old JSON value and any recorded `resumedDecisionIds` for evidence, without interpreting it as the current trace schema or adding a resumed ID. If the source evidence cannot be verified, the ID space is exhausted, capacity is insufficient or the reservation cannot be written, the scheduler SHALL retain the original answered alert and evidence and issue a deduplicated no-ID notice for manual handling. It SHALL run no stage and advance no exit for that batch. An existing entry for the same batch SHALL be recovered first.

The same transfer procedure SHALL run initially and after restart. It SHALL read only the two reserved IDs to verify the source and replacement. Under project protection, it SHALL set the verified source alert to `used` with a version reason and retain its request and answer. A source already verified in that terminal state for the same transfer SHALL be reused. It SHALL then write or verify the one replacement alert at the reserved ID, bound to the original batch, original start and return-to-session choice. It SHALL preserve the entry on a failed read, write or identity check and SHALL NOT allocate another ID or resume the conversation. A later version match SHALL NOT change a saved transfer. Only the same-batch handoff or the existing withdrawal rule below permits cleanup. The early-archive guard still applies.

When a normal decision cannot be continued, the scheduler SHALL recover against the saved start and SHALL NOT run `claude` or replay the old result. A trace failure SHALL retain the entry. A generic recovery alert SHALL retain failures, original and current paths, `request.traceBefore`, `resumedDecisionIds`, any deferred-question ID and `request.pendingTraceKey`. Only a trusted resumable session and matching trace version permit `补充说明后继续`; otherwise it SHALL offer only `回会话处理`. The early-archive requirement takes precedence and permits only `回会话处理`.

The scheduler SHALL finish the consumed decision by expected status before creating a recovery alert. For a version handoff, the durable replacement reservation precedes that status update. Another open decision SHALL block generic recovery and SHALL NOT be executed in its place; early-archive exit decisions follow the early-archive requirement. The entry SHALL hold only one reservation. Only a question verified as void specifically by the same recheck is eligible for the void transition. Its persisted void state takes precedence even if a fresh trace now matches; another void cause does not authorize handoff. After confirmed absence of the normal result file or that verified void, the scheduler SHALL atomically replace the normal reservation (including kind and `traceAfter`) with `alertId`, keeping the same start. After interruption it SHALL validate only the persisted reservation and SHALL NOT create a second decision. To allocate an ID it SHALL enumerate legal files `D-0001.json` through `D-9999.json` by name and accept no number after the maximum. A legal file name occupies its number even if its content is damaged. Preflight the availability of a new ID before stage start or resume and before any exit draft or retry that needs a new decision. No ID SHALL mean no run, draft or overwrite. A verified saved ID or approved exit action does not need new admission. If an approved exit fails without an available alert ID, retain its completed steps and failure, stop the exit sequence, and do not retry it automatically. In all no-ID paths retain any existing start and send a deduplicated notice without a decision ID directing the user to withdraw that batch and return to the session. The notice SHALL NOT count as a completed handoff.

The card send key SHALL be a stable digest of the verified real project root, change name, `startedAt` and decision ID. Sending again for the same reservation SHALL use the same key and the same content. A timeout or changed batch SHALL NOT record a `messageId` from the send. Serialized card content SHALL fit a local maximum of 24 KiB in UTF-8. An oversized check alert SHALL keep full local evidence and send a summary on the same decision: item count, batch, local evidence location, and only return to the session. A summary SHALL NOT authorize continuation. If the summary cannot be sent, keep the unresolved handoff, attempt a bounded no-ID notice, and retain a local diagnostic. In recovery the budget also applies to preparation and sending of cards and notices.

For a stage entry the scheduler SHALL first prove the previous writer stopped. It SHALL remove an entry only when one of the following holds: normal check and result handling with final record re-read completed; the same-batch alert was written, read back and checked before its card; or complete identity resolution proved withdrawal of this batch or supersession at its original directory. A failed removal SHALL preserve the entry and block the batch, checking the one stored reservation on retry without replaying the result. Removal SHALL NOT clear an early-archive marker. Before any normal exit the pending entry SHALL be removed and the separate early-archive guard SHALL pass.

#### Scenario: Pending trace is stored before a run
- **WHEN** a start or resume is about to clear `rerunStage` or write the implementation snapshot
- **THEN** its original comparison start and resumed decision IDs have already been written in the autopilot home with mode `600`
- **AND** failure of that write starts no process and changes no record or decision

#### Scenario: Failed version handoff reservation preserves the original alert
- **WHEN** an answered alert has a saved original start or selected continuation boundary of another version, and the scheduler cannot persist a replacement reservation
- **THEN** the original alert stays `answered` with its evidence intact, no replacement is created, and the scheduler issues a deduplicated no-ID manual notice
- **AND** neither the stage nor an exit action starts for that batch

#### Scenario: Interrupted version handoff keeps the same replacement
- **WHEN** the scheduler persists a version-handoff entry and stops either before marking the original alert `used` or afterwards before writing the replacement alert
- **THEN** the next process finishes the original alert and writes or verifies only the reserved replacement ID, with the complete original start and only `回会话处理`
- **AND** it does not run a stage or an exit action during the handoff and does not clear the entry before the required read-back and pre-send identity check

#### Scenario: Recovered record is checked before exit actions
- **WHEN** a run changed `STD-02` to `risk-accepted` without an answer, the record could not be read afterwards, and the original record becomes readable in the next scheduler process
- **THEN** that process compares with the saved start and creates a recovery alert naming `STD-02` before any new stage, exit draft, answered exit execution, retry or closing notice
- **AND** no autopilot record or decision was recreated during the failed read

#### Scenario: Repeated record failures keep the first snapshot
- **WHEN** the original record is unreadable for two rounds and the scheduler restarts between the rounds
- **THEN** the first `traceBefore` and every saved resumed decision ID remain unchanged, no stage or exit is run, and recovery uses that start

#### Scenario: Trace failure after record recovery keeps the original start
- **WHEN** a pending record becomes readable but `trace` still fails
- **THEN** the saved start remains unchanged, no run is started, and the scheduler retries the comparison before later stage or exit handling

#### Scenario: Recovery alert transfer is retried without duplicates
- **WHEN** the scheduler is interrupted after reserving `alertId` or writing its recovery alert and before clearing the pending entry
- **THEN** the next process reuses the same ID and start, creates no second open decision, and keeps the batch blocked until transfer is verified

#### Scenario: Normal result decision survives an interrupted cleanup
- **WHEN** a normal result has written a question or trace alert and the scheduler stops before removing its pending entry, or entry removal fails
- **THEN** the next process verifies the saved result decision ID, kind, pending key and original start, and completes the same transfer without a second decision or a new run
- **AND** a question is released only when a fresh trace equals the saved successful post-run trace; otherwise a failed read keeps it blocked, or a changed trace voids it before recovery from the original start

#### Scenario: Cleanup failure before exit does not draft an exit
- **WHEN** a normal run passes its trace check but its completed entry cannot be removed
- **THEN** no exit draft, answered exit execution, retry or closing notice is processed while that entry remains unfinished

#### Scenario: Corrupt pending file is not treated as empty
- **WHEN** `pending-trace.json` exists but cannot be read, is malformed or has an unsupported version
- **THEN** no stage, exit draft or exit execution runs, the file is kept, and a notice reports the reason

#### Scenario: Recovery without a resumable session offers only return
- **WHEN** a pending check has no trusted session ID, an unresumable session, or a start from another trace version
- **THEN** its recovery alert has only `回会话处理`, and does not resume `claude` or draft an exit

#### Scenario: Unchanged records after read recovery still require handover
- **WHEN** the same batch becomes readable and its trace equals the saved start
- **THEN** one recovery alert explains that the run result was not handled and no old result is automatically replayed

#### Scenario: Notice deduplication does not remove unfinished checks
- **WHEN** environment checks clear notification reasons or a second run check writes `rule-check.json`
- **THEN** the entries of `pending-trace.json` are unchanged

#### Scenario: Recovery budget rotates to healthy candidates
- **WHEN** several pending entries of different names each exhaust the trace timeout and a healthy ready candidate of another name exists
- **THEN** the round stops recovery after the budget, handles the healthy candidate, and keeps every unvisited entry blocking its own name with its original start
- **AND** the next round continues after the saved cursor, and the cursor survives a scheduler restart

#### Scenario: Question transfer verifies the digest
- **WHEN** a normal question decision is written with `request.pendingTraceDigest` and the scheduler stops before removing its entry
- **THEN** the next process recomputes the digest from the entry's `traceBefore`, completes the same transfer when it matches, and keeps the entry blocked with a notice when it differs
- **AND** the decision file contains no full copy of the start

#### Scenario: Capacity limit blocks a new start
- **WHEN** saving a new pending entry would exceed the entry-count or size limit
- **THEN** the stage of that name does not start, a notice names the limit, and existing entries are unchanged
- **AND** a pending file beyond the whole-file limit stops the round like invalid content

#### Scenario: A timed-out safe attempt still advances the cursor
- **WHEN** a bounded wait exhausts recovery time after the current entry was safely attempted and its original start was kept
- **THEN** the scheduler may make just the reserved cursor replacement and the next round starts after that entry
- **AND** if the replacement fails it retains the old cursor

#### Scenario: A large or incomplete history is not an empty list
- **WHEN** the decision scan cannot finish within the budget or encounters a file beyond its read limit
- **THEN** the original entry remains, no affected decision transfers, and a completed scan in another batch can still be handled within budget

#### Scenario: A smaller card keeps full local check details
- **WHEN** an alert with local evidence would exceed 24 KiB or its summary is not deliverable
- **THEN** keep the same ID and original details, send at most the bounded summary with return to the session, or attempt only a bounded manual notice
- **AND** blocked actions do not advance because of an undelivered card

#### Scenario: Send keys distinguish same-name batches
- **WHEN** two verified batches share a change name and decision ID, and the first batch's send is retried
- **THEN** the two batches use distinct external keys and the retry reuses the first key
- **AND** a late response does not modify the batch record or decision

#### Scenario: A normal stage alert may finish handoff after restart
- **WHEN** a stage error or no-progress alert has been written and the scheduler stops before removing the pending entry
- **THEN** the next process verifies its saved type, fields and status and transfers the same alert without replaying the stage
- **AND** a missing session ID permits only return to the session

#### Scenario: An admitted entry can reserve recovery at the volume boundary
- **WHEN** admitted entries leave no space for a question `traceAfter`, but their charged size is within 64 MiB
- **THEN** the old file remains readable, no question is created, and the scheduler can persist its cursor and the recovery reservation using reserved bytes without deleting another start

#### Scenario: A missing normal result transfers to a single recovery reservation
- **WHEN** a normal decision ID was reserved but the file is absent, and the next process is interrupted after its recovery alert is saved
- **THEN** the original start is unchanged and the next process verifies only the same stored `alertId`, never the replaced normal reservation

#### Scenario: A normal check alert retains the original start
- **WHEN** handoff of a normal check alert is retried and the pending entry is then removed
- **THEN** the alert retains the original `request.traceBefore` for evidence
- **AND** permitted continuation of an `unread` alert uses that start while that of a `listed` alert uses its verified `comparisonBoundary`

#### Scenario: Verified void takes precedence over a restored snapshot
- **WHEN** the old question was voided by rechecking and the process stopped before replacing its reservation, and the current snapshot matches again
- **THEN** recovery switches to the one alert reservation and does not transfer the void question

#### Scenario: External waits use only remaining recovery time
- **WHEN** a recovered entry has less time left than a trace or notification timeout
- **THEN** the scheduler caps the wait by the time left, does not commit a late result, and keeps unvisited entries blocked when other candidates proceed

### Requirement: The autopilot SHALL locate the managed batch for status and cancel

`start`, `cancel` and `status` SHALL first select the configured project whose real checkout is the Git root of the working directory, when present. Without such a match they SHALL scan configured projects and accept only one verified candidate that qualifies for the command. Unreadable or ambiguous matches SHALL return nonzero with candidate paths but no untrusted content. Configuration order SHALL NOT select a project. A verified same-name lock in another project SHALL NOT be attributed to the selected project. `cancel` and `status` SHALL share the candidate enumeration and record-identity reader of the scheduler. Without a batch identity from a run, they SHALL choose the unique `active` or `exiting` batch of the project and name, ignoring recordless directories and old `void` batches. Several unfinished batches or an unreadable or invalid candidate SHALL cause a nonzero exit with the paths, without changing records. When there is no unfinished batch, only a unique readable `void` batch SHALL support the existing repeated-cancel and status behavior. `status` SHALL print the selected directory, `startedAt`, decisions, running-stage status and any unfinished comparison summary; an unreadable record SHALL NOT be reported as no autopilot or a successful cancellation.

`cancel` SHALL use the selected batch identity and the write and wait rules of spec `autopilot-entry`. It SHALL NOT delete a pending trace entry. `start` SHALL prefer the new active directory; it SHALL reject a same-name pending check, an invalid pending file or another unfinished batch even after its check was transferred. It SHALL also verify return-to-session handoffs for the same name, including those in archives, as specified by `autopilot-entry`. Other terminal `void` or `closed` archives SHALL NOT block a valid new batch. Final start admission and write, both cancel write sections, and scheduler and bridge batch writes SHALL use the same short per-project exclusion to keep ownership and `startedAt` stable through write. They SHALL NOT hold it while waiting for the running stage or an external service. The owner SHALL be verifiable by process instance. Waiting for this protection SHALL be bounded; unknown ownership SHALL NOT be treated as stale. If both locks are needed the scheduler SHALL take the run lock first. Failed ownership or identity validation SHALL NOT write to the selected path.

#### Scenario: Same-name projects are not selected by configuration order
- **WHEN** two projects have a qualifying record with the same name
- **THEN** a call within one configured checkout addresses only that checkout
- **AND** a call without that context cannot select a project unless a full scan confirms a unique candidate

#### Scenario: Status finds the archive behind an empty active directory
- **WHEN** the unique unfinished batch is in an archive, an active directory of the same name contains only `notes.md`, and old archives contain `void` batches
- **THEN** `status` reports the actual archive path, its `startedAt`, decisions and running-stage status

#### Scenario: Cancel follows the selected batch into the archive
- **WHEN** cancel selected a batch, the running stage moves it into an archive during the lock wait, and a new active batch with another `startedAt` appears at the original path
- **THEN** cancel rechecks and voids the selected archive record and its open decisions, leaving the new batch unchanged

#### Scenario: Multiple managed batches are not selected by date
- **WHEN** two candidate records of the name have status `active` or `exiting`
- **THEN** `status` and `cancel` return a nonzero exit listing both paths, and cancel changes no record

#### Scenario: New active change is not replaced by an old archive
- **WHEN** a new active change and an old `void` archive share a name and there is no pending check
- **THEN** start uses the active change, not the archive

#### Scenario: Unfinished trace blocks a new handover of the same name
- **WHEN** a pending check exists for the project and name
- **THEN** start refuses to create a new batch until the old check is transferred or its cancellation is proved

#### Scenario: Transferred alert does not allow a second batch of the same name
- **WHEN** an archive batch of the name is still `active` with a pending alert, its pending-trace entry has been transferred and removed, and a new active change of the same name exists
- **THEN** `start` exits with code 1, lists the archive directory and its `startedAt`, and writes no new record
- **AND** an old `void` archive of the name does not block the same start when no unfinished batch remains

### Requirement: The scheduler SHALL block exit when a run archives the change outside the archive stage

The scheduler SHALL store the actual stage and before-run location class. When the same batch moved from active to archived in a stage other than `archive`, the scheduler SHALL persist `exitBlock` with reason `early-archive` and its stage in the batch record before issuing a decision. Normal handling and restart recovery SHALL share this guard and it SHALL take precedence over ordinary results and existing exit decisions. The marker SHALL survive handoff and pending-entry removal. The scheduler SHALL refuse exit drafts, existing exit execution, retries and exit completion notices, and SHALL void existing open exit decisions by expected status. Failed marker write, identity recheck or void SHALL NOT permit exit; the original start SHALL remain pending until handoff is verified. The scheduler SHALL offer only `回会话处理`, naming the actual stage, quality or verify without evidence of completion, and known check failures. It SHALL NOT replay the result. The block ends only when the original batch is proved `void` after withdrawal or return-to-session handling; the old batch SHALL NOT continue exit. Normal `archive` and resume of an already-archived batch without this marker keep their existing behavior.

#### Scenario: Self-archive in apply blocks the exit
- **WHEN** an apply run moves the change into its archive directory and the trace check has no failure
- **THEN** no exit action is drafted, and a session alert with only `回会话处理` names the apply stage and the missing quality and verify stages
- **AND** the autopilot record is kept

#### Scenario: Archive stage archive keeps the exit path
- **WHEN** an archive run moves the change into its archive directory
- **THEN** the existing exit handling runs unchanged

#### Scenario: Early archive remains blocked after recovery and handoff
- **WHEN** an early archive is recognized only after restart, or its handoff is done while a prior exit decision exists
- **THEN** the batch remains blocked across subsequent rounds and entry cleanup, only return-to-session handling is offered, and no exit draft, execution, retry or exit completion notice runs
