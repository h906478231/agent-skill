---
name: ddd-unit-testing
description: DDD单元测试与集成测试生成规则。为聚合根、Command、Policy生成单元测试和集成测试。基于建模文档全量生成测试，支持增量更新。当需要为DDD代码生成测试时加载此skill。
---

# DDD 单元测试与集成测试生成规则

## 测试分类原则

### 单元测试（Unit Tests）
**定义**：测试单个领域对象的业务行为，不依赖外部系统（数据库、网络、文件系统）。

**特征**：
- 速度极快（< 10ms/测试）
- 完全隔离（mock所有基础设施依赖）
- 测试领域逻辑正确性
- 使用真实的领域对象（聚合、值对象、领域服务）

### 集成测试（Integration Tests）
**定义**：测试领域层与基础设施层的集成，验证持久化、事件发布等基础设施行为。

**特征**：
- 速度较慢（> 100ms/测试）
- 依赖真实基础设施（内存数据库、测试容器）
- 测试技术实现正确性
- 验证Repository实现、事务边界、事件发布机制

---

## 测试框架选择

### 单元测试框架
- **JUnit 5** (`org.junit.jupiter.api.Test`)
- **Mockito** (mock基础设施依赖)
- **AssertJ** (流式断言，可选)

### 集成测试框架
- **Spring Boot Test** (`@SpringBootTest`, `@DataJpaTest`)
- **Testcontainers** (真实数据库容器，可选)
- **H2** (内存数据库，快速集成测试)

---

## 阶段 10：单元测试生成

### 10.1 聚合根单元测试（最高优先级）

**测试目标**：聚合的业务方法 + 不变量 + 领域事件发布

#### 测试覆盖规则（基于建模文档完整场景覆盖）

**核心原则**：测试数量由业务场景决定，不是固定的2-3个。必须覆盖建模文档中定义的所有前置条件和业务规则。

##### 1. 创建型方法（静态工厂）测试
从建模文档的"聚合设计"部分提取测试场景：

**必须测试的场景**：
- ✅ **成功路径**：有效参数 → 聚合创建成功 + 产生创建事件
- ✅ **每个必填参数的空值校验**：参数为null → 抛出异常
- ✅ **每个参数的业务规则校验**：参数不符合业务规则 → 抛出异常
- ✅ **组合规则校验**：多个参数的组合约束（如"Email或Phone至少一个"）→ 抛出异常
- ✅ **初始状态验证**：验证聚合的初始状态字段值正确

**示例**（基于UserAccount.create()）：
```java
// 从建模文档提取：create方法的前置条件
// - id, username, password不能为null
// - Email或Phone至少提供一个
// - 初始状态为ACTIVE，failedLoginCount=0

@Test void create_成功后_应产生AccountRegisteredEvent() { ... }
@Test void create_当id为null_应抛出异常() { ... }
@Test void create_当username为null_应抛出异常() { ... }
@Test void create_当password为null_应抛出异常() { ... }
@Test void create_当Email和Phone都为空_应抛出异常() { ... }
@Test void create_当只提供Email_应创建成功() { ... }
@Test void create_当只提供Phone_应创建成功() { ... }
@Test void create_成功后_初始状态应为ACTIVE() { ... }
@Test void create_成功后_failedLoginCount应为0() { ... }
```

##### 2. 业务方法测试
从建模文档的"领域命令清单"中的"前置条件"列提取测试场景：

**必须测试的场景**：
- ✅ **成功路径**：满足所有前置条件 → 业务逻辑执行 + 产生业务事件 + 状态变更正确
- ✅ **每个前置条件的违反场景**：不满足某个前置条件 → 抛出对应异常
- ✅ **状态转换场景**：如果方法涉及状态转换，测试所有可能的状态转换路径
- ✅ **边界值场景**：如果有数值判断（如failedLoginCount >= 5），测试边界值
- ✅ **领域事件验证**：验证事件类型、事件字段值、事件数量

