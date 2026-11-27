# review-operating-assumptions Specification

## Purpose
技术评审的运行假设区块、触发方式代码与假设外观察、重走时的评审范围与防锚定注入、按后果定级与条件状态、apply 前的条件检查、Blocker/Major Finding 台账、没有修复的 finding 的留痕，以及撤销接受的代价。

## Requirements

### Requirement: L2、L3 与命中升级信号的 MVP 的 design SHALL 有运行假设区块

design.md SHALL 有标题为 `运行假设` 的区块，固定三行：

| 行 | 内容 |
|---|---|
| 用户 | 用户是谁、几个人、签字人与作者是否为同一人 |
| 威胁模型 | 写「按 ADR-0016」。变更需要防有意伪造时，写出要防伪造的检查 |
| 规模上限 | 本变更处理的每类对象及其数字上限。没有数量对象时写「无数量对象」 |

格式与判据 SHALL 只在 `skills/openspec-explore/shared/operating-assumptions.md` 定义。规模上限 SHALL 不设全局默认值。

技术评审前置校验 SHALL 在判定等级后检查：等级为 L2、L3，或方案类型为 MVP 并命中升级信号时，区块缺失、缺少任一行，或规模上限既没有数字也没有写「无数量对象」，SHALL 停止评审，提示用 `/opsx:update` 补写。L1 与 MVP 未命中信号 SHALL 不检查该区块。

#### Scenario: L3 变更缺少运行假设时停止评审
- **WHEN** 等级判为 L3，design.md 没有「运行假设」区块
- **THEN** 前置校验停止，不启动评审子 agent，提示用 `/opsx:update` 补写

#### Scenario: 命中升级信号的 MVP 缺少运行假设时停止评审
- **WHEN** 方案类型为 MVP，命中「权限判定」，design.md 没有「运行假设」区块
- **THEN** 前置校验停止，不启动评审子 agent

#### Scenario: 规模上限没有数字时停止评审
- **WHEN** 等级判为 L2，「规模上限」一行写「数据量适中」
- **THEN** 前置校验停止，写出缺少数字上限

#### Scenario: L1 变更不检查运行假设
- **WHEN** 等级判为 L1，design.md 没有「运行假设」区块
- **THEN** 前置校验不因缺少该区块停止

### Requirement: 评审 SHALL 按运行假设的威胁模型判断触发场景

评审 agent SHALL 在审查前读取 design.md 的运行假设。威胁模型为「按 ADR-0016」时：

- 约束流程内 agent 的检查，SHALL 按「会出错、会走捷径，不会有意伪造」评审。
- 外部输入与对外发送的内容，SHALL 按攻击者评审。把外部文本交给流程内 agent 的入口算外部输入。

威胁模型写出要防伪造的检查时，这些检查 SHALL 按攻击者评审。

#### Scenario: 有意伪造的绕过写法不计入裁决
- **WHEN** 威胁模型为「按 ADR-0016」，安全评审发现 agent 可以先查明 hook 只比较小写路径，再用大写路径写决策文件
- **THEN** 该发现写入「假设外观察」，不进 findings 表

#### Scenario: 走捷径的触发场景必须报出
- **WHEN** 威胁模型为「按 ADR-0016」，核对允许 agent 用以前对另一条 finding 的「接受」关闭新的 Blocker
- **THEN** 该发现进 findings 表，触发场景以 `[T3]` 开头

#### Scenario: 外部输入按攻击者评审
- **WHEN** 威胁模型为「按 ADR-0016」，飞书卡片回调没有核对点击者的 `operator_id`
- **THEN** 该发现进 findings 表，触发场景以 `[T4]` 开头

#### Scenario: 变更声明防伪造时按攻击者评审
- **WHEN** 威胁模型写明「签字读取要防伪造」，评审发现 agent 可以构造一行被读成签字的文字
- **THEN** 该发现进 findings 表

### Requirement: Blocker 与 Major SHALL 写出触发方式代码，其余发现写入假设外观察

Blocker 与 Major 的「触发场景」单元格 SHALL 以下列代码之一开头：

| 代码 | 触发方式 |
|---|---|
| `[T1]` | 正常使用：按规格使用就会发生 |
| `[T2]` | 出错：流程内 agent 写错格式、漏写或判断错 |
| `[T3]` | 走捷径：流程内 agent 为通过门禁放宽判断、复用以前的同意或改写记录 |
| `[T4]` | 外部输入：来自外部输入，按攻击者假设 |

触发场景涉及的数量 SHALL 不超过运行假设的规模上限。交互式与 workflow 的角色 SHALL 把缺码或错码的 Blocker 与 Major 作为待核对条目交给汇总，保留 ID、场景、位置与后果，不得先写入「建议」或「假设外观察」。汇总 SHALL 先复核场景与级别，再按范围分流。缺码或错码但场景明确且在运行假设内时，SHALL 补正代码、按后果定级，不得仅因格式降级。确认不在运行假设内或没有可复现的触发场景时，SHALL 写入「假设外观察」并在疑似误报检测中记原 ID 与依据。可能阻断但场景仍待核对时，SHALL 要求原维度补证，并在完成核对前保持 `BLOCKED`。

