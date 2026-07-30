---
name: ddd-coding-workflow
description: DDD 代码落地的双阶段工作流。先根据 `domain-model.md` 生成领域层代码，再根据 `application-model.md` 生成应用层代码。领域模型纯领域，应用模型负责用例编排。
---

# DDD 代码落地工作流

## 目标

把建模结果按两段落地：

- 第一段：领域层代码生成，只依赖 `docs/ddd/domain-model.md`
- 第二段：应用层代码生成，依赖 `docs/ddd/domain-model.md` 和 `docs/ddd/application-model.md`

`domain-model.md` 保持纯领域，不承担应用服务编排信息。
`application-model.md` 负责承载应用层用例、请求/返回模型、事务边界和命令编排。

## 架构前提

1. **优先使用独立领域模块**：领域代码应放在单独的 domain 模块中，不依赖 application 模块。
2. **无独立模块时也要独立包根**：如果用户明确不拆模块，仍必须使用独立包根隔离领域代码，例如 `{basePackage}.ddddomain`。
3. **应用层只依赖领域公开接口**：应用层不得依赖聚合实现细节。应用层与领域层交互时，优先依赖领域模块暴露的公开接口。
4. **领域段可以独立执行**：没有 `application-model.md` 时，可以只执行领域层生成。
5. **应用段不得倒推建模**：`ddd-coding-workflow` 不能因为应用层生成需要而修改 `domain-model.md` 或重做聚合边界。

## 前置条件

### 领域层生成前提

1. `docs/ddd/domain-model.md` 已存在且包含完整纯领域建模结果
2. 项目中已有 shared 基类（`AggregateRoot`、`DomainEvent`、`Identifier`、`DomainException`），如果没有则在阶段 1 创建

### 应用层生成前提

1. `docs/ddd/domain-model.md` 已存在
2. `docs/ddd/application-model.md` 已存在且包含完整应用编排结果
3. 领域层代码已生成并编译通过

## 输入

### 输入一：`docs/ddd/domain-model.md`

至少包含：

- 限界上下文/子域
- 领域事件清单（含类名、所属聚合）
- 事件字段定义
- 领域命令清单（含类名、目标聚合、命令类型、前置条件）
- 命令参数定义
- Policy 清单（含类名、是否有状态、触发动作是否已建模）
- 聚合设计（含聚合根、ID、ID 值类型、状态数据含 `version` 字段说明、不变量含业务状态机约束、领域服务/端口）
- 聚合协作视图（协作原则 / 协作矩阵 / 关键协作时序）

> 并发语义、乐观并发令牌方案、分布式锁选型、CAS 行为、冲突返回语义**不**在 `domain-model.md` 中，由 `application-model.md ## 6. 聚合并发约束` 提供。

### 输入二：`docs/ddd/application-model.md`

至少包含：

- 模块与依赖约束
- 应用服务清单
- 用例清单（含并发冲突语义列）
- 请求模型定义
- 返回模型定义
- 外部协作类型（无 / 本地调用 / 远程查询 / 远程写入）
- 执行方式（同步编排 / 提交后事件 / Saga）
- 一致性要求与事务边界
- 聚合并发约束（每个可写聚合：并发策略 / 并发令牌 / CAS 行为 / 冲突返回语义）
- 失败语义（同事务回滚 / 重试直到成功 / 补偿 / 人工介入）
- 读模型清单状态声明（默认有读模型；明确"无读模型"也算有效声明）
- 领域公开接口约束

## 执行流程

```
第一段：领域层生成
[1/9] 生成 shared 基类 →
[2/9] 生成值对象与枚举 →
[3/9] 生成领域事件 →
[4/9] 生成领域命令与领域公开入口 →
[5/9] 生成聚合根 →
[6/9] 生成仓储接口与领域端口 →
[7/9] 生成领域服务与 Policy 骨架 →
[8/9] 领域层编译验证 →
[9/9] 领域层单元测试 →

第二段：应用层生成
[1/4] 生成 Req / DTO →
[2/4] 生成 Application Service →
[3/4] 应用层编译验证 →
[4/4] 应用层集成测试
```

如果缺少 `application-model.md`，执行完第一段后停止，并明确告诉用户应用层生成前置条件未满足。

---

## 第一段：领域层生成

### 阶段 1：生成 shared 基类