**示例**（基于UserAccount.login()）：
```java
// 从建模文档提取：login命令的前置条件
// - 账号状态不能为DISABLED
// - 如果状态为LOCKED且未到解锁时间，不能登录
// - 密码必须匹配
// - 密码错误5次后自动锁定

@Test void login_成功后_应产生AccountLoggedInEvent() { ... }
@Test void login_成功后_failedLoginCount应重置为0() { ... }
@Test void login_成功后_状态应为ACTIVE() { ... }
@Test void login_当账号状态为DISABLED_应抛出ACCOUNT_DISABLED异常() { ... }
@Test void login_当账号状态为LOCKED且未到解锁时间_应抛出ACCOUNT_LOCKED异常() { ... }
@Test void login_当账号状态为LOCKED但已到解锁时间_应自动解锁并登录成功() { ... }
@Test void login_当密码错误_应产生LoginFailedEvent() { ... }
@Test void login_当密码错误_failedLoginCount应加1() { ... }
@Test void login_当密码错误达到5次_应自动锁定账号() { ... }
@Test void login_当密码错误达到5次_应产生AccountLockedEvent() { ... }
@Test void login_当密码错误第4次_不应锁定账号() { ... } // 边界值测试
```

##### 3. 不变量测试
从建模文档的"聚合设计"中的"不变量"列提取测试场景：

**必须测试的场景**：
- ✅ **每个不变量至少1个测试**：验证不变量在任何业务操作后都成立
- ✅ **不变量破坏场景**：尝试破坏不变量 → 操作被拒绝

**示例**（基于Order聚合的不变量）：
```java
// 从建模文档提取：Order聚合的不变量
// - 订单总金额 = 所有商品金额之和
// - 订单状态转换：未支付 → 已支付/已取消（不可逆）

@Test void addProduct_后_总金额应等于所有商品金额之和() { ... }
@Test void removeProduct_后_总金额应等于所有商品金额之和() { ... }
@Test void pay_后_状态应为已支付() { ... }
@Test void pay_后_不能再次支付() { ... }
@Test void cancel_后_状态应为已取消() { ... }
@Test void cancel_后_不能再支付() { ... }
@Test void pay_后_不能取消() { ... } // 状态不可逆
```

##### 4. 测试场景提取流程

**步骤1：读取建模文档**
- 定位到对应聚合的"聚合设计"部分
- 从"命令-事件映射"表中提取所有命令编号、对应的执行分支与产生事件
- 提取"不变量"列表

**步骤2：对每个命令，查找其前置条件**
- 在"领域命令清单"中找到对应命令
- 读取"前置条件"列的所有条件
- 每个条件生成1个测试（违反该条件的场景）

**步骤3：对每个业务方法，分析状态转换**
- 识别方法涉及的状态字段
- 列举所有可能的状态转换路径
- 每个路径生成1个测试

**步骤4：对每个不变量，生成验证测试**
- 每个不变量至少1个正向验证测试
- 如果不变量可能被破坏，生成破坏场景测试

**步骤5：边界值和特殊场景**
- 识别数值判断（如 >= 5, < 100）
- 生成边界值测试（4, 5, 6 或 99, 100, 101）
- 识别特殊逻辑（如"自动解锁"），生成对应测试

#### 测试模板

