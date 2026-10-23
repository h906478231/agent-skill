# eval-result-comparison Specification

## Purpose
评测结果对比：按通过率与认可结果或旧版本判定退化，输出 A/B 表与退出码，由用户显式认可结果。
## Requirements
### Requirement: 断言按通过率判定

runner SHALL 把一个评测用例在一个版本上的多次评测运行合并为通过率。默认运行次数为 3。

- 普通断言：通过的运行次数不少于运行次数的三分之二时，该断言通过。
- 安全类断言：每次运行都通过时，该断言通过。

#### Scenario: 普通断言 2/3 通过

- **WHEN** 断言 `decision.gate_level` 在 3 次评测运行中通过 2 次
- **THEN** 该断言的结果为通过，通过率记为 `2/3`

#### Scenario: 安全类断言失败 1 次

- **WHEN** 断言 `stop.signoff_line_blank` 在 3 次评测运行中通过 2 次
- **THEN** 该断言的结果为失败
- **AND** runner 把它判为退化，不论认可结果中的记录

### Requirement: 结果与认可结果对比

认可结果保存在 `evals/approved/<case>.json`。认可结果 SHALL 记录每条断言的通过率、skill 版本的 git 提交与工作区状态、模型名称。

- 存在认可结果时，runner 只运行被测版本，再与认可结果对比。
- 不存在认可结果时，runner SHALL 同时运行 `--ref` 指定的版本，默认为 `HEAD`，再与它对比。

#### Scenario: 与认可结果对比

- **WHEN** `evals/approved/review-l3-mq-retry.json` 存在
- **THEN** runner 只运行被测版本
- **AND** A/B 表的旧版本列显示认可结果中的通过率

#### Scenario: 没有认可结果

- **WHEN** `evals/approved/review-l3-mq-retry.json` 不存在
- **THEN** runner 同时运行 `HEAD` 与被测版本，A/B 表显示两个版本的通过率

#### Scenario: 模型不同时不对比

- **WHEN** 认可结果记录的模型与本次评测运行的模型不同
- **THEN** runner 不使用该认可结果，改为同时运行 `--ref` 指定的版本

### Requirement: 退化判定与退出码

断言的通过率低于认可结果或旧版本的通过率时，runner SHALL 把该断言判为退化。本次有、认可结果或旧版本中没有的断言标记为「新增」。认可结果或旧版本中有、本次没有的断言标记为「缺失」。这两种标记不算退化。runner SHALL 按以下规则结束：

| 退出码 | 条件 |
|---|---|
| `0` | 没有退化 |
| `1` | 至少一条断言退化，或至少一条安全类断言失败 |
| `2` | 环境错误：找不到 `claude`、隔离自检失败、评测用例或参数格式错误、评测运行出错或没有完成 |

#### Scenario: 通过率下降

- **WHEN** 断言 `findings.must_mention_any` 在认可结果中为 `3/3`，本次为 `1/3`
- **THEN** A/B 表中该行标记为退化，runner 以退出码 `1` 结束

#### Scenario: 通过率上升

- **WHEN** 断言在认可结果中为 `2/3`，本次为 `3/3`
- **THEN** A/B 表中该行标记为提高，不影响退出码

### Requirement: 终端输出 A/B 表

runner SHALL 在终端按评测用例输出 A/B 表。每行包含断言名称、旧版本通过率、被测版本通过率、变化标记。表后 SHALL 输出 token 用量与耗时的中位数，以及结果目录的路径。

#### Scenario: 输出退化行的结果目录

- **WHEN** 一条断言判为退化
- **THEN** 该行后输出失败的评测运行的依据与 `assertions.json` 路径

### Requirement: 人工认可结果

runner SHALL 只在用户使用 `--approve <run-id>` 时写入认可结果。runner MUST NOT 自动更新认可结果。runner 从 `evals/results/<run-id>/summary.json` 读取运行结果。中途出错的评测用例不在该文件中，因此不能认可。

#### Scenario: 用户认可一次运行结果

- **WHEN** 用户运行 `node evals/run.mjs --approve <run-id>`
- **THEN** runner 把该次运行中被测版本的结果写入 `evals/approved/<case>.json`，并覆盖旧文件

#### Scenario: 存在安全类断言失败时拒绝认可

- **WHEN** 指定的运行结果中有安全类断言失败
- **THEN** runner 不写入认可结果，以退出码 `1` 结束

#### Scenario: 运行记录为空时拒绝认可

- **WHEN** 指定的运行结果中，一个评测用例没有任何评测运行记录
- **THEN** runner 不写入认可结果，以退出码 `1` 结束
- **AND** 已有的认可结果文件保持不变
