---
name: ddd-domain-service
description: DDD领域服务、工厂、仓储、Policy 的建模与实现。聚焦无状态对象、仓储端口、领域服务协作与 Policy 骨架，不预设具体监听技术。当设计领域服务层对象时加载此skill。
---

# DDD 领域服务、工厂、仓储、Policy

> 来源: https://ddd-fans.github.io/ddd-guideline/

## 一、职责边界

- `docs/ddd/domain-model.md` 负责定义领域服务、仓储端口、Policy 的语义结论。
- `docs/ddd/application-model.md` 负责定义应用服务边界、事务边界、用例编排。
- 领域服务 skill 负责领域层对象的职责与协作，不负责生成 Req/DTO/Application Service。
- Policy 是否以 Spring 事件监听器、消息消费器、调度器或直接方法调用实现，是后续落地选择，不是建模事实。

## 二、领域服务

### 定义

领域服务是领域模型中的无状态对象，封装算法、跨对象协作或不适合放进某个聚合内部的领域逻辑。

### 何时建模领域服务

- 功能明显属于领域逻辑。
- 功能本身无状态。
- 放进某个聚合会让聚合职责失衡。
- 需要多个领域对象或端口协作完成。

### 常见类型

- 领域服务
- 工厂
- 仓储
- Policy
- 领域公开入口实现（命令处理实现）

### 命名规则

- 领域服务类名统一采用 `[领域]+[功能]+DomainService` 格式，必须以 `DomainService` 结尾。
- `[领域]` 取自所属聚合或子域名称（如 `User`、`Order`、`Account`）。
- `[功能]` 表达该服务承担的领域职责（如 `UsernameUniqueness`、`VerificationToken`、`PriceCalculation`）。
- 示例：`UserUsernameUniquenessDomainService`、`OrderPriceCalculationDomainService`、`AccountVerificationTokenDomainService`。
- 不使用 `XxxChecker`、`XxxVerifier`、`XxxHelper`、`XxxManager`、`XxxService` 等无法体现领域服务身份的后缀。
- 工厂、仓储、Policy 不适用本规则，沿用各自命名约定（`XxxFactory`、`XxxRepository`、`XxxPolicy`）。

### 实现要点

- 一般为单例、无状态。
- 通过构造器注入依赖。
- 可以依赖仓储接口、领域端口和其他领域服务。
- 不承担 HTTP、Req、DTO、Controller、ORM 实体等职责。

---

## 三、工厂

### 定义

工厂封装聚合从无到有的创建过程。它处理创建阶段的领域规则，而不是技术层面的对象实例化。

### 规则

- 聚合创建逻辑复杂时，优先使用工厂。
- 所有创建场景都需要的校验放工厂。
- 仅某个命令需要的临时校验，放命令实现或应用编排层。
- 创建事件由工厂或聚合创建流程注册，不要放到仓储载入逻辑里。

---

## 四、仓储

### 核心原则

- 语义上整存整取。
- 接口定义在领域层，实现在基础设施层。
- Repository 至少提供 `save()` 和 `findById()`。
- 仅生成建模文档明确需要的查询方法，不因“代码方便”临时新增查询。

### 性能处理

- 先考虑延迟加载、脏检查、缓存等实现优化。
- 若性能问题来自聚合过大，应回到建模阶段重新拆分聚合。

---

## 五、Policy

### 定义

Policy 是无状态的领域规则对象，用于响应某个业务事实后触发后续领域动作。它描述的是“当某事件发生时，业务上应该继续做什么”。

### 建模边界

- Policy 名称、触发事件、目标动作来自 `domain-model.md`。
- Policy 是否由应用层同事务调用、Spring 同步事件触发、异步消息触发或调度器触发，不在本 skill 中预设。
- 如果一个流程需要长期持有状态，应升级为 SAGA/流程管理器，而不是把状态塞进 Policy。

### 依赖规则

1. Policy 优先依赖专用公开入口实现类，例如 `LockAccountCommandHandler`；`CommandHandler<C, R>` 只用于说明其输入输出签名。
2. Policy 不直接依赖命令实现类。
3. Policy 不直接依赖应用服务。
4. Policy 不应使用 `new` 创建命令处理实现。
5. 事件应尽量携带足够业务信息，减少 Policy 回查聚合。

### 一致性语义

- 需要强一致时，Policy 可能在同一事务内被同步触发。
- 允许最终一致时，Policy 也可能由异步机制触发。
- 这是实现与部署决策，不应由 Policy 类名或代码模板强行决定。

