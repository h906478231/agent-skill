## Slice 01: 实现完成后可以生成双轴独立 Review 报告（工作流端到端）
Blocked by: 无（可立即开始）
Seam: `/opsx:quality <change>` 或 `openspec-code-quality` 入口（见 design.md「测试 Seam 决策」）

- [ ] 1.1 定义 Standards Review 与 Spec Fidelity Review 的输入范围、职责边界、finding 前缀和统一报告字段，并与现有 Technical Review / Verify 的职责去重
- [ ] 1.2 增加两个隔离的 Review 执行角色，确保两者使用同一 base commit、current fingerprint 和 review scope，且不读取对方原始报告
- [ ] 1.3 生成 `review/standards.md`、`review/spec-fidelity.md` 和 `review/code-review-summary.md`，汇总报告只引用原始报告并按任一未闭环 Blocker 阻断
- [ ] 1.4 为双轴 Review 增加命令级验证：确认两份原始报告独立存在、基线一致、finding 可定位，且任一 Blocker 会得到 `BLOCKED` 裁决

## Slice 02: 每个垂直切片可以记录与当前实现绑定的新鲜证据
Blocked by: 无（可立即开始）
Seam: `/opsx:apply <change>` 或 `openspec-apply-change` 入口（见 design.md「测试 Seam 决策」）

- [ ] 2.1 定义 `evidence/slice-<id>.md` 模板，记录 Slice 行为、Seam、时间、fingerprint、变更文件、验证命令、结果、覆盖行为和剩余风险
- [ ] 2.2 增强 tasks 切片格式，在 checkbox 外增加 `Evidence:` 引用，同时保持 `- [ ]` / `- [x]` 解析兼容
- [ ] 2.3 在 Apply 切片完成流程中加入“运行切片验证 → 记录结果 → 写入证据 → 再勾选任务”的顺序约束，并支持项目自定义测试/编译命令
- [ ] 2.4 为当前 fingerprint 与证据 fingerprint 一致、缺少证据、证据字段不完整三类情况增加命令级验证

## Slice 03: Verify 和 Archive 可以阻断无效 Review 或过期证据
Blocked by: Slice 01, Slice 02
Seam: `/opsx:verify <change>` 与 `/opsx:archive <change>`（见 design.md「测试 Seam 决策」）

- [ ] 3.1 在 Verify 中检查适用切片的 Evidence 引用、证据文件、验证结果、Seam 覆盖和 fingerprint 新鲜度
- [ ] 3.2 定义行为无关变更的证据豁免记录格式；无法证明不影响切片行为时按证据过期处理
- [ ] 3.3 在 Archive 前置校验中加入双轴 Review 原始报告、汇总裁决、未闭环 Blocker、缺失/过期证据和 Verify CRITICAL 检查
- [ ] 3.4 使用完整变更样例验证通过路径和阻断路径：双轴通过且证据新鲜可以归档；任一 Review Blocker、缺失证据或过期证据不得归档
- [ ] 3.5 更新相关流程说明，明确本能力不追溯强制历史变更，不自动执行 Push、PR、部署或外部任务回写