「假设外观察」SHALL 不计入严重级别计数，不影响维度结论与门禁裁决，不向用户询问处理方式。汇总 SHALL 不复制「假设外观察」。Minor SHALL 不要求代码。「假设外观察」与「建议」SHALL 只作为当轮维度报告的可选附录：不编号、不跨轮累加、不进 Finding 台账、不参与台账核对。「假设外观察」每条写出发现与复核确认的不成立原因；「建议」每条写出发现与原严重级别。

代码与判据 SHALL 只在 `finding-format.md` 定义。

#### Scenario: 超出规模上限的发现写入假设外观察
- **WHEN** 规模上限写「每个变更的决策文件不超过 200 个」，性能评审的触发场景是 9,000 个决策文件
- **THEN** 该发现写入「假设外观察」，不进 findings 表

#### Scenario: 漏写触发方式代码不移除已成立的 Blocker
- **WHEN** 一条 Blocker 已写明可复现的场景与后果，场景在运行假设内，但报告漏写代码
- **THEN** 汇总补正代码，按 Blocker 计入裁决，不移到「假设外观察」

#### Scenario: 可能阻断的场景未核实时不放行
- **WHEN** 缺码条目的后果足以阻断，但汇总无法判定其场景是否成立
- **THEN** 汇总要求原维度补证，在核对完成前保持 `BLOCKED`

#### Scenario: 写不出触发方式代码的 Major 写入假设外观察
- **WHEN** 一条 Major 的触发场景只能写「理论上可能被绕过」，写不出 `[T1]` 至 `[T4]` 之一
- **THEN** 该发现写入「假设外观察」

#### Scenario: 限范围复审先复核缺码再分流
- **WHEN** 限范围复审发现受已登记修改波及的 Blocker，但缺少触发方式代码
- **THEN** 角色将该项送汇总复核，不写入「建议」
- **AND** 补正代码后按 Blocker 计入裁决；未完成复核且所述后果足以阻断时保持 `BLOCKED`

#### Scenario: 假设外观察不影响裁决
- **WHEN** 一个维度没有 Blocker，「假设外观察」有 3 条
- **THEN** 该维度结论不因这 3 条为「打回」，汇总的 Blocker、Major、Minor 计数不包含这 3 条

#### Scenario: Minor 不要求触发方式代码
- **WHEN** 一条 Minor 的触发场景没有代码
- **THEN** 该 Minor 留在 findings 表

#### Scenario: 假设外观察与建议只做当轮附录
- **WHEN** R1 的 `review/performance.md` 有 2 条「假设外观察」，R2 重走性能维度没有新发现该类条目
- **THEN** R2 报告不要求保留 R1 的条目，也不要求编号，汇总不因该小节条数变化停止

### Requirement: 重走门禁时 SHALL 先核对登记再限定评审范围

第一轮评审 SHALL 审 proposal.md 与 design.md 全文。重走门禁时，通过登记覆盖核对后，评审范围 SHALL 取下列两类登记的位置：

- **定稿前**：design.md 末尾「评审意见闭环记录」的「落在 design 的哪一节」列。定稿前建议优先只修改 Blocker；凡对 design.md 做了实质修改（无论来自 Blocker、Major 还是主动调整），修改者 SHALL 在闭环记录中补写一行（非 finding 触发的 ID 填 `自改-R<n>`）。
- **定稿后**：`review-summary.md`「定稿与签字后修改」登记表的「文件:行号」列。评审子 agent SHALL 不读取 `review-summary.md`；主会话（或 workflow 调用方通过可选参数 `changedLocations`）SHALL 提取上一次评审之后登记的 `文件:行号` 列表。调用方传列表时 SHALL 同时传入该列表所依据的文件集合和逐文件原始 SHA-256。只有与本轮固定输入匹配，且登记覆盖通过核对，才能把位置作为纯文本注入子 agent 的提示词。

评审 agent SHALL 先做上轮闭环验证，再审范围内的位置。按触发场景复核规则处理缺码或错码后，范围外的新发现 SHALL 只有在同时满足以下两条时进入 findings 表：

1. 严重级别为 Blocker，且触发场景以 `[T1]` 至 `[T4]` 之一开头；
2. 被本次已登记的修改波及（如修改破坏了未修改节的不变量或接口契约），或属于数据损坏与外部安全越权（`[T1]` 正常使用或 `[T4]` 外部输入）。

限范围时，范围外的其他新发现 SHALL 写入「建议」，不影响计数、维度结论与裁决。分发前，主会话或 workflow SHALL 先固定本轮规划原文、文件集合与原始 SHA-256，然后用同一份内容核对登记覆盖、生成位置并分发。核对 SHALL 以上一次完成该维度评审的输入为比较依据。对变更文件，SHALL 核对旧正文与旧哈希，并逐处核对实质差异，包含新增和删除的规划文件；排除任务进度。只有覆盖完整时，才 SHALL 限定范围或沿用旧报告。

