## Context

当前仓库的实现后质量控制由 `/opsx:quality`、`/opsx:verify` 和 `/opsx:archive` 共同承担：Quality 关注代码 diff，Verify 关注任务、规格和设计一致性，Archive 负责最终收口。现有流程已经有实现前的多角色 Technical Review，但实现后的审查没有将工程规范和规格忠实度拆成两个独立视角；同时，`tasks.md` 的 checkbox 只能表达“任务被标记完成”，不能表达某个垂直切片是否在当前代码版本上取得了可复核的验证结果。

本变更属于流程和产物层的横切增强，目标是保留现有 OpenSpec 事实源和命令入口，在 Quality、Apply、Verify、Archive 之间增加明确的报告和证据契约。

## Goals / Non-Goals

**Goals:**

- 将实现后 Review 拆为相互独立的 Standards Review 和 Spec Fidelity Review。
- 固定两条 Review 轴使用的代码基线和变更范围。
- 保留两个 Review 轴的原始报告，并通过汇总报告给出统一裁决。
- 为每个垂直切片建立一份可复核的新鲜证据记录。
- 将证据绑定到切片、Seam、验证命令、结果和当前实现 fingerprint。
- 在 Verify 阶段检查证据完整性、覆盖范围和新鲜度。
- 在 Archive 阶段阻断未闭环的 Review Blocker 和无效切片证据。
- 保持现有 L0 豁免和 Technical Review 职责不变。

**Non-Goals:**

- 不替换实现前的 Technical Review。
- 不把两个 Review 轴合并成单一不可追溯的报告。
- 不为所有历史变更补造切片证据。
- 不规定所有项目必须使用同一套构建或测试命令。
- 不自动执行 git push、创建 PR、部署、发布或云舟任务回写。
- 不把临时验证证据升级为跨变更长期领域事实。

## Decisions

### 1. 采用两个独立 Review 轴，而不是一份混合报告

新增两个原始报告：

- `review/standards.md`：代码规范、复用、可读性、复杂度、死代码和测试可维护性。
- `review/spec-fidelity.md`：proposal、design、spec、tasks、scenario 和实现之间的忠实度。

新增 `review/code-review-summary.md` 作为汇总和裁决文件，但汇总不得覆盖、重排或删除原始报告内容。

**选择理由**：混合报告会让 Blocker 来源、判断依据和责任边界不清；保留两个原始报告可以支持独立复核和后续定位。

**备选方案**：

| 方案 | 成本 | 性能/效率 | 复杂度 | 风险 |
|---|---|---|---|---|
| A：一份统一 Review 报告 | 低 | 单次执行较快 | 低 | 视角混杂，难以确认是规范问题还是规格偏离 |
| B：双轴独立报告 + 汇总裁决 | 中 | 两个 Agent 可并行，墙钟接近较慢轴 | 中 | 需要维护轴边界和汇总逻辑 |
| C：继续使用现有 Quality + Verify，不拆轴 | 最低 | 无新增执行成本 | 最低 | 无法解决独立性和责任边界问题 |

**推荐 B**：它以有限流程成本换取独立性和可追溯性；A 无法保留独立判断，C 无法解决当前根因。

### 2. 两条 Review 轴使用同一固定代码基线

Review 开始时必须记录：

- change name；
- base commit 或等价基线；
- 当前实现 fingerprint；
- Review scope；
- 生成时间。

两个 Review Agent 只读取同一基线对应的变更范围和 OpenSpec artifacts，不读取另一个轴的报告。

**选择理由**：如果两个 Agent 使用不同代码版本，报告之间不可比较，也无法判断后续修复是否使报告失效。

**备选方案**：使用各 Agent 启动时的工作区状态。实现简单，但存在竞态和结果不可复现风险，因此不采用。

### 3. 切片证据以文件形式落在变更目录

每个垂直切片对应：

```text
evidence/slice-<id>.md
```

`tasks.md` 的切片标题区域增加 `Evidence:` 引用；不改变 `- [ ]` / `- [x]` checkbox 格式。

证据至少包含：

- Slice 标识和用户行为；
- 关联的 Seam；
- 记录时间；
- 当前实现 fingerprint；
- 变更文件；
- 验证命令及结果；
- 覆盖的验收行为；
- 剩余风险。

**选择理由**：证据与变更一起归档，能被 Verify 和后续接手者读取；引用放在 checkbox 外部，不破坏现有进度解析。

**备选方案**：把证据直接写在 `tasks.md`。文件更少，但会使任务清单膨胀，难以按切片复核；不采用。

### 4. 新鲜度以实现 fingerprint 为主要判据

证据不能只依赖时间戳。Verify 必须比较证据记录的 fingerprint 与当前待验证实现的 fingerprint：

- 相同：证据可继续使用；
- 不同且变化影响该切片行为：证据过期，必须重跑；
- 只有不影响行为的文案或说明变化：由 Verify 记录豁免理由；
- 无法判断变化影响：按证据过期处理。

**选择理由**：时间新不代表证据对应当前代码；fingerprint 能把验证结论和代码版本绑定。

