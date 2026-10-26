# test-run-record Specification

## Purpose
测试运行记录：一键测试每次运行后，写入测试运行记录，包含执行步骤、结果文件、静态测试明细、轨迹摘要与读取命中。前置检查通过后中途退出时同样写入。
## Requirements
### Requirement: 一键测试每次运行后写入测试运行记录

`evals/test-skill.sh` SHALL 在 `<评测数据目录>/reports/<YYYYMMDD-HHMMSS>[-N]/` 写入测试运行记录。评测数据目录取环境变量 `WORKFLOW_EVAL_ROOT`，没有设置时取 `evals/`。测试运行记录包含：

- `report.md`：测试运行记录的入口文件。
- `execution.json`：每一步的结果、耗时与结果文件，以及各分组的通配、run-id 与状态、生效的测试用环境变量，是执行步骤表的数据来源。
- `routing.json`：修改的文件、选中的评测用例、选中依据、运行的通配、费用估算、`unrouted` 与 `uncovered`。
- `run.log`：第 6 步各分组 `run.mjs` 的终端输出。
- `static/`：harness 自测与静态测试的逐条结果。
- `runs/<case>/<ref>-<n>/trace-summary.json`：每次评测运行的轨迹摘要。

目录分配：

- 目录名已存在时依次加 `-2`、`-3`，规则与 `run.mjs` 的 run-id 相同。
- 只在目录不存在时创建。遇到已存在的目录时，换下一个后缀。

写入方式：

- `execution.json` 与 `routing.json` 只由 node 写入：先写临时文件，再用 `rename` 替换。
- `test-skill.sh` MUST NOT 拼接 JSON 文本，MUST NOT 把 shell 变量拼进 `node -e` 的源代码。
- node 的写入入口（`execution.json`、`routing.json`、`report.md`）SHALL 在写入前使用同一个目录校验：目录必须已经存在，真实路径的上一级必须正好是 `<评测数据目录>/reports/`，目录名符合记录目录的格式。不满足时以退出码 `2` 结束，不写入文件。
- `static/` 与 `run.log` 由 `node --test`、shell 重定向与 `tee` 写入，SHALL 写入分配目录时已校验的真实路径，写入前不再逐次校验。

写入时机：

- 前置检查通过之后，`test-skill.sh` 从任一步骤退出时 SHALL 写入测试运行记录。`report.md` 的结论写出退出的步骤与退出码。
- 收到 SIGINT 或 SIGTERM 时 SHALL 同样写入。
- 前置检查失败时不写入，原因是 Node.js 可能不可用。
- 记录目录分配失败时，`test-skill.sh` SHALL 不写测试运行记录：终端输出告警，其余步骤照常执行，退出码不变，静态测试不加 junit reporter。
- run-id 列表 SHALL 按第 6 步前后 `results/` 下目录的差集取得，不依赖 `run.mjs` 输出的「结果目录：」一行。
- `execution.json` 缺失或不是合法的 JSON 时，SHALL 仍然生成 `report.md`：执行步骤表写「执行步骤数据缺失」，结论使用退出时的退出码。
- `test-skill.sh` 的退出码 MUST NOT 因写入测试运行记录而改变。写入失败时，终端输出告警。
- 退出前，终端 SHALL 输出 `report.md` 的路径。

#### Scenario: 完整运行的执行步骤表

- **WHEN** `test-skill.sh --yes` 运行到评测结束
- **THEN** `report.md` 的执行步骤表有 6 行：前置检查、harness 自测、静态测试、选择评测用例、运行计划、运行评测
- **AND** 每行写出结果、耗时与结果文件，没有结果文件的写「—」

#### Scenario: 静态测试失败时仍写入测试运行记录

- **WHEN** 静态测试中有 1 条测试失败
- **THEN** `test-skill.sh` 以退出码 `1` 结束，与本变更之前相同
- **AND** `report.md` 的结论写出在第 3 步「静态测试」退出，第 4–6 步标为「未执行」

#### Scenario: 没有选中评测用例

- **WHEN** 本次修改没有匹配到任何评测用例
- **THEN** `report.md` 写出修改的文件与没有评测用例覆盖的文件
- **AND** 「评测运行」一节写「本次没有运行评测」

