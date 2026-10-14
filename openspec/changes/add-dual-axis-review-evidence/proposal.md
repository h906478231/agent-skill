## Why

当前 OpenSpec 已有实现前技术评审、实现后代码质量评审和 Phase 6 Verify，但实现后的审查仍主要由单一质量入口承载，难以明确区分“工程规范是否合格”和“实现是否忠实于需求/设计”。同时，`tasks.md` 的勾选状态不能单独证明每个垂直切片确实经过了与当前代码版本匹配的测试和检查，代码后续变化还可能使原有验证结果失效。

本次变更补充两个闭环能力：一是以固定代码基线并行执行、独立留存的 Standards Review 与 Spec Fidelity Review；二是为每个垂直切片记录绑定当前实现指纹的新鲜验证证据，并在 Verify 和 Archive 前检查证据完整性与有效性。

## 第一性原理分析

### 表面需求 vs 底层问题

- **用户提出的需求**：增加双轴独立 Review，并记录每个切片的新鲜证据。
- **真正要解决的问题**：当前“任务完成”和“代码已被正确、及时、独立验证”之间缺少可追溯的证据边界，导致工程质量问题、规格偏离和过期验证结果可能被混在一起。
- **是否存在需求误解**：这不是简单增加两个 Markdown 文件，而是要建立评审职责边界、固定评审输入版本、切片证据与代码指纹的关联，以及阻断规则。

### 基本约束

| 约束类型 | 具体约束 | 影响 |
|---|---|---|
| 业务约束 | 现有 OpenSpec 已有 Technical Review、Quality、Verify 和 Archive 流程 | 新能力必须增量接入，不能另建平行流程 |
| 技术约束 | `tasks.md` checkbox 是现有进度事实源，不能破坏其解析格式 | 证据引用必须放在切片标题或 checkbox 外部 |
| 治理约束 | Review 报告需要保留独立原始意见，不能用汇总报告替代 | 必须分别保存两个评审轴的报告 |
| 一致性约束 | 代码修改后，旧测试结果可能不再代表当前实现 | 证据必须绑定代码 fingerprint 或等价基线 |

### 必要性验证

- **不做会怎样**：质量评审继续同时承担规范和规格核对，Blocker 来源不清；任务全部勾选时仍可能缺少切片级测试证据；后续代码变化后旧证据可能被误用。
- **做了能带来什么**：每个切片拥有可追溯的验证命令、结果、Seam 和代码版本；实现后评审可以分别回答“代码是否合格”和“需求是否实现正确”；Verify 能识别缺证据、证据过期和未覆盖行为。
- **是否有更简单的替代方案**：只在 `tasks.md` 增加“已测试”文字或只生成一份合并 Review 报告成本更低，但无法证明证据对应当前代码，也无法保留双轴独立判断，因此不足以解决根因。
- **必要性结论**：必须做，但应采用增量方式接入现有 Apply、Quality、Verify 和 Archive，不新增完整独立工作流。

## What Changes

- 新增双轴独立 Review 能力：
  - Standards Review 只检查代码规范、可维护性、复用、复杂度和实现层质量；
  - Spec Fidelity Review 只检查需求、Spec、Design、Tasks 和 Scenario 的实现一致性；
  - 两个评审使用同一固定基线并行执行，互不读取对方原始报告；
  - 分别保存原始报告，并由汇总报告进行裁决；任一轴存在未闭环 Blocker 时阻断后续归档。
- 新增切片新鲜证据能力：
  - 每个垂直切片关联一份证据记录；
  - 记录行为、Seam、验证命令、结果、变更文件、实现 fingerprint 和剩余风险；
  - 切片任务完成前必须生成证据；
  - Verify 检查证据是否存在、是否覆盖验收行为、是否仍匹配当前实现；
  - 证据缺失或过期时不得归档。
- 增强现有 Quality、Apply、Verify、Archive 的前置和收口校验。
- 不改变现有 Technical Review 的职责，不自动执行 Push、PR、部署或其他外部发布动作。

## Capabilities

### New Capabilities

- `dual-axis-review`: 对实现后的变更执行 Standards Review 与 Spec Fidelity Review，保留独立报告并形成阻断裁决。
- `slice-fresh-evidence`: 为每个垂直切片记录绑定实现版本的新鲜验证证据，并在验证和归档阶段校验证据闭环。

### Modified Capabilities

- 无。当前 `openspec/specs/` 没有已存在的主能力规格；本次通过新增能力规格描述与现有 OpenSpec 命令的集成要求。

## Impact

- **流程**：影响 `/opsx:apply`、`/opsx:quality`、`/opsx:verify`、`/opsx:archive` 的执行规则和前置校验。
- **变更产物**：新增 `review/standards.md`、`review/spec-fidelity.md`、`review/code-review-summary.md` 以及 `evidence/slice-*.md`。
- **任务格式**：在不改变 checkbox 解析格式的前提下，为切片增加 Evidence 引用和证据要求。
- **代码与依赖**：不引入业务代码依赖；需要复用现有 OpenSpec status、changeRoot、fingerprint、review 和 archive 机制。
- **兼容性**：历史变更没有新证据时，不应被追溯强制要求；新规则从启用该能力的变更开始生效，并保留 L0 豁免边界。
