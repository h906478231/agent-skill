# ste-reply-guard Specification

## Purpose
对话回复检查：对 AI 对话回复执行禁用别名检查；Claude Code 用 Stop hook 阻断，其他 agent 用共享规则约束。
## Requirements
### Requirement: Claude Code replies SHALL be blocked when they contain forbidden aliases

The skill SHALL provide a Stop hook command for Claude Code. The command SHALL read the hook event from stdin, read the assistant text after the last user message from the transcript, add the `last_assistant_message` field of the event when it is present and not yet in the transcript, and check the result against the forbidden aliases of `$CLAUDE_PROJECT_DIR/CONTEXT.md`. When a forbidden alias is found, the command SHALL output a block decision whose reason lists each alias and its replacement.

#### Scenario: Reply with a forbidden alias
- **WHEN** the last assistant message contains `退单` and CONTEXT.md lists `退单` as an alias of `取消`
- **THEN** the hook outputs a block decision with the reason "退单 → 取消"

#### Scenario: Reply without findings
- **WHEN** the last assistant message contains no forbidden alias
- **THEN** the hook exits with code 0 and outputs no block decision

### Requirement: The reply guard SHALL retry at most once

When the hook event has `stop_hook_active` set to true, the command SHALL NOT block again. It SHALL allow the stop so that a reply is never blocked in a loop.

#### Scenario: Second stop after a forced rewrite
- **WHEN** the rewritten reply still contains a forbidden alias and `stop_hook_active` is true
- **THEN** the hook allows the stop

### Requirement: Reply checks SHALL only block on forbidden aliases

For replies, the command SHALL treat non-approved general words and vague words as warnings that do not block. It SHALL NOT check sentence length or heuristic rules. It SHALL skip fenced code blocks, inline code, markdown blockquotes, URLs, file paths and identifiers, with the same file-path and identifier rules as the artifact check, so that quoted user text and code do not cause a block.

#### Scenario: Vague word in a reply
- **WHEN** the last assistant message contains `适当` and no forbidden alias
- **THEN** the hook does not block

#### Scenario: User text quoted in a blockquote
- **WHEN** the reply quotes the user with a markdown blockquote that contains `退单`
- **THEN** the hook does not report `退单`

### Requirement: Reply guard SHALL degrade explicitly

When the project has no CONTEXT.md, or the transcript cannot be read, the command SHALL allow the stop and SHALL NOT fail the session.

#### Scenario: Transcript missing
- **WHEN** the transcript path in the hook event does not exist
- **THEN** the hook exits with code 0 and outputs no block decision

### Requirement: The hook SHALL be enabled manually

The skill SHALL document the `settings.json` snippet that registers the Stop hook and SHALL NOT modify any `settings.json` file automatically.

#### Scenario: Installing the skill
- **WHEN** a user installs `openspec-ste`
- **THEN** no `settings.json` file changes, and the SKILL.md shows the snippet to add

### Requirement: Other agents SHALL be constrained by shared reply rules

The skill SHALL provide a shared reply-rules file that states the STE rules for replies. The skill SHALL document one line for `CLAUDE.md` or `AGENTS.md` that references this file. The documentation SHALL state that agents other than Claude Code have no reply blocking, and that artifact checks remain the fallback.

#### Scenario: Codex project
- **WHEN** a project uses Codex CLI with the reply-rules line in `AGENTS.md`
- **THEN** the documentation states that replies are constrained by rules only and artifacts are still blocked by the STE check
