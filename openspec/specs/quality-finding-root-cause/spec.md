# quality-finding-root-cause Specification

## Purpose
按根因类别记录和处理质量评审 finding，并规定切片证据、verify 与完成清单如何保留处理依据。

## Requirements

### Requirement: Spec Fidelity finding SHALL 写出根因类别

Spec Fidelity Review 的每条 finding SHALL 在「建议修复」列开头写根因前缀 `[根因 <类别>]`。类别 SHALL 为下表之一：

| 类别 | 根因 | 判据 |
|---|---|---|
| B | 实现偏离规划 | 规划写明了做法，实现没有照做 |
| C1 | 规划留白 | 规划没有写到这个细节，实现缺少或不一致。修复能只改代码，并且不与规划已写的内容冲突 |
| C2 | 规划缺陷 | 修复需要的规划修改按 `gate-policy.md` 第 5 节判据属于「方案变更」档 |
| C3 | 规划文字错误 | 修复只需要措辞档的规划修改，实现不需要改 |

类别判据 SHALL 只在 `dual-axis-review.md` 定义。Standards Review 的 finding SHALL 不写根因前缀，按 A 代码质量处理。Spec Fidelity SHALL 不为「另一种做法也可行」写 finding。判据不能确定是 C2 还是 C3 时，类别 SHALL 取 C2。判据不能确定是 C1 还是 C2 时，类别 SHALL 取 C2。

变更没有 `review-summary.md` 时，类别 SHALL 仍按第 5 节的规划档位判据判定。

`review/spec-fidelity.md` SHALL 在 `## 根因类别记录` 中为每个已分类的 SPEC finding 按 ID 保留一个列表项，例如 `- SPEC-02：[根因 C2]`。重跑覆盖报告时 SHALL 保留已有类别记录，即使对应条目已移出 Findings 表。用户纠正类别时 SHALL 更新同一 ID 的记录；若 Findings 表仍有该条目，也 SHALL 更新其前缀。该节 SHALL 不记录状态，不新增 Findings 表或 Finding 台账的列。

#### Scenario: 实现没有照做规划写明的做法
- **WHEN** design D4 写明「分发前固定输入」，实现在汇总时重新读取磁盘文件
- **THEN** 该 finding 的「建议修复」以 `[根因 B]` 开头，建议修复只改代码

#### Scenario: 规划没写到的细节由实现决定
- **WHEN** design 只写「同轮收窄后保留原始哈希」，没有写登记行与哈希的先后，实现漏处理同轮登记
- **AND** 实现可以在 D4 的意图内选一种先后，不与已写规则冲突
- **THEN** 该 finding 的「建议修复」以 `[根因 C1]` 开头，建议修复只改代码

#### Scenario: 修复需要改变技术决策
- **WHEN** spec 场景要求的结果按 design 的决策无法实现，修复需要新增一个机制
- **THEN** 该 finding 的「建议修复」以 `[根因 C2]` 开头

#### Scenario: 规划文字错误
- **WHEN** spec 写「第 3 步」，规则只有 2 步，实现符合规则
- **THEN** 该 finding 的「建议修复」以 `[根因 C3]` 开头，写出拟改的文字

#### Scenario: 判据不确定时取 C2
- **WHEN** agent 不能确定修复需要的规划修改是措辞档还是方案变更档
- **THEN** 该 finding 的根因类别为 C2

### Requirement: Step 6 SHALL 按根因类别提供处理选项

`/opsx:quality` Step 6 SHALL 按根因类别询问开放的 Blocker 与 Major：

| 类别 | 选项 | 选「修复」后的写入 |
|---|---|---|
| A、B、C1 | `修复`、`risk accepted`、`误报` | `tasks.md` 新增未勾选任务 |
| C3 | `修复`、`risk accepted`、`误报` | 不写规划产物。写完同一批的其他回复后停止，提示 `/opsx:update` |
| C2 | `risk accepted`、`收窄范围`、`改变技术决策`、`误报` | 见下文 |

C2 的选项 SHALL 为下表。下表 SHALL 只在 `dual-axis-review.md` 的「根因类别」一节定义。C2 的选项 SHALL 不引用 `gate-policy.md` 第 5 节「定稿后处理开放 finding」表。