调用方未提供列表的版本，或文件集合、哈希与分发输入不符时，SHALL 不使用该列表，按固定输入重新核对。仍无法核对或存在漏登记时，受影响维度 SHALL 审 proposal.md 与 design.md 全文且不得沿用；不能确定影响时 SHALL 重跑全部纳入维度。主会话 SHALL 核对当前 specs、tasks 与 proposal、design 一致；行为依据缺失时 SHALL 停止并提示补齐规划。

范围规则 SHALL 只在 `closed-loop-verification.md` 定义。

#### Scenario: 第一轮审全文
- **WHEN** 变更第一次运行 `/opsx:review`
- **THEN** 评审 agent 审 proposal.md 与 design.md 全文

#### Scenario: 重走只审闭环记录列出的节
- **WHEN** R2 重走，旧输入可核对，闭环记录的 D2 与 D5 覆盖全部实质差异
- **THEN** 评审 agent 只对 D2 与 D5 报告新的 Major 与 Minor

#### Scenario: 未登记差异不进入限范围的新基线
- **WHEN** R2 核对发现作者登记了 D2 的修复，但漏记了 D5 的行为修改，或拿不到与旧哈希匹配的正文
- **THEN** 受影响维度不沿用旧报告，恢复全文评审；不能确定影响时重跑全部纳入维度
- **AND** 不用新输入哈希证明旧范围内的修改已经评审

#### Scenario: 定稿前非 Blocker 修改登记后纳入重走范围
- **WHEN** R1 为 `BLOCKED`，作者修完 Blocker 后顺手调整了 design 的 D6，并在闭环记录增加 `自改-R1` 指向 D6
- **THEN** R2 重走时把 D6 纳入评审范围

#### Scenario: 定稿后重走由主会话注入修改位置且子 agent 不读汇总
- **WHEN** 定稿轮之后因方案变更重走安全维度，已核对的登记表有 `design.md:85-92`，且位置对应本轮固定输入
- **THEN** 主会话把 `design.md:85-92` 注入安全子 agent 的 prompt
- **AND** 安全子 agent 不读取 `review-summary.md` 与其他维度的报告

#### Scenario: 位置列表对应旧版本时不限定范围
- **WHEN** 调用方传入依据 V1 核对的位置，workflow 固定的送审输入为 V2，文件哈希不一致
- **THEN** workflow 不注入 V1 的位置，不沿用 V1 的范围判断
- **AND** 使用 V2 重新核对；无法核对时受影响维度审全文，影响不明时重跑全部纳入维度

#### Scenario: 范围外受波及或数据安全类 Blocker 仍报出
- **WHEN** R2 重走，评审 agent 发现 D2 的修改破坏了未登记的 D3 的事务边界，导致 `[T1]` 数据损坏 Blocker
- **THEN** 该 Blocker 进 findings 表

#### Scenario: 未修改节中未受波及的孤立走捷径发现写入建议
- **WHEN** R2 重走，评审 agent 在未登记的 D3 发现一条与本轮修改无关的 `[T3]` 走捷径问题
- **THEN** 该发现写入「建议」小节，不进 findings 表，不计入裁决

#### Scenario: 范围外的 Major 写入建议
- **WHEN** R2 重走，评审 agent 在没有登记的 D3 发现一条 Major
- **THEN** 该发现写入「建议」小节，写出原严重级别 Major，不计入 Major 计数

### Requirement: Blocker 与 Major SHALL 按后果定级，条件原文 SHALL 写明修复是否新增机制

评审 SHALL 按不修的后果确定 Blocker 与 Major，SHALL 不因修复要新增状态、持久文件或独立机制而把 Major 定为 Blocker。「有条件通过」的条件原文 SHALL 写明修复是否新增机制，供定稿前确定推荐项（`technical-review-convergence`）。条件原文可以包含新增机制。用户在定稿前选择修复后，写入条件原文登记为条件落点，不重走门禁；若修改运行假设，则按运行假设全量重审规则。判据 SHALL 只在 `gate-policy.md` 第 1 节定义。

#### Scenario: 修复要新增机制的 Major 不定为 Blocker
- **WHEN** 性能维度发现项目写保护内的读取没有累计上限，修复要新增一个累计读取额度，不修的后果是持有保护的时间超出预算
- **THEN** 该发现仍为 Major，条件原文写明「新增机制」

#### Scenario: 只补参数与边界的条件写明不新增机制
- **WHEN** 安全维度要求在已有校验中补上目录并集检查与输入格式校验
- **THEN** 条件原文写明「不新增机制」，定稿前的推荐项为修复

### Requirement: 有条件通过的条件 SHALL 写明处理状态，apply 前 SHALL 没有待处理的条件

