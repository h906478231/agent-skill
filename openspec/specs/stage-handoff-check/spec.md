# stage-handoff-check Specification

## Purpose
阶段交接检查：用确定性测试检查各阶段的输入与产出能接上，命令、skill 与规则文件没有孤立项。检查由 `npm test` 运行，不启动 agent。
## Requirements
### Requirement: phases.md 的阶段表写明每个阶段的产出

`skills/openspec-technical-review/shared/phases.md`「各阶段的输入与新会话」表 SHALL 有 4 列：阶段、读取的输入、产出、能否在新会话中开始。

- 输入与产出中的文件与目录 SHALL 写成行内代码，例如 `verification.md`、`evidence/`。
- 只在部分情况下读取的输入，SHALL 在行内代码的后面用括号写出条件，例如 `review-summary.md`（启用技术评审时）。
- 不是行内代码的文字是说明，阶段交接检查不读取。

#### Scenario: 表格缺少产出列

- **WHEN** 「各阶段的输入与新会话」表没有「产出」列
- **THEN** `npm run test:handoff` 失败，输出 `phases.md` 与缺少的列名

### Requirement: 每个输入文件都有上游产出

`scripts/lib/stage-handoff.mjs` SHALL 定义 4 条分支，每条分支是以 archive 结束的阶段顺序：

| 分支 | 阶段顺序 |
|---|---|
| 标准 | propose → review → apply → quality → verify → archive |
| 评审回路 | propose → review → update → review → apply → quality → verify → archive |
| L0 豁免 | propose → apply → verify → archive |
| MVP 跳过评审 | propose → apply → quality → verify → archive |

阶段交接检查 SHALL 按以下规则检查阶段表：

- 没有条件的输入：每条包含该阶段的分支都要检查。该阶段之前的某个阶段 MUST 产出该文件，或者该文件是项目资产（`CONTEXT.md`、`docs/adr/`）。
- 写有条件的输入：阶段表中 MUST 有一个阶段产出该文件。
- 分支中的每个阶段 MUST 在阶段表中有一行。
- 阶段表中的每个阶段 MUST 出现在至少一条分支中，或者属于按需阶段（grill、explore、overview）。

检查失败时 SHALL 输出分支、阶段与文件。

#### Scenario: verify 不再产出 verification.md

- **WHEN** 阶段表中 verify 的「产出」不再包含 `verification.md`
- **THEN** `npm run test:handoff` 失败
- **AND** 输出指出「标准」分支中 archive 的输入 `verification.md` 没有上游产出

#### Scenario: 条件输入在 L0 豁免分支中不要求产出

- **WHEN** apply 的输入写有 `review-summary.md`（启用技术评审时）
- **THEN** 「L0 豁免」分支通过检查，尽管该分支没有 review

#### Scenario: 新增阶段没有归入分支

- **WHEN** 阶段表新增一行阶段 `sonar`，4 条分支与按需阶段都不包含它
- **THEN** `npm run test:handoff` 失败，输出 `sonar`

#### Scenario: 本仓库当前的阶段表通过检查

- **WHEN** 在本仓库运行 `npm run test:handoff`
- **THEN** 4 条分支的交接检查与规则文本对账全部通过

### Requirement: 阶段表与阶段 skill 的规则文本对账

阶段交接检查 SHALL 核对阶段表每一行的行内代码文件名，出现在该阶段 skill 的规则文本中。

- 阶段对应的 skill 按「命令-Skill 对照表」查找：阶段名 `X` 对应 `/opsx:X`。`propose / ff` 逐个查找，对照表写「无（上游命令）」的命令跳过。
- 规则文本是 `skills/<skill>/` 下的 `.md` 与 `.mjs` 文件，`vendor/` 目录与阶段表事实源 `skills/openspec-technical-review/shared/phases.md` 除外。

匹配规则：

- 文件：行内代码中的完整写法（如 `review/standards.md`），前后不能紧接字母、数字或 `-`。
- 目录：最后一级目录名加 `/`（`openspec/changes/archive/` 取 `archive/`），前面不能紧接字母、数字或 `-`。
- `proposal.md`、`design.md`、`specs/`、`tasks.md`：按 artifact id `proposal`、`design`、`specs`、`tasks` 匹配，前后不能紧接字母、数字或 `-`。