#### Scenario: 用户取消运行

- **WHEN** 用户在运行计划的确认中回答 `N`
- **THEN** `report.md` 的结论写出用户在第 5 步取消

#### Scenario: 第 6 步被中断

- **WHEN** 假 Claude 进程运行第 2 次评测运行时，`test-skill.sh` 所在的进程组收到 SIGINT（与终端按 Ctrl-C 相同）
- **THEN** `report.md` 的结论写出在第 6 步退出，并链接本次新增的结果目录
- **AND** 已完成的第 1 次评测运行列出轨迹摘要，结论输出 `node evals/run.mjs --case '<该分组的通配>' --resume <run-id>`

#### Scenario: 同一秒内生成两份记录

- **WHEN** 两次运行在同一秒内分配测试运行记录目录
- **THEN** 两份记录分别写入 `<时间>` 与 `<时间>-2`

#### Scenario: 执行步骤数据缺失

- **WHEN** 退出时 `execution.json` 不存在
- **THEN** 仍然生成 `report.md`，执行步骤表写「执行步骤数据缺失」，结论写出退出码

#### Scenario: 记录目录分配失败

- **WHEN** `node evals/report.mjs --new-record` 以非 `0` 的退出码结束
- **THEN** 终端输出告警，`test-skill.sh` 的退出码与静态测试、评测的结果相同
- **AND** 仓库根目录没有新增文件，静态测试没有因为 junit 的目标目录不存在而失败

### Requirement: 评测中断后的命令只运行选中的评测用例

测试运行记录的结论与终端 SHALL 为第 6 步的每个分组给出命令：

- 中断的分组：`node evals/run.mjs --case '<通配>' --resume <run-id>`。原因是 `run.mjs` 续跑时不记录 `--case`，不传时选中全部评测用例。
- 未开始与未执行的分组：`node evals/run.mjs --case '<通配>'`，不带 `--resume`。结论写「N 个分组未执行，本次测试不完整」，N 包含未开始的分组。
- 传过 `--model` 时，每条命令都带上。
- 分组的退出码不为 `0`、并且没有新增 run-id 时，该分组的状态 SHALL 为「未开始」。
- `WORKFLOW_EVAL_ROOT` 生效时，每条命令前 SHALL 加 `WORKFLOW_EVAL_ROOT=<评测数据目录>`：终端写真实路径，`report.md` 写占位 `<评测数据目录>`。
- 每个分组的 run-id 取该分组调用 `run.mjs` 前后 `results/` 下新增的目录。只有名字匹配 `^\d{8}-\d{6}(-\d+)?$` 的目录才作为 run-id，其他新增目录忽略并告警。

#### Scenario: 续跑只运行中断的分组

- **WHEN** 选中 1 个 apply 评测用例与 3 个 update 评测用例，apply 分组的 `run.mjs` 以退出码 `2` 结束
- **AND** 用户依次执行结论中的两条命令
- **THEN** 假 Claude 进程只被这 4 个评测用例调用

#### Scenario: 异常的目录名不进入命令

- **WHEN** 第 6 步期间 `results/` 下新增一个名字为 `x;echo` 的目录
- **THEN** 结论中的命令不包含该名字，终端输出告警

#### Scenario: 分组没有新增 run-id

- **WHEN** 某个分组的 `run.mjs` 以退出码 `2` 结束，`results/` 下没有新增目录
- **THEN** `execution.json` 中该分组的状态为「未开始」
- **AND** 结论给出不带 `--resume` 的 `node evals/run.mjs --case '<通配>'`

### Requirement: 测试用环境变量只在临时评测数据目录下生效

`WORKFLOW_EVAL_CLAUDE`、`WORKFLOW_EVAL_CHANGED`、`WORKFLOW_EVAL_PACKAGE`、`WORKFLOW_EVAL_HARNESS`、`WORKFLOW_EVAL_REPO` SHALL 只在 `WORKFLOW_EVAL_ROOT` 已设置、并且它的真实路径不在仓库根目录内时生效。