`review-summary.md` 条件清单的「状态」列 SHALL 取下列值之一：

| 状态 | 含义 | 「对应任务或行号」列 |
|---|---|---|
| `待处理` | 还没有选择处理，或选了修复还没有写入规划 | 空 |
| `已写入` | 选了修复，已用 `/opsx:update` 写入规划 | 任务编号或 `<文件>:<行号>` |
| `risk-accepted` | 来源 finding 已接受风险 | 处理记录所在的 `review/<role>.md` |
| `false-positive` | 来源 finding 已判为误报 | 处理记录所在的 `review/<role>.md` |
| `deferred` | 来源 finding 已移到后续变更 | 处理记录所在的 `review/<role>.md` |

汇总 SHALL 把新条件写为 `待处理`，记录来源维度、finding ID 与条件原文。只有关联开放 Major 且有明确原文的待处理条件 SHALL 进入定稿前询问；缺来源、缺原文或已处理却无可核对的任务、行号或处理记录的条件仍 SHALL 视同 Blocker。询问之后，条件状态 SHALL 跟随当前处理结果。状态的取值与判据 SHALL 只在 `gate-policy.md` 第 1 节定义。verify 对这些状态的核对见 `verify-condition-check`。

apply 前置校验 SHALL 在签字校验之后读取条件清单。汇总写有 `定稿轮：R<n>`，并且有状态为 `待处理`、不在上表或缺少可核对的任务、行号或处理记录的条件时，apply SHALL 停止，写出条件编号，提示先完成定稿前的询问，再用一次 `/opsx:update` 写入。apply SHALL 不在实现中补写条件。汇总没有 `定稿轮：R<n>` 时，apply 前置校验 SHALL 不做这项检查。

对于已经启用技术评审的变更，apply 的最终准入 SHALL 与撤销共用排他保护。两条 apply 入口 SHALL 在首次实施写入前检查当前活跃目录、裁决、签字、待完成撤销及本次核对的规划、适用条件和登记依据。不符、存在待完成撤销或无法取得保护时 SHALL 停止。没有条件或无需再次人工确认也 SHALL 执行最终准入。准入 SHALL 以保护内检查通过为准，之后释放保护；已经完成准入的本次实现不因之后的撤销而取消。再次启动 SHALL 重新检查。

#### Scenario: apply 前仍有待处理的条件时停止
- **WHEN** 已签字，汇总写有 `定稿轮：R9`，条件 R9-C07 的状态为 `待处理`
- **THEN** apply 停止，写出 R9-C07，提示完成定稿轮的询问并用一次 `/opsx:update` 写入
- **AND** 不进入实现

#### Scenario: 已接受与已写入的条件不阻断 apply
- **WHEN** 已签字，全部条件的状态为 `已写入`、`risk-accepted`、`false-positive` 或 `deferred`
- **THEN** apply 前置校验不因条件状态停止

#### Scenario: 状态不在取值中的条件按待处理停止
- **WHEN** 汇总写有 `定稿轮：R9`，条件 R9-C02 的状态写「规划已写明，待验收」
- **THEN** apply 停止，写出 R9-C02

#### Scenario: 没有定稿轮的旧汇总不检查条件状态
- **WHEN** 汇总没有 `定稿轮：R<n>`，条件的状态为自由文字
- **THEN** apply 前置校验不因条件状态停止

#### Scenario: 撤销先完成时拒绝 apply 最终准入
- **WHEN** apply 已通过之前的签字和规划检查，无需再次向用户确认，另一会话撤销一条没有关联条件的 Blocker
- **THEN** apply 在最终准入时重读裁决，看到 `BLOCKED` 或待完成撤销后停止，不写任务基线或实现

#### Scenario: apply 已完成准入后不追溯取消
- **WHEN** apply 在写入保护内通过最终检查，此后另一会话完成撤销
- **THEN** 该次已完成的准入不撤回，下一次启动仍要重新检查，不能沿用这次结果

### Requirement: 技术评审的维度报告 SHALL 有累加的 Blocker 与 Major Finding 台账

每份 `review/<role>.md` SHALL 有「Finding 台账」一节，列为 `ID | 严重级别 | 首次轮次 | 状态 | 处理轮次 | 处理依据`。每个出现过的 `Blocker` 与 `Major` finding ID SHALL 有一行。移出开放 Findings 前，SHALL 在同份报告的处理记录按 ID 保存完整原发现。撤销时 SHALL 使用与待撤销决定对应的原发现。`Minor` SHALL 不进台账，留在当轮 findings 表中。台账行 SHALL 不删除，跨轮只更新状态、处理轮次与处理依据。状态 SHALL 取 `open`、`closed`、`risk-accepted`、`false-positive`、`deferred` 之一。

