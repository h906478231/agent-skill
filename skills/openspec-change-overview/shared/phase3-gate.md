# Phase 3 技术评审门禁：多维度交叉验证

Phase 3 的多维度并行评审本身就是交叉验证机制：同一方案被多个不同专业视角审查，互相发现盲区。**纳入哪些维度由分级决定**（L1 两维 / L2 四维 / L3 全量），分级规则见 `../../openspec-technical-review/shared/gate-levels.md`。

## 交叉验证的典型场景

| 场景 | 单一维度可能漏掉 | 交叉验证如何发现 |
|------|---------------|----------------|
| 幂等设计 | 并发维度认为「有唯一索引就够了」 | 数据库维度发现「索引缺少 tenant_id 前导，跨租户会冲突」 |
| 缓存一致性 | 性能维度建议「缓存永不过期」 | 架构维度发现「无过期机制导致脏数据无法更新」 |
| SQL 注入 | 安全维度发现「拼接 SQL」 | 数据库维度进一步指出「预编译之外还需输入长度校验」 |

## 交叉验证的落地机制

1. **纳入范围的各维度独立评审**：每个子 agent 只读 `proposal.md` + `design.md`，不看其他维度的 `review/<role>.md`，避免锚定偏差
2. **汇总阶段做冲突检测**：`review-summary.md` 必须列出「跨维度冲突项」（如：性能建议与安全建议矛盾）
3. **冲突必须在 design.md 中闭环**：不能让矛盾的建议同时进入 `tasks.md`

## 门禁裁决规则

裁决判定、边界情形与重走范围见 `../../openspec-technical-review/shared/gate-policy.md`（唯一事实源），本文件不复制判定表。要点：任一纳入维度 `verdict = 打回` 或存在**未闭环 Blocker** → `BLOCKED`；全部 `通过 / 有条件通过` 且无未闭环 Blocker → `READY_FOR_HUMAN_APPROVAL`。**人工确认是硬门禁**：人工在 `review-summary.md` 写入 `Technical Review Approved` 前，禁止 `/opsx:apply`。

## 「有条件通过」的条件必须落地

「有条件通过」不等于「通过」。**每一条「条件」必须映射到 `tasks.md` 的一个可勾选任务项**，否则条件写完就没人管，等同于失效。

汇总时在 `review-summary.md` 中列出：

```markdown
## 有条件通过的条件清单

| 条件ID | 来源维度 | 条件内容 | 对应 tasks.md 任务 | 状态 |
|--------|---------|---------|-------------------|------|
| C-01 | database | 幂等键唯一索引须 tenant_id 前导 | T-03 建表 DDL | 待实现 |
| C-02 | performance | 批量 INSERT 须开 rewriteBatchedStatements | T-05 数据写入 | 待实现 |
```

**无法映射到 tasks 的条件，视同 Blocker 处理** —— 因为它没有落地路径。
Phase 6 验证时逐条核对条件是否真的满足，未满足不得归档。

## Blocker 闭环留痕（格式见事实源）

门禁 `BLOCKED` 后回改 `design.md` 时，**必须在末尾登记「评审意见闭环记录」区块** —— 重走门禁的子 agent 是全新上下文，没有留痕它会重新发现同一问题或漏掉验证。区块的列定义与闭合判定（已闭环 / 假闭环 / risk accepted）见 `../../openspec-technical-review/shared/closed-loop-verification.md`，本文件不复制表格。

## 重走门禁（迭代回路）

铁律：**门禁输入是 `design.md`（+ `proposal.md`）。输入变了且变在评审维度上 → 重走；没变 → 不重走。**

完整的场景判定表与牵连关系速查表见 `../../openspec-technical-review/shared/gate-policy.md`。操作命令：

```bash
/opsx:review <change>                          # 全量重走
/opsx:review <change> --roles security         # 增量重走，其余沿用上轮 review/<role>.md
```

**裁决始终对全部纳入维度求值**：沿用维度若仍有未闭环 Blocker，门禁仍 `BLOCKED`。
