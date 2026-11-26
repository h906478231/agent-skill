# technical-review-convergence Specification

## Purpose
规定技术评审的收敛检查、定稿轮后开放 finding 的处理、规划修改的登记，以及 apply 和 verify 的校验。

## Requirements

### Requirement: 定稿轮之后的开放 finding SHALL 不重新打开技术评审

裁决首次为 `READY_FOR_HUMAN_APPROVAL` 的一轮 SHALL 是定稿轮。汇总 SHALL 在 `review-summary.md` 的「定稿与签字后修改」节写出 `定稿轮：R<n>`。因方案变更重走门禁后，新一轮的裁决再次为 `READY_FOR_HUMAN_APPROVAL` 时，定稿轮 SHALL 改为该轮。

仍有实质 Blocker 或其他打回原因时，主会话 SHALL 不询问开放 Major 的处理方式。排除这些原因后，主会话 SHALL 在定稿与提示签字前，请用户为每条开放 Major 选择处理方式；不得要求先有可签字裁决。只待用户选择或写入已选修复时，机器可读裁决 SHALL 保持 `BLOCKED`，正文写明「待条件处理」，该等待状态 SHALL 不计为 Blocker。条件处理完成后，SHALL 先确认当前运行假设与本轮固定输入一致，再核对任务、行号或处理记录，才可发布可签字裁决。无法核对时 SHALL 保持 `BLOCKED`。全部发布可签字裁决的入口 SHALL 遵守 `review-operating-assumptions` 的撤销规则，包含条件处理完成后的发布。首次定稿前的条件落点也 SHALL 登记并逐处核对，保留评审输入版本与登记基线。Minor SHALL 可以按维度一次选择。可选的处理 SHALL 为：

| 处理 | 规划修改 | 重走门禁 | 条件状态 |
|---|---|---|---|
| 修复 | 签字前用一次 `/opsx:update` 写入修复；未修改运行假设时登记为条件落点 | 不重走；修改运行假设时全量重走 | `已写入` |
| risk accepted | 按 `gate-policy.md` 第 4 节写接受记录与复查触发阈值 | 不重走 | `risk-accepted` |
| 误报 | 按 `gate-policy.md` 第 4 节写驳回记录 | 不重走 | `false-positive` |
| 移到后续变更 | 台账状态为 `deferred`，处理记录写去向 | 不重走 | `deferred` |

选 risk accepted、误报或移到后续变更时，修改者 SHALL 只留痕，SHALL 不修改 proposal、design、specs 与 tasks。有最近一次未撤销且与状态相符的处理记录后，这三种处理 SHALL 不阻断签字、apply、verify 与 archive。未修改运行假设时，修复新增的机制 SHALL 由 quality 与 verify 验收，SHALL 不让技术评审重走。修复修改运行假设时，update SHALL 将变化与依赖新假设的修改按方案变更登记，不得登记为条件落点。汇总 SHALL 保留原评审输入与 `BLOCKED`，全部纳入维度按新假设重审前不得定稿或提示签字。

推荐项 SHALL 取下列规则中第一条符合的：

1. 汇总「疑似误报检测」判为误报：推荐误报。
2. 修复只改既有决策内的参数、边界、顺序或拒绝分支：推荐修复。
3. 修复要新增状态、持久文件、子命令或协议，并且不修的后果是误拒绝或交回会话处理：推荐 risk accepted。
4. 其他情况：推荐移到后续变更。

每个选项的说明 SHALL 写出修复是否新增机制，以及重走范围。修改运行假设的修复 SHALL 写「全量重走」，其他选项 SHALL 写「不重走」。开放的 Major 不超过 4 条时，主会话 SHALL 用 AskUserQuestion 逐条询问。超过 4 条时，主会话 SHALL 先输出一张表，列为 `ID | 一句话白话 | 推荐处理 | 理由`，再请用户确认整张表或改写其中的行。用户的回复 SHALL 写入处理记录的来源。