- 已闭环的 Blocker 与 Major SHALL 留在台账中，状态为 `closed`，处理依据写 design 的位置或任务编号。它 SHALL 不再进入本轮 findings 表。
- findings 表 SHALL 只列状态为 `open` 的 finding。
- `technical-review-gate.workflow.js` 的 `REVIEW_SCHEMA` 中 `status` 枚举 SHALL 包含 `deferred`，与五个状态值一致。
- 台账的格式 SHALL 只在 `finding-format.md` 定义，闭环时的写法 SHALL 只在 `closed-loop-verification.md` 定义。

评审子 agent SHALL 在审查前读取本维度上一轮的 `review/<role>.md`，从台账得知已处理的 Blocker 与 Major。对状态为 `closed`、`risk-accepted`、`false-positive`、`deferred` 的问题，子 agent SHALL 不换新编号重新报出。处理依据的前提已变化时，子 agent SHALL 沿用原 ID 把状态改为 `open`，并写出变化点。子 agent SHALL 不读取其他维度的报告。

主会话或 workflow SHALL 在写入本轮报告前保留各维度旧报告。分发后，角色 SHALL 返回拟发布报告、台账与 Findings，不直接覆写旧报告。不在本轮范围的开放 Blocker SHALL 沿用原 ID 和完整字段，除非有已核对的同 ID 处理依据。

发布前 SHALL 逐维度确认：旧台账每个 ID 在本轮恰有一行；开放 Blocker 与 Major 在台账和 Findings 中的 ID、级别、状态相符；旧开放 Blocker 仍按 Blocker 参与裁决，或有该 ID 的已核对闭环依据或用户决定。沿用的维度也 SHALL 核对现有台账与 Findings。本轮报告 SHALL 保留旧报告已经存下的原发现及其对应处理记录。新决定缺少完整原发现时不覆写。旧报告未保存原发现时，SHALL 保留现有记录，只有能核对同 ID 原文才补齐，不得从摘要生成。旧报告没有台账时，SHALL 用旧 Findings 中的开放 Blocker 与 Major 作迁移依据。首轮无旧报告时不做跨轮比较。

ID 缺失或重复、状态或级别不符、缺处理依据时，SHALL 列出维度与 ID，保留该维度旧报告并保持 `BLOCKED`。SHALL 不以行数代替核对，也不核对「假设外观察」和「建议」的条数。

交互式、workflow、用户处理与撤销、update 写汇总登记 SHALL 使用同一写入入口。候选 SHALL 绑定规划文件集合与 SHA-256，以及参与裁决的角色报告和汇总的 SHA-256 或缺失状态。写入入口 SHALL 按变更目录实际路径取得排他保护，在一次保护中复核当前版本并完成写入，不在两个命令之间释放保护。占用、版本不符或无法核对时 SHALL 停止，不写候选。异常退出遗留的保护不得自动接手。

多文件写入 SHALL 先以完整文件写入并确认 `BLOCKED` 汇总，再替换角色报告或与汇总登记同批的规划文件，最后才写与新产物相符的裁决或登记。首次阻断写入失败时 SHALL 不改角色报告或同批规划文件。阻断写入之后的任何失败 SHALL 不发布可签字裁决。中断恢复 SHALL 从当前实际产物重新核对，不继承旧候选。等待用户处理时 SHALL 先发布阻断版并释放保护。最终放行 SHALL 另取保护，核对处理完成后的报告及汇总版本。

#### Scenario: 撤销完成后不得发布旧候选
- **WHEN** 一轮评审生成候选，用户在另一会话完成撤销，规划内容未改
- **THEN** 候选所用的角色报告和汇总版本不再匹配，发布停止，不覆写撤销记录、开放状态或阻断裁决

#### Scenario: 发布最后复核到写入之间不能撤销
- **WHEN** 发布已取得保护且完成最后复核，另一个进程请求撤销同一变更的处理
- **THEN** 撤销在保护释放前不能写入；再次尝试时核对最新版本，不沿用旧输入

#### Scenario: 角色报告写入失败不发布可签字裁决
- **WHEN** 已写入 `BLOCKED` 汇总，替换一份角色报告失败
- **THEN** 汇总保持 `BLOCKED`，不使用部分写入的结果发布可签字裁决

#### Scenario: 已闭环的 Blocker 与 Major 留在台账
- **WHEN** R1 的 `review/security.md` 有 Blocker `SEC-01`，R2 闭环验证确认已闭环
- **THEN** R2 报告的 findings 表没有 `SEC-01`，台账中 `SEC-01` 的状态为 `closed`，处理依据写 design 的位置

#### Scenario: Minor 不进台账
- **WHEN** R1 的 `review/security.md` 有 1 条 Major `SEC-01` 与 2 条 Minor `SEC-02`、`SEC-03`
- **THEN** 台账只有 `SEC-01` 一行，`SEC-02` 与 `SEC-03` 留在 findings 表

