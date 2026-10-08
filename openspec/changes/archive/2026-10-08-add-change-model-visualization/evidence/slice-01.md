# Slice 01 新鲜证据

- Slice: 01
- Behavior: 变更模型可以被检查（格式与 6 项阻断端到端）
- Seam: `node change-model.mjs check <changeRoot>`
- Recorded At: 2026-10-08T07:06:52Z
- Fingerprint: git-tree:2706d4050ae9b059bd1a041f11c4669fd5503d05
- Fingerprint Source: node skills/openspec-technical-review/scripts/implementation-gate.mjs fingerprint openspec/changes/add-change-model-visualization
- Result: PASS

## 变更文件
- skills/openspec-change-overview/shared/change-model.md
- skills/openspec-change-overview/scripts/change-model.mjs
- skills/openspec-change-overview/vendor/js-yaml.mjs
- skills/openspec-change-overview/vendor/js-yaml.LICENSE
- scripts/test-change-model.mjs
- package.json

## 验证命令
| 命令 | 结果 | 摘要 |
|------|------|------|
| `npm run -s test:change-model` | PASS | 18 tests, 18 pass, 0 fail |
| `node --check skills/openspec-change-overview/scripts/change-model.mjs` | PASS | 语法检查通过（JS 项目无类型检查，以语法检查替代） |
| `npm test`（全部切片完成后刷新指纹） | PASS | verify 168 条引用可达；orchestration 15 + migration 24 + gate 22 + ste 41 + change-model 30（含本切片全部用例），全部通过 |

## 覆盖的验收行为
- change-model / Unchanged element → 「check：合法模型退出码 0，输出与 STE 检查相同字段的 JSON；没有 diff 的迁移视为未变」
- change-model / Unsupported section → 「check：顶层出现 sequences 时报 CM-1 schema 阻断」
- change-model / Step causes a transition → 「check：步骤 S5 的 causes: [T5] 指向存在的迁移时不报告；指向不存在的迁移时报 CM-1」
- change-model / Added transition without a scenario → 「check：新增迁移 T5 没有 scenarios 时退出码 1，按 CM-3 报告 T5 及其行号」
- change-model / Scenario reference does not exist → 「check：T6 引用 order-refund/渠道退款成功 而 spec 中没有该 Scenario 时报告缺失的引用」
- change-model / Changed element without before → 「check：修改的迁移 T3 没有 before 时退出码 1，按 CM-4 报告 T3」
- change-model / Removed state still targeted → 「check：状态 CLOSED 已删除而未变迁移 T2 的 to 仍为 CLOSED 时，按 CM-6 报告 T2」「check：未删除的连线指向已删除的步骤时报 CM-6」
- change-model / Valid reference → 「check：order-cancel/已支付订单取消后进入退款中 匹配 spec 中 #### Scenario: 后的文本，引用有效」
- change-model / Missing section → 「check：design.md 存在但没有「可视化判定」小节时退出码 1，报告 CM-5」
- change-model / Declared hit without a model → 「check：小节声明状态变动命中 order-status 而模型没有该状态机时报 CM-5」「check：模型中的流程没有在小节中声明、缺少某一行或格式错误时报 CM-5」
- change-model / No design.md → 「check：没有 design.md 的变更退出码 0，不要求可视化判定」
- change-model / Forbidden alias in a trigger → 「check：迁移 trigger 为「用户退单」且「退单」是禁用别名时，报告 CM-2 及替代词「取消」与所在行」
- change-model / STE skill missing → 「check：找不到 openspec-ste 时跳过 CM-2 并告警，其他规则照常执行」
- 切片行为：ID 唯一、多个代码块 → 「check：迁移 ID 在全部状态机内重复、design.md 有两个 change-model 代码块时报 CM-1」；退出码 2 → 「check：变更目录不存在时退出码 2」

## 剩余风险
- change-model / Apply with a blocking change-model finding 属于 skill 入口，由 Slice 04 覆盖。
- 行号按 `key: value` 文本定位；同一状态机内多个元素写成相同的 `key: value` 时，定位到第一处。

## 豁免记录
| From Fingerprint | To Fingerprint | 变化文件 | 不影响本切片行为的理由 | 判定人 | 日期 |
|------------------|----------------|---------|--------------------|-------|------|
