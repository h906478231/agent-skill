# DDD 流程图生成规范和校验

## 问题根源

生成的 HTML 文件不符合标准模板 v1.0.0 的规范，导致高亮功能异常。

## 必须遵守的规范

### 1. 数据结构规范

```javascript
// ✅ 正确的数据结构
const data = {
    commands: {
        'C1': {
            id: 'C1',                    // 必填
            name: '创建订单',             // 必填
            className: 'CreateOrderCommand', // 必填
            trigger: '用户',              // 必填（或 actor）
            input: '...',                 // 必填（或 inputs）
            precondition: '...',          // 必填（或 preconditions）
            aggregate: 'Order',           // 必填
            events: ['E1']                // 必填，数组形式
        }
    },
    events: {
        'E1': {
            id: 'E1',                     // 必填
            name: '已创建订单',            // 必填
            className: 'OrderCreatedEvent', // 必填
            meaning: '订单创建成功',       // 必填
            aggregate: 'Order'            // 必填
        }
    },
    aggregates: {
        'Order': {
            id: 'Order',                  // 必填
            name: '订单',                  // 必填
            description: '...',           // 可选
            entities: [],                 // 可选
            valueObjects: []              // 可选
        }
    },
    policies: {
        'P1': {
            id: 'P1',                     // 必填
            name: '通知发货',              // 必填
            className: 'NotifyShipmentPolicy', // 必填
            listenEvents: ['E2'],         // 必填，数组形式（注意是复数）
            triggerCommands: ['C3'],      // 必填，数组形式（注意是复数）
            rule: '支付后自动通知'         // 必填
        }
    }
};
```

### 2. 常见错误

| 错误 | 正确 | 说明 |
|------|------|------|
| `listenEvent: 'E1'` | `listenEvents: ['E1']` | 必须是数组且复数 |
| `triggerCommand: 'C1'` | `triggerCommands: ['C1']` | 必须是数组且复数 |
| `events: 'E1'` | `events: ['E1']` | 必须是数组 |
| `actor: '用户'` | `trigger: '用户'` 或保持 `actor` | 两者都支持但推荐 trigger |
| `inputs: []` | `input: '...'` 或保持 `inputs` | 两者都支持 |

---

## 校验工具

### 生成前校验脚本

```javascript
function validateModelData(data) {
    const errors = [];
    
    // 1. 完整性检查
    if (!data.commands || Object.keys(data.commands).length === 0) {
        errors.push('缺少 commands 或为空');
    }
    if (!data.events || Object.keys(data.events).length === 0) {
        errors.push('缺少 events 或为空');
    }
    if (!data.aggregates || Object.keys(data.aggregates).length === 0) {
        errors.push('缺少 aggregates 或为空');
    }
    if (!data.policies) {
        errors.push('缺少 policies 对象');
    }
    
    // 2. 命令校验
    for (const [id, cmd] of Object.entries(data.commands || {})) {
        if (!cmd.name) errors.push(`命令 ${id} 缺少 name`);
        if (!cmd.className) errors.push(`命令 ${id} 缺少 className`);
        if (!cmd.aggregate) errors.push(`命令 ${id} 缺少 aggregate`);
        
        // 关键：events 必须是数组
        if (!Array.isArray(cmd.events)) {
            errors.push(`命令 ${id} 的 events 必须是数组，当前是: ${typeof cmd.events}`);
        }
        
        // 引用检查
        if (cmd.aggregate && !data.aggregates[cmd.aggregate]) {
            errors.push(`命令 ${id} 引用的聚合 ${cmd.aggregate} 不存在`);
        }
        if (cmd.events) {
            cmd.events.forEach(e => {
                if (!data.events[e]) {
                    errors.push(`命令 ${id} 引用的事件 ${e} 不存在`);
                }
            });
        }
    }
    
    // 3. 事件校验
    for (const [id, evt] of Object.entries(data.events || {})) {
        if (!evt.name) errors.push(`事件 ${id} 缺少 name`);
        if (!evt.className) errors.push(`事件 ${id} 缺少 className`);
        if (!evt.meaning) errors.push(`事件 ${id} 缺少 meaning`);
        if (!evt.aggregate) errors.push(`事件 ${id} 缺少 aggregate`);
        
        // 引用检查
        if (evt.aggregate && !data.aggregates[evt.aggregate]) {
            errors.push(`事件 ${id} 引用的聚合 ${evt.aggregate} 不存在`);
        }
    }
    
    // 4. 聚合校验
    for (const [id, agg] of Object.entries(data.aggregates || {})) {
        if (!agg.name) errors.push(`聚合 ${id} 缺少 name`);
    }
    
    // 5. 策略校验 - 关键！
    for (const [id, policy] of Object.entries(data.policies || {})) {
        if (!policy.name) errors.push(`策略 ${id} 缺少 name`);
        if (!policy.className) errors.push(`策略 ${id} 缺少 className`);
        if (!policy.rule) errors.push(`策略 ${id} 缺少 rule`);
        
        // 关键：必须是复数数组形式
        if (!Array.isArray(policy.listenEvents)) {
            errors.push(`策略 ${id} 的 listenEvents 必须是数组，当前是: ${typeof policy.listenEvents}`);
        }
        if (!Array.isArray(policy.triggerCommands)) {
            errors.push(`策略 ${id} 的 triggerCommands 必须是数组，当前是: ${typeof policy.triggerCommands}`);
        }
        
        // 检查是否误用了单数形式
        if (policy.listenEvent !== undefined) {
            errors.push(`策略 ${id} 使用了错误的字段 'listenEvent'，应该是 'listenEvents' (复数)`);
        }
        if (policy.triggerCommand !== undefined) {
            errors.push(`策略 ${id} 使用了错误的字段 'triggerCommand'，应该是 'triggerCommands' (复数)`);
        }
        
        // 引用检查
        if (policy.listenEvents) {
            policy.listenEvents.forEach(e => {
                if (!data.events[e]) {
                    errors.push(`策略 ${id} 监听的事件 ${e} 不存在`);
                }
            });
        }
        if (policy.triggerCommands) {
            policy.triggerCommands.forEach(c => {
                if (!data.commands[c]) {
                    errors.push(`策略 ${id} 触发的命令 ${c} 不存在`);
                }
            });
        }
    }
    
    return {
        valid: errors.length === 0,
        errors: errors
    };
}

// 使用示例
const result = validateModelData(data);
if (!result.valid) {
    console.error('❌ 数据校验失败：');
    result.errors.forEach(err => console.error('  •', err));
    throw new Error('数据校验失败，无法生成流程图');
} else {
    console.log('✅ 数据校验通过');
}
```

