# artifact-git-boundary Specification

## Purpose
变更产物的 git 边界：agent 读取的命令与 skill 中，变更目录产物的去向说明不要求 agent 执行 git 操作，并由一致性测试检查。
## Requirements
### Requirement: Agent-read artifact statements SHALL carry the git boundary sentence

Every agent-read file under `claude/commands/opsx/` and `skills/` that states how change-directory artifacts are kept SHALL describe archiving with `openspec archive`. Each such statement SHALL contain the git boundary sentence `不执行 \`git add\` 或 \`git commit\`。项目 \`.gitignore\` 忽略 \`openspec/\` 时，不得用 \`git add -f\` 加入产物。是否提交由用户决定。` These files SHALL NOT tell the agent to commit change-directory artifacts. The listed files are the five command files `review.md`, `quality.md`, `overview.md`, `explain.md`, `video.md`, and the five skill files `openspec-code-quality/SKILL.md`, `openspec-code-quality/shared/dual-axis-review.md`, `openspec-apply-change/shared/slice-evidence.md`, `openspec-discussion-sync/SKILL.md`, `openspec-change-overview/SKILL.md`.

#### Scenario: Review command states archive and boundary
- **WHEN** an agent reads the artifact section of `claude/commands/opsx/review.md`
- **THEN** the section says the artifacts are archived with `openspec archive`
- **AND** the section contains the git boundary sentence
- **AND** the section does not contain `提交 git`

#### Scenario: Project ignores openspec
- **WHEN** the project `.gitignore` ignores `openspec/` and the agent finishes `/opsx:review`
- **THEN** the agent does not run `git add` or `git add -f` on `review-summary.md` or `review/*.md`
- **AND** `git status` shows no staged file under `openspec/changes/<name>/`

#### Scenario: User asks to commit
- **WHEN** the user explicitly asks the agent to commit the review artifacts
- **THEN** the agent follows the request of the user

### Requirement: Project-level asset statements SHALL keep their commit wording

Statements about project-level assets (`CONTEXT.md` and `docs/adr/`) SHALL keep their commit wording, because these assets live outside `openspec/` and are not archived with a change. Each such line SHALL contain `项目级资产`.

#### Scenario: Grill asset line is unchanged
- **WHEN** `skills/openspec-grill/SKILL.md` states that `CONTEXT.md` and `docs/adr/` are committed to git
- **THEN** the line contains `项目级资产`
- **AND** the line is not changed by this capability

### Requirement: Process documents SHALL state that the agent does not commit artifacts

The git lifecycle section of `workflow/OpenSpec-AI-研发流程.md` and Q6 of `workflow/quickstart-guide.md` SHALL keep the commit policy for gate artifacts. Each SHALL also contain the git boundary sentence, so that the decision of the project `.gitignore` takes precedence over the policy.

#### Scenario: Lifecycle section keeps policy and adds boundary
- **WHEN** a person reads the section 「门禁产物的git归属与生命周期」 of `workflow/OpenSpec-AI-研发流程.md`
- **THEN** the table still marks `review-summary.md` and `review/<role>.md` as committed
- **AND** the section contains the git boundary sentence

### Requirement: The consistency test SHALL detect drift of the git boundary

`scripts/test-doc-consistency.mjs` SHALL fail when a listed file does not contain the git boundary sentence. The test SHALL also scan `.md`, `.mjs` and `.js` files under `claude/commands/` and `skills/`, and SHALL fail on each line that matches `提交 ?git` and does not contain `项目级资产`. Each failure message SHALL name the file, and the scan failure SHALL also name the line number.

#### Scenario: New command reintroduces commit wording
- **WHEN** a new file `claude/commands/opsx/foo.md` contains the line `产物提交 git，随 openspec archive 归档。`
- **THEN** `npm run test:consistency` fails
- **AND** the message names `claude/commands/opsx/foo.md` and the line number

#### Scenario: Listed file loses the boundary sentence
- **WHEN** the git boundary sentence is removed from `claude/commands/opsx/quality.md`
- **THEN** `npm run test:consistency` fails
- **AND** the message names `claude/commands/opsx/quality.md`

#### Scenario: Project-level asset lines pass
- **WHEN** the scan reads `skills/openspec-grill/shared/context-format.md` line 3
- **THEN** the line contains `项目级资产` and the test does not fail on it

### Requirement: The git boundary test SHALL cover the artifact rules of the apply skill

`skills/openspec-apply-change/shared/post-implementation-changes.md` states where the `## 实现后修改登记` table is kept. `skills/openspec-apply-change/shared/deployment-document.md` states where `deployment.md` is kept. Each of the two files SHALL contain the git boundary sentence in its section `产物的 git 边界`. `scripts/test-doc-consistency.mjs` SHALL include both files in the list of files that the git boundary test checks.

#### Scenario: Ledger rule file loses the boundary sentence
- **WHEN** the git boundary sentence is removed from `skills/openspec-apply-change/shared/post-implementation-changes.md`
- **THEN** `npm run test:consistency` fails
- **AND** the message names `skills/openspec-apply-change/shared/post-implementation-changes.md`

#### Scenario: Deployment rule file loses the boundary sentence
- **WHEN** the git boundary sentence is removed from `skills/openspec-apply-change/shared/deployment-document.md`
- **THEN** `npm run test:consistency` fails
- **AND** the message names `skills/openspec-apply-change/shared/deployment-document.md`
