# 门禁裁决与迭代规则（执行层唯一事实源）

> 本文件是 agent 执行门禁时的判定规则**唯一事实源**：怎么裁决、什么时候重走、改了什么要连带重跑什么、不认可结论怎么留痕。
> 路径：`<SKILL_DIR>/shared/gate-policy.md`
>
> **面向人的策略**（变更分级、签字人资格与责任、门禁强制力边界、产物 git 生命周期）不在本文件，见 `workflow/OpenSpec-AI-研发流程.md`。

## 1. 门禁裁决

对**全部纳入范围的维度**求值（含增量重走时沿用上轮结论的维度）：

| 条件 | 裁决 |
|------|------|
| 任一维度 `verdict = 打回`，或存在**未闭环 Blocker**（findings 表中 `严重级别 = Blocker` 且 `闭环状态 = open`，含缺省） | `BLOCKED` |
| 全部 `通过` / `有条件通过`，且无未闭环 Blocker | `READY_FOR_HUMAN_APPROVAL` |

四条补充判定：

- **「声称已闭环但实际未闭环」一律按未闭环 Blocker 计入裁决**（见 `closed-loop-verification.md`）。
- **映射不到 `tasks.md` 的「有条件通过」条件视同 Blocker** —— 没有落地路径的条件等于失效。
- **纳入维度没有评审产物时裁决为 `BLOCKED`**（如增量重走时某个沿用维度上轮没有 `review/<role>.md`）—— 没评审过的维度无法求值，不得推测或编造上轮结论，把该维度加入重跑范围。
- **人工确认是硬门禁**：裁决为 `READY_FOR_HUMAN_APPROVAL` 只代表可以交人审，不代表可以 apply。人工在 `review-summary.md` 写入 `Technical Review Approved` 之前，禁止进入实现。

### 机器可读裁决行（唯一出口）

`review-summary.md` 的人工确认区必须在签字行之前写下面两行。每行只写键和一个枚举值，不加说明文字；hook 与 apply 前置校验按行首键名读取：

```markdown
Gate-Level: L2
Gate-Verdict: BLOCKED
Technical Review Approved: __________
```

| 键 | 取值 | 说明 |
|----|------|------|
| `Gate-Level` | `L1` / `L2` / `L3` / `MVP` | 与分级结论项一致（规则见 `gate-levels.md`） |
| `Gate-Verdict` | `READY_FOR_HUMAN_APPROVAL` / `BLOCKED` | 按本节上表判定，与门禁裁决项一致；理由写在门禁裁决项，不写进这一行 |

- 重走门禁、驳回或 risk accepted 改变裁决时，同步更新 `Gate-Verdict` 行。
- `Gate-Verdict: BLOCKED` 时，**即使签字行已签也禁止 apply**（hook 与 `apply-gate-check.md` 都按此拦截）。
- L3 在签字行后追加 `复核: __________`，对应分级表的「建议第二人复核」。**这一行是建议项**：留空不拦截，hook 与 apply 前置校验都不检查它。
- 本格式引入前生成的 `review-summary.md` 没有 `Gate-Verdict` 行：hook 只校验签字行，apply 前置校验从门禁裁决项读裁决。

裁决为 `BLOCKED` 时，必须在输出中明确告知用户：回改 `design.md` 后要在其末尾 `## 评审意见闭环记录` 区块登记每条 Blocker，格式 `finding ID | 维度 | 原始问题 | 处理方式 | 落在 design 的哪一节 | 轮次`（首轮 R1，依次 R2…）。**不登记，下一轮评审 agent 就会重复报同一个问题。**

## 2. 什么时候重走门禁

铁律：**门禁的输入是 `design.md`（+ `proposal.md`）。输入变了且变在评审维度上 → 重走；没变 → 不重走。**

| 场景 | 做法 |
|------|------|
| 改动牵动跨维度地基（模块归属、一致性口径、表模型） | **全量重走**，纳入范围的维度全跑 |
| 改动只碰单一维度（纯转义、纯索引调整） | **增量重走**，只重跑受影响维度，其余纳入维度沿用上轮 `review/<role>.md` |
| 不认可结论（误报 / 知情接受） | **不重走**，留驳回痕迹，仅更新裁决计数 |
| 仅改文案措辞、补充说明，未动技术决策 | **不重走** |
| 实现阶段改了技术方案（换存储、改并发模型、改表结构） | **重走**，按下方牵连关系表确定范围 |
| 实现阶段纯 bug 修复，未动 design | **不重走** |

**判断口诀：宁可多跑一个维度，不可漏跑被牵连的维度。**

## 3. 牵连关系速查（改了左边，右边也要重跑）

| 改动内容 | 必须一并重跑 |
|---------|-------------|
| 表结构 / 索引 | database + performance + concurrency（幂等键依赖唯一索引） |
| 幂等 / 状态机设计 | concurrency + database |
| 同步改异步（引入 MQ） | 全部维度 |
| 批大小 / 并发度 | performance + concurrency + database |
| 接口出入参 | security + architecture |
| 加密 / 脱敏方案 | security + database（加密字段无法直接建唯一索引） |

增量重走时，**裁决仍对全部纳入维度求值**：沿用维度若仍有未闭环 Blocker，门禁仍 `BLOCKED`。

## 4. 不认可评审结论：驳回与 risk accepted

AI 评审会误报，**被误报卡死不是流程的本意**。两条逃生通道，都必须**具名留痕**，禁止直接删除 finding —— 删掉就没有决策记录了。

前提：**不改 `design.md` 就不重走门禁**。输入没变，重跑只会得到同样的结论。

在 `review/<role>.md` 对应 finding 下追加记录，并把该 finding 的 `闭环状态` 改为 `false-positive` / `risk-accepted`（**保留该行，不得删除**），再在 `review-summary.md` 的裁决计数中扣除。

**误报**（问题不成立）：

```markdown
> **驳回**：SEC-01
> 理由：该导出接口仅对内部管理员开放，且经角色校验，不存在外部输入路径。
> 判定：误报（非 Blocker）
> 驳回人：张三  日期：2026-07-31
```

**risk accepted**（问题真实但决定不修）—— 必须写明接受理由与**复查触发阈值**：

```markdown
> **risk accepted**：PERF-03
> 理由：当前数据量 3000 条，全量加载内存可控。
> 触发阈值：单次 > 5 万条时须改流式处理，届时重开变更。
> 接受人：李四  日期：2026-07-31
```

两者的区别不能混用：**问题不成立叫误报，问题成立但不修叫 risk accepted。** 把真问题写成「误报」会让后续复查失去线索。