#### Scenario: 定稿轮选择修复的 Major 一次写入，不重走
- **WHEN** R5 无实质 Blocker 或其他打回原因，有 7 条开放 Major，用户对 3 条选择修复，对 4 条选择 risk accepted
- **THEN** 签字前一次 `/opsx:update` 写入 3 条修复，对应条件的状态为 `已写入`
- **AND** 另 4 条只写接受记录，对应条件的状态为 `risk-accepted`，design、specs 与 tasks 不因它们修改
- **AND** 核对条件落点后，裁决变成 `READY_FOR_HUMAN_APPROVAL`，写入定稿轮并提示签字，不提示 `/opsx:review`

#### Scenario: 修复新增的机制不重走技术评审
- **WHEN** 定稿前，用户对一条修复要新增累计读取额度且不修改运行假设的 Major 选择修复
- **THEN** update 把额度写入 design 与 tasks，登记表的规划档位为条件落点
- **AND** 下一步提示签字，不提示 `/opsx:review`

#### Scenario: 修复 Major 修改运行假设时先全量重审
- **WHEN** 用户选择修复 Major，update 将运行假设的规模上限从 50 改为 100
- **THEN** 该修改和依赖新上限的修改登记为方案变更，不登记为条件落点
- **AND** 裁决保留 `BLOCKED`，不写定稿轮、不提示签字
- **AND** 全部纳入维度按新假设审全文并重算裁决后，才判断能否定稿

#### Scenario: 误报只留痕
- **WHEN** 汇总「疑似误报检测」把 SEC-15 列为误报，用户选择误报
- **THEN** `review/security.md` 有 SEC-15 的驳回记录，台账状态为 `false-positive`，对应条件的状态为 `false-positive`
- **AND** design 不变，登记表没有新行

#### Scenario: 移到后续变更只留痕
- **WHEN** 定稿前，用户对 ARCH-43 选择移到后续变更
- **THEN** 台账中 ARCH-43 的状态为 `deferred`，处理记录写去向
- **AND** proposal、design、specs 与 tasks 不因它修改

#### Scenario: 推荐项按修复方式与后果确定
- **WHEN** 一条 Major 的修复要新增开机时间解除规则，不修的后果是依靠暂缓的登记一直被拒绝
- **THEN** 推荐项为 risk accepted，选项说明写「新增机制」与「不重走」

#### Scenario: 开放 Major 超过 4 条时先输出表
- **WHEN** 实质阻断清零，定稿前有 20 条开放 Major
- **THEN** 主会话先输出一张含推荐处理的表，请用户确认整张表或改写其中的行
- **AND** 不逐条发出 20 个问题

#### Scenario: 有明确来源的待处理条件不阻止询问
- **WHEN** 唯一的开放 Major 带有明确条件原文，规划没有预先写入尚未选择的修复
- **THEN** 主会话请用户选择处理，不把待处理条件计为 Blocker
- **AND** 在处理完成并核对落点前，裁决保持 `BLOCKED`，不提示签字

#### Scenario: 定稿前仍有实质 Blocker 时不询问 Major 的处理
- **WHEN** R3 的裁决为 `BLOCKED`，有 2 条 Blocker 与 9 条 Major
- **THEN** 汇总只请用户处理 Blocker，9 条 Major 在台账中保持 `open`

### Requirement: 定稿后的规划修改 SHALL 登记规划档位

定稿轮之后，每次修改 `proposal.md`、`design.md`、`specs/` 或 `tasks.md`，修改者 SHALL 在 `review-summary.md` 的「定稿与签字后修改」节的登记表写一行。列 SHALL 为 `序号 | 日期 | 轮次 | 文件:行号 | 关联 | 规划档位 | 说明`。「关联」SHALL 写 finding ID 或条件编号。规划档位 SHALL 取下表中的一个值：

| 规划档位 | 判据 |
|---|---|
| 措辞 | 只改用词、错别字或排版。SHALL、场景、决策与任务的含义不变 |
| 条件落点 | 只写入汇总已列的条件，或用户已选的处理。写入的内容不超出条件原文 |
| 范围收窄 | 只移除需求、场景或任务，不增加行为。保留部分不再引用移除的内容 |
| 方案变更 | 其他修改，包含新增或改变决策、机制、持久文件、状态、需求与场景的行为 |

