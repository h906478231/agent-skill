---
name: ddd-persistence
description: DDD持久化模式。ORM映射聚合、ACID事务、事务边界划分、并发控制（乐观锁/悲观锁）、发件箱模式保证最终一致性。当实现聚合持久化或处理分布式一致性时加载此skill。
---

# DDD 持久化模式 (ORM + 事务 + 发件箱)

> 来源: https://ddd-fans.github.io/ddd-guideline/

## 一、ORM

### 定义
Object-Relational Mapping，通过 ORM 框架将内存对象和数据库关系型对象映射，只需操作对象即可操作数据库。

### ORM 不是 DDD 必须的
ORM 和 DDD 没有必然关系，不使用 ORM 也完全可以实现 DDD。

### ORM 对 DDD 的好处
- **延迟加载**：聚合载入内存后完整可用，延迟加载解决载入数据过多的性能问题
- **变更追踪**：自动完成增量更新，减少手动比对，比全量更新性能更好
- **一级缓存**：同一事务中同一 id 只有一个对象，避免多次载入产生不同对象导致覆盖冲突
- **面向对象操作**：大大简化数据库操作，更容易关注对象本身

### ORM 的缺点
有些 ORM 框架映射能力不足，对聚合内部结构有更严格要求，导致聚合设计不灵活。需评估是否值得。

---

## 二、事务 (Transaction)

### ACID 特性
- Atomic 原子性：要么都执行要么都不执行
- Consistent 一致性：相同数据值一致
- Isolate 隔离性：并发变更序列相互隔离
- Durable 持久性：变更结果持久化不丢失

### DDD 中需要事务的场景
需要持久化的数据：聚合状态、领域事件、发件箱消息、读模型。涉及一致性的都需要事务。

以下动作要满足 ACID：
- 一个聚合的一次变更
- 一个命令的执行过程
- 监听领域事件完成一个动作

### 事务编排
把哪些动作放到一个事务中 = 划分事务边界。在领域模块之外编排（不同场景可能组合不同命令、有不同性能要求）。

### 事务范围大小
符合业务逻辑、性能可接受时，大事务更好（让数据库帮你实现 ACID，降低开发成本）。事务过大导致性能问题或部分失败不符合业务逻辑时才拆小。事务越小越需要最终一致性，开发维护负担越大。

### 锁持有时间
锁只保护“读取最新聚合状态 + 修改 + 保存”这段最小临界区。远程 HTTP 读、复杂计算、外部校验、MQ 投递等动作默认放在事务外或提交后，避免长时间占用数据库锁。

### 数据库不支持 ACID
- 完全不支持（如 Redis）：不适合作为聚合持久化数据库，必须选择支持 ACID 的数据库
- 部分支持（如 MongoDB）：每次命令只修改一个聚合，聚合间通过领域事件最终一致
- 尽量选择 ACID 功能全面的数据库

### 并发正确性
聚合不应被并行修改。加悲观锁（串行化）或乐观锁（后执行者失败）。性能够用时推荐数据库悲观锁（最简单、保证正确性）。

### 业务状态机约束与技术并发控制的分工
- **业务状态机约束**："锁定中不可登录""已提交后不可修改""审批通过后不可撤回"等业务规则，建模为聚合不变量或命令前置条件，写入 `domain-model.md`
- **技术并发控制**：解决"两个执行流同时改同一聚合导致覆盖写"，由 `application-model.md` `## 6. 聚合并发约束` 声明并发策略（乐观并发(CAS) / 悲观锁 / 分布式锁 / 串行化队列 / 只读不需要），本 skill 负责对应实现规约
- 业务状态机约束本身不替代并发控制；状态机检查通过仍可能发生覆盖写
- `domain-model.md` 不出现"业务锁规则"字段；并发语义不出现在 `domain-model.md`

### 输入来源
- 选什么并发策略：来自 `application-model.md` `## 6. 聚合并发约束`
- 是否包含 `version` 字段：来自 `domain-model.md` 聚合状态数据 + `application-model.md` `## 6. 聚合并发约束` 并发令牌列
- CAS 行为细节：来自 `application-model.md` `## 6. 聚合并发约束` CAS 行为列
- 冲突返回语义：来自 `application-model.md` `## 6. 聚合并发约束` 冲突返回语义列 / 用例清单并发冲突语义列

本 skill 不重新决定并发策略，只规约策略落地的技术约束。

### 实现分层
- "必须串行化"首先是建模与应用编排约束，由 `application-model.md` 决定，不是聚合根内部自己完成的技术动作。
- 聚合与领域模型不直接依赖 Redis、Redisson、ZooKeeper 等分布式锁客户端。
- 若 `application-model.md` 选择数据库悲观锁：由应用层控制事务，由仓储基础设施实现在事务内提供锁定读取。
- 若 `application-model.md` 选择 Redis 分布式锁：由应用层在调用领域公开入口前先获取按聚合 ID 的锁，锁实现放在应用层外围或基础设施层。

### 选择规则参考（供 application-model 决策时参考；持久化层不重做选择）
- 乐观锁：冲突概率低，允许后执行者失败，调用方可接受重试
- 悲观锁：同一聚合争用高，必须串行执行，或业务上不能接受基于旧快照再尝试
- 按聚合 ID 串行队列 / Actor：热点聚合特别集中，且希望把冲突前移到应用层排队