```java
package {basePackage}.domain.{子域}.aggregate;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

/**
 * {聚合根名称}聚合根单元测试
 */
class {聚合根名称}Test {

    // ========== 创建型测试 ==========
    
    @Test
    void create_{聚合名}_成功后_应产生{创建事件名}() {
        // Given: 有效的创建参数
        {参数类型} param1 = {有效值};
        {参数类型} param2 = {有效值};
        
        // When: 调用静态工厂方法
        {聚合根名称} aggregate = {聚合根名称}.create(param1, param2);
        
        // Then: 聚合状态正确
        assertNotNull(aggregate.getId());
        assertEquals({期望值}, aggregate.get{字段名}());
        
        // Then: 产生了创建事件
        assertEquals(1, aggregate.getDomainEvents().size());
        assertTrue(aggregate.getDomainEvents().get(0) instanceof {创建事件名}Event);
    }
    
    @Test
    void create_{聚合名}_当{前置条件不满足}_应抛出异常() {
        // Given: 无效参数
        {参数类型} invalidParam = {无效值};
        
        // When & Then: 抛出领域异常
        DomainException exception = assertThrows(
            DomainException.class,
            () -> {聚合根名称}.create(invalidParam, ...)
        );
        assertEquals("{错误码}", exception.getCode());
    }
    
    // ========== 业务方法测试 ==========
    
    @Test
    void {业务方法名}_成功后_应产生{事件名}() {
        // Given: 已创建的聚合
        {聚合根名称} aggregate = {聚合根名称}.create(...);
        aggregate.clearEvents(); // 清空创建事件
        
        // When: 调用业务方法
        aggregate.{业务方法名}({参数});
        
        // Then: 状态变更正确
        assertEquals({期望值}, aggregate.get{字段名}());
        
        // Then: 产生了业务事件
        assertEquals(1, aggregate.getDomainEvents().size());
        {事件名}Event event = ({事件名}Event) aggregate.getDomainEvents().get(0);
        assertEquals({期望值}, event.get{字段名}());
    }
    
    @Test
    void {业务方法名}_当{前置条件不满足}_应抛出异常() {
        // Given: 不满足前置条件的聚合
        {聚合根名称} aggregate = {创建不满足条件的聚合};
        
        // When & Then: 抛出领域异常
        DomainException exception = assertThrows(
            DomainException.class,
            () -> aggregate.{业务方法名}({参数})
        );
        assertEquals("{错误码}", exception.getCode());
    }
    
    // ========== 不变量测试 ==========
    
    @Test
    void {业务方法名}_应维护不变量_{不变量描述}() {
        // Given: 聚合
        {聚合根名称} aggregate = {聚合根名称}.create(...);
        
        // When: 执行可能破坏不变量的操作
        aggregate.{业务方法名}({参数});
        
        // Then: 不变量仍然成立
        assertTrue({不变量验证表达式});
    }
}
```

#### 测试命名规范
- **格式**：`{方法名}_{前置条件}_{预期结果}()`
- **示例**：
  - `create_Order_成功后_应产生OrderCreatedEvent()`
  - `pay_Order_当订单已支付_应抛出异常()`
  - `cancel_Order_应维护不变量_订单状态不可逆()`

---

### 10.2 命令处理器测试

**测试目标**：验证命令处理器实现类（`XxxCommandHandler implements CommandHandler<C, R>`）正确编排聚合业务方法，并正确完成持久化。

#### 测试覆盖规则（基于建模文档完整场景覆盖）

**核心原则**：命令处理器测试数量由命令的前置条件和业务场景决定。必须覆盖建模文档"领域命令清单"中定义的所有前置条件。被测对象是 `XxxCommandHandler`，命令对象本身（`XxxCommand`）作为不可变数据载体不单独测试。

##### 1. 创建型命令处理器测试
从建模文档的"领域命令清单"提取测试场景：

**必须测试的场景**：
- ✅ **成功路径**：满足所有前置条件 → Handler创建聚合 → 保存成功 → 返回聚合ID
- ✅ **每个前置条件的违反场景**：不满足某个前置条件 → Handler抛出异常 → 未保存聚合
- ✅ **领域服务校验场景**：如果有领域服务（如唯一性检查），测试校验失败场景
- ✅ **聚合创建失败场景**：聚合工厂方法抛出异常 → Handler传播异常 → 未保存聚合

