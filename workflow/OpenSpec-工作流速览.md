# OpenSpec 工作流速览

> 本文是流程速览。规则以各 skill 的事实源文件为准：
> `skills/openspec-technical-review/shared/phases.md`、`gate-policy.md`、`gate-levels.md`，
> `skills/openspec-apply-change/shared/post-implementation-changes.md` 与
> `skills/openspec-code-quality/shared/dual-axis-review.md`。
>
> **【A】** 表示 `add-review-assumptions` 的待实现规则，不适用于当前流程。

## 变更状态（截至 2026-11-25）

| 变更 | 状态 | 对本文的影响 |
|---|---|---|
| `add-technical-review-convergence` | 已归档 | 定稿轮、签字后规划修改登记及收敛检查已生效 |
| `classify-quality-findings-by-root-cause` | 已归档 | 质量评审按根因类别询问；规划修改走 `/opsx:update` |
| `add-review-assumptions` | 已通过技术评审并签字，待实现 | 【A】标记保留，归档后再更新速览 |

---

## ① 规划

```text
（有未决决策）grill ─→ 共识写入 discussion-log + CONTEXT.md + docs/adr/
│ 决策要先查事实：research / explore 查清 → 回到 grill
│ L0/L1 可跳过 grill；没有未决项 → 直接 propose
│
└─ explore ─→ proposal.md（第一性原理）─→ design.md（方案四维对比 + 测试 Seam）
   │ 【A】L2/L3、MVP 命中信号：design 写「运行假设」三行
   │      使用者（谁、几个人、签字人是不是作者）
   │      威胁模型（默认写「按 ADR-0016」；要防有意伪造时写出要防的检查）
   │      规模上限（每类对象的数字上限，或写「无数量对象」；没有全局默认值）
   │
   └─ propose / ff ─→ specs + tasks.md（垂直切片 + 阻塞 DAG）─→ ◆ 卡点①：STE + 变更模型
      │
      └─ 分级 ─→ L0 / MVP 未命中信号：不评审，直接 apply
                 L1：database + security ｜ L2：+ architecture + performance ｜ L3：五个维度全跑
                 MVP 命中信号：只跑信号映射出的维度 ｜ 拿不准 → 升一级
```

## ② 技术评审

```text
review ─→ 【A】前置：L2/L3、MVP 命中信号时，缺运行假设或缺任一行 → 中止，用 update 补写
│ 【A】评审 agent 先读运行假设：
│      流程内 agent → 按「会出错、会走捷径，不会有意伪造」评审
│      外部输入 / 对外发送的内容 → 按攻击者评审
│ 【A】Blocker / Major 的触发场景以代码开头，数量不超过规模上限：
│      [T1] 正常使用 ｜ [T2] 出错 ｜ [T3] 走捷径 ｜ [T4] 外部输入
│      写不出代码或超出上限 → 写入「假设外观察」：不计数、不影响裁决、不询问用户
│
├─ BLOCKED ─→ 改 design（在「评审意见闭环记录」登记每条 Blocker）─→ review
│ │ 【A】重审范围：第 1 轮审全文；之后只审闭环记录列出的节
│ │      范围外的新发现：带 T 代码的 Blocker 进 findings，其余写入「建议」
│ │      放宽运行假设 → 全量重审，重跑全部纳入维度；措辞或用户选择的收窄 → 不重走
│ │ 第 3 轮起仍为 BLOCKED，且新增 Blocker + Major 不少于上一轮：收窄范围 / risk accepted / 继续修复
│ │ 收窄范围只关闭对应位置和涉及代码模块均已从保留规划中移除的 Blocker
│ │ 误报 / risk accepted → 具名留痕，不重走
│ │ 【A】撤销接受或驳回 → 追加撤销记录（保留原记录），闭环状态改回 open
│ │      explain 解析这类 finding 时写出重新打开的代价（每种处理要重走的维度）
│
└─ READY（定稿轮）─→ 每条 Major 选一种处理（Minor 可以按维度一次选）：
   │ 写成任务 / 接受 / 移到后续变更 → 不重新评审
   │ 改变技术决策 → 只重审受影响的维度（不作为推荐项）
   │ 【A】定稿后重审：只审登记表列出的「文件:行号」
   │
   └─ 签字 ─→ 改规划时，每次登记一种档位
        措辞 / 条件落点 / 范围收窄 → apply 时确认规划档位 → 放行
        方案变更 → 重审受影响的维度
        【A】放宽运行假设 → 记为方案变更，全量重审
        【A】运行假设的措辞或用户选择的收窄 → 记为措辞或范围收窄，不重走
        规划已改而没有登记 → apply 停止
```

## ③ 实现与收口

```text
apply ─→ ◆ 卡点③：签字与规划输入版本校验（逐文件 SHA-256 + 登记表）→ STE → 变更模型
│ 按切片实现 + TDD；证据先于勾选（evidence 绑定实现指纹）
│ 勾选后再改代码 → 在 tasks.md「实现后修改登记」登记一种档位：
│   非行为 / 仅测试 → 不开新一轮 ｜ 等价（用户确认）→ 只重跑 Standards ｜ 行为 → 新增任务，两轴增量重跑
│
└─ quality ─→ Standards ∥ Spec Fidelity → code-review-summary（有 open 的 Blocker 即 BLOCKED）
   │ 【A】两个角色都引用 ADR-0016：约束流程内 agent 的检查按「出错 / 走捷径」评审，其他判据不变
   │ 逐条询问开放的 Blocker、Major（PASSED 时也问）；Minor 不问
   │ 按双轴评审规则的「根因类别」提供选项；C2 不提供代码修复
   │ 代码修复新增任务；规划修改只提示运行 update，quality 不改已有规划
   │ 未处理的 Sonar 行单独询问：修复 / 误报 / 接受
   │
   └─ verify ─→ 三维校验 + 条件核对 + 证据新鲜度 + 双轴裁决核对 + ◆ 卡点④
      │ 核对签字后每个登记行的档位，不符合判据记 CRITICAL
      │ 收窄范围关闭的 Blocker：核对位置和涉及代码模块均已从保留的 design / specs / tasks 移除
      │
      └─ archive ─→ 前置阻断 → specs 同步 → changes/archive/ → recap.md
```

## 旁路

```text
签字后 ─→ autopilot：apply → quality → verify → archive 由调度脚本运行，提问与出口动作经飞书卡片决定
随时   ─→ progress（进度）/ overview（总览）/ explain（解析 finding）/ video（讲解视频）
约束   ─→ 同一检出中，同一时间只有一个变更处于 apply 到 archive 之间
```

---

最后更新：2026-11-25