目标：确保领域层基础类存在。

检查项：

- `AggregateRoot<ID>`
- `DomainEvent`
- `Identifier<T>`
- `DomainException`

设计约束：

- `AggregateRoot<ID>` 提供 `domainEvents` 管理能力
- `DomainEvent` 必须包含 `eventId`、`occurredOn`、`aggregateType`、`aggregateId`
- `Identifier<T>` 负责 ID 值封装与相等性判断
- `DomainException` 继承 `RuntimeException`

加载 skill：`ddd-aggregate`、`ddd-domain-event`

验证：编译通过。

### 阶段 2：生成值对象与枚举

目标：根据 `domain-model.md` 的事件字段、命令参数、聚合状态数据生成值对象和枚举。

生成规则：

1. 聚合 ID → 继承 `Identifier<T>` 的值对象类
2. 状态枚举 → 枚举类
3. 复合语义字段（如地址、金额、目标、用途）→ 值对象类
4. 简单标量字段 → 在聚合或命令中直接使用
5. 优先复用已有值对象，避免同义字段重复生成

包路径：

- 独立领域模块时：`{domainBasePackage}.model`
- 单模块隔离时：`{basePackage}.ddddomain.model`

加载 skill：`ddd-value-object`

验证：编译通过。

### 阶段 3：生成领域事件

目标：根据领域事件清单和事件字段定义生成事件类。

生成规则：

1. 每个事件一个类，继承 `DomainEvent`
2. 类名必须以 `Event` 结尾
3. 事件字段完全来自 `domain-model.md`
4. 事件必须不可变：`private final` + getter，无 setter
5. 事件构造函数调用 `super(aggregateType, aggregateId)`
6. 事件携带足够业务信息，减少消费方回查聚合

包路径：

- 独立领域模块时：`{domainBasePackage}.event`
- 单模块隔离时：`{basePackage}.ddddomain.event`

加载 skill：`ddd-domain-event`

验证：编译通过。

### 阶段 4：生成领域命令与领域公开入口

目标：根据领域命令清单生成命令类，并为应用层暴露稳定的领域入口。

生成规则：

1. 每个命令一个 `final class`，类名以 `Command` 结尾
2. 命令参数完全来自 `domain-model.md`
3. 命令只做数据承载，不写业务逻辑
4. 默认在 `api` 包生成通用父接口 `CommandHandler<C, R>`
5. 为每个命令生成专用公开入口实现类 `XxxCommandHandler`，例如 `RegisterAccountCommandHandler implements CommandHandler<RegisterAccountCommand, UserId>`
6. 无返回值命令的专用处理器统一继承或实现 `CommandHandler<XxxCommand, Void>`
7. 在 `api` 包直接生成专用公开处理器实现类；应用层与 Policy 默认依赖 `XxxCommandHandler`，不直接注入 `CommandHandler<C, R>`
8. 专用公开入口实现类 `XxxCommandHandler` 直接承载命令处理逻辑，不再额外生成 `Adapter` 类或命令内部 `Handler` 入口
9. 创建型命令实现：前置校验 → 聚合工厂创建 → 保存
10. 操作型命令实现：加载聚合 → 空值检查 → 调用业务方法 → 保存
11. 操作型命令的聚合加载方式必须匹配 `application-model.md ## 6. 聚合并发约束` 中目标聚合的并发策略：`悲观锁` → 仓储提供锁定读取或等价串行机制；`分布式锁` → 应用层先加锁再调用处理器；`乐观并发(CAS)` → 保存时做版本校验，并发令牌方案与 `application-model.md` 一致；`串行化队列` → 应用层将命令路由到对应聚合 ID 的串行队列；`只读不需要` → 该聚合不应被写入命令调用，建模阶段已矛盾
12. 持有聚合锁期间不生成远程 HTTP / MQ / 文件 I/O 等长耗时代码
13. 业务逻辑在聚合内部，公开入口实现只做编排

包路径建议：

- 命令：`{domainBasePackage}.command` 或 `{basePackage}.ddddomain.command`
- 公开接口：`{domainBasePackage}.api` 或 `{basePackage}.ddddomain.api`
- 实现类：`{domainBasePackage}.api` 或 `{basePackage}.ddddomain.api`

加载 skill：`ddd-domain-command`

验证：