**示例**（基于RegisterAccountCommand）：
```java
// 从建模文档提取：RegisterAccount命令的前置条件
// - username必须唯一
// - 验证码必须有效
// - Email或Phone至少提供一个

@Test void handle_RegisterAccount_成功后_应保存聚合() { ... }
@Test void handle_RegisterAccount_成功后_应返回UserId() { ... }
@Test void handle_RegisterAccount_当username已存在_应抛出异常() { ... }
@Test void handle_RegisterAccount_当username已存在_不应保存聚合() { ... }
@Test void handle_RegisterAccount_当验证码无效_应抛出异常() { ... }
@Test void handle_RegisterAccount_当验证码无效_不应保存聚合() { ... }
@Test void handle_RegisterAccount_当Email和Phone都为空_应抛出异常() { ... }
@Test void handle_RegisterAccount_当只提供Email_应创建成功() { ... }
@Test void handle_RegisterAccount_当只提供Phone_应创建成功() { ... }
```

##### 2. 操作型命令处理器测试
从建模文档的"领域命令清单"提取测试场景：

**必须测试的场景**：
- ✅ **成功路径**：聚合存在 + 满足前置条件 → Handler调用聚合方法 → 保存聚合 → 聚合产生事件
- ✅ **聚合不存在场景**：Repository返回null → Handler抛出异常
- ✅ **每个前置条件的违反场景**：聚合状态不满足前置条件 → 聚合抛出异常 → Handler传播异常
- ✅ **领域服务校验场景**：如果有领域服务校验，测试校验失败场景
- ✅ **验证聚合方法被调用**：通过验证聚合产生了领域事件来确认

**示例**（基于LoginCommand）：
```java
// 从建模文档提取：Login命令的前置条件
// - 用户必须存在
// - 账号状态不能为DISABLED
// - 如果状态为LOCKED且未到解锁时间，不能登录
// - 密码必须匹配

@Test void handle_Login_成功后_应保存聚合() { ... }
@Test void handle_Login_成功后_聚合应产生AccountLoggedInEvent() { ... }
@Test void handle_Login_当用户不存在_应抛出USER_NOT_FOUND异常() { ... }
@Test void handle_Login_当用户不存在_不应保存聚合() { ... }
@Test void handle_Login_当账号状态为DISABLED_应抛出ACCOUNT_DISABLED异常() { ... }
@Test void handle_Login_当账号状态为LOCKED_应抛出ACCOUNT_LOCKED异常() { ... }
@Test void handle_Login_当密码错误_应抛出INVALID_PASSWORD异常() { ... }
@Test void handle_Login_当密码错误_应保存聚合() { ... } // 注意：密码错误也要保存（记录失败次数）
@Test void handle_Login_当密码错误_聚合应产生LoginFailedEvent() { ... }
```

##### 3. 测试场景提取流程

**步骤1：读取建模文档的"领域命令清单"**
- 定位到对应命令行
- 读取"前置条件"列的所有条件
- 读取"产生事件"列的事件列表

**步骤2：对每个前置条件，生成违反场景测试**
- 每个前置条件生成1个测试（违反该条件）
- 验证抛出了正确的异常
- 验证未保存聚合（或保存了但状态未变更）

**步骤3：对成功路径，生成完整验证测试**
- 验证Handler调用了Repository.save()
- 验证聚合产生了正确的领域事件（通过getDomainEvents()）
- 如果有返回值，验证返回值正确

**步骤4：对领域服务依赖，生成Mock场景测试**
- 识别Handler依赖的领域服务（如`UserUsernameUniquenessDomainService`）
- 生成领域服务校验失败的测试
- 使用Mockito的when().thenThrow()模拟失败

**步骤5：边界和特殊场景**
- 如果命令涉及数值判断，生成边界值测试
- 如果命令有多个可选参数组合，生成组合测试

#### 测试模板

