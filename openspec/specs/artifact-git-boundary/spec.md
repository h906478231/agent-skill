# artifact-git-boundary Specification

## Purpose
变更产物的 git 边界：agent 读取的命令与 skill 中，变更目录产物的去向说明不要求 agent 执行 git 操作，并由一致性测试检查。
## Requirements
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