#### Scenario: 已移到后续变更的问题不重复报出
- **WHEN** R1 台账中 `SEC-04` 的状态为 `deferred`，R2 的安全子 agent 再次看到同一个问题
- **THEN** R2 的 findings 表没有新编号的同一问题，台账中 `SEC-04` 仍为 `deferred`

#### Scenario: 台账行数未减少但旧 ID 丢失时停止汇总
- **WHEN** 拟发布报告遗漏一个旧的开放 Blocker ID，又加入一个新 Major ID，台账行数不变
- **THEN** 汇总列出缺少的 ID，保留该维度旧报告和 `BLOCKED` 裁决

#### Scenario: 台账开放 Blocker 漏列时停止汇总
- **WHEN** 拟发布报告的台账保留一条 `open` 的 Blocker，但 Findings 漏列它
- **THEN** 汇总列出不一致的 ID，保留该维度旧报告和 `BLOCKED` 裁决

#### Scenario: 前提变化时沿用原 ID 重新打开
- **WHEN** R1 台账中 `SEC-04` 的状态为 `deferred`，R2 之前 design 修改了 `SEC-04` 所在的决策并已登记
- **THEN** R2 的安全子 agent 沿用 `SEC-04`，把状态改为 `open`，写出变化点

#### Scenario: 子 agent 不读取其他维度的报告
- **WHEN** R2 的并发子 agent 读取上一轮报告
- **THEN** 它只读取 `review/concurrency.md`

#### Scenario: workflow 的 REVIEW_SCHEMA 包含 deferred
- **WHEN** 读取 `technical-review-gate.workflow.js` 的 `REVIEW_SCHEMA`
- **THEN** `findings.items.properties.status.enum` 包含 `open`、`closed`、`risk-accepted`、`false-positive`、`deferred`

### Requirement: 没有修复的 finding SHALL 留痕

Blocker 或 Major 的处理为 risk accepted、移到后续变更，或由收窄范围关闭时，修改者 SHALL 在对应 `review/<role>.md` 的台账之后增加一条处理记录，写明：

| 字段 | 内容 |
|---|---|
| 处理方式 | risk accepted、移到后续变更或收窄范围 |
| 决定人与日期 | 用户姓名与日期，以及回复来源（交互会话） |
| 理由 | 用户给出的理由，用户没有给出时写「用户未说明」 |
| 捡起条件 | 什么情况下重新处理。risk accepted 写复查触发阈值 |
| 去向 | 只用于移到后续变更：后续变更名，还没有创建时写「未建」 |

移到后续变更的 finding，台账状态 SHALL 为 `deferred`。`deferred` SHALL 不计入严重级别计数，不影响维度结论与门禁裁决。由收窄范围关闭的 Blocker，台账状态为 `closed`，处理依据写「范围收窄 #<登记序号>」。处理记录的格式 SHALL 只在 `gate-policy.md` 第 4 节定义。

#### Scenario: 移到后续变更的 Major 留痕
- **WHEN** 定稿后，用户对 ARCH-43 选择「移到后续变更」，没有给出后续变更名
- **THEN** 台账中 ARCH-43 的状态为 `deferred`
- **AND** 处理记录写明决定人、日期、理由、捡起条件与去向「未建」

#### Scenario: deferred 不计入裁决
- **WHEN** 一个维度只有一条 Major，状态为 `deferred`
- **THEN** 该维度的 Major 计数为 0，维度结论不因它为「有条件通过」

### Requirement: 运行假设修改 SHALL 按方向确定重走范围

运行假设三行中任一行修改时，修改者 SHALL 按 `skills/openspec-explore/shared/operating-assumptions.md` 判定修改的方向：

| 方向 | 判据 | 规划档位 | 重走范围 |
|---|---|---|---|
| 措辞 | 只改用词、错别字或排版，假设的含义不变 | 措辞 | 不重走 |
| 收窄 | 新假设允许的每一种使用情况，旧假设都允许。例如人数减少、规模上限变小、要防有意伪造的检查减少 | 范围收窄 | 不重走 |
| 放宽 | 新假设允许旧假设不允许的使用情况。例如人数增加、规模上限变大、新增数量对象、要防有意伪造的检查增加 | 方案变更 | 全部纳入维度审 proposal.md 与 design.md 全文 |