### 强制性规则（MUST / SHOULD / MAY）
- 每个可写聚合 `MUST` 在 `application-model.md` `## 6. 聚合并发约束` 中声明并发策略；本 skill 在落地时校验该字段是否齐备。
- 采用乐观并发控制的聚合，其持久化模型 `MUST` 包含 `version`、`etag`、`revision` 或等价并发令牌，且与 `domain-model.md` 中状态数据 `version` 字段一致。
- 乐观锁保存操作 `MUST` 执行原子 compare-and-swap 或等价版本校验。
- 并不是所有聚合都 `MUST` 带 `version` 字段；只有选择乐观并发控制的可写聚合才 `MUST` 具备版本令牌。
- 对数据库承载的聚合更新，数据库原生悲观锁 / 乐观锁 `SHOULD` 作为默认正确性方案。
- Redis 分布式锁 `MAY` 作为热点聚合、跨实例入场控制或底层存储缺少可靠锁/CAS能力时的补充机制。
- Redis 分布式锁 `MUST NOT` 作为数据库承载聚合更新的唯一正确性保障。
- 若使用 Redis 分布式锁，锁粒度 `MUST` 至少收敛到 `aggregateType + aggregateId` 或等价业务键，`MUST NOT` 使用系统级全局锁替代聚合级并发控制。

### 落地规则
1. 锁粒度按聚合 ID，而不是整张表或整类命令。
2. 整存整取聚合禁止“无版本校验的覆盖式 save”。
3. 乐观锁场景：读取聚合时拿到 `version` / `etag`，保存时做 compare-and-swap；冲突后当前写入失败。
4. 悲观锁场景：在事务内以锁定读取方式装载聚合，提交或回滚前不释放锁。
5. 多实例部署时，不要把单 JVM 本地锁当作最终正确性保障。
6. 持锁期间不做远程 HTTP 写、MQ 发送、文件 I/O 等长耗时动作。

### 冲突与重试
- 只对技术性的并发冲突做有限重试，重试上限以 `application-model.md` `## 6. 聚合并发约束` 冲突返回语义为准。
- 重试前必须重新加载聚合，不能基于旧对象再次保存。
- 业务状态机约束失败（不变量违反、命令前置条件未满足）属于领域异常，不属于并发重试范围。

### Redis 分布式锁适用性
- 适合：多实例部署下的热点聚合、需要跨节点串行入场、存储层缺乏可靠行锁或 CAS 能力
- 不适合：把它当成所有聚合的默认必选项，或替代数据库事务内版本校验 / 行锁
- 采用前要明确：锁键、超时时间、续租策略、释放语义、失败后的降级与补偿策略

### 组合式版本令牌示例
如果不希望把 `version` 暴露成聚合业务字段，推荐用组合包装，而不是让“扩展聚合”继承原聚合。

```java
package {domainBasePackage}.repository;

import lombok.AllArgsConstructor;
import lombok.Getter;

@Getter
@AllArgsConstructor
public class VersionedAggregate<A> {

    private final A aggregate;
    private final long version;
}
```

```java
package {domainBasePackage}.repository;

public interface UserAccountRepository {

    VersionedAggregate<UserAccount> findById(UserId userId);

    VersionedAggregate<UserAccount> save(VersionedAggregate<UserAccount> loaded);
}
```

```java
VersionedAggregate<UserAccount> loaded = userAccountRepository.findById(command.getUserId());
UserAccount account = loaded.getAggregate();

account.changePhone(command.getPhone());

userAccountRepository.save(loaded);
```

要点：
- 方法名可保持普通的 `findById`，调用方不需要从方法名感知是否携带版本令牌
- load 时返回“聚合 + 版本令牌”的组合对象
- 业务方法仍然只操作纯聚合对象
- 推荐直接 `save(loaded)`，由仓储基础设施自行读取旧版本令牌并完成 CAS 更新
- 只有在接口必须拆开时，才退化为 `save(aggregate, expectedVersion)` 形式
- 不推荐 `ExtraUserAgg extends UserAgg` 这类继承式包装

---

## 三、发件箱模式 (Outbox Pattern)

### 定义
分布式系统中避免消息丢失和数据不一致的模式：
1. 在业务处理的数据库事务中，把要发送的消息写入本地数据库的发件箱表
2. 在事务外扫描发件箱，发送消息，标记成功，失败重试直到成功

### DDD 中的使用场景
不能利用数据库事务完成强一致性、需要最终一致性时使用。最常见：确保监听领域事件的对象一定能收到事件。

### 保证顺序
一般只需一个聚合或一些聚合的消息保证有序。生成领域事件时给它生成排序标志：
- 数据库自增序列
- 时间戳（注意精度）
- Redis 自增计数器

使用 MQ 时根据具体 MQ 的消息顺序机制设计。

### 消费失败
重新发送，重新消费。

### 避免重复消费
- 重复消费不影响业务逻辑 → 兼容重复消费
- 影响业务逻辑 → 消费端做幂等
- 生成领域事件时给事件生成 id 作为幂等唯一标识

## 四、Outbox-first 本地事件投递规则

当系统既需要本地 Spring 事件，又需要后续接入 Outbox 持久化时，默认采用 Outbox-first，而不是“事务内直接发 Spring 事件”。

### 推荐链路
1. 事务内完成主写模型保存。
2. 同一事务内写入 Outbox 记录。
3. 事务提交后由 relay / scheduler 读取 Outbox。
4. relay 再发布本地 Spring 事件、MQ 消息或远程 HTTP 调用。

### 原因
- 统一事实源，避免一部分事件只存在于内存、一部分事件落库。
- 失败后可重试、可审计、可补发。
- Spring 事件、MQ、HTTP 都变成同一条 Outbox 链路的不同下游适配器。

### 生成与实现决策
- 若 `application-model.md` 标注最终一致，默认采用 Outbox-first。
- 事务内不要生成“写模型成功后立即直发远程 HTTP”的代码。
- 提交后本地 Spring 事件也优先由 Outbox relay 触发，而不是绕过 Outbox 直接发布。
- 监听方与远程调用方都必须按 `eventId` 做幂等。