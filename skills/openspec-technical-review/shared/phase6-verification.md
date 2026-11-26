# Phase 6 验证：实现与设计交叉核对

Phase 6 的 Coherence 维度（`/opsx:verify` 的三维校验之一）就是交叉验证：用 `design.md` 验证代码实现。

## 三维校验

核心命令：`/opsx:verify <change-name>`

| 维度 | 校验内容 |
|------|---------|
| Completeness | `tasks.md` 勾选是否完整、spec 中的 requirement 是否都已实现 |
| Correctness | requirement ↔ 代码实现映射、scenario 是否被覆盖 |
| **Coherence** | **实现是否偏离 `design.md` 的既定决策**、代码风格与项目模式是否一致 |

存在 `review/spec-fidelity.md` 时，Completeness 与 Correctness 中的需求、场景核对，以及 Coherence 中的设计偏离，读取它的规格覆盖矩阵与设计偏离清单，不逐条搜代码；复用条件与严重级别见 `../../openspec-verify-change/SKILL.md`「复用 Spec Fidelity 结论」。

输出写入变更目录的 `verification.md`：头部的结论字段 `Verify-Verdict`（`PASS` / `FAIL`）与 `Critical-Count`（CRITICAL 的条数）、评分卡 + 按 CRITICAL / WARNING / SUGGESTION 分级的问题清单。archive 读取该文件，不读对话；门禁 `archive` 子命令按两个结论字段阻断归档（取值规则见 `../../openspec-verify-change/SKILL.md`「报告字段」，阻断口径见 `implementation-gate-check.md`「Archive」一节）。**存在 CRITICAL 或 `Verify-Verdict: FAIL` 时不得归档。**

## 门禁特有的补充：条件核对

`/opsx:verify` 不认识 `review-summary.md`（那是门禁的产物，非 OpenSpec 原生 artifact），因此它**不会**核对「有条件通过」的条件。这一步需单独做：

直接读取 `review-summary.md` 的「有条件通过」条件清单，逐条核对 —— **这是门禁闭环的最后一环，也最容易被跳过**。不运行 `/opsx:overview`，也不要求刷新 `overview.md`；存在完整版 overview 时，报告写出它的「最近生成」日期与「依据轮次」。映射规则见 `gate-policy.md`。

| 条件的映射 | 核对内容 |
|-----------|---------|
| 任务 | 任务已勾选，实现确实存在，不只是打了勾 |
| `<文件>:<行号>`（条件只需修改规划产物） | 该行存在，并且写明了条件 |
| `risk-accepted`、`false-positive` 或 `deferred` | 核对当前维度报告中同一 finding 的最近一次处理记录。记录未撤销，且与台账及条件状态相符；不回退到旧记录 |
| 待处理或缺少可核对的任务、行号、当前处理记录 | 仍开放，不得归档 |

结果写进 `verification.md` 的「评审条件」小节：条件、落点、状态及当前处理记录的路径、决定标识和核对内容。没有汇总时写「不适用：该变更未经技术评审」。增量复核也重核条件，不沿用旧结果。

## 受保护的 verify 发布与归档最后复核

`<WRITE>` 指技术评审 skill 的 `scripts/review-write.mjs`。两个入口均在前置核对开始前运行 `node <WRITE> snapshot <changeRoot>`，保留输出，按同一版本核对目录实例、规划、汇总、角色报告与旧验证报告。失配不沿用旧核对。以下子命令通过标准输入接收 JSON：

- **最终发布**：在保护外验证与准备完整报告。`node <WRITE> verify <changeRoot>` 接收 `expected`（原快照）、`repo`（选定的实现仓根目录）、`fingerprint`（开始核对时的 verify 范围指纹）、`report`（候选 Markdown）及 `conditions`（逐项 `{id, closed, handling}`，无条件为空数组）。有有效处理记录的 `handling` 含 `{path, decision, hash}`，`hash` 为该决定标题后的原始正文 SHA-256，截止下一个三级或二级标题。入口复核条件与实现指纹并生成 `Review-Conditions-SHA256`；不要手填。`PASS` 与 `FAIL` 走同一入口。不符或目录已移动时不追写任一路径，不重建活跃目录。
- **归档最后复核**：`node <WRITE> archive <changeRoot>` 接收 `expected`（已通过前置校验的快照）、`repo`、`target`（本变更对应的 `changes/archive/YYYY-MM-DD-<name>`）与 `sync`（本次选择）。同一次保护内复核活跃目录、裁决、签字、开放 Blocker、待完成撤销、验证报告版本与条件及当前处理记录。另按 verify 同范围重算实现指纹，与报告 `Fingerprint` 比较。没有终点用当前指纹；有效变更终点用该提交指纹，既有切片证据检查不变。指纹缺失、不可读、不匹配或无法重算时，不写本次待同步记录、不移动、不启动同步；重新 verify 再做归档前置校验，无效终点先修正。verify 先写则归档重做前置校验；归档先移动则 verify 不追写。不要读取 overview 条件矩阵。
- 归档、verify 发布和撤销共用同一活跃变更写入保护。归档移动成功，从目标释放本次保护；失败从原路径释放。用户确认、同步、完成清单和外部步骤都在保护外。

## 归档后同步与独立同步

归档前只预览差异并取得确认，不写主规格。`sync: {choice: "sync", delta, files}` 中，`delta` 是 `specs/` 下全部增量文件的相对路径与原始 SHA-256；`files` 以 `<能力>/spec.md` 为键，值是 `before`（写前原始 SHA-256，缺失为 `null`）、`target`（已确认目标 SHA-256）及 `content`（目标正文）。跳过用 `choice: "skip"` 与用户理由 `reason`，不需同步用 `choice: "not-needed"`。