判据不确定时，规划档位 SHALL 取方案变更。

首次 apply 的基线任务数行与既有任务的勾选状态 SHALL 作为进度记录，不写登记表。任务的新增、删除、移动或内容修改 SHALL 按规划修改处理。

评审输入版本 SHALL 保留 `tasks.md` 的原始 SHA-256，另记 `tasks.md` 的任务内容 SHA-256。生成任务内容 SHA-256 时，SHALL 仅移除一级标题后首个非空行中符合 `基线任务数：N（YYYY-MM-DD 首次 apply）` 格式的行及该行末尾的换行符，并把顶层任务项的 `- [x] ` 前缀替换成 `- [ ] `。代码块中的示例与其他文本、顺序、空白、换行 SHALL 原样保留。写入基线任务数行时 SHALL 不改变原有空行。

登记表序号 SHALL 使用递增且不重复的正整数。分发评审前，主会话 SHALL 固定规划文件集合与原始内容。逐文件 SHA-256、任务内容 SHA-256 和 `登记基线序号：<非负整数>` SHALL 与该次分发绑定。基线序号取分发时登记表最后序号，空表写 `0`。评审 SHALL 使用固定版本。

汇总 SHALL 转录分发时的哈希与基线序号，保留原值。汇总前 SHALL 再核对当前文件集合与原始 SHA-256。输入发生变化，或无法确认评审使用固定版本时，SHALL 停止，不发布可签字裁决。

规划存在实质差异时，记录已核对版本前 SHALL 验证修改前内容与评审输入或上一个已核对版本相同。每处差异 SHALL 对应本批新增登记的文件、位置与判据。汇总 SHALL 另记差异与登记的对应关系、完整文件集合、逐文件原始 SHA-256、任务内容 SHA-256 和已核对登记的最后序号。无法核对修改前内容或存在未登记差异时，SHALL 停止，不从当前文件补写。

apply 前置校验 SHALL 在签字校验通过之后比较规划输入版本：

1. 汇总「评审输入版本」不是逐个文件的 SHA-256 时，SHALL 停止，提示重走门禁。
2. 比较集合 SHALL 为两部分的并集：汇总列出的文件，以及当前存在的 `proposal.md`、`design.md`、`tasks.md` 与 `specs/` 下的全部文件。只在一边出现的文件 SHALL 按已改变处理。
3. SHALL 读取序号大于登记基线序号的登记行，包含同轮且在记录评审输入之后增加的行。基线序号或登记行编号无效时 SHALL 停止。非零基线序号没有对应登记行时也 SHALL 停止。旧汇总没有基线序号时，SHALL 只读取能确认在评审输入之后的登记；不能确认的同轮行不算已登记。适用行中有方案变更时 SHALL 停止，提示重走受影响的维度。
4. 对两边都存在但原始 SHA-256 不同的 `tasks.md`，SHALL 比较任务内容 SHA-256。汇总中的任务内容 SHA-256 存在且与当前值相同时，`tasks.md` SHALL 按未改变处理；缺少该值、值无效或不同，SHALL 按已改变处理。比较集合中的文件均未改变时 SHALL 放行，不请求确认进度记录。
5. 存在实质差异时，apply SHALL 核对当前文件集合、逐文件哈希和登记最后序号与已核对版本一致。`tasks.md` 仍按第 4 步排除规定的进度记录。缺少记录、存在未经核对的登记或发现不一致时 SHALL 停止。文件名命中登记不算核对通过。旧汇总缺少已核对版本时，规划不变可继续；存在实质差异时停止。
6. 核对通过后，SHALL 输出第 3 步选出的登记行，用 AskUserQuestion 请用户确认规划档位。用户不确认时 SHALL 停止，提示重走受影响的维度。用户确认时，SHALL 按下列规则复核，复核通过才放行。