```java
package {basePackage}.domain.{子域}.api;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import static org.mockito.Mockito.*;
import static org.junit.jupiter.api.Assertions.*;

/**
 * {命令名}CommandHandler 测试
 */
@ExtendWith(MockitoExtension.class)
class {命令名}CommandHandlerTest {

    @Mock
    private {聚合名}Repository {聚合名小写}Repository;
    
    @Mock
    private {领域服务名} {领域服务名小写}; // 如果有领域服务依赖
    
    @InjectMocks
    private {命令名}CommandHandler handler;
    
    // ========== 创建型命令测试 ==========
    
    @Test
    void handle_{命令名}_成功后_应保存聚合() {
        // Given: 有效的命令
        {命令名}Command command = new {命令名}Command({参数});
        
        // When: 处理命令
        {返回类型} result = handler.handle(command);
        
        // Then: 保存了聚合
        verify({聚合名小写}Repository).save(any({聚合名}.class));
        assertNotNull(result);
    }
    
    @Test
    void handle_{命令名}_当前置条件不满足_应抛出异常() {
        // Given: 不满足前置条件的命令
        {命令名}Command command = new {命令名}Command({无效参数});
        
        // Given: Mock领域服务抛出异常
        when({领域服务名小写}.check{条件}(any()))
            .thenThrow(new DomainException("{错误码}", "{错误信息}"));
        
        // When & Then: 抛出异常
        assertThrows(DomainException.class, () -> handler.handle(command));
        
        // Then: 未保存聚合
        verify({聚合名小写}Repository, never()).save(any());
    }
    
    // ========== 操作型命令测试 ==========
    
    @Test
    void handle_{命令名}_成功后_应调用聚合业务方法并保存() {
        // Given: 已存在的聚合
        {聚合名} existingAggregate = {聚合名}.create(...);
        when({聚合名小写}Repository.findById(any()))
            .thenReturn(existingAggregate);
        
        // Given: 有效的命令
        {命令名}Command command = new {命令名}Command({参数});
        
        // When: 处理命令
        handler.handle(command);
        
        // Then: 调用了聚合业务方法（通过验证聚合产生了事件）
        assertFalse(existingAggregate.getDomainEvents().isEmpty());
        
        // Then: 保存了聚合
        verify({聚合名小写}Repository).save(existingAggregate);
    }
    
    @Test
    void handle_{命令名}_当聚合不存在_应抛出异常() {
        // Given: 聚合不存在
        when({聚合名小写}Repository.findById(any()))
            .thenReturn(null);
        
        // Given: 命令
        {命令名}Command command = new {命令名}Command({参数});
        
        // When & Then: 抛出异常
        DomainException exception = assertThrows(
            DomainException.class,
            () -> handler.handle(command)
        );
        assertEquals("{错误码}", exception.getCode());
    }
}
```

#### 关键约束
1. **命令对象本身不测试**：`XxxCommand` 是不可变数据载体，无需单独测试。
2. **测试重点是命令处理器实现类**：验证 `XxxCommandHandler` 的编排逻辑（加载聚合 → 调用业务方法 → 保存聚合）。
3. **Mock所有基础设施**：Repository、领域服务、领域端口都用 Mock。
4. **使用真实聚合**：不 mock 聚合根，让真实业务逻辑产出事件、变更状态。
5. **覆盖并发语义所要求的加载路径**：若 `application-model.md` 声明聚合为 `必须串行化` 且采用仓储锁定读取，则测试中应明确 `findByIdForUpdate` 等专用方法被调用；分布式锁方案下处理器内部不感知锁，由应用层测试单独覆盖。

---

### 10.3 Policy测试

**测试目标**：验证Policy正确监听事件并触发对应命令。

#### 测试覆盖规则
1. **每个Policy至少1个测试**：验证事件触发命令
2. **验证命令参数正确**：确认从事件中提取了正确的数据
3. **验证条件判断**（如果有）：确认Policy的业务规则

#### 测试模板