- 不满足时，`test-skill.sh` 与 `report.mjs` MUST 以退出码 `2` 结束，输出变量名，不启动 Claude Code。
- 任一 `WORKFLOW_EVAL_*` 生效时，终端 SHALL 输出「测试覆盖变量生效：<变量名>」。
- 生效的变量 SHALL 写入 `execution.json` 的 `overrides`，`report.md` 结论的第一行 SHALL 写出这些变量。
- `evals/test/` 中启动子进程的辅助函数 SHALL 共用一个 `cleanEnv()`：先删除继承的全部 `WORKFLOW_EVAL_*`，再设置本测试需要的变量。启动 `test-skill.sh` 的辅助函数 MUST 设置 `WORKFLOW_EVAL_CLAUDE`。
- `test-skill.sh` 运行第 2 步 harness 自测与第 3 步静态测试时，子进程的环境 MUST NOT 含任何 `WORKFLOW_EVAL_*`。
- 只设置 `WORKFLOW_EVAL_ROOT` 与 `WORKFLOW_EVAL_CHANGED`、不设置 `WORKFLOW_EVAL_CLAUDE` 时，一键测试在临时评测数据目录中运行真实的 Claude Code，只用于人工验收。`report.md` 的结论 SHALL 在生效的变量一行之后写出 Claude 命令（真实进程或测试替身）、修改清单来源与评测数据目录。

#### Scenario: 测试开关残留在终端

- **WHEN** 只设置了 `WORKFLOW_EVAL_CHANGED`，没有设置 `WORKFLOW_EVAL_ROOT`，用户运行 `bash evals/test-skill.sh`
- **THEN** 以退出码 `2` 结束，输出 `WORKFLOW_EVAL_CHANGED`
- **AND** Claude Code 没有启动

#### Scenario: 测试中生效的变量写入结论

- **WHEN** CLI 测试把 `WORKFLOW_EVAL_ROOT` 指向临时目录，并设置 `WORKFLOW_EVAL_CHANGED`
- **THEN** `report.md` 结论的第一行写出 `WORKFLOW_EVAL_ROOT` 与 `WORKFLOW_EVAL_CHANGED`

#### Scenario: 只残留 WORKFLOW_EVAL_CLAUDE

- **WHEN** 只设置了 `WORKFLOW_EVAL_CLAUDE`，用户运行 `bash evals/test-skill.sh`
- **THEN** 以退出码 `2` 结束，输出 `WORKFLOW_EVAL_CLAUDE`
- **AND** 假 Claude 进程没有启动

#### Scenario: 评测数据目录在仓库内

- **WHEN** `WORKFLOW_EVAL_ROOT` 的真实路径在仓库根目录内，并设置了 `WORKFLOW_EVAL_CHANGED`
- **THEN** 以退出码 `2` 结束，输出变量名，Claude Code 没有启动

#### Scenario: harness 自测不继承外层的测试用环境变量

- **WHEN** 外层设置了临时的 `WORKFLOW_EVAL_ROOT` 与 `WORKFLOW_EVAL_CHANGED`，运行 `test-skill.sh`
- **THEN** 第 2 步与第 3 步的子进程中没有任何 `WORKFLOW_EVAL_*`

### Requirement: report.md 列出执行步骤与结果文件

`report.md` SHALL 按以下顺序包含 6 节：

| 节 | 内容 |
|---|---|
| 结论 | 生效的测试用环境变量、Claude 命令、修改清单来源、评测数据目录、未开始与未执行的分组数、退出码、退出的步骤、本次新增的结果目录的链接（有 run-id 时）、续跑与补跑命令、读取命中的告警数、临时目录外的访问次数、估算费用与实际费用 |
| 执行步骤 | 每一步的结果、耗时与结果文件 |
| 修改与评测用例 | 每个修改的文件：选中的评测用例、选中依据（`stage` 或 `covers`）、读取命中；`unrouted` 与 `uncovered` |
| 静态测试明细 | 每个测试脚本的条数、失败数与耗时。失败的测试写出测试名与 junit 文件的路径 |
| 阶段交接 | 4 条分支的 Mermaid 流程图，边上写交接的文件，检查失败的交接标为「断开」 |
| 评测运行 | 每个评测用例：断言对比；每次评测运行的被测版本、是否完成、轨迹摘要、产物相对阶段快照的「新增」「修改」 |