没有出现时 SHALL 失败，输出阶段、skill 与文件名。

#### Scenario: verify 的规则文本不再出现 verification.md

- **WHEN** `skills/openspec-verify-change/` 下的规则文本把 `verification.md` 全部改为 `verify-report.md`，阶段表没有修改
- **THEN** `npm run test:handoff` 失败
- **AND** 输出 `verify`、`openspec-verify-change` 与 `verification.md`

#### Scenario: schema 产物按 artifact id 匹配

- **WHEN** `openspec-propose` 的规则文本只写 artifact id `specs`，没有写 `specs/`
- **THEN** propose 一行的 `specs/` 对账通过

#### Scenario: 只有 vendor 目录出现文件名

- **WHEN** 某个文件名只出现在 `skills/<skill>/vendor/` 下的文件中
- **THEN** 该文件名判为没有出现在规则文本中，检查失败

#### Scenario: 阶段表本身不计入规则文本

- **WHEN** `openspec-technical-review` 的文件中，只有 `shared/phases.md` 出现 `review-summary.md`
- **THEN** review 一行的对账失败，输出 `review`、`openspec-technical-review` 与 `review-summary.md`

#### Scenario: 上游命令跳过对账

- **WHEN** 阶段表有 `propose / ff` 一行，对照表中 `/opsx:ff` 的 skill 写为「无（上游命令）」
- **THEN** 该行只核对 `openspec-propose` 的规则文本，不因 `/opsx:ff` 失败

### Requirement: 每个命令都有对应的 skill

阶段交接检查 SHALL 读取 `workflow/OpenSpec-AI-研发流程.md`「命令-Skill 对照表」，检查以下 2 项：

- `claude/commands/opsx/` 下的每个命令文件在对照表中有一行。
- 对照表中每一行的命令文件存在。该行的 skill 写为「无（上游命令）」以外的值时，`skills/<skill>/SKILL.md` 存在。

#### Scenario: 新增命令没有写入对照表

- **WHEN** 新增 `claude/commands/opsx/sonar.md`，对照表没有 `/opsx:sonar` 一行
- **THEN** `npm run test:handoff` 失败，输出 `sonar.md`

#### Scenario: 对照表写了不存在的 skill

- **WHEN** 对照表中 `/opsx:verify` 一行的 skill 写为 `openspec-verify`
- **THEN** `npm run test:handoff` 失败，输出 `openspec-verify`

### Requirement: shared 规则文件没有孤立文件

对 `skills/*/shared/` 下的每个 `.md` 文件，`skills/` 或 `claude/commands/` 下 SHALL 至少有另一个文件引用它。

- 引用方是 `.md`、`.js`、`.mjs` 文件，`vendor/` 目录除外。
- 引用按文件名匹配，文件名前后不能紧接字母、数字或 `-`。

#### Scenario: 新增的 shared 文件没有被引用

- **WHEN** 新增 `skills/openspec-apply-change/shared/foo.md`，没有任何文件引用 `foo.md`
- **THEN** `npm run test:handoff` 失败，输出该文件路径

#### Scenario: 文件名是另一个文件名的后缀

- **WHEN** 其他文件只引用了 `apply-gate-check.md`，没有引用 `gate-check.md`
- **THEN** `skills/openspec-ste/shared/gate-check.md` 判为孤立文件

### Requirement: 阶段交接检查是确定性测试

`scripts/test-stage-handoff.mjs` SHALL 通过 `npm run test:handoff` 运行，并且是 `npm test` 的一部分。它 MUST NOT 访问网络、启动子进程或调用 Claude Code。在本仓库中运行时，耗时 SHALL 不超过 1 秒。

#### Scenario: 作为 npm test 的一部分运行

- **WHEN** 用户运行 `npm test`
- **THEN** 阶段交接检查与其他静态测试一起运行
- **AND** 阶段交接检查失败时，`npm test` 退出码不为 `0`
