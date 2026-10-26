# eval-case-routing Specification

## Purpose
评测用例路由：按评测用例的 `stage` 与 `covers` 选择要运行的评测用例，列出没有评测用例覆盖的修改。
## Requirements
### Requirement: 按评测用例的 stage 选择评测用例

`evals/test-skill.sh` SHALL 按每个评测用例 `case.yaml` 的 `stage` 取默认覆盖范围，用默认覆盖范围与 `covers` 匹配本次修改的文件。`test-skill.sh` SHALL 运行匹配到任一文件的评测用例。

- 默认覆盖范围写在 `evals/lib/routing.mjs` 的常量中，按 `stage` 列出 glob 与排除项。
- 评测用例列表读 `<评测数据目录>/cases/`。评测数据目录与 `run.mjs` 相同：`WORKFLOW_EVAL_ROOT`，没有设置时为 `evals/`。
- 公共规则 `skills/openspec-ste/**` 与 `skills/openspec-change-overview/**` 匹配默认覆盖表中全部 stage 的评测用例。
- `test-skill.sh` MUST NOT 按评测用例名写路由。新增评测用例时，不修改 `test-skill.sh`。
- `--all` 的行为不变：选中全部评测用例。

#### Scenario: 修改 update skill 时选中全部 update 评测用例

- **WHEN** 本次修改了 `skills/openspec-update-change/SKILL.md`
- **THEN** 路由选中 `stage` 为 `update` 的 3 个评测用例
- **AND** 该文件不出现在「没有评测用例覆盖」的列表中

#### Scenario: 修改 review skill 时选中全部 review 评测用例

- **WHEN** 本次修改了 `skills/openspec-technical-review/shared/gate-policy.md`
- **THEN** 路由选中 `stage` 为 `review` 的 4 个评测用例

#### Scenario: 修改 apply 前的签字检查规则只选中 apply 评测用例

- **WHEN** 本次只修改了 `skills/openspec-technical-review/shared/apply-gate-check.md`
- **THEN** 只选中 `stage` 为 `apply` 的评测用例
- **AND** 不选中 `stage` 为 `review` 的评测用例

#### Scenario: 新增评测用例自动参与路由

- **WHEN** 用户新增一个 `stage: overview` 的评测用例，没有修改 `test-skill.sh`
- **THEN** 修改 `skills/openspec-change-overview/SKILL.md` 时，路由选中该评测用例

### Requirement: stage 没有默认覆盖的评测用例只按 covers 选中

评测用例的 `stage` 不在默认覆盖表中时，`routing.mjs` MUST NOT 抛错。该评测用例 SHALL 写入 `routing.json` 的 `unrouted`，终端与 `report.md` SHALL 列出它。

- 这类评测用例只按 `covers` 或 `--all` 选中，公共规则不选中它。
- `chain`（`eval-harness-v2` 的链式用例）不设默认覆盖。原因是链式用例一次约 8–15 美元，是否运行由用户决定。

#### Scenario: 链式用例没有写 covers

- **WHEN** 一个 `stage: chain` 的评测用例没有写 `covers`，本次修改了 `skills/openspec-update-change/SKILL.md`
- **THEN** 路由不选中该评测用例，`routing.json` 的 `unrouted` 包含它
- **AND** `routing.mjs` 没有抛错，路由仍选中 3 个 update 评测用例

### Requirement: 修改清单不经过 shell 拆分

`routing.mjs` SHALL 用参数数组调用以下两条 git 命令，按 NUL 分隔得到修改的文件：

- `git -c core.quotePath=false diff --name-only -z HEAD -- skills claude/commands/opsx`
- `git -c core.quotePath=false ls-files -z --others --exclude-standard -- skills claude/commands/opsx`

约束：

- 环境变量 `WORKFLOW_EVAL_CHANGED`（按行分隔）只作为测试与人工验收的替代输入。生效条件见 spec `test-run-record`「测试用环境变量只在临时评测数据目录下生效」。
- 只有命令行入口读取 `WORKFLOW_EVAL_CHANGED`，以参数传给 `routing.mjs` 的公开函数。公开函数 MUST NOT 读取 `process.env`。
- `test-skill.sh` MUST NOT 自己拆分文件名。shell 中的路径变量 SHALL 加双引号。

#### Scenario: 中文与空格文件名

- **WHEN** 本次在临时 git 仓库中新增了未跟踪的 `skills/openspec-ste/shared/规则 说明.md`
- **THEN** `routing.json` 的 `changed` 包含该路径，与磁盘上的文件名相同
- **AND** 路由按公共规则选中评测用例，该文件不出现在「没有评测用例覆盖」的列表中

### Requirement: 实际运行的评测用例与选中的评测用例相同

`routing.mjs` SHALL 导出 `toGlobs`，把选中集合转换为 `--case` 通配：

- 选中集合等于全部评测用例时，返回 `["*"]`。
- 否则按 stage 把选中集合分组。组内评测用例名的公共前缀加 `*` 只匹配该组选中的评测用例时，用该通配；否则逐个写评测用例名。
- 通配按 stage 名排序。
- 通配由 node 按 NUL 分隔交给 `test-skill.sh`，`test-skill.sh` 读取时变量 SHALL 加双引号。

`routing.json` SHALL 写入 `selected`（评测用例与选中依据）、`globs`，以及 `executed`（各通配匹配到的评测用例的并集）。