- 每个命令都有对应命令类
- 每个命令都有对应的 `XxxCommandHandler` 公开入口，其签名由 `CommandHandler<C, R>` 约束
- 应用层直接依赖 `api/XxxCommandHandler`，不依赖 `command` 包内实现细节

### 阶段 5：生成聚合根

目标：根据聚合设计生成聚合根类。

生成规则：

1. 继承 `AggregateRoot<{聚合ID类型}>`
2. 内部状态字段来自聚合设计中的状态数据
3. 创建型命令 → 静态工厂方法 `create(...)`
4. 操作型命令 → 实例业务方法
5. 不变量 → 在业务方法入口使用守卫式校验强制保证：条件不满足时立即抛出领域异常并停止执行，不进入后续状态变更
6. 私有构造函数，禁止外部直接 new
7. 只暴露只读状态，不提供 public setter
8. 若 `domain-model.md` 不变量中包含业务状态机约束（如"锁定中不可登录""已提交后不可修改"），则生成明确的状态字段/值对象，并在业务方法入口使用守卫式校验：命中约束条件时立即拒绝执行，不把技术锁（version / 分布式锁键）写进聚合业务语言

包路径：

- 独立领域模块时：`{domainBasePackage}.aggregate`
- 单模块隔离时：`{basePackage}.ddddomain.aggregate`

加载 skill：`ddd-aggregate`

验证：编译通过。

### 阶段 6：生成仓储接口与领域端口

目标：为聚合和领域能力生成稳定的领域端口。

生成规则：

1. 为每个聚合生成 Repository 接口
2. Repository 至少包含 `save()` 和 `findById()`
3. 仅生成建模文档明确需要的查询方法，不因应用层方便性临时新增查询
4. 唯一性校验、密码加密、外部验证等能力生成领域端口接口
5. Repository 必须支持 `application-model.md ## 6. 聚合并发约束` 中目标聚合的并发策略：`悲观锁` 时提供锁定读取或等价能力；`乐观并发(CAS)` 时保存必须执行版本校验或等价 compare-and-swap，并发令牌字段与 `domain-model.md` 中聚合状态数据 `version` 字段一致；`分布式锁` 时仓储不内置加锁，由应用层在仓储外层加锁；`串行化队列` 时仓储不内置队列，由应用层路由到队列；`只读不需要` 时仓储仅提供查询能力，不提供写入入口
6. 接口定义在领域层，具体实现在基础设施层

包路径：

- 独立领域模块时：`{domainBasePackage}.repository`、`{domainBasePackage}.port`
- 单模块隔离时：`{basePackage}.ddddomain.repository`、`{basePackage}.ddddomain.port`

加载 skill：`ddd-domain-service`

验证：编译通过。

### 阶段 7：生成领域服务与 Policy 骨架

目标：根据聚合设计和 Policy 清单生成领域服务与 Policy 骨架。

生成规则：

1. 纯领域逻辑 → 生成领域服务类
2. 需外部实现的能力 → 生成接口（端口）
3. Policy 只根据 `domain-model.md` 的 Policy 清单生成骨架，不自行扩展监听链路
4. Policy 默认依赖专用公开入口实现类 `XxxCommandHandler`；`CommandHandler<C, R>` 只作为其签名约束
5. 若 Policy 标记“是否有状态 = 是”，停止按普通 Policy 生成，要求补充 SAGA / 流程管理器建模后再继续
6. 若 Policy 的触发动作在命令清单中不存在且被标记为“预留”，则跳过代码生成，仅保留语义占位并向用户报告
7. 若技术实现需要 Spring 事件监听器，可在代码骨架中体现，但不得改变建模语义

包路径：

- 独立领域模块时：`{domainBasePackage}.service`
- 单模块隔离时：`{basePackage}.ddddomain.service`

加载 skill：`ddd-domain-service`

验证：编译通过。

### 阶段 8：领域层编译验证

目标：确保领域层代码独立编译通过。

验证通过标准：

- [ ] 领域层无编译错误
- [ ] 领域层不依赖 application 包或 application 模块
- [ ] 每个命令的专用公开入口实现类都由 `CommandHandler<C, R>` 约束
- [ ] 每个聚合都有对应 Repository 接口
- [ ] Policy 仅依赖领域公开 API
- [ ] 每个可写聚合都已按 `application-model.md ## 6. 聚合并发约束` 在仓储或应用层落地其并发策略