- 同一批修改既有收窄又有放宽，或方向无法判断时，SHALL 按放宽处理。
- 收窄 SHALL 由用户选择。登记行的「说明」SHALL 以「用户选择：」开头，写出原值、新值与触发阈值。触发阈值 SHALL 写出实际使用超出新假设时重开评审的条件。说明以「agent 判定：」开头的收窄 SHALL 按放宽处理。请用户选择收窄时，主会话 SHALL 显示原值、新值与所依据的方向判据行。
- 技术评审重走前的范围核对 SHALL 对登记为措辞、范围收窄或条件落点的运行假设修改，按方向判据逐行比较旧值与新值。出现新增使用情况、新增数量对象、含义变化或无法判断时，范围核对 SHALL 返回 `assumptions-changed`。登记为措辞的运行假设修改，说明不以「用户选择：」开头时，范围核对也 SHALL 返回 `assumptions-changed`。
- 收窄 SHALL 不关闭任何开放的 finding。开放的 finding SHALL 按原有规则处理。重走时，已有的开放 Blocker 与 Major SHALL 不因触发场景落到收窄后的假设外而改变状态，只有用户的处理记录才能改变。
- 放宽某一行时，引用该行收窄的 risk accepted SHALL 视为前提已变，全量重走时按原 ID 改回 `open` 并重新询问。
- 运行假设的措辞修改 SHALL 由用户选择。登记行的「说明」SHALL 以「用户选择：」开头，写出原值与新值，并说明含义不变的理由。说明以「agent 判定：」开头的运行假设措辞修改 SHALL 按放宽处理。
- 放宽时，受新假设影响的修改也 SHALL 按方案变更处理。在全部纳入维度按新假设审完并重算裁决前 SHALL 保持 `BLOCKED`，不提示签字。此规则优先于 Major 修复不重走的规则。
- 运行假设的每次修改 SHALL 在登记表登记，定稿前也登记。

#### Scenario: 规模上限调大后全量重审
- **WHEN** R3 之前，update 把规模上限从 200 改为 2,000
- **THEN** 登记行的规划档位为方案变更，R3 重跑全部纳入维度，评审 agent 审全文

#### Scenario: 定稿后放宽「用户」一行登记为方案变更
- **WHEN** 定稿轮之后，update 把「用户」一行从单用户改为 3 个人
- **THEN** 登记表有一行方案变更，apply 前置校验停止

#### Scenario: 用户选择把规模上限调小
- **WHEN** 定稿轮之后，用户选择把每轮维度数的上限从 5 改为 3，登记行说明为「用户选择：每轮维度数上限 5→3；触发阈值：某轮纳入维度超过 3 个时重开评审」
- **THEN** 登记行的规划档位为范围收窄，不重走评审，签字不失效

#### Scenario: agent 判定的收窄按放宽处理
- **WHEN** update 把规模上限从 50 改为 30，登记行说明以「agent 判定：」开头
- **THEN** 该修改按放宽处理，登记为方案变更，全部纳入维度审全文

#### Scenario: 同一批修改既有收窄又有放宽
- **WHEN** 一次 update 把人数上限从 3 改为 1，同时新增一个数量对象的上限
- **THEN** 该批修改按放宽处理，登记为方案变更

#### Scenario: 只改运行假设的措辞
- **WHEN** update 把「威胁模型：按 ADR 0016」改为「威胁模型：按 ADR-0016」，用户选择措辞，登记行说明以「用户选择：」开头
- **THEN** 登记行的规划档位为措辞，不重走评审

#### Scenario: agent 判定的运行假设措辞按放宽处理
- **WHEN** 定稿轮之后，update 把「用户：单用户本机使用」改为「用户：本机使用」，登记为措辞，说明以「agent 判定：」开头
- **THEN** 该修改按放宽处理，登记为方案变更，全部纳入维度审全文

#### Scenario: 登记为收窄的修改新增了数量对象
- **WHEN** 登记行为范围收窄，规模上限从「每轮 1 至 5 个维度」改为「每轮至多 3 个维度，每个维度至多审 3 份规划文件」，之后因其他方案变更重走门禁
- **THEN** 范围核对按方向判据比较旧值与新值，发现新增数量对象，返回 `assumptions-changed`，全部纳入维度审全文

#### Scenario: 放宽后引用收窄的 risk accepted 改回 open
- **WHEN** 用户把规模上限从 50 改为 10，对 PERF-03 选 risk accepted 并引用该收窄，之后把上限改回 50
- **THEN** 该修改登记为方案变更，全量重走时 PERF-03 改回 `open`，主会话重新询问处理方式

#### Scenario: 收窄不关闭开放的 finding
- **WHEN** 用户选择把规模上限从 50 改为 10，PERF-03 的触发场景要 40 条数据，PERF-03 为 `open`
- **THEN** PERF-03 仍为 `open`，按原有规则处理
- **AND** 之后因其他修改重走时，评审维度不因 PERF-03 落到新假设外而改变它的状态

### Requirement: 撤销风险接受或驳回 SHALL 留痕并在解析中写出代价

撤销一条 finding 的 risk accepted、驳回或移到后续变更时，修改者 SHALL 在共用写入保护内先原子替换 `review-summary.md`。第一次替换 SHALL 同时写入 `BLOCKED` 裁决和待完成的撤销记录，记录 SHALL 绑定 finding ID 与该次原处理决定；没有关联条件或已有原发现也 SHALL 写入。该次替换还 SHALL 将关联条件改为 `待处理` 并清除旧落点。首次替换失败时 SHALL 不修改角色报告。

