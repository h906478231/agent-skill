---
name: ddd-domain-command
description: DDD领域命令的建模与实现。聚焦命令定义、目标聚合、专用命令处理器实现类、泛型父接口 `CommandHandler<C, R>`、命令实现与事务边界，不负责应用服务编排。
---

# DDD 领域命令

> 参考: https://ddd-fans.github.io/ddd-guideline/

## 输入
- `docs/ddd/domain-model.md` 提供命令、目标聚合、命令参数、返回模型、领域规则。
- `docs/ddd/application-model.md` 提供应用服务如何调用命令处理器实现类。
- 本 skill 只负责领域命令侧建模与实现，不负责 Req/DTO/Application Service。

## 职责边界
- 负责: 命令对象、命令处理器实现类、聚合调用、领域校验、持久化。
- 不负责: Controller、Req/DTO、Application Service 编排、事务注解放置策略。
- 事务边界默认由应用层控制，命令处理器只表达领域语义。

## 核心规则

### 1. 命令是明确的领域意图
- 一个命令只表达一个明确业务动作。
- 命令参数优先使用值对象、枚举、聚合 ID，而不是裸 `String` / `Long`。
- 命令对象保持不可变，推荐 `final class` + 全参构造。

### 2. 公开入口使用专用命令处理器实现类
- 保留一个通用泛型父接口 `CommandHandler<C, R>`，仅用于约束输入/输出签名。
- 对应用层与 Policy 暴露的稳定入口，使用专用命令处理器实现类 `XxxCommandHandler`。
- 应用层直接注入 `RegisterAccountCommandHandler` 这类专用实现类，而不是直接注入 `CommandHandler<C, R>`。
- 当前默认规则下，不额外生成 `Adapter` 类。
- `XxxCommandHandler` 自身直接承载命令处理逻辑。

推荐公开入口:

```java
package {domainBasePackage}.api;

public interface CommandHandler<C, R> {

    R handle(C command);
}
```
注：上例只对应数据库悲观锁或等价仓储锁定读取方案。若采用 Redis 分布式锁，应在 Application Service 侧先获取锁，再调用该处理器。

### 模板

### 模板：泛型父接口
```java
package {domainBasePackage}.api;

public interface CommandHandler<C, R> {

    R handle(C command);
}
```

### 模板：命令对象
```java
package {domainBasePackage}.command;

import lombok.AllArgsConstructor;
import lombok.Getter;

@Getter
@AllArgsConstructor
public final class RegisterAccountCommand {

    private final Username username;
    private final PlainPassword plainPassword;
    private final Email email;
    private final Phone phone;
    private final VerificationToken verificationToken;
}
```

### 模板：专用公开入口实现类
```java
package {domainBasePackage}.api;

import {domainBasePackage}.aggregate.UserAccount;
import {domainBasePackage}.command.RegisterAccountCommand;
import {domainBasePackage}.model.UserId;
import {domainBasePackage}.repository.UserAccountRepository;
import {domainBasePackage}.service.UserUsernameUniquenessDomainService;
import {domainBasePackage}.service.UserVerificationTokenDomainService;
import lombok.AllArgsConstructor;
import org.springframework.stereotype.Component;

@Component
@AllArgsConstructor
public class RegisterAccountCommandHandler implements CommandHandler<RegisterAccountCommand, UserId> {

    private final UserAccountRepository userAccountRepository;
    private final UserUsernameUniquenessDomainService userUsernameUniquenessDomainService;
    private final UserVerificationTokenDomainService userVerificationTokenDomainService;

    @Override
    public UserId handle(RegisterAccountCommand command) {
        userUsernameUniquenessDomainService.check(command.getUsername());
        userVerificationTokenDomainService.verify(command.getVerificationToken());

        UserAccount account = UserAccount.create(
                UserId.generate(),
                command.getUsername(),
                command.getPlainPassword(),
                command.getEmail(),
                command.getPhone()
        );

        userAccountRepository.save(account);
        return account.getId();
    }
}
```