提问前，apply SHALL 保留已核对的文件集合、逐文件 SHA-256、任务内容 SHA-256、登记最后序号和显示的登记行完整内容。还 SHALL 保留本轮评审输入版本、登记基线序号、裁决和签字。仅在当前会话保留，不写持久文件。

确认返回后，apply SHALL 在开始实施或写入任务进度前重新读取这些值。适用登记的内容与最后序号均 SHALL 不变。规划只允许第 4 步定义的任务进度变化。若其他值变化、签字或裁决不再放行，或无法核对，SHALL 停止，不沿用该次确认，不修改签字行。

update SHALL 按上述规则核对本批差异。只在登记了方案变更时，SHALL 在 `tasks.md` 写「规划更新内容仍待技术评审和人工确认」。

#### Scenario: 条件落点不让签字失效
- **WHEN** R10 已签字，update 把条件 C64 的原文写入 `design.md:97`，登记为条件落点并记录已核对版本
- **THEN** apply 前置校验输出该登记行，请用户确认规划档位
- **AND** 用户确认后放行

#### Scenario: 措辞修改不让签字失效
- **WHEN** 已签字后，update 按 STE 检查改了 `tasks.md` 中的 11 个用词，登记为措辞并记录已核对版本
- **THEN** apply 前置校验请用户确认该行的规划档位，用户确认后放行

#### Scenario: 方案变更让 apply 停止
- **WHEN** 已签字后，登记表在最新一轮之后有一行方案变更
- **THEN** apply 前置校验停止，提示重走该行涉及的维度
- **AND** 不修改签字行

#### Scenario: 未登记的规划修改让 apply 停止
- **WHEN** 已签字后 `design.md` 的 SHA-256 与汇总记录不同，登记表没有 `design.md` 的行
- **THEN** apply 前置校验停止，提示先运行 `/opsx:update` 登记，或重走门禁

#### Scenario: 签字后新增规划文件按已改变处理
- **WHEN** 已签字后，update 创建 `specs/new-cap/spec.md`，汇总的评审输入版本没有列出该文件
- **THEN** apply 前置校验把该文件按已改变处理
- **AND** 该文件没有登记行时停止，有方案变更行时停止

#### Scenario: 评审输入版本不是逐个文件的 SHA-256
- **WHEN** 汇总的评审输入版本只写了 `git rev-parse HEAD` 的值
- **THEN** apply 前置校验停止，提示重走门禁

#### Scenario: 仅写入任务进度记录后可以续跑
- **WHEN** 已签字的汇总有任务内容 SHA-256，首次 apply 写入基线任务数行，在证据通过后勾选一项任务，然后中断
- **AND** 没有方案变更登记行，其他规划文件不变
- **THEN** 下次 apply 识别出 `tasks.md` 的任务内容 SHA-256 未变
- **AND** 不要求登记或确认这两类进度记录，允许继续未完成的任务

#### Scenario: 改写任务内容不能按进度记录放行
- **WHEN** 已签字后勾选一项任务，同时改写既有任务的完成标准，且没有对应登记行
- **THEN** 任务内容 SHA-256 不同，apply 将 `tasks.md` 按已改变处理并停止

#### Scenario: 旧汇总只有原始任务文件哈希
- **WHEN** 已签字的旧汇总只有 `tasks.md` 的原始 SHA-256，当前文件的原始 SHA-256 不同
- **THEN** apply 将 `tasks.md` 按已改变处理，不用当前文件补写评审版本

#### Scenario: 评审分发后输入发生变化
- **WHEN** 子 agent 收到固定版本后，用户在汇总前保存了 `design.md` 的新内容
- **THEN** 汇总保留分发版本，不用当前哈希替换
- **AND** 停止，不发布可签字裁决

#### Scenario: 已核对版本之后又有实质修改
- **WHEN** 同轮范围收窄通过差异核对，已记录哈希，之后同一文件的保留内容发生修改且未重新核对
- **THEN** apply 发现当前哈希与已核对版本不一致并停止，即使该文件已有登记

