# tasks.md 任务拆分：垂直切片与阻塞 DAG

> 规定 tasks.md 的拆分方式：**垂直切片（tracer bullet）+ 显式阻塞边**，禁止按技术层水平拆分。
> 本模块是任务拆分规则的唯一事实源，**住在它的内容领域**（tasks.md 由 `openspec-propose` 生成，规则随 skill 走、装了 propose 就一定有）。`skills/openspec-propose/SKILL.md` 用 skill 内相对路径 `shared/task-slicing.md` 引用本文件；其他 skill 跨 skill 引用 `../openspec-propose/shared/task-slicing.md`；Glob 兜底搜 `**/openspec-propose/shared/task-slicing.md`。`workflow/OpenSpec-AI-研发流程.md` 引用不复制。
> 配套模块：`../../openspec-explore/shared/seam-decisions.md`（切片的 Seam 行取自 design.md「测试 Seam 决策」区块）、`../../openspec-apply-change/shared/tdd-discipline.md`（apply 按切片实施）。

## 为什么禁止按技术层拆分

「先做所有表 → 再做所有接口 → 最后做所有前端」的水平拆分，在任何一个中间状态系统都不可运行、不可验证。第一个能跑的东西出现得越晚，集成风险积累得越大，agent 也越容易在缺乏真实反馈的情况下连续走偏。

垂直切片让每个可交付单元都打穿全部层：完成一个切片，就有一个可演示、可验证的用户行为。

## 垂直切片规则（tracer bullet）

- 每个切片打穿一条窄但**完整的端到端路径**：schema → 领域/服务逻辑 → API → UI/外部接口 → 测试
- 一个切片完成后必须**独立可演示或可验证**（用户视角的一个行为，不是「数据库层完成」）
- 一个切片的体量必须**装进一个全新 agent 会话的上下文窗口**——超出就继续切
- 需要先整理代码边界才能实施业务变化时，prefactoring 作为第一个切片（「先让变化变容易，再做容易的变化」）

## tasks.md 格式（checkbox 兼容）

`/opsx:apply` 与 `/opsx:verify` 依赖 `- [ ]` / `- [x]` 解析任务进度，切片结构必须包裹在 checkbox **之外**，checkbox 行格式不得改变：

```markdown
## Slice 01: 用户可以创建订单（端到端）
Blocked by: 无（可立即开始）
Seam: POST /orders（HTTP API，见 design.md「测试 Seam 决策」）
Evidence: evidence/slice-01.md

- [ ] T1.1 订单表 schema 与迁移脚本
- [ ] T1.2 POST /orders 接口实现
- [ ] T1.3 创建订单集成测试（验证本切片可演示）

## Slice 02: 用户可以支付订单
Blocked by: Slice 01
Seam: POST /orders/{id}/payment
Evidence: evidence/slice-02.md

- [ ] T2.1 支付状态机与幂等键
- [ ] T2.2 支付接口与集成测试
```

要求：

- `Blocked by:` 必写，无依赖时写「无（可立即开始）」
- `Seam:` 行引用 design.md「测试 Seam 决策」区块声明的公共边界（L2/L3 变更必写）
- `Evidence:` 行指向该切片的新鲜证据记录，路径固定为 `evidence/slice-<id>.md`（相对变更目录，`<id>` 取标题编号）；生成 tasks 时就写上，证据文件由 apply 在勾选前生成。模板、生成时机与新鲜度规则见 `../../openspec-apply-change/shared/slice-evidence.md`
- `Blocked by:` / `Seam:` / `Evidence:` 都写在 checkbox 之外，不得塞进 `- [ ]` 行
- 任务项编号在切片内递增，勾选状态是唯一进度事实源

## 阻塞边与 frontier

- 声明的依赖必须**真实阻塞**（不做完前置切片，本切片无法验证），不是「顺手先做」
- 所有前置切片已完成的切片构成 **frontier**：frontier 上的切片可以并行领取、并行派发子 agent
- 纯线性依赖链按序执行即可，不要为了画 DAG 而制造假依赖

## 宽重构例外：expand-contract

一个波及全库的机械改动（改共享列名、改共享符号类型）无法拆成能独立落绿的垂直切片，**不要硬塞进 tracer bullet**，按 expand-contract 编排：

1. **Expand**：新旧形式并存（新加列/新接口，不删旧的）
2. **Migrate**：按爆炸半径分批迁移调用方（按包/按目录一批一个切片，每批被 Expand 阻塞，批批保持 CI 绿）
3. **Contract**：无调用方残留后，删除旧形式（被全部 Migrate 批次阻塞）

连分批都无法独立保绿时，保持顺序不变，让批次共享一个集成分支，统一在一个「集成验证」切片里保绿。

## 发布前三问（用户确认后 tasks.md 才算定稿）

1. **粒度是否合适**：有没有太粗（一个切片装不下一个上下文）或太细（一天能交付好几个）的切片？
2. **阻塞边是否真实**：每个 Blocked by 是否真的 gate 它？有没有漏掉的依赖？
3. **是否需要合并或再拆**：相邻切片是否其实是一个行为？一个切片是否藏着两个行为？

用户确认通过后，tasks.md 进入定稿状态，可进入技术评审门禁。

## 分级适用

| 等级 | 要求 |
|------|------|
| L0 | 无要求，直接 apply |
| L1 | 建议采用；任务少于 3 条时平铺清单亦可 |
| L2/L3 | **必须采用**；review-summary「有条件通过」的条件仍按任务项映射，映射不到视同 Blocker（不变） |

## 与其他规则的关系

- 切片的 `Seam:` 行 ← design.md「测试 Seam 决策」区块（`../../openspec-explore/shared/seam-decisions.md`）
- apply 按切片 red-green 实施 ← `../../openspec-apply-change/shared/tdd-discipline.md`
- 切片的 `Evidence:` 行 → apply 勾选前生成的证据记录（`../../openspec-apply-change/shared/slice-evidence.md`），verify / archive 据此核对新鲜度
- grill 访谈（skill `openspec-grill`）确认的共识是切片拆分的输入：未消除的隐含假设会直接变成错误的切片边界