| 选项 | 写入 | 重走技术评审 |
|---|---|---|
| `risk accepted` | 按 `gate-policy.md` 第 4 节，在 `review/spec-fidelity.md` 写接受记录 | 不重走 |
| `收窄范围` | quality 不写入。`/opsx:update` 把对应的需求、场景或任务移出本变更，写入 proposal「不做」，规划档位为范围收窄 | 不重走 |
| `改变技术决策` | quality 不写入。`/opsx:update` 修改 design 中的决策，规划档位为方案变更 | 按 `gate-policy.md` 第 3 节重走受影响的维度 |
| `误报` | 按 `gate-policy.md` 第 4 节，在 `review/spec-fidelity.md` 写驳回记录 | 不重走 |

C2 的推荐项 SHALL 按下面的规则确定：

- 缺陷只让该 Requirement 的部分 Scenario 不成立时，推荐 `risk accepted`。
- 缺陷让该 Requirement 的全部 Scenario 都不成立时，推荐 `收窄范围`。
- `改变技术决策` SHALL 不作为推荐项。

`改变技术决策` 的选项说明 SHALL 写出要重走的维度。变更有 `review-summary.md` 时，维度 SHALL 按 `gate-policy.md` 第 3 节确定。变更没有 `review-summary.md` 时，说明 SHALL 写「无技术评审，只修改规划」，update SHALL 不写登记行。选 `收窄范围` 或 `改变技术决策` 时，Step 6 SHALL 不写入该条，写完同一批的其他回复后停止，提示 `/opsx:update`。

旧报告的 SPEC finding 没有根因前缀时，Step 6 SHALL 先按判据补判类别，再写出问题。

#### Scenario: B 类 finding 选择修复
- **WHEN** 用户对一条 `[根因 B]` 的 Major 选择 `修复`
- **THEN** `tasks.md` 新增一项未勾选任务，写出 finding ID 与位置
- **AND** 规划产物没有修改

#### Scenario: C2 类 finding 的默认选项
- **WHEN** 一条 `[根因 C2]` 的 Major 只让 Requirement 的 4 个 Scenario 中的 1 个不成立
- **THEN** Step 6 的问题有 `risk accepted`、`收窄范围`、`改变技术决策`、`误报` 四个选项
- **AND** 推荐项是 `risk accepted`，`改变技术决策` 的说明写出要重走的维度

#### Scenario: C2 类 finding 选择改变技术决策
- **WHEN** 用户对一条 `[根因 C2]` 的 Major 选择 `改变技术决策`，变更有 `review-summary.md`
- **THEN** Step 6 不修改规划产物，提示运行 `/opsx:update`
- **AND** update 登记方案变更后，apply 按 `gate-policy.md` 第 3 节要求重走受影响的维度

#### Scenario: C2 类 finding 选择收窄范围
- **WHEN** 用户对一条 `[根因 C2]` 的 Major 选择 `收窄范围`，变更有 `review-summary.md`
- **THEN** Step 6 不修改规划产物，提示运行 `/opsx:update`
- **AND** update 把对应的需求移出本变更，写入 proposal「不做」，登记为范围收窄，不重走技术评审

#### Scenario: 技术评审的处理表改变后 C2 选项不变
- **WHEN** `gate-policy.md` 第 5 节的「定稿后处理开放 finding」表删去「改变技术决策」一行
- **THEN** `dual-axis-review.md` 的 C2 选项仍为 `risk accepted`、`收窄范围`、`改变技术决策`、`误报` 四项

#### Scenario: 旧报告没有根因前缀
- **WHEN** 上一轮 `review/spec-fidelity.md` 有一条没有根因前缀的开放 Major
- **THEN** Step 6 先判定该条的类别，再按该类别写出选项

### Requirement: 质量评审 SHALL 不写规划产物

`/opsx:quality` SHALL 不修改 `proposal.md`、`design.md`、`specs/` 与 `tasks.md` 中已有的规划内容。规划修改 SHALL 由 `/opsx:update` 写入，并按 `gate-policy.md` 第 5 节登记规划档位。在 `tasks.md` 新增修复任务的规则不变，本需求不改变它的登记方式。

finding 的「建议修复」写有 `<文件>:<行号>` 与拟改文字，并且该位置已改为拟改文字时，Step 6 SHALL 把台账改为 `closed`，闭环依据写 `<文件>:<行号>`，不询问。