```java
package {basePackage}.domain.{子域}.service;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import static org.mockito.Mockito.*;

/**
 * {Policy名}Policy测试
 */
@ExtendWith(MockitoExtension.class)
class {Policy名}PolicyTest {

    @Mock
    private {命令名}CommandHandler {命令名小写}CommandHandler;
    
    @InjectMocks
    private {Policy名}Policy policy;
    
    @Test
    void handle{事件名去除Event后缀}_应触发{命令名}Command() {
        // Given: 领域事件
        {事件名}Event event = new {事件名}Event({事件参数});
        
        // When: Policy处理事件
        policy.handle{事件名去除Event后缀}(event);
        
        // Then: 触发了命令
        verify({命令名小写}CommandHandler).handle(argThat(command -> 
            command.get{字段名}().equals(event.get{字段名}())
        ));
    }
    
    @Test
    void handle{事件名去除Event后缀}_当条件不满足_不应触发命令() {
        // Given: 不满足条件的事件
        {事件名}Event event = new {事件名}Event({不满足条件的参数});
        
        // When: Policy处理事件
        policy.handle{事件名去除Event后缀}(event);
        
        // Then: 未触发命令
        verify({命令名小写}CommandHandler, never()).handle(any());
    }
}
```

#### 关键约束
1. **Policy 本质是测试命令触发**：验证事件→命令的映射关系。
2. **Mock 专用 `XxxCommandHandler`**：不测试命令处理器内部执行逻辑（那是 10.2 命令处理器测试的职责）。
3. **验证命令参数**：使用 `argThat` 验证从事件中提取出的命令参数正确性。
4. **不依赖具体监听机制**：测试只验证 `policy.on(event)` 行为，不绑定 `@EventListener` / MQ 监听器具体形式。

---

### 10.4 测试基础设施生成

在生成测试之前，先生成测试辅助类：

```java
package {basePackage}.domain.{子域}.test;

import {basePackage}.domain.shared.AggregateRoot;
import {basePackage}.domain.shared.DomainEvent;
import static org.junit.jupiter.api.Assertions.*;

/**
 * 聚合测试基类
 */
public abstract class AggregateTestBase {
    
    /**
     * 断言聚合产生了指定类型的领域事件
     */
    protected <T extends DomainEvent> T assertDomainEvent(
            AggregateRoot<?> aggregate, 
            Class<T> eventType) {
        return aggregate.getDomainEvents().stream()
            .filter(eventType::isInstance)
            .map(eventType::cast)
            .findFirst()
            .orElseThrow(() -> new AssertionError(
                "Expected event " + eventType.getSimpleName() + " not found"
            ));
    }
    
    /**
     * 断言聚合产生了指定数量的领域事件
     */
    protected void assertEventCount(AggregateRoot<?> aggregate, int expectedCount) {
        assertEquals(expectedCount, aggregate.getDomainEvents().size(),
            "Expected " + expectedCount + " events but got " + aggregate.getDomainEvents().size());
    }
}
```

**包路径**：`{basePackage}.domain.{子域}.test`

---

## 阶段 11：集成测试生成

### 11.1 Repository集成测试

**测试目标**：验证Repository实现正确持久化和查询聚合。

#### 测试覆盖规则
1. **save()方法测试**：验证聚合正确保存到数据库
2. **findById()方法测试**：验证聚合正确加载
3. **自定义查询方法测试**：验证业务查询正确性
4. **事件发布测试**：验证领域事件正确发布到事件总线

#### 测试模板