- `executed` 与 `selected` 不同时，第 5 步 SHALL 以退出码 `2` 结束，不运行评测。
- 第 5 步显示运行计划之前，SHALL 对 `executed` 中的全部评测用例运行 `validateCase` 与 `checkSnapshot`。任一失败时以退出码 `2` 结束，输出评测用例名，不运行任何分组。
- 第 6 步 SHALL 对每个通配调用一次 `node evals/run.mjs --case '<通配>'`，传过 `--model` 时一并带上。
- 某个分组的退出码为 `2` 时，`test-skill.sh` SHALL 停止后续分组。
- 总退出码取各分组退出码的最大值。

#### Scenario: 跨 stage 时只运行选中的评测用例

- **WHEN** 本次修改了 `skills/openspec-apply-change/SKILL.md` 与 `skills/openspec-update-change/SKILL.md`
- **THEN** 路由选中 1 个 apply 评测用例与 3 个 update 评测用例
- **AND** 假 Claude 进程只被这 4 个评测用例调用，其他评测用例没有运行

#### Scenario: 阶段快照不合法时不运行任何分组

- **WHEN** 选中两个分组，第 2 个分组中一个评测用例的阶段快照不合法
- **THEN** 第 5 步以退出码 `2` 结束，输出该评测用例名
- **AND** 没有运行任何分组，假 Claude 进程启动 0 次

#### Scenario: 某个分组环境错误时停止后续分组

- **WHEN** 第 1 个分组的 `run.mjs` 以退出码 `2` 结束
- **THEN** 后续分组没有运行，`test-skill.sh` 以退出码 `2` 结束
- **AND** 终端为后续分组输出补跑命令 `node evals/run.mjs --case '<通配>'`，测试运行记录把后续分组标为「未执行」

#### Scenario: 选中全部评测用例时只运行一次

- **WHEN** 本次修改了公共规则 `skills/openspec-ste/shared/gate-check.md`
- **THEN** `routing.json` 的 `globs` 为 `["*"]`
- **AND** 第 6 步只调用一次 `run.mjs`

### Requirement: 运行计划估算没有历史的评测用例

`routing.mjs` SHALL 导出 `estimatePlan`，为每个选中的评测用例估算费用与耗时：

- 有历史记录：按历史中位数估算，与本变更之前的算法相同。
- 没有历史记录：按同 stage 有历史的评测用例的单次中位数推算，标为「按同 stage 推算」。
- 同 stage 也没有历史：标为「无法估算」。
- 历史读 `<评测数据目录>/results/*/summary.json`。

输出要求：

- 合计 SHALL 写成「至少 $X，另有 N 次评测运行无法估算」，并写出没有认可结果、需要双跑的评测用例数。
- 估算值 SHALL 写入 `routing.json`。`report.md` 的结论 SHALL 对比估算值与 `summary.json` 中实际的 `costUsd`。

#### Scenario: 选中没有历史的 update 评测用例

- **WHEN** 本次只修改了 `skills/openspec-update-change/SKILL.md`，`update-design-blocker` 与 `update-scope-blocker` 没有历史记录
- **THEN** 运行计划把这两个评测用例的金额标为「按同 stage 推算」，按 `update-after-blocked` 的单次中位数计算
- **AND** 合计包含这两个评测用例的推算金额

#### Scenario: 同 stage 没有历史

- **WHEN** 路由选中 `overview-change-model`，`overview` 的评测用例都没有历史记录
- **THEN** 该评测用例标为「无法估算」，合计写出无法估算的评测运行次数

### Requirement: case.yaml 可以用 covers 声明额外覆盖的文件

`case.yaml` SHALL 接受可选键 `covers`：非空的字符串列表，每项是相对仓库根目录的 glob。`covers` 与 `stage` 的默认覆盖范围合并使用。

- `covers` 不是非空字符串列表时，`evals/run.mjs` 与 `test-skill.sh` MUST 以退出码 `2` 结束，并且不启动 Claude Code。
- `covers` 只影响路由，不影响评测运行与断言。

#### Scenario: update 评测用例声明覆盖 explore 的 shared 规则

- **WHEN** `update-after-blocked` 的 `case.yaml` 写有 `covers: ["skills/openspec-explore/shared/*.md"]`
- **AND** 本次修改了 `skills/openspec-explore/shared/first-principles.md`
- **THEN** 路由选中 `update-after-blocked`

#### Scenario: covers 格式错误时不启动 Claude Code

- **WHEN** 某个 `case.yaml` 写有 `covers: skills/openspec-explore/shared/*.md`（字符串，不是列表）
- **THEN** `test-skill.sh` 以退出码 `2` 结束，输出该评测用例名与键名
- **AND** Claude Code 没有启动

### Requirement: 没有评测用例覆盖的修改单独列出

`skills/openspec-*` 或 `claude/commands/opsx/` 下的修改文件没有匹配到任何评测用例时，`test-skill.sh` SHALL 在终端列出该文件。该文件 SHALL 写入 `routing.json` 的 `uncovered`。只有这类修改时，`test-skill.sh` 不运行评测，以退出码 `0` 结束。

#### Scenario: 修改 archive skill

- **WHEN** 本次只修改了 `skills/openspec-archive-change/SKILL.md`
- **THEN** 终端列出该文件，说明没有评测用例覆盖
- **AND** 不运行评测，退出码为 `0`

#### Scenario: 非工作流 skill 的修改不列出

- **WHEN** 本次只修改了 `skills/ddd-aggregate/SKILL.md`
- **THEN** 该文件不出现在「没有评测用例覆盖」的列表中