#### Scenario: C3 类 finding 选择修复
- **WHEN** 用户对一条 `[根因 C3]` 的 Major 选择 `修复`
- **THEN** quality 不修改该规划产物，台账保持 `open`
- **AND** 输出提示运行 `/opsx:update`

#### Scenario: update 写入拟改文字后关闭
- **WHEN** `/opsx:update` 已把 `specs/x/spec.md:12` 改为 finding 写出的拟改文字，再次运行 `/opsx:quality`
- **THEN** Step 6 把该 finding 改为 `closed`，闭环依据写 `specs/x/spec.md:12`，不询问

### Requirement: C1 的实现决定 SHALL 写在切片证据

修复 C1 finding 的任务完成时，apply SHALL 在该任务所属切片的证据中写「实现决定」小节。小节 SHALL 为表格，列为 `finding ID | 规划位置 | 规划没写的内容 | 实现的选择 | 不冲突的依据`。apply SHALL 不为 C1 回写规划产物。

「实现决定」SHALL 是可选小节。没有 C1 修复任务的切片 SHALL 不写该小节。

#### Scenario: 修复 C1 后写出实现决定
- **WHEN** apply 完成修复 SPEC-02（`[根因 C1]`）的任务 4.4
- **THEN** 任务 4.4 所属切片的证据有「实现决定」小节，有一行 SPEC-02
- **AND** `design.md` 与 `specs/` 没有因 SPEC-02 修改

### Requirement: verify SHALL 承认 SPEC finding 的 risk accepted 记录

Spec Fidelity 报告中状态为 `risk-accepted` 的 SPEC finding，有 `gate-policy.md` 第 4 节格式的接受记录（接受人、理由、触发阈值与来源行）时，verify SHALL 把该记录作为偏离的留痕。verify SHALL 不要求把该偏离另写入 `design.md`，SHALL 记 WARNING，不记 CRITICAL。

接受记录缺少接受人或来源行时，verify SHALL 按现行规则处理该偏离。

#### Scenario: C2 偏离已 risk accepted
- **WHEN** 设计偏离清单有一行对应 SPEC-02，SPEC-02 的状态为 `risk-accepted` 并有完整的接受记录，`design.md` 没有该项
- **THEN** verify 记一条 WARNING，写出 SPEC-02 与接受记录的位置
- **AND** 该项不使 `Verify-Verdict` 成为 `FAIL`

#### Scenario: 接受记录不完整
- **WHEN** SPEC-02 的状态为 `risk-accepted`，接受记录没有来源行
- **THEN** verify 按现行规则核对该偏离是否写入 `design.md`

### Requirement: recap SHALL 列出 C2 finding

生成完成清单时，recap SHALL 从 `review/spec-fidelity.md` 的「根因类别记录」筛出 C2，并按 ID 读取 Finding 台账的状态。recap SHALL 把这些 C2 合并为 `## 没做与遗留` 的一条事项，不按状态筛选。事项 SHALL 写出数量、ID、每条的状态，并写明「规划缺陷，技术评审没有发现」。变更没有 `review-summary.md` 时，事项 SHALL 写「规划缺陷，变更没有运行技术评审」。

旧报告没有某个 ID 的类别记录时，recap SHALL 只使用 Findings 表中仍可读取的根因前缀。两处都没有类别时，recap SHALL 不推断该条属于 C2。没有 C2 finding 时，SHALL 不写该事项。

#### Scenario: 归档变更有两条 C2 finding
- **WHEN** 归档变更有 `review-summary.md`，`review/spec-fidelity.md` 的类别记录将 SPEC-02 与 SPEC-05 标为 C2
- **AND** Finding 台账的状态分别为 `risk-accepted` 和 `closed`
- **THEN** `recap.md` 的 `## 没做与遗留` 有一条事项，写出 2 条、两个 ID 与各自的状态，以及「规划缺陷，技术评审没有发现」

#### Scenario: 已关闭的 C2 移出 Findings 表后仍列入完成清单
- **WHEN** 双轴质量评审把一条 C2 标为 `closed`，重跑覆盖 `review/spec-fidelity.md` 时将该条移出 Findings 表
- **THEN** 「根因类别记录」仍保留该条的 ID 与 `[根因 C2]`
- **AND** 归档后，完成清单仍列出该 ID 及其 `closed` 状态