```java
package {basePackage}.infrastructure.{子域}.repository;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.ActiveProfiles;
import static org.junit.jupiter.api.Assertions.*;

/**
 * {聚合名}Repository集成测试
 */
@DataJpaTest
@ActiveProfiles("test")
@Import({Repository实现类.class}) // 如果需要
class {聚合名}RepositoryIntegrationTest {

    @Autowired
    private {聚合名}Repository repository;
    
    @Test
    void save_应正确持久化聚合() {
        // Given: 新创建的聚合
        {聚合名} aggregate = {聚合名}.create({参数});
        
        // When: 保存聚合
        repository.save(aggregate);
        
        // Then: 可以通过ID查询到
        {聚合名} loaded = repository.findById(aggregate.getId());
        assertNotNull(loaded);
        assertEquals(aggregate.getId(), loaded.getId());
        assertEquals(aggregate.get{字段名}(), loaded.get{字段名}());
    }
    
    @Test
    void findBy{业务属性}_应返回正确的聚合() {
        // Given: 已保存的聚合
        {聚合名} aggregate = {聚合名}.create({参数});
        repository.save(aggregate);
        
        // When: 通过业务属性查询
        {聚合名} found = repository.findBy{业务属性}({属性值});
        
        // Then: 返回正确的聚合
        assertNotNull(found);
        assertEquals(aggregate.getId(), found.getId());
    }
    
    @Test
    void save_应发布聚合的领域事件() {
        // Given: 产生了领域事件的聚合
        {聚合名} aggregate = {聚合名}.create({参数});
        aggregate.{业务方法}({参数}); // 产生业务事件
        
        // When: 保存聚合
        repository.save(aggregate);
        
        // Then: 事件已发布（需要配置事件监听器验证）
        // 注：此测试需要配合Spring事件机制或消息队列验证
    }
}
```

#### 关键约束
1. **使用@DataJpaTest**：只加载JPA相关配置，速度快
2. **使用内存数据库**：H2或配置test profile使用内存模式
3. **测试真实持久化**：不mock Repository，测试真实数据库交互
4. **事务自动回滚**：@DataJpaTest默认每个测试后回滚

---

### 11.2 ApplicationService集成测试

**测试目标**：验证应用服务正确编排命令、管理事务、发布事件。

#### 测试覆盖规则
1. **用例方法测试**：验证完整的用例流程
2. **事务边界测试**：验证事务正确提交/回滚
3. **事件发布测试**：验证领域事件正确发布到外部

#### 测试模板

```java
package {basePackage}.application.{子域};

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.annotation.Transactional;
import static org.junit.jupiter.api.Assertions.*;

/**
 * {子域}ApplicationService集成测试
 */
@SpringBootTest
@ActiveProfiles("test")
@Transactional
class {子域}ApplicationServiceIntegrationTest {

    @Autowired
    private {子域}ApplicationService applicationService;
    
    @Autowired
    private {聚合名}Repository repository;
    
    @Test
    void {用例方法名}_应完成完整流程() {
        // Given: 请求对象
        {命令名}Req req = new {命令名}Req({参数});
        
        // When: 调用应用服务
        {返回DTO} result = applicationService.{用例方法名}(req);
        
        // Then: 返回结果正确
        assertNotNull(result);
        
        // Then: 聚合已持久化
        {聚合名} aggregate = repository.findById({聚合ID});
        assertNotNull(aggregate);
        assertEquals({期望值}, aggregate.get{字段名}());
    }
    
    @Test
    void {用例方法名}_当业务异常_应回滚事务() {
        // Given: 会导致业务异常的请求
        {命令名}Req req = new {命令名}Req({无效参数});
        
        // When & Then: 抛出异常
        assertThrows(DomainException.class, 
            () -> applicationService.{用例方法名}(req));
        
        // Then: 数据未持久化（事务已回滚）
        {聚合名} aggregate = repository.findById({聚合ID});
        assertNull(aggregate);
    }
}
```

#### 关键约束
1. **使用@SpringBootTest**：加载完整Spring上下文
2. **使用@Transactional**：每个测试后自动回滚
3. **测试完整流程**：从应用服务入口到持久化
4. **验证事务边界**：确认异常时事务回滚

---

## 测试文件命名与包路径

### 单元测试
- **文件名**：`{被测试类名}Test.java`
- **包路径**：与被测试类相同，但在`src/test/java`下
- **示例**：
  - `UserAccount.java` → `UserAccountTest.java`
  - `LoginCommandHandler.java` → `LoginCommandHandlerTest.java`