#### Scenario: 等待确认时规划正文改变
- **WHEN** apply 已显示登记并等待确认，用户在此期间保存了新的 `design.md` 正文，之后确认原登记
- **THEN** apply 在开始实施前发现哈希不同并停止，不沿用此次确认

#### Scenario: 等待确认时登记内容改变
- **WHEN** apply 等待确认期间，一行已显示的登记改变了规划档位，登记序号与规划文件都不变
- **THEN** apply 发现登记内容与所显示的内容不同，停止且不沿用此次确认

#### Scenario: 等待确认时签字不再适用
- **WHEN** apply 等待确认期间，评审裁决变成 `BLOCKED` 或签字被撤回
- **THEN** apply 在确认返回后停止，不修改签字行

#### Scenario: 等待确认时仅有任务进度变化
- **WHEN** apply 等待确认期间，只改变了 `tasks.md` 中既有任务的勾选状态，其他核对值都不变
- **THEN** 用户确认后，apply 按任务内容 SHA-256 核对通过；切片证据要求不变

#### Scenario: 无效登记基线序号阻止 apply
- **WHEN** 汇总写 `登记基线序号：5`，登记表没有序号 5 的行
- **THEN** apply 停止，不用后续登记代替缺失的基线行

#### Scenario: 用户不确认登记的规划档位
- **WHEN** 已签字后有一行已核对的条件落点登记，apply 请用户确认，用户回答不确认
- **THEN** apply 前置校验停止，提示重走受影响的维度
- **AND** 不修改签字行

#### Scenario: 旧版评审汇总没有登记表
- **WHEN** 汇总没有「定稿与签字后修改」节，规划输入版本与当前文件不同
- **THEN** apply 前置校验停止，提示重走门禁

### Requirement: verify SHALL 核对签字后规划修改的档位

verify SHALL 读取登记表中规划档位为措辞、条件落点、范围收窄的行，按判据核对对应位置的内容。范围收窄行关闭了 Blocker 时，verify SHALL 另外核对该 Blocker「位置」与「涉及代码模块」列出的内容已从保留的 design、specs、tasks 中移除。内容不符合判据时，verify SHALL 记一条 CRITICAL，写出登记序号、`文件:行号` 与不符合的判据。

#### Scenario: 条件落点超出条件原文
- **WHEN** 一行登记为条件落点，对应位置写入了条件原文之外的新机制
- **THEN** verify 记 CRITICAL，写出该行序号与「超出条件原文」

#### Scenario: 范围收窄后仍有引用
- **WHEN** 一行登记为范围收窄，移除了一个场景，但保留的任务仍引用该场景
- **THEN** verify 记 CRITICAL，写出引用所在的 `文件:行号`

#### Scenario: 收窄范围关闭的 Blocker 位置仍在保留规划中
- **WHEN** 一行范围收窄关闭了一条 Blocker，该 Blocker 的位置是 design 的决策 D3，D3 仍在 design 中
- **THEN** verify 记 CRITICAL，写出该行序号与 `design.md` 中 D3 的行号

### Requirement: 第 3 轮起的评审汇总 SHALL 写收敛检查

从第 3 轮起，汇总 SHALL 在 `review-summary.md` 写「收敛检查」节。表格 SHALL 每轮一行，列为 `轮次 | 纳入维度数 | 新增 Blocker | 新增 Major | 开放 Blocker`。「新增」SHALL 只计本轮的新编号。

裁决为 `BLOCKED`，仍有开放 Blocker，并且本轮新增的 Blocker 与 Major 之和不少于上一轮时，Step 3 SHALL 向用户提供下列选项，每个选项写出重走范围：

- 收窄范围：把开放 Blocker 命中的需求移出本变更，登记为范围收窄。移出的需求不再评审。
- risk accepted：按 `gate-policy.md` 第 4 节接受开放的 Blocker。
- 继续修复：回改 design，重走受影响的维度。