### 5. 证据生成时机放在切片完成和勾选之前

Apply 按现有 TDD 纪律完成一个切片后：

1. 运行切片相关测试；
2. 运行项目约定的类型检查、编译或等价静态检查；
3. 记录命令和结果；
4. 生成或更新该切片证据；
5. 证据有效后再勾选该切片任务。

完整测试仍在全部切片完成后执行，不替代切片级证据。

### 6. Blocker 裁决采用任一轴阻断

`code-review-summary.md` 必须列出两个轴的状态。任一轴存在未闭环 Blocker，Review 总体状态为 `BLOCKED`，不得进入 Archive。

只有满足以下条件才允许通过：

- 两个原始报告都已生成；
- 两轴都没有未闭环 Blocker；
- 汇总报告记录了固定基线和 fingerprint；
- 所有切片证据存在且有效；
- Verify 没有 CRITICAL 或未解决的证据问题。

### 7. 历史变更和 L0 变更保持兼容

- 本变更只对启用新能力的变更生效；不要求修改历史 archive。
- L0 仍可跳过技术评审和双轴 Review，但若创建了 Review 产物则必须遵守相应完整性规则。
- 没有垂直切片的低风险变更不强制创建空的 `evidence/` 目录，但必须在 Verify 中说明不适用理由。

## Risks / Trade-offs

- **[Risk] Review 成本增加** → 两个轴并行执行，L0 豁免；低风险变更不强制启用完整双轴 Review。
- **[Risk] 两个轴重复报告同一问题** → 在轴定义中规定职责边界；汇总阶段允许关联同一实现位置，但不得删除原始 finding。
- **[Risk] fingerprint 计算方式不统一** → 由实现阶段复用现有 workflow 的 fingerprint 或定义项目级稳定计算方式，证据必须记录生成来源。
- **[Risk] 证据文件增加变更目录体积** → 每个切片只保存 Markdown 摘要，不保存完整测试日志；大日志使用命令和外部构建产物引用。
- **[Risk] 代码修改后忘记更新证据** → Verify 比较 fingerprint；不匹配直接标记为过期并阻断归档。
- **[Risk] 任务被勾选但证据滞后** → Apply 规则要求证据先于任务勾选，Verify 再次核对 checkbox 与证据。
- **[Risk] 汇总报告掩盖独立评审意见** → Archive 前置校验要求两个原始报告必须存在，汇总只做裁决索引。

## Migration Plan

1. 新增两个能力 spec 和流程规则，但不改历史变更目录。
2. 在 Quality 命令中加入双轴 Review 的调度和报告产物。
3. 在 Apply 规则中加入切片证据生成时机和模板。
4. 在 Verify 中加入证据存在性、覆盖性和 fingerprint 新鲜度检查。
5. 在 Archive 中加入双轴 Review 与切片证据的阻断校验。
6. 选取一个新的 L1/L2 变更试运行；根据重复报告、证据生成成本和误报情况调整规则。
7. 不满意时可回滚新增命令规则和产物校验；已有 review/evidence 文件作为普通变更产物保留，不影响旧归档结构。

## Open Questions

- fingerprint 是否统一采用现有 DevOps Route 输出，还是由 Quality/Verify 共同计算一个仓库级 git fingerprint？
- Standards Review 和 Spec Fidelity Review 是否分别由独立 sub-agent 执行，还是允许同一编排器启动两个隔离上下文？
- 项目自定义测试命令是否需要在 `design.md` 或项目配置中声明，还是只记录实际执行命令？

## 测试 Seam 决策

| Seam | 类型 | 覆盖的行为 |
|---|---|---|
| `/opsx:quality <change>` 或对应 `openspec-code-quality` 入口 | 工作流命令/Skill | 双轴 Review 调度、固定基线、独立报告和汇总裁决 |
| `/opsx:apply <change>` 或对应 `openspec-apply-change` 入口 | 工作流命令/Skill | 切片完成前后的证据生成、Evidence 引用和 fingerprint 记录 |
| `/opsx:verify <change>` | 工作流命令 | 证据存在性、覆盖性、新鲜度以及 Review 结果校验 |
| `/opsx:archive <change>` | 工作流命令 | 双轴 Blocker、过期证据和 Verify CRITICAL 的归档阻断 |

### 为什么是这些 Seam

- 变更目标是 OpenSpec 工作流行为，不是业务模块内部实现；优先使用现有命令/Skill 入口验证端到端结果。
- 不新增测试专用命令或内部函数测试入口，避免把验证耦合到编排实现细节。
- Review 报告、evidence 文件和 archive 结果都是可观察输出，因此命令级 Seam 足以验证主要行为。

### 每个验收行为挂哪个 Seam

- 双轴报告独立生成和 Blocker 裁决 → `/opsx:quality <change>`
- 切片证据生成与 fingerprint 记录 → `/opsx:apply <change>`
- 缺失或过期证据被发现 → `/opsx:verify <change>`
- 不满足条件时禁止归档 → `/opsx:archive <change>`
