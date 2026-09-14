# Phase 2 方案探索：测试 Seam 决策

Phase 2 除产出候选方案交叉验证矩阵外，还必须确定**从哪些公共边界（Seam）验证行为**。Seam 不先定，apply 阶段的测试就是随手写的——测到内部实现上，一重构测试就碎；测得太低，一个行为要三个测试才能覆盖。

## 什么是 Seam

Seam 是**公共边界**：不打开模块内部、就能观察行为的接口位置。典型 seam：HTTP API、消息契约、应用服务公开接口、CLI 命令、聚合根公开方法。测试住在 seam 上，永远不打进内部。

## design.md 必须包含的「测试 Seam 决策」区块

```markdown
## 测试 Seam 决策

### 选定的 Seam
| Seam | 类型 | 覆盖的行为 |
|------|------|-----------|
| POST /api/orders | HTTP API | 创建订单、订单校验、幂等 |
| OrderAggregate（公开方法） | 领域接口 | 状态机流转、业务规则 |

### 为什么是这些 Seam
- 复用既有 POST /api/orders 接口测试基建（既有 TestRestTemplate 模板），不新增 seam
- 状态机规则在聚合根内部，HTTP 层断言不可读，故保留聚合根这一个较低 seam
- 本变更不新增 seam，seam 总数保持 2

### 每个验收行为挂哪个 Seam
- 「用户可以创建订单」→ POST /api/orders
- 「已支付订单不可再支付」→ OrderAggregate
```

## Seam 选择判据

| 判据 | 通过标准 | 不通过示例 |
|------|---------|-----------|
| **优先复用** | 既有 seam 能覆盖的行为就不新增 seam | 每个行为都开一个新测试入口 |
| **层级最高** | 两个 seam 都能验证同一行为时选高的（HTTP 优先于 Service） | 绕过 API 直接测 Service 内部方法 |
| **数量最少** | seam 总数越少越好，理想是 1 | 无必要地同时测 HTTP + Service + Mapper 三层 |
| **新增有据** | 新增 seam 是设计决策，必须在区块中说明为什么既有 seam 不够 | 静默新增测试专用接口 |

## 检查点

- [ ] 每个验收行为都能映射到至少一个 seam？
- [ ] 新增的 seam 是否说明了既有 seam 为什么不够？
- [ ] tasks.md 每个切片的 `Seam:` 行是否引用了本区块声明的 seam？

## 分级要求

- **L2/L3**：design.md 必含本区块，缺失不得进入 Phase 3 门禁
- **L0/L1**：建议有；缺省时 apply 阶段先与用户口头确认测试边界（见 `../../openspec-apply-change/shared/tdd-discipline.md`「何时生效」）

## 下游消费

- `../../openspec-propose/shared/task-slicing.md`：切片的 `Seam:` 行引用本区块
- `../../openspec-apply-change/shared/tdd-discipline.md`：apply 只在本区块声明的 seam 写测试
- Phase 6 验证的 Correctness 维度：scenario 覆盖检查以本区块的映射为对照