最后复核通过后，归档入口移动前原子写 `archive-sync.md`，用本次选择替换失败批次的记录。记录失败不移动；移动失败不写主规格，重试重新确认。只有随目录成功移动的记录授权同步。移动成功并释放保护后执行 `node <WRITE> resume-sync <archivedRoot>`，stdin 传 `{}`。续办不重复移动或外部步骤。

续办核对归档增量，跳过已达目标的文件，只替换仍为写前版本的文件。冲突拒绝覆写；释放保护后重新预览和确认，以 `replacement`（新同步方案）和 `expectedRecord`（原记录的原始 SHA-256）重试。中断保留归档与待补记录；全部达到目标才记 `synced`。

独立同步保留原授权和入口，`node <WRITE> sync <changeRoot>` 接收 `{delta, files}`，不要求先归档、不读归档记录。三条路径共用主规格根目录的 `.main-spec-sync.lock`，忙时不写，不与活跃变更保护同时持有。归档摘要和完成清单分别报告移动和「已同步」「不需同步」「未选择同步」「待补同步」。

## 核对签字后规划修改的档位

读取 `review-summary.md` 的「定稿与签字后修改」登记表。按 `gate-policy.md` 第 5 节逐行核对措辞、条件落点、范围收窄，检查登记的文件位置与实际内容。核对范围收窄时检查保留部分的引用。若范围收窄行关闭了 Blocker，再按第 6 节确认其「位置」与「涉及代码模块」所列内容均已从保留的 design、specs、tasks 移除。

条件落点按两种来源核对：

- **汇总条件**：按登记的条件编号读取汇总条件原文，检查规划内容没有超出原文。
- **在实现中修复**：核对具名的用户选择、关联 finding 与任务内容；实现后核对对应实现及证据。只要与用户选择及 finding 匹配，无独立条件编号也不因此判为不合规。超出用户选择或无法找到对应依据时记 CRITICAL。

不符合判据时，在 `verification.md` 的 CRITICAL 清单逐行写出登记序号、`文件:行号` 和不符合的判据。例如「超出条件原文」，或「仍引用已移除的场景」。CRITICAL 阻断归档；按 `gate-policy.md` 第 3 节重走受影响维度后再 verify。没有登记表时写明不适用，不补造记录。

## 切片证据与双轴评审核对

`/opsx:verify` 在三维校验中运行 `scripts/implementation-gate.mjs` 的 `evidence` 与 `review` 子命令：缺失 / 不完整 / 失败 / 过期的切片证据与双轴评审 `BLOCKED` 均为 CRITICAL，不适用时写明理由。处理口径的唯一事实源见 `implementation-gate-check.md`，此处不重复。

## 增强交叉核对清单

在 `/opsx:verify` 的标准三维校验基础上，补充以下人工核对项（这些是 `/opsx:verify` 不检查的）：

```markdown
## Phase 6 交叉核对清单

### 1. 回溯第一性原理（设计 → 需求）
- [ ] 实现是否解决了 `proposal.md` 中识别的「底层问题」而非「表面需求」
- [ ] 是否引入了 `proposal.md` 未识别的新约束（如：新依赖、新运维成本）

### 2. 方案选择一致性（实现 → 设计）
- [ ] 代码实现的关键决策点（如：存储选型、并发模型）是否与 `design.md` 推荐方案一致
- [ ] 若实现过程中改了方案，是否回填更新了 `design.md` 并重走门禁

### 3. 评审条件闭环（实现 → 评审）
- [ ] `review-summary.md` 的「有条件通过」条件是否都对应到任务、`<文件>:<行号>` 或有效处理记录，并已闭环
- [ ] 没有可核对的落点或处理记录的条件仍开放

### 4. 设计阶段可测试性验证（补充设计盲区）
- [ ] 关键业务逻辑是否可单测（外部依赖是否可 mock）
- [ ] 是否需要造测试数据，若需要是否已提供脚本

### 5. 运维成本验证（补充设计盲区）
- [ ] 是否新增需要人工干预的场景（如：死信队列需人工重放）
- [ ] 监控/告警/对账工具是否就位
```

**有任一未通过项不得归档。** 报告把未通过项视同 Blocker，`Verify-Verdict` 写 `FAIL`，不记为 CRITICAL。修复后重跑 Phase 6，若修复过程改了设计则需重走对应维度的 Phase 3 门禁。

## 修复后要不要重走门禁？

| 修复性质 | 是否重走 Phase 3 门禁 |
|---------|---------------------|
| 纯 bug 修复，未动设计 | 否，重跑 Phase 6 即可 |
| 修复过程中**改了技术方案**（换存储、改并发模型、改表结构） | **是**，回 `design.md` 更新后按牵连关系重走对应维度 |
| 发现设计缺陷但决定下个变更再改 | 否，记录为 risk accepted 并在 `review-summary.md` 留痕 |

**判据与 Phase 3 一致。** 定稿后的规划修改按 `gate-policy.md` 第 5 节确定规划档位；方案变更按第 3 节重走受影响维度。代码修复没有改变技术方案时不重走门禁。

## 项目自有的验证动作

编译、单测、集测与 Sonar 以外的静态扫描按**项目自身规范**执行，本仓不做约定（这是跨项目 skill 仓，写死构建命令没有意义）。项目配置了 Sonar 时，扫描在 `/opsx:quality` 最后一步执行，verify 按 `../../openspec-code-quality/shared/sonar-scan.md`「Verify 核对」读取结果。全绿才可归档。