一条 Blocker 只有在满足下面的前提时，才能由收窄范围改为 `closed`：该 Blocker「位置」与「涉及代码模块」列出的内容，已从保留的 design、specs、tasks 中移除。闭环依据 SHALL 写「范围收窄 #<登记序号>，已移除：<位置>」。不满足前提的 Blocker SHALL 只提供 risk accepted 与继续修复两个选项。

同轮收窄范围时，Step 3 SHALL 增加登记并保留该轮的评审输入版本与登记基线序号。关闭 Blocker 或重算裁决前，SHALL 逐处核对全部差异并记录已核对版本。未通过核对时 SHALL 保持阻断。实质阻断清零后，SHALL 按本规格处理开放 Major 与待处理条件；存在待处理项时 SHALL 保持 `BLOCKED`，不提示签字。条件处理已核对或没有待处理条件时，仍 SHALL 按 `review-operating-assumptions` 核对待完成的撤销；通过后才发布 `READY_FOR_HUMAN_APPROVAL` 并写定稿轮。

第 1、2 轮 SHALL 不写收敛检查。

#### Scenario: 第 3 轮新增不减少时提供收窄范围
- **WHEN** R3 的裁决为 `BLOCKED`，R2 新增 1 条 Blocker 与 3 条 Major，R3 新增 2 条 Blocker 与 9 条 Major
- **THEN** 汇总写出 R1 至 R3 的收敛检查表
- **AND** Step 3 提供收窄范围、risk accepted、继续修复三个选项

#### Scenario: 第 2 轮不写收敛检查
- **WHEN** R2 的裁决为 `BLOCKED`
- **THEN** 汇总没有「收敛检查」节，Step 3 不提供收窄范围

#### Scenario: 收窄范围后关闭对应 Blocker
- **WHEN** 用户选择收窄范围，2 条开放 Blocker 命中的需求移出本变更，2 条 Blocker 的位置都已从保留的规划中移除，且全部差异已核对
- **THEN** 这 2 条 Blocker 的闭环状态为 `closed`，闭环依据写「范围收窄 #<登记序号>，已移除：<位置>」
- **AND** 没有其他阻断原因且无需处理条件时，裁决改为 `READY_FOR_HUMAN_APPROVAL`，不启动新的评审子 agent

#### Scenario: 同轮收窄范围后签字并继续 apply
- **WHEN** R3 分发前固定评审输入，登记基线序号为 4，Step 2 的裁决为 `BLOCKED`
- **AND** Step 3 按前提移除一条需求，增加序号 5 的范围收窄登记；全部差异已核对且没有其他阻断项或待处理条件
- **THEN** 汇总保留原始 SHA-256 和序号 4，更新 `Gate-Verdict` 为 `READY_FOR_HUMAN_APPROVAL`，写 `定稿轮：R3`，不启动新一轮评审
- **AND** 人工签字后，apply 显示序号 5 的登记，不重复确认序号 4 及之前的登记；用户确认、返回后复核通过且没有其他阻断项时放行
- **AND** 用户不确认时停止，不改签字行

#### Scenario: 同文件存在未登记的保留内容修改
- **WHEN** 同轮收窄移除 `design.md` 中的一项需求并登记，但该文件还包含一处未登记的保留决策修改
- **THEN** Step 3 不把该文件写入已核对版本，保持原 Blocker 开放
- **AND** 不发布可签字裁决

#### Scenario: 根源在保留决策上的 Blocker 不能用收窄范围关闭
- **WHEN** 一条开放 Blocker 的位置是 design 的决策 D3，D3 同时支撑需求甲与需求乙，用户只把需求甲移出本变更
- **THEN** 这条 Blocker 保持 `open`
- **AND** Step 3 对这条 Blocker 只提供 risk accepted 与继续修复

#### Scenario: 收窄范围后仍有待处理条件时先询问
- **WHEN** R3 收窄范围后实质阻断清零，但仍有带明确原文的 Major 条件待处理
- **THEN** 先请用户选择处理，裁决保持 `BLOCKED`，不再提供收窄或接受 Blocker 的选项
- **AND** 条件处理完成且核对落点后才提示签字