### 阶段 9：领域层单元测试

目标：基于 `domain-model.md` 为领域层生成完整测试。

测试范围：

- 聚合根业务方法
- 不变量（含业务状态机约束，如锁定中拒绝、已提交后拒绝）
- 领域命令公开入口
- Policy 事件触发关系

> 并发冲突场景属于应用层 / 基础设施层测试，依据 `application-model.md ## 6. 聚合并发约束`，不在领域层单元测试范围。

加载 skill：`ddd-unit-testing`

验证：

- [ ] 聚合根场景覆盖完整
- [ ] 命令前置条件都有对应测试
- [ ] 每个不变量都有验证测试
- [ ] 每个含业务状态机约束的聚合至少有 1 个状态机约束守卫测试（如锁定中拒绝、已提交后拒绝）
- [ ] 每个已生成的 Policy 至少有 1 个测试

---

## 第二段：应用层生成

### 阶段 1：生成 Req / DTO

目标：根据 `application-model.md` 生成应用层请求模型和返回模型。

生成规则：

1. Req 只来自 `application-model.md` 的请求模型定义
2. DTO 只来自 `application-model.md` 的返回模型定义
3. 不从 `domain-model.md` 反推 Req 或 DTO
4. Req 与 DTO 只做数据传递，不写业务逻辑

包路径：

- `application.{子域}.req`
- `application.{子域}.dto` 或 `application.common.dto`

加载 skill：`ddd-ports-adapters`

验证：编译通过。

### 阶段 2：生成 Application Service

目标：根据 `application-model.md` 的应用服务清单和用例清单生成应用服务。

生成规则：

1. Application Service 的边界来自 `application-model.md`，不从纯领域模型猜测
2. 每个用例方法对应一个明确的用例
3. Application Service 只做五件事：Req 转换 → 必要时执行串行化控制（如按聚合 ID 获取分布式锁）→ 调用专用领域公开入口 → 事务管理 → 结果转换
4. Req 中的外部标量字段必须按 `domain-model.md` 的命令参数类型转换为值对象、枚举或标识后再构造命令
5. 应用层依赖领域公开接口，不依赖聚合实现或领域实现类
6. 方法上的事务边界和一致性要求来自 `application-model.md`
7. 一个用例可以编排多个领域公开接口
8. 不在应用层写领域业务判断
9. 如果 `application-model.md` 标注最终一致，则只生成编排边界和调用骨架，不生成 MQ、Outbox、补偿等基础设施实现
10. 若 `application-model.md` 明确采用分布式锁实现“必须串行化”，则锁获取放在 Application Service 或其外层用例装饰器中；领域模块不直接依赖 Redis 客户端。

包路径：

- `application.{子域}`

加载 skill：`ddd-ports-adapters`

验证：

- [ ] 所有用例都有对应方法
- [ ] 所有方法只依赖领域公开接口
- [ ] 事务边界与 `application-model.md` 一致
- [ ] 未直接暴露领域对象给外部

### 阶段 3：应用层编译验证

目标：确保应用层与领域层协作正确，且依赖方向未破坏。

验证通过标准：

- [ ] 应用层编译通过
- [ ] 应用层不依赖领域实现包
- [ ] 领域层仍不依赖应用层
- [ ] 所有 Req / DTO 放在正确包路径

### 阶段 4：应用层集成测试

目标：验证应用层用例编排、事务边界和与领域层的集成行为。

测试范围：

- Application Service 用例流程
- 事务提交与回滚
- Repository 与领域公开入口集成

加载 skill：`ddd-unit-testing`

验证：

- [ ] 每个 Application Service 至少有 1 个集成测试
- [ ] 关键事务边界都有回滚测试
- [ ] 集成测试只验证已建模的用例，不额外发明用例

---

## 关键约束