确认替换完成后，修改者 SHALL 在对应 `review/<role>.md` 的原决定之后增加撤销记录，写明撤销人、原因与日期，按该次决定对应的完整原发现恢复 Findings，台账与该条状态改为 `open`。若旧报告缺原文，SHALL 保留待完成记录并写明原因。能从旧报告核对同 ID 原文时补齐，否则请原维度按当前方案复核同 ID，不得从摘要推测。中断时 SHALL 从实际产物继续，不重复写入同一条撤销记录。

任何发布可签字裁决的入口及归档 SHALL 在同一写入保护内核对汇总中是否有待完成的撤销。普通发布 SHALL 不清除待完成记录。只有在保护内确认同 ID、同次原决定的撤销留痕、完整原发现在 Findings 中恢复、台账与 Findings 均为 `open`、该 ID 全部关联条件为 `待处理` 且无旧落点后，恢复操作才 SHALL 按全部纳入维度重算，并原子替换汇总以写入重算结果、清除该记录。其他待完成的撤销仍 SHALL 保留并阻断签字。没有关联条件时也 SHALL 核对其他依据。任何依据不符时 SHALL 保留记录与 `BLOCKED`，不得发布可签字裁决或移动变更目录。仍开放的 Blocker SHALL 保持阻断，重新开放的 Major SHALL 重新处理。原决定 SHALL 保留但不作为当前处理依据。再次发布可签字裁决前 SHALL 留存旧批准的历史说明，人工确认区留空待重新签字。规则与格式 SHALL 只在 `gate-policy.md` 第 4 节定义。

`openspec-finding-explain` 解析闭环状态为 `risk-accepted`、`false-positive` 或 `deferred` 的 finding 时，SHALL 在文档末尾写「重新打开的代价」一节，列出重新打开后可选的处理及各自的规划修改与重走范围：Major 按定稿后的四种处理（修复、risk accepted、误报、移到后续变更，见 `technical-review-convergence`）写出，Blocker 按 `gate-policy.md` 第 3 节的牵连关系写出要重走的维度。

#### Scenario: 解析已接受的 finding 时写出重新打开的代价
- **WHEN** 用户为一条 `risk-accepted` 的 Major PERF-02 运行 finding 解析
- **THEN** 解析文档末尾有「重新打开的代价」一节，四种处理各写出规划修改与「不重走」

#### Scenario: 撤销接受保留原记录
- **WHEN** 用户撤销 ARCH-28 的 risk accepted
- **THEN** `review/architecture.md` 保留原接受记录，其后有撤销记录，写明撤销人、原因与日期
- **AND** ARCH-28 的闭环状态为 `open`

#### Scenario: 覆写报告后撤销仍可恢复原发现
- **WHEN** 用户接受一条没有关联条件的 Blocker，之后两轮重审均覆写了角色报告，再撤销这次接受
- **THEN** 从角色报告保留的处理记录取回该次决定对应的原发现，以同 ID、原位置、场景和后果恢复为 `open`
- **AND** 不依赖原轮次报告、关联条件或新快照文件

#### Scenario: 撤销写入中断时保留阻断
- **WHEN** 用户撤销已签字的 Blocker 风险接受，汇总已写入 `BLOCKED`，在维度报告同步完成前会话中断
- **THEN** 同一次汇总替换中已写入该 ID 和原决定的待完成记录，已有签字不能让 apply 放行
- **AND** 角色报告未完成时，不清除记录或发布可签字裁决

#### Scenario: 撤销无关联条件的 Blocker 写入失败后直接复审
- **WHEN** 撤销一条没有关联条件、原发现仍在的已接受 Blocker，原子替换汇总后角色报告写入失败
- **AND** 新一轮评审从失败后留在磁盘的产物生成候选，候选版本核对通过
- **THEN** 全部发布入口仍保留该 ID 与原决定的待完成记录，保持 `BLOCKED`，不提示签字

#### Scenario: 核对同次撤销恢复后才重算
- **WHEN** 某 finding 有待完成的撤销，报告已保存撤销留痕、同次原决定的完整原发现与 `open` 状态，且同 ID 全部关联条件均为 `待处理` 且无旧落点
- **THEN** 恢复操作在同一次保护内核对落盘结果，清除该记录，重算全部纳入维度；该 Blocker 仍开放时保持 `BLOCKED`
- **AND** 留痕对应另一次决定、原发现缺失、台账或 Findings 仍未开放、任一关联条件仍有旧落点时，保留记录与 `BLOCKED`

### Requirement: 质量评审的两个角色 SHALL 引用 ADR-0016

`openspec-code-quality` 的 Spec Fidelity 与 Standards 角色文件 SHALL 各有一句话引用 ADR-0016，说明约束流程内 agent 的检查按出错与走捷径评审。两个角色的其他判据 SHALL 不变。

#### Scenario: 角色文件引用 ADR-0016
- **WHEN** 读取 `roles/spec-fidelity.md` 与 `roles/standards.md`
- **THEN** 两个文件都含 `docs/adr/0016-review-threat-model-by-input-source.md`