### 集成测试
- **文件名**：`{被测试类名}IntegrationTest.java`
- **包路径**：与被测试类相同，但在`src/test/java`下
- **示例**：
  - `UserAccountRepository.java` → `UserAccountRepositoryIntegrationTest.java`
  - `UserApplicationService.java` → `UserApplicationServiceIntegrationTest.java`

---

## 增量测试生成规则

当`domain-model.md`变更后，测试需要同步更新：

### 变更类型与测试更新策略

| 建模变更 | 测试更新策略 |
|---------|-------------|
| 新增聚合 | 生成完整测试套件（聚合测试 + Repository集成测试） |
| 新增命令 | 生成命令处理器测试（`XxxCommandHandlerTest`） |
| 修改聚合业务方法 | 更新对应测试的断言 |
| 修改不变量 | 更新不变量验证测试 |
| 新增Policy | 生成Policy测试 |
| 删除命令/聚合 | 标记对应测试为待删除（需人工确认） |

### 测试变更检测流程

1. **对比建模文档版本**：识别新增/修改/删除的建模对象
2. **生成受影响测试清单**：列出需要新增/修改的测试文件
3. **增量生成测试**：
   - 新增测试 → 创建新测试文件
   - 修改测试 → 使用edit工具更新断言
   - 删除测试 → 提示用户确认后删除

---

## 验证标准

### 阶段10验证（单元测试）
- [ ] **完整场景覆盖**：每个聚合根的每个业务方法都有完整场景测试（成功路径 + 所有前置条件违反场景 + 边界值场景）
- [ ] **命令处理器完整覆盖**：每个 `XxxCommandHandler` 的每个前置条件都有对应的测试
- [ ] **不变量验证**：每个不变量都有验证测试
- [ ] **Policy测试**：每个Policy至少有1个测试（事件触发命令）
- [ ] **所有测试可以编译通过**
- [ ] **执行`mvn test -Dtest=*Test`所有单元测试通过**
- [ ] **单元测试执行时间 < 30秒**

**验证方法**：
1. 对照建模文档的"领域命令清单"，检查每个命令的每个前置条件是否都有对应测试
2. 对照建模文档的"聚合设计"，检查每个不变量是否都有验证测试
x3. 对照建模文档的"聚合设计"中的"命令-事件映射"，检查每个命令的每个执行分支（成功 / 失败 / 状态分支）及其产生事件是否都有对应测试覆盖

### 阶段11验证（集成测试）
- [ ] 每个Repository至少有2个测试（save + findById）
- [ ] 每个ApplicationService至少有1个测试（完整流程）
- [ ] 所有测试可以编译通过
- [ ] 执行`mvn test -Dtest=*IntegrationTest`所有集成测试通过
- [ ] 集成测试执行时间 < 2分钟

---

## 关键约束（贯穿全流程）

1. **基于建模文档全量生成**：不能只测试几个方法，必须覆盖建模文档中的所有命令和聚合业务方法
2. **新增/修改聚合必须同步测试**：建模文档变更后，测试必须同步更新
3. **不测试值对象**：值对象是简单数据载体，构造函数校验由聚合测试覆盖
4. **命令处理器测试聚焦专用实现类**：命令对象本身无需测试，测试重点是 `XxxCommandHandler` 的编排逻辑
5. **Policy测试即事件→命令映射测试**：验证正确的事件触发了正确的命令
6. **单元测试使用真实聚合**：不mock聚合根，测试真实业务逻辑
7. **集成测试使用真实基础设施**：使用内存数据库或测试容器，不mock Repository
8. **测试命名语义化**：使用中文描述业务场景，便于理解
9. **测试独立性**：每个测试可独立运行，不依赖执行顺序
10. **匹配项目测试风格**：如果项目已有测试，新生成的测试必须与现有风格一致