1. **两段生成明确分离**：领域层生成和应用层生成必须逻辑分段，领域层可以独立完成。
2. **`domain-model.md` 纯领域**：coding workflow 不能要求它承载应用层信息。
3. **应用层信息只来自 `application-model.md`**：不得从纯领域模型推断 Application Service、Req、DTO、事务用例。
4. **领域模块优先独立**：若项目支持多模块，优先生成独立 domain 模块。
5. **无独立模块时也要隔离包根**：至少用 `ddddomain` 等专属包根隔离领域代码。
6. **应用层通过接口与领域交互**：这一点是强依赖。
7. **不生成基础设施层代码**：MQ、Outbox、Repository 实现、外部适配器等仍单独处理。
8. **严格遵循建模文档**：类名、字段、用例、关系必须与 `domain-model.md` / `application-model.md` 一致。
9. **状态型 Policy 不能降级生成**：遇到 `是否有状态 = 是` 的 Policy，必须回到建模补充 SAGA / 流程管理器信息。
10. **预留动作不生成悬空代码**：若 Policy 指向的动作尚未建模为命令或公开接口，只能跳过生成并报告。
11. **如果输入文档缺字段，停止并反馈**：不能自行补齐关键建模信息。

## 增量生成规则

- `domain-model.md` 变化 → 重新执行第一段，必要时再执行第二段
- `application-model.md` 变化且 `domain-model.md` 未变 → 只执行第二段
- 新增或变更的类用增量方式更新
- 删除的建模对象对应代码需人工确认后删除

## 与 `ddd-architect` 的衔接

- `ddd-architect` 负责输出 `domain-model.md` 和 `application-model.md`
- `ddd-coding-workflow` 只消费，不重做建模
- 如果落地时发现模型缺口，正确流程是：回到 `ddd-architect` 修正文档，再重新执行对应段落

## 应用编排消费规则

`ddd-coding-workflow` 不负责判定同步编排、提交后事件、Saga 或远程 HTTP 写入边界；这些方法论由 `ddd-application-orchestration-modeling` 统一维护。本 skill 只消费 `application-model.md` 中已经声明的应用编排结论。

### 1. 生成前必查项

对每个用例都必须检查 `application-model.md` 是否明确以下字段或等价说明：
- 外部协作类型：`无 / 本地调用 / 远程查询 / 远程写入`
- 执行方式：`同步编排 / 提交后事件 / Saga`
- 一致性要求与事务边界
- 并发冲突语义：`失败返回 / 有限重试 / 排队串行 / 人工介入`
- 失败语义：`同事务回滚 / 重试直到成功 / 补偿 / 人工介入`

对每个可写聚合都必须检查 `application-model.md ## 6. 聚合并发约束` 是否明确：
- 并发策略：`乐观并发(CAS) / 悲观锁 / 分布式锁 / 串行化队列 / 只读不需要`
- 并发令牌（采用乐观并发时）
- CAS 行为
- 冲突返回语义（与用例并发冲突语义一致）

如果上述任一关键字段缺失，停止应用层生成并反馈给 `ddd-architect`，要求补充 `ddd-application-orchestration-modeling` 的建模结论；不得自行假设。

### 2. 按执行方式消费

- `同步编排`：在 `Application Service` 中按 `application-model.md` 声明的顺序编排多个 `XxxCommandHandler`；不把当前用例的必做步骤降级为事件监听链路。
- `提交后事件`：只生成应用层编排边界和领域事件交接骨架；不直接生成 MQ、Outbox、relay、scheduler、远程 HTTP 适配器或补偿实现。
- `Saga`：只有在 `application-model.md` 已明确 Saga / 流程管理器模型时才继续生成；若仅标注“待补充 Saga 建模”，停止并反馈给 `ddd-architect`。
- `远程查询`：可按 `application-model.md` 声明在本地事务前或事务外调用对应端口；不得延长聚合锁持有时间。
- `远程写入`：不得生成事务内直接 HTTP 写入；必须消费 `application-model.md` 中的 `提交后事件` 或 `Saga` 结论。

### 3. 只消费判定结果

- coding 阶段可以根据已声明的执行方式选择代码骨架，但不能重新判断执行方式是否合理
- 如果发现 `application-model.md` 的执行方式与字段语义冲突，例如"远程写入 + 同事务强一致"，停止生成并反馈给 `ddd-architect`
- 如果发现 `application-model.md ## 6. 聚合并发约束` 中并发令牌字段与 `domain-model.md` 聚合状态数据中 `version` 字段不一致（如声明乐观并发但 `version` 字段缺失），停止生成并反馈给 `ddd-architect`
- 如果发现用例并发冲突语义与对应聚合并发约束的冲突返回语义冲突，停止生成并反馈给 `ddd-architect`