---

## 生成流程规范

### 标准流程

```
1. 准备建模数据
   ↓
2. 运行校验脚本 validateModelData()
   ↓
3. 如果校验失败 → 修正数据 → 重新校验
   ↓
4. 校验通过 → 使用 template-v1.0.0.html
   ↓
5. 替换占位符
   - {{DOMAIN_NAME}}
   - {{MODEL_DATA}}
   ↓
6. 输出 HTML 文件
   ↓
7. 在浏览器中测试
```

### 禁止做法

❌ 不要手动编写 HTML 文件  
❌ 不要修改标准模板的高亮逻辑  
❌ 不要使用单数形式 `listenEvent` / `triggerCommand`  
❌ 不要跳过数据校验步骤  

---

## 快速修复当前文件

对于已生成的 `mass-flow-v2.html`，有两种修复方式：

### 方式 1：修正数据重新生成（推荐）

```javascript
// 修正策略的数据结构
'P1': { 
    name: '零点自动暂停策略', 
    className: 'MidnightAutoPausePolicy', 
    listenEvents: ['E_MIDNIGHT'],      // 改为数组
    triggerCommands: ['C11'],          // 改为数组
    rule: '...' 
}
```

然后使用标准模板重新生成。

### 方式 2：手动修复（临时方案）

在当前 HTML 文件中查找替换：
- `listenEvent:` → `listenEvents: [`
- `triggerCommand:` → `triggerCommands: [`
- 并在值后面添加 `]`

但这种方式不推荐，因为还有其他代码逻辑不一致。

---

## 检查清单

生成 HTML 前必须确认：

- [ ] 使用了 `template-v1.0.0.html` 作为基础
- [ ] 数据结构通过了 `validateModelData()` 校验
- [ ] Policy 使用 `listenEvents` 和 `triggerCommands`（复数数组）
- [ ] Command 的 `events` 是数组
- [ ] 所有必填字段都已填写
- [ ] 所有引用的 ID 都存在

生成 HTML 后必须测试：

- [ ] 在浏览器中可以打开
- [ ] 点击命令高亮正确（1层）
- [ ] 点击事件高亮正确（2层）
- [ ] 点击策略高亮正确（2层）
- [ ] 点击聚合高亮正确（1层）
- [ ] 详情面板显示正确

---

## 总结

**核心问题**：未使用标准模板，数据结构不规范

**根本原因**：
1. 使用了旧版本的代码/模板
2. 数据字段使用单数而非复数数组
3. 没有运行数据校验

**解决方案**：
1. **始终使用** `template-v1.0.0.html`
2. **必须运行** 数据校验脚本
3. **严格遵守** 数据结构规范（复数数组）
