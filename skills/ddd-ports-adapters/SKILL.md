---
name: ddd-ports-adapters
description: DDD端口适配器架构（六边形架构/洋葱架构/整洁架构）。聚焦领域模块隔离、应用层编排、领域公开接口、基础设施适配器与双文档输入边界。当设计系统架构或模块依赖关系时加载此skill。
---

# DDD 端口适配器架构

> 来源: https://ddd-fans.github.io/ddd-guideline/

## 一、目标

端口适配器架构的核心是把领域模块放在中心位置，让业务语义先稳定下来，再由应用层和基础设施层围绕它完成编排与适配。遵循依赖翻转原则（DIP），利用编程技巧将领域模块居于架构核心，让领域模块不依赖别的模块，别的模块来依赖领域模块。

在当前工作流中，它同时承担两个边界约束：

1. 领域层代码只由 `docs/ddd/domain-model.md` 驱动。
2. 应用层代码只由 `docs/ddd/application-model.md` 驱动，不从纯领域模型反推。

## 二、模块与依赖边界

### 优先方案：独立模块

```
{project}/
  {module}-domain/          <- 领域层，核心模块
  {module}-application/     <- 应用层，编排与事务
  {module}-infrastructure/  <- 基础设施层，持久化/消息/外部系统适配
  {module}-adapter/         <- web/mq/scheduler 等入口适配器
```

### 退化方案：单模块隔离

如果当前项目不拆模块，也必须至少用独立包根隔离领域代码，例如：

- 领域层：`{basePackage}.ddddomain`
- 应用层：`{basePackage}.application`
- 基础设施层：`{basePackage}.infrastructure`
- 入口适配器：`{basePackage}.adapter`

### 依赖方向（不可违反）

```
adapter -> application -> domain
infrastructure -> domain
```

约束：

- domain 不依赖 application、infrastructure、adapter
- application 依赖 domain，但只依赖领域公开接口和领域模型公共类型
- infrastructure 依赖 domain，用于实现仓储、端口、监听适配器等
- adapter 依赖 application，不直接操作聚合和仓储

## 三、双文档输入边界

### `domain-model.md` 负责

- 聚合、命令、事件、值对象、仓储端口、领域服务、Policy 语义
- 领域层对外暴露的公开入口名称

### `application-model.md` 负责

- Application Service 清单
- 用例清单
- Req / DTO 定义
- 命令编排顺序
- 事务边界与一致性要求

### 不允许的倒推

- 不从 `domain-model.md` 猜测 Application Service 数量
- 不从 `domain-model.md` 猜测 Req / DTO
- 不从 `domain-model.md` 猜测 Controller 结构
- 若缺少 `application-model.md`，可以只生成领域层，不生成应用层

## 四、领域公开入口

应用层与 Policy 应依赖每个命令对应的专用公开入口实现类，例如 `RegisterAccountCommandHandler`、`LockAccountCommandHandler`。通用 `CommandHandler<C, R>` 只作为这些专用入口的父接口，用于约束输入/输出类型。

推荐做法：

- `api` 包放通用父接口 `CommandHandler<C, R>` 与专用公开入口实现类 `XxxCommandHandler`
- `api` 包直接放专用公开入口实现类，例如 `RegisterAccountCommandHandler`
- `command` 包保留命令对象与其内部处理实现（如静态 `Handler`）或等价内部实现
- 应用层通过 `XxxCommandHandler` 调用领域能力，不直接注入 `CommandHandler<C, R>`
- 基础设施层实现 repository / port

这保证了：

- 领域模型可以独立编译与测试
- 应用层依赖稳定的专用公开入口命名，而不是面向泛型接口装配
- 泛型只作为签名约束，不污染应用层注入类型

## 五、推荐包结构

### 领域层

```text
{domainBasePackage}/
  shared/
  {子域}/
    api/
    aggregate/
    command/
    event/
    model/
    repository/
    port/
    service/
```

### 应用层

```
{applicationBasePackage}/
  service/
  req/
  dto/
```

### 基础设施层

```
{infrastructureBasePackage}/
  persistence/
  messaging/
  external/
```

### 入口适配器

```
{adapterBasePackage}/
  web/
  mq/
  scheduler/
```

## 六、Application Service 规则

### 来源

Application Service 的边界、数量、方法名、Req、DTO、事务边界都必须来自 `application-model.md`，不能使用“一子域一个 ApplicationService”之类的固定套路强推。

### 职责

Application Service 只做五件事：

1. Req -> 领域值对象/枚举/命令转换
2. 必要时执行用例级串行化控制（如按聚合 ID 获取分布式锁）
3. 调用一个或多个领域公开接口
4. 划分事务边界
5. 结果转换为 DTO

### 禁止下沉

- 不直接依赖聚合实现类
- 不直接依赖仓储
- 不绕过 `api` 直接依赖 `command` 包内实现细节
- 不在 Application Service 中写领域规则判断
- 外部输入若是 `String` / `Long` 等标量，需先转换为领域值对象或枚举，再构造命令
- 若选择 Redis 分布式锁，锁获取属于应用编排步骤，不放进聚合和领域服务内部。

### 推荐模板