`report.md` 中指向仓库文件的路径 SHALL 相对仓库根目录；指向测试运行记录与评测结果目录的链接 SHALL 相对 `report.md` 所在的目录。评测数据目录不是仓库的 `evals/` 时，指向仓库文件的路径只写成行内代码，`report.md` MUST NOT 写出评测数据目录的绝对路径。

来自运行轨迹、git、junit 与断言的文字 SHALL 只由 `report.mjs` 的一个转义函数写入：

- 命令、路径与文件名写成行内代码，内容中的 `|` 写成 `\|`，换行写成空格。
- 其他表格单元格中的 `|` 写成 `\|`，`<`、`>` 写成 `&lt;`、`&gt;`，`[`、`]`、`(`、`)`、`!` 前加 `\`。
- 链接只指向 `report.mjs` 确定的路径。agent 写出的文件名只写成行内代码，不作为链接。
- Mermaid 的节点 ID 由报告生成，显示文字写在双引号中。

#### Scenario: 阶段交接断开时报告标出断开的边

- **WHEN** 阶段交接检查失败，archive 的输入 `verification.md` 没有上游产出
- **THEN** 「阶段交接」一节的流程图把指向 archive 的 `verification.md` 边标为「断开」
- **AND** 「静态测试明细」写出 `test-stage-handoff.mjs` 的失败

#### Scenario: 评测运行的产物分为新增与修改

- **WHEN** 一次评测运行的 `diff.txt` 修改了 `design.md`，创建了 `review-summary.md`
- **THEN** 该评测运行的产物列表把 `design.md` 标为「修改」，把 `review-summary.md` 标为「新增」

#### Scenario: 报告转义不可信的文字

- **WHEN** 一次评测运行的命令含 `|`、换行与临时目录根，产物中有一个文件名为 `x](https://example.invalid/a.png)`
- **THEN** `report.md` 中各表格的列数不变，`<tmp>` 在预览中可见
- **AND** 该文件名写成行内代码，没有生成链接或图片

#### Scenario: 评测数据目录在仓库外时不写出本机路径

- **WHEN** `WORKFLOW_EVAL_ROOT` 指向仓库外的临时目录，生成测试运行记录
- **THEN** `report.md` 中指向结果目录的链接写成 `../../results/<run-id>/` 开头的相对路径，不含临时目录的绝对路径
- **AND** 仓库文件写成行内代码，不作为链接

### Requirement: 按结果目录列出评测运行

报告 SHALL 扫描 `results/<run-id>/<case>/<ref>-<n>/` 列出评测运行。`summary.json` 的 `cases` 只用于断言对比。

- 是否完成按 `assertions.json` 判定，与 `run.mjs` 的口径相同：没有隔离停止，`runError` 为空，并且有 result 事件或已超时。`assertions.json` 缺失时为未完成。
- 旧格式的 `assertions.json` 缺少字段时 SHALL 按运行轨迹补判：`isolationStopped`、`timedOut` 缺失时为 `false`；`runError`、`hasResult` 缺失时，取 `evals/lib/assert.mjs` 的 `parseTrace` 对 `trace.jsonl` 的解析结果。补判的评测运行标「旧格式，按运行轨迹判定」。`assertions.json` 不是合法的 JSON 时判为未完成，并告警。
- 未完成的评测运行列出轨迹摘要，标为「未完成」，不计入读取命中的总数。
- 不在 `summary.cases` 中的评测用例标为「未完成，没有断言对比」。
- `summary.json` 的必需字段为 `runId` 与 `cases`。`versions`、`ref`、`options`、`comparison`、`baseVersion` 可以缺少，缺少时写「未记录」。
- `<case>/` 下没有 `<ref>-<n>/` 目录，或全部 `<ref>-<n>/` 目录中都没有 `trace.jsonl` 时，报告 SHALL 对该评测用例输出告警「结果目录结构不认识」。该评测用例不计入读取命中的总数，不按 0 统计。
- 只有部分 `<ref>-<n>/` 目录没有 `trace.jsonl` 时，报告不输出这条告警，这几次评测运行判为未完成（「没有 trace.jsonl」）。
- 每次评测运行 SHALL 写出被测版本：`summary.versions` 中的 commit、是否有未提交修改、`diffHash`。

#### Scenario: 评测中断后的结果目录

- **WHEN** 结果目录的 `summary.cases` 为 `{}`，`apply-blank-signoff` 有 2 次已完成的 WORKTREE 评测运行
- **THEN** 「评测运行」一节列出这 2 次评测运行，该评测用例标为「未完成，没有断言对比」

#### Scenario: 旧格式的 assertions.json

- **WHEN** `assertions.json` 没有 `hasResult` 与 `runError`，`trace.jsonl` 中只有 1 个 result 事件，`is_error` 为 false
- **THEN** 该评测运行判为已完成，标「旧格式，按运行轨迹判定」

#### Scenario: 旧格式的结果目录

- **WHEN** 结果目录的 `summary.json` 只有 `runId`、`createdAt`、`cases`
- **THEN** 报告以退出码 `0` 结束，被测版本处写「未记录」

#### Scenario: 不认识的结果目录结构

- **WHEN** 一个评测用例的目录下只有按步骤分层的子目录，没有 `<ref>-<n>/`
- **THEN** 报告对该评测用例输出告警「结果目录结构不认识」，读取命中不按 0 统计

### Requirement: 静态测试保存逐条结果

`test-skill.sh` SHALL 读取 `package.json` 中 `test` 脚本串联的脚本名，逐个运行，不复制脚本清单。

- 形式为 `node --test <文件>` 的脚本：加 Node.js 自带的 junit reporter，结果写入 `static/<脚本名>.junit.xml`。脚本名中 `A–Z`、`a–z`、`0–9`、`.`、`_`、`-` 以外的字符都换成 `-`。原因是 Windows 的文件名不能含 `:`，脚本名含 `/` 时目标目录不存在。
- 终端仍显示静态测试输出的最后 8 行。
- 其他脚本：标准输出与标准错误写入 `static/<脚本名>.log`，记录退出码。脚本名的换写规则相同。
- 任一脚本失败时，静态测试判为失败。其余脚本继续运行，用于写出完整的明细。
- junit 文件不是合法的 XML，或缺少 `</testsuites>` 时，`report.mjs` SHALL 把该脚本标为「结果不完整（运行被中断）」，不统计条数与失败数，仍然生成 `report.md`。
- 用户单独运行 `npm test` 时，行为不变，不写入任何文件。

#### Scenario: 新增测试脚本时静态测试明细自动包含

- **WHEN** `package.json` 的 `test` 串联了新脚本 `test:handoff`，`test-skill.sh` 没有修改
- **THEN** 「静态测试明细」包含 `test:handoff` 一行
- **AND** `static/test-handoff.junit.xml` 存在

#### Scenario: 引用校验脚本保存日志

- **WHEN** 静态测试运行 `verify`（`node scripts/verify-references.mjs`）
- **THEN** `static/verify.log` 保存它的输出，「静态测试明细」写出它的退出码

#### Scenario: 单独运行 npm test 不写入文件

- **WHEN** 用户单独运行 `npm test`
- **THEN** 不创建 `reports/` 下的任何文件

#### Scenario: 第 3 步被中断

- **WHEN** 静态测试的一个脚本运行中，`test-skill.sh` 所在的进程组收到 SIGINT
- **THEN** `report.md` 写出，「静态测试明细」把该脚本标为「结果不完整（运行被中断）」
- **AND** 结论写出中断时正在运行的脚本，退出码为 `130`

### Requirement: 轨迹摘要按 6 类归类工具调用

报告脚本 SHALL 读取评测运行的 `trace.jsonl`，把每次工具调用归入以下 6 类之一，写入 `trace-summary.json`：

| 类 | 判定 |
|---|---|
| 被拒绝 | 工具调用有对应的 `permission_denied` 事件。优先于其他类 |
| 读取规则 | Read 的路径在临时目录的 `.claude/skills/` 或 `.claude/commands/` 下；Grep、Glob 的 `path` 在这两个目录下；Skill 工具调用 |
| 读取产物 | 其他 Read，以及其他 Glob、Grep |
| 写入产物 | Write、Edit、MultiEdit、NotebookEdit（与 `evals/lib/assert.mjs` 的 `WRITE_TOOLS` 相同） |
| 运行检查 | Bash 命令运行 `ste-lint.mjs`、`change-model.mjs`、`implementation-gate.mjs`、`check-review-approval.sh` 或 `openspec validate` |
| 其他命令 | 其他 Bash 命令，以及其他工具 |

归类规则：

- Skill 工具调用的路径记为 `.claude/skills/<目录>/SKILL.md`，目录按 frontmatter 的 `name` 与调用的 `skill` 取值对应。
- Agent 工具的调用 SHALL 作为子 agent 分组。带 `parent_tool_use_id` 的工具调用归入对应的子 agent 分组，分组内同样按 6 类归类。
- 运行检查的结论 SHALL 取工具结果中 JSON 的 `verdict` 字段。工具结果不是 JSON 时取 `is_error`。命令含管道且工具结果不是 JSON 时，结论标为「退出码不可信」。

保存的字段：

- 每条工具调用只保存：序号、工具名、类、下表「保存的内容」、运行检查的结论、`outside` 标记、子 agent 分组。
- MUST NOT 保存 Write、Edit、MultiEdit 的内容、工具结果正文、Agent 与 Task 调用的 `prompt`、Skill 调用的 `args`，以及 init 事件中 `cwd` 与 `claude_code_version` 以外的字段。

| 工具 | 作为路径的字段 | 保存的内容 |
|---|---|---|
| Read、Write、Edit、MultiEdit | `file_path` | 改写后的路径 |
| NotebookEdit | `notebook_path` | 改写后的路径 |
| Grep | `path`，缺失时为临时目录 | 改写后的路径 |
| Glob | `pattern` 是绝对路径时，取第一个通配符之前的目录；否则取 `path`，缺失时为临时目录 | 改写后的路径 |
| Bash | 不取路径 | 改写后截断的命令 |
| Skill | 不取路径 | `skill` 的取值与对应的 `SKILL.md` 路径 |
| Agent、Task | 不取路径 | `subagent_type` 与改写后截断的 `description` |
| 其他工具 | 不取路径 | 只保存工具名 |
- 顶层 SHALL 写 `schemaVersion`、`classifier`（6 类规则的版本）、`claudeCodeVersion`、`source`（`runId`、`case`、`ref`、`index`、`traceBytes`、`traceSha256`）。

路径改写（只由一个函数完成）：

- 临时目录取运行轨迹中第一个 init 事件的 `cwd`，后面的 init 事件不改变它。临时目录根取 `cwd` 中以 `workflow-eval-` 开头的那一级目录。
- 临时目录内的路径，写成相对它的路径。
- 临时目录根内、临时目录外的路径，写成 `<tmp>/<相对根的路径>`。
- 路径等于用户主目录时写成 `~`，以「用户主目录 + `/`」开头时写成 `~/<其余部分>`。其余路径写成 `<临时目录外>/<最后两级>`。
- 命令文本、`permission_denied` 的消息、Agent 调用的 `description` 与报告引用的断言说明中，临时目录根写成 `<tmp>`，用户主目录写成 `~`，然后截断到 200 个字符。
- `/private/var/` 与 `/var/` 按同一个前缀处理。

临时目录外的访问：

- Read、Grep、Glob、Write、Edit、MultiEdit、NotebookEdit 按上表取得的路径不在临时目录根内时，SHALL 标记 `outside: true`。被拒绝的调用同样标记。6 类的计数不变。
- 标记 `outside` 的路径匹配 `*/skills/openspec-*/**` 或 `*/commands/opsx/**` 时，SHALL 另标「读取了非被测版本的规则」。

报告脚本 MUST NOT 修改评测结果目录中的文件。

#### Scenario: 为已有的 update 评测运行生成轨迹摘要

- **WHEN** 为 run-id `20261014-091654` 生成报告
- **THEN** `update-after-blocked` 的 WORKTREE-1 轨迹摘要共 56 次工具调用
- **AND** 读取规则 10 次、读取产物 14 次、写入产物 20 次、运行检查 4 次、其他命令 2 次、被拒绝 6 次
- **AND** 临时目录外的访问 2 次，都被拒绝

#### Scenario: Skill 调用归入读取规则

- **WHEN** 一次 review 评测运行调用 Skill 工具，`skill` 为 `openspec-technical-review`
- **THEN** 该调用归入「读取规则」，路径为 `.claude/skills/openspec-technical-review/SKILL.md`

#### Scenario: 子 agent 的工具调用归入分组

- **WHEN** 一次 review 评测运行通过 Agent 工具启动 5 个子 agent
- **THEN** 轨迹摘要有 5 个子 agent 分组，每个分组列出该子 agent 的工具调用

#### Scenario: 管道掩盖退出码

- **WHEN** Bash 命令为 `node .../ste-lint.mjs check <changeRoot> | head -20`，工具结果不是完整的 JSON
- **THEN** 该次运行检查的结论为「退出码不可信」

#### Scenario: 报告不写出本机绝对路径

- **WHEN** 为本地全部结果目录逐个生成报告
- **THEN** `report.md` 与全部 `trace-summary.json` 中，用户主目录的绝对路径与 `/var/folders` 都出现 0 次

#### Scenario: 运行轨迹有多个 init 事件

- **WHEN** 运行轨迹有 2 个 init 事件，第 2 个的 `cwd` 是 `<临时目录>/.claude/skills/openspec-technical-review`
- **THEN** 临时目录取第 1 个 init 的 `cwd`，对 `openspec/changes/` 下文件的读取不标记 `outside`

#### Scenario: Glob 的路径等于用户主目录

- **WHEN** 一次 Glob 的 `path` 正好等于用户主目录
- **THEN** 轨迹摘要中该路径写成 `~`，标记 `outside`

#### Scenario: Glob 只有绝对路径的 pattern

- **WHEN** 一次 Glob 没有 `path`，`pattern` 是用户主目录下 `.claude/skills/openspec-technical-review/shared/*.md`
- **THEN** 该调用标记 `outside` 与「读取了非被测版本的规则」

#### Scenario: 读取临时目录外的旧版规则

- **WHEN** 一次评测运行用 Glob 列出用户主目录下 `.agents/skills/openspec-explore/shared` 中的文件，调用没有被拒绝
- **THEN** 该调用归入「读取产物」，标记 `outside` 与「读取了非被测版本的规则」
- **AND** 结论的「临时目录外的访问」为 1 次

### Requirement: 读取命中统计修改过的规则文件

报告 SHALL 为每个修改的文件统计读取命中，只统计路由选中了评测用例的文件。读取命中写成 `<命中数>/<总数>`：

- 总数：选中的评测用例中，已完成的 WORKTREE 评测运行数。
- 命中数：其中读取过该文件的评测运行数。

以下情况计为读取：

- Read 该文件。
- Skill 工具调用：计为读取对应 skill 目录的 `SKILL.md`。
- `output_mode` 为 `content` 的 Grep：结果中出现的文件。`path` 是一个文件、并且结果不为空时，该文件计为读取。
- 评测用例 prompt 以 `/opsx:<命令>` 开头时，`claude/commands/opsx/<命令>.md` 计为已读取。

统计规则：

- Glob 与其他模式的 Grep 不计为读取。Grep 的结果只用于统计，MUST NOT 写入轨迹摘要。
- 临时目录的 `.claude/skills/<路径>` 对应仓库的 `skills/<路径>`，`.claude/commands/opsx/<文件>` 对应 `claude/commands/opsx/<文件>`。
- 子 agent 的读取同样计入。
- 结果目录中有、但路由没有选中的评测用例，只在「评测运行」一节显示，不计入读取命中。
- 读取命中为 0 时，报告与终端 SHALL 输出告警。告警 MUST NOT 改变 `test-skill.sh` 的退出码。
- 一键测试没有评测运行时（第 6 步没有开始，或没有新增 run-id），结论不写读取命中，不输出读取命中的告警；「修改与评测用例」一节照常写出修改的文件，选中了评测用例的文件读取命中写 `0/0（没有已完成的 WORKTREE 评测运行）`。
- 没有评测用例覆盖的修改文件，读取命中写「没有评测用例」。

#### Scenario: 路由选中但运行没有读取

- **WHEN** 本次修改了 `skills/openspec-apply-change/shared/post-implementation-changes.md`，路由选中 `apply-blank-signoff`
- **AND** 3 次 WORKTREE 评测运行都没有读取该文件
- **THEN** 该文件的读取命中为 `0/3`，报告与终端输出告警
- **AND** `test-skill.sh` 的退出码只由评测结果决定

#### Scenario: 命令文件由斜杠命令加载

- **WHEN** 本次修改了 `claude/commands/opsx/apply.md`，评测用例的 prompt 为 `/opsx:apply order-retry`
- **THEN** 该文件的读取命中等于已完成的 WORKTREE 评测运行总数

#### Scenario: 子 agent 读取的规则计入命中

- **WHEN** 本次修改了 `skills/openspec-technical-review/roles/concurrency.md`，只有 review 的子 agent 读取了它
- **THEN** 该次评测运行计入该文件的读取命中

#### Scenario: Skill 工具加载的 SKILL.md 计入命中

- **WHEN** 本次修改了 `skills/openspec-technical-review/SKILL.md`，review 的评测运行用 Skill 工具加载 `openspec-technical-review`
- **THEN** 这些评测运行计入该文件的读取命中

#### Scenario: Grep 读到的规则文件计入命中

- **WHEN** 一次评测运行用 `output_mode: content` 的 Grep 在 `.claude/skills/openspec-technical-review/shared` 下搜索，结果中出现 `gate-policy.md`
- **THEN** 该次评测运行计入 `skills/openspec-technical-review/shared/gate-policy.md` 的读取命中

### Requirement: 为已有结果目录单独生成报告

`node evals/report.mjs --run <run-id> [--changed <文件>...]` SHALL 只读取 `<评测数据目录>/results/<run-id>/`，在 `<评测数据目录>/reports/<YYYYMMDD-HHMMSS>[-N]/` 写入测试运行记录。目录分配规则与一键测试相同。

- `<run-id>` MUST 匹配 `^\d{8}-\d{6}(-\d+)?$`，否则以退出码 `2` 结束，不写入文件。
- `--record <目录>` 的真实路径 MUST 在 `<评测数据目录>/reports/` 下，否则以退出码 `2` 结束。
- 执行步骤表只有「生成报告」一行。
- 没有传 `--changed` 时，「修改与评测用例」一节写「没有提供修改的文件」，不统计读取命中。
- run-id 不存在、`summary.json` 不是合法的 JSON 或缺少必需字段时，以退出码 `2` 结束，不写入文件。
- `summary.json` 的 `versions.WORKTREE` 与当前工作区不同时，「阶段交接」与「修改与评测用例」两节 SHALL 写明计算依据的版本。
- 传了 `--changed`、并且该 run-id 的 WORKTREE 没有未提交修改时，结论 SHALL 注明「该结果目录的 WORKTREE 不含未提交修改」。
- 写入成功时以退出码 `0` 结束。

#### Scenario: 为历史结果生成报告

- **WHEN** 用户运行 `node evals/report.mjs --run 20261014-091654`
- **THEN** 写入一份测试运行记录，「评测运行」一节包含 `update-after-blocked` 的 6 次评测运行
- **AND** `evals/results/20261014-091654/` 中的文件没有变化

#### Scenario: run-id 不存在

- **WHEN** 用户运行 `node evals/report.mjs --run 20990101-000000`
- **THEN** 以退出码 `2` 结束，`reports/` 下没有新目录

#### Scenario: run-id 格式不合法

- **WHEN** 用户运行 `node evals/report.mjs --run ../x`
- **THEN** 以退出码 `2` 结束，没有读取或写入评测数据目录以外的文件
