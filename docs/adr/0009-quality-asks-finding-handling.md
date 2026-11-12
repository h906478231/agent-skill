# ADR-0009: quality 用 AskUserQuestion 询问未闭环 Blocker、Major 与 Sonar 问题的处理方式，agent 按回复写入留痕字段

- 状态：已接受
- 日期：2026-11-08
- 决策者：agent-skills 团队（用户 2026-11-08 在 `/opsx:grill` 中确认）
- 关联变更：`openspec/changes/add-autopilot-loop`
- 修改：`skills/openspec-code-quality/shared/sonar-scan.md:63`「决策人只能由用户填写，agent 不得代填」

## 背景

`/opsx:quality` 只报告。未闭环的 Blocker 与 Major 由用户在会话中口头告诉 agent 怎么处理：修复时回 `tasks.md` 新增任务，误报与 risk accepted 按 `gate-policy.md` 第 4 节留痕（`dual-axis-review.md`「修复与重跑」）。

这条路径有三个缺口：

1. **裁决为 PASSED 时，未闭环 Major 没有人决定**。进度规则 R8 只看裁决，PASSED 后直接进入 verify 与 archive。已归档变更的双轴台账中有 22 个 Major：17 个 `closed`，1 个 `risk-accepted`，4 个在归档时仍为 `open`（`add-ste-gate` 的 STD-12、STD-13、SPEC-11，`guard-agent-git-on-artifacts` 的 STD-01）。
2. **托管（`add-autopilot-loop`）中没有选项**。第一轮 quality 写完报告后本轮结束 → 下一轮仍是 R8，再跑 quality → `classify` 没有代码变化，输出「无需新一轮」→ 进展摘要不变，发会话告警。用户只能在告警卡片的文本框中逐条写处理方式，并且多跑一轮。
3. **托管中留痕字段无人能写**。`sonar-scan.md:63` 禁止 agent 填写「决策人」，用户不在电脑前不能改文件，「误报」「接受」行在 verify 记 CRITICAL。`gate-policy.md` 第 4 节只给出「接受人」「驳回人」的示例，没有写明谁来填写。

## 决策

**1. quality 询问每条未闭环的 Blocker 与 Major**

- 双轴裁决之后（项目配置了 Sonar 时在扫描之后），对每条未闭环的 Blocker 与 Major，用 AskUserQuestion 询问处理方式：`修复` / `risk accepted` / `误报`。裁决为 `PASSED` 但仍有未闭环 Major 时也询问。Minor 不询问。
- Sonar 本次修改行上的问题与质量门失败的条件使用同一种询问，选项为 `修复` / `误报` / `接受`。
- 交互会话与托管都执行，skill 不区分运行方式。
- Blocker 与 Major 的选项相同，Blocker 也可以 risk accepted 与误报，沿用 `gate-policy.md` 第 4 节。
- 问题文本写出 finding 摘要，以及 agent 拟好的 risk accepted 理由与触发阈值、误报理由。原因：托管卡片只原样复制问题文本与选项标签，不显示选项说明（`add-autopilot-loop` design D9）。用户用 Other 自填时，以自填文字为准。

**2. 留痕字段可以由 agent 按回复写入**

- 留痕字段：双轴原始报告中驳回记录的「驳回人」、risk accepted 记录的「接受人」，以及 `review/sonar.md` 的「决策人」。
- agent 只能按用户对**该 finding ID 或该 Sonar 行**的 AskUserQuestion 回复写入，记录要写明回复来源：交互会话，或托管决策号。托管的回复由桥接脚本核对 `operator_id` 是用户本人。
- 只适用于 `/opsx:quality` 写的记录。技术评审 `review/<role>.md` 的驳回与 risk accepted 记录不变：评审之后还有签字行，托管也不运行技术评审。

**3. 签署字段不变**

签字行 `Technical Review Approved:`、`tasks.md` 的变更终点区块（含「判定人」）、待环境补测登记的「确认人」、分镜签署行 `Storyboard Approved:`，仍只能由用户写。AskUserQuestion 的回复不能代替。

区分的依据：签署字段决定能否进入下一阶段，或者决定评审与验证的范围（批准方案、把终点之后的提交排除在评审外、推迟验证），写错了会使一项检查失效，记录中看不出来。留痕字段记录的是对一条 finding 的处理：选项与拟好的理由原样写在问题中，记录写明来源，可以追溯到这次回复。

## 备选方案

| 方案 | 结论 |
|---|---|
| 只在裁决不是 `PASSED` 时询问 | 否决：PASSED 时的未闭环 Major 仍不经决定归档（背景 1） |
| 保持现状，只报告 | 否决：托管中多跑一轮，用户只能逐条手写 |
| 只在托管中询问 | 否决：两条路径要分别测试，评测与托管运行的规则不同 |
| 留痕字段保持只由用户填写 | 否决：托管中询问只能收集选择，记录无法闭环，Sonar 行在 verify 记 CRITICAL |
| 只在托管中允许 agent 写入 | 否决：同一种记录在两种模式下留痕规则不同 |
| 理由由用户自己写，或分两步询问 | 否决：手机上逐条输入；托管中每多一次询问就多一张卡片与一次恢复会话 |
| B1、B2 Blocker 只能修复或误报 | 否决：沿用 `gate-policy.md` 第 4 节，不新增限制；记录仍要写理由、触发阈值与来源 |

## 后果

- `sonar-scan.md:63` 改为「决策人按留痕字段规则写入」。其他写有「规则与签字行相同」的位置（`slice-evidence.md:206`、`post-implementation-changes.md:132`、`implementation-gate.mjs` 的注释）指的是签署字段，规则不变。
- `add-autopilot-loop` 的 Non-Goal「不修改各 skill 中的 `AskUserQuestion` 调用」（`design.md:35`）不再成立，范围扩大到 `openspec-code-quality`。现有签字作废，要重走技术评审并重新签字。
- 风险：在手机上点一次就可以 risk accepted 一条 B1（写错数据）或 B2（越权）的 Blocker。记录有理由、触发阈值与来源，可以事后追溯，但不能防止误点。
- 选 `修复` 时 agent 在 `tasks.md` 新增未勾选的任务，进度规则回到 R6，托管下一轮运行 apply，不再出现「无需新一轮」的空转。
- 2026-11-08 `/opsx:update add-autopilot-loop` 定下实施细节（用户确认，见该变更 design D15）：
  - Sonar 选「误报」后不要求用户在 SonarQube 中标记，`review/sonar.md` 的记录就是处理依据。
  - 用户选 `修复`、并且只需改一处规划产物时，由 quality 按问题中的文字修改，不经 `/opsx:update`；要改多处或改 specs 的 Requirement 时，选项为 `回会话处理`。
  - 留痕字段的用户名取项目的 `git config user.name`。
- 2026-11-12 用户选择把决策 1、2 在交互会话中的部分从 `add-autopilot-loop` 拆出先实现（即该变更 Slice 09，分支 `fix/quality-asks-finding-handling`）。起因：Wechat_ServiceV2 `add-es-message-export-api` 的 quality R1 把 6 个 Major 全部写成修复任务，没有人询问是否 risk accepted。托管中的部分（托管决策编号作来源、分批恢复、`回会话处理` 让托管作废）仍随 `add-autopilot-loop` 实现。