```java
package {applicationBasePackage}.service;

import {applicationBasePackage}.dto.UserIdDTO;
import {applicationBasePackage}.req.RegisterAccountReq;
import {domainBasePackage}.api.RegisterAccountCommandHandler;
import {domainBasePackage}.model.UserId;
import {domainBasePackage}.command.RegisterAccountCommand;
import {domainBasePackage}.model.Email;
import {domainBasePackage}.model.Phone;
import {domainBasePackage}.model.PlainPassword;
import {domainBasePackage}.model.Username;
import {domainBasePackage}.model.VerificationToken;
import lombok.AllArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@AllArgsConstructor
public class AccountApplicationService {

    private final RegisterAccountCommandHandler registerAccountCommandHandler;

    @Transactional(rollbackFor = Exception.class)
    public UserIdDTO registerAccount(RegisterAccountReq req) {
        RegisterAccountCommand command = new RegisterAccountCommand(
                new Username(req.getUsername()),
                new PlainPassword(req.getPassword()),
                req.getEmail() == null ? null : new Email(req.getEmail()),
                req.getPhone() == null ? null : new Phone(req.getPhone()),
                new VerificationToken(req.getVerificationToken())
        );

        return new UserIdDTO(registerAccountCommandHandler.handle(command).getValue());
    }
}
```

### 多命令编排模板

```java
@Transactional(rollbackFor = Exception.class)
public CommandResultDTO disableAccount(DisableAccountReq req) {
    disableAccountCommandHandler.handle(new DisableAccountCommand(
            req.getTargetUserId(),
            req.getReason(),
            req.getOperatorId()
    ));

    sessionInvalidationCommandHandler.handle(new InvalidateSessionCommand(
            req.getTargetUserId()
    ));

    return CommandResultDTO.success();
}
```

是否允许这种编排，必须以 `application-model.md` 的用例定义为准。

### 分布式锁服务示例

下例展示“必须串行化”且采用 Redis 分布式锁时的推荐边界：Application Service 先按聚合 ID 获取锁，再调用领域公开入口。领域模块不直接依赖 Redis 客户端。

```java
package {applicationBasePackage}.lock;

import java.time.Duration;
import java.util.function.Supplier;

public interface AggregateLockService {

    <T> T executeWithLock(String lockKey, Duration leaseTime, Supplier<T> action);
}
```

```java
package {applicationBasePackage}.service;

import {applicationBasePackage}.lock.AggregateLockService;
import {applicationBasePackage}.req.ConfirmOrderReq;
import {domainBasePackage}.api.ConfirmOrderCommandHandler;
import {domainBasePackage}.command.ConfirmOrderCommand;
import lombok.AllArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;

@Service
@AllArgsConstructor
public class OrderApplicationService {

    private final AggregateLockService aggregateLockService;
    private final ConfirmOrderCommandHandler confirmOrderCommandHandler;

    @Transactional(rollbackFor = Exception.class)
    public void confirmOrder(ConfirmOrderReq req) {
        String lockKey = "order:" + req.getOrderId();
        aggregateLockService.executeWithLock(lockKey, Duration.ofSeconds(10), () -> {
            confirmOrderCommandHandler.handle(new ConfirmOrderCommand(req.getOrderId(), req.getOperatorId()));
            return null;
        });
    }
}
```

```java
package {infrastructureBasePackage}.lock;

import {applicationBasePackage}.lock.AggregateLockService;
import lombok.AllArgsConstructor;

import java.time.Duration;
import java.util.function.Supplier;

@AllArgsConstructor
public class RedisAggregateLockService implements AggregateLockService {

    @Override
    public <T> T executeWithLock(String lockKey, Duration leaseTime, Supplier<T> action) {
        // 这里放具体 Redis / Redisson 加锁、续租、释放逻辑
        return action.get();
    }
}
```

## 七、Controller 与其他入口适配器

### Controller 规则

- Controller 只接收外部请求并调用 Application Service。
- Controller 不直接 new 领域命令实现。
- Controller 不直接调用仓储或聚合。

```java
package {adapterBasePackage}.web;

import {applicationBasePackage}.service.AccountApplicationService;
import {applicationBasePackage}.req.RegisterAccountReq;
import lombok.AllArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/accounts")
@AllArgsConstructor
public class AccountController {

    private final AccountApplicationService accountApplicationService;

    @PostMapping("/register")
    public ResponseEntity<?> register(@RequestBody RegisterAccountReq req) {
        return ResponseEntity.ok(accountApplicationService.registerAccount(req));
    }
}
```

### 监听器 / 调度器规则

- MQ 消费者、Spring 监听器、Scheduler 都属于 adapter / infrastructure。
- 它们可以调用 Application Service，也可以把事件转交给纯领域 Policy。
- 具体选型来自实现约束，不能反向修改建模边界。

## 八、检查清单

- [ ] 领域代码位于独立模块或独立包根 `ddddomain`
- [ ] 应用层只依赖领域公开接口
- [ ] Application Service 的边界来自 `application-model.md`
- [ ] Req / DTO 只来自 `application-model.md`
- [ ] adapter 没有越过 application 直接操作 domain 内部实现
- [ ] infrastructure 只实现端口，不倒推建模

## 九、禁止事项

- ❌ 用“一子域一个 ApplicationService”覆盖建模文档
- ❌ 从纯领域模型猜 Req / DTO / Controller
- ❌ Application Service 直接依赖仓储或聚合实现
- ❌ Controller 直接调用领域实现类或仓储
- ❌ 因为技术实现方便而打破 `domain -> application` 的依赖边界