### 推荐骨架：纯领域 Policy

```java
package {domainBasePackage}.service;

import {domainBasePackage}.api.LockAccountCommandHandler;
import {domainBasePackage}.command.LockAccountCommand;
import {domainBasePackage}.event.LoginFailedEvent;
import lombok.AllArgsConstructor;

@AllArgsConstructor
public class LockAccountAfterLoginFailedPolicy {

    private final LockAccountCommandHandler lockAccountCommandHandler;

    public void on(LoginFailedEvent event) {
        if (event.getFailedLoginCount() < 5) {
            return;
        }

        lockAccountCommandHandler.handle(new LockAccountCommand(
                event.getUserId(),
                event.getFailedLoginCount(),
                event.getOccurredAt()
        ));
    }
}
```

### 可选适配器：Spring 事件监听包装

如果项目最终选择 Spring 事件机制，可以在领域外层增加监听适配器，把事件转交给纯领域 Policy：

```java
package {basePackage}.infrastructure.messaging;

import {domainBasePackage}.event.LoginFailedEvent;
import {domainBasePackage}.service.LockAccountAfterLoginFailedPolicy;
import lombok.AllArgsConstructor;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

@Component
@AllArgsConstructor
public class LoginFailedPolicyListener {

    private final LockAccountAfterLoginFailedPolicy policy;

    @EventListener
    public void handle(LoginFailedEvent event) {
        policy.on(event);
    }
}
```

如果项目明确把 Policy 本身实现为 Spring Bean，也可以直接在 Policy 类上使用 `@Component` / `@EventListener`，但这只是实现风格，不应在建模或 codegen 阶段被默认硬编码成唯一方案。

### 何时不用 Policy

- 聚合内部规则 -> 放进聚合。
- 同一个用例中的显式编排 -> 放进 Application Service。
- 需要持久状态的长流程 -> 使用 SAGA / 流程管理器。

---

## 六、推荐包结构

独立领域模块时：

```
{domainBasePackage}.service
{domainBasePackage}.repository
{domainBasePackage}.port
{domainBasePackage}.api
```

单模块隔离时：

```
{basePackage}.ddddomain.service
{basePackage}.ddddomain.repository
{basePackage}.ddddomain.port
{basePackage}.ddddomain.api
```

---

## 七、检查清单

- [ ] 领域服务是无状态对象
- [ ] 领域服务类名为 `[领域]+[功能]+DomainService`，以 `DomainService` 结尾
- [ ] 没有使用 `XxxChecker`、`XxxVerifier`、`XxxHelper`、`XxxManager`、`XxxService` 等弱化命名
- [ ] 仓储接口只暴露建模文档明确需要的能力
- [ ] Policy 依赖领域公开接口，而不是实现类
- [ ] Policy 技术实现没有被错误固化成唯一方案
- [ ] 需要长期状态的流程没有误建成 Policy

## 八、禁止事项

- ❌ 在领域服务中写 Req / DTO / Controller 逻辑
- ❌ 领域服务命名不带 `DomainService` 后缀，或退化为 `XxxChecker` / `XxxVerifier` / `XxxHelper` / `XxxManager` / `XxxService`
- ❌ Policy 直接依赖应用服务
- ❌ Policy 直接 `new` 命令实现类
- ❌ 把 `@EventListener` 当成 Policy 的唯一实现方式
- ❌ 为了解决性能问题而绕过聚合边界直接改数据库语义
## Policy 与同步编排的边界补充

### 不要把同事务必做步骤误建成 Policy
满足以下任一条件时，优先放进 `Application Service` 同步编排，而不是做成 Policy：
- 步骤失败必须导致当前用例整体回滚。
- 步骤只是当前用例内部多个命令的显式顺序执行。
- 步骤不具有“提交后自动响应某业务事实”的独立语义。

### 适合建模为 Policy 的场景
- 某业务事实发生后，系统自动触发后续动作。
- 该后续动作可以由同步或异步机制承载，但是否同步只是实现决策，不改变其语义。
- 即使当前选择同事务触发，该动作依然是“事实发生后的自动反应”，而不是主流程内部必做步骤。

### 与远程调用的关系
- 远程 HTTP 读/校验不应直接导致新建 Policy；通常属于应用编排前置步骤。
- 远程 HTTP 写若只是提交后副作用，可由 Policy + Outbox / relay 承载。
- 远程 HTTP 写若失败需要补偿或跨事务推进，不应继续留在普通 Policy，应升级到 `ddd-saga`。