### 模板：无返回值命令公开入口实现类
```java
package {domainBasePackage}.api;

import {domainBasePackage}.aggregate.UserAccount;
import {domainBasePackage}.command.DisableAccountCommand;
import {domainBasePackage}.repository.UserAccountRepository;
import lombok.AllArgsConstructor;
import org.springframework.stereotype.Component;

@Component
@AllArgsConstructor
public class DisableAccountCommandHandler implements CommandHandler<DisableAccountCommand, Void> {

    private final UserAccountRepository userAccountRepository;

    @Override
    public Void handle(DisableAccountCommand command) {
        UserAccount account = userAccountRepository.findById(command.getTargetUserId());
        account.disable(command.getOperatorId(), command.getReason());
        userAccountRepository.save(account);
        return null;
    }
}
```

### 模板：带并发控制的操作型命令公开入口实现类
```java
package {domainBasePackage}.api;

import {domainBasePackage}.aggregate.Order;
import {domainBasePackage}.command.ConfirmOrderCommand;
import {domainBasePackage}.repository.OrderRepository;
import lombok.AllArgsConstructor;
import org.springframework.stereotype.Component;

@Component
@AllArgsConstructor
public class ConfirmOrderCommandHandler implements CommandHandler<ConfirmOrderCommand, Void> {

    private final OrderRepository orderRepository;

    @Override
    public Void handle(ConfirmOrderCommand command) {
        Order order = orderRepository.findByIdForUpdate(command.getOrderId()); // 或等价的串行化读取方式
        order.confirm(command.getOperatorId());
        orderRepository.save(order); // 乐观锁模式下此处必须做版本校验
        return null;
    }
}
```

注：上例只对应数据库悲观锁或等价仓储锁定读取方案。若采用 Redis 分布式锁，应在 Application Service 侧先获取锁，再调用该处理器。

### 模板：组合式乐观并发控制处理器
```java
package {domainBasePackage}.api;

import {domainBasePackage}.aggregate.UserAccount;
import {domainBasePackage}.command.ChangePhoneCommand;
import {domainBasePackage}.repository.UserAccountRepository;
import {domainBasePackage}.repository.VersionedAggregate;
import lombok.AllArgsConstructor;
import org.springframework.stereotype.Component;

@Component
@AllArgsConstructor
public class ChangePhoneCommandHandler implements CommandHandler<ChangePhoneCommand, Void> {

    private final UserAccountRepository userAccountRepository;

    @Override
    public Void handle(ChangePhoneCommand command) {
        VersionedAggregate<UserAccount> loaded = userAccountRepository.findById(command.getUserId());
        UserAccount account = loaded.getAggregate();

        account.changePhone(command.getPhone());

        userAccountRepository.save(loaded);
        return null;
    }
}
```

注：这里的 `VersionedAggregate<UserAccount>` 只是“聚合 + 版本令牌”的组合包装，不是新的聚合，也不是通过继承扩展原聚合。仓储方法名可以保持普通的 `findById`，推荐让命令处理器直接 `save(loaded)`，而不是显式读取裸 `version` 值。

## 检查清单
- [ ] 命令都来自 `domain-model.md`，没有偷做应用层建模。
- [ ] 命令参数优先使用值对象、枚举、聚合 ID。
- [ ] 每个命令都有对应的 `XxxCommandHandler implements CommandHandler<C, R>`。
- [ ] 应用层与 Policy 依赖 `api` 中的 `XxxCommandHandler`，不直接注入泛型接口。
- [ ] 无返回值命令统一返回 `Void`。
- [ ] 命令处理器中完成加载聚合、调用行为、保存聚合。
- [ ] 命令处理器遵守目标聚合的并发语义，不做裸覆盖保存。
- [ ] 若采用组合式乐观锁，命令处理器使用 `VersionedAggregate<T>` 或等价包装承载版本令牌，优先直接 `save(loaded)`，不通过继承扩展聚合。

## 反模式
- 不要把命令处理器写成 Application Service、Controller 或 DTO 转换器。
- 不要让应用层绕过 `api` 直接依赖 `command` 包内实现细节。
- 不要在命令处理器中混入 HTTP / JSON / MQ 等适配器细节。
- 不要为了公开入口再额外生成 `Adapter` 类。
- 不要让命令处理器反推应用层编排。
- 不要把“业务锁字段”误当成并发控制实现。
- 不要对整存整取聚合做无版本校验的覆盖式保存。