---
name: ddd-event-storm-visualizer
description: 将 ddd-modeling-workflow 的建模产物转换为交互式的事件风暴流程图。支持可点击节点、基于节点类型的分层高亮、主题切换。使用统一的标准模板（v2.0.0）确保生成结果一致。
---

# DDD 事件风暴可视化生成器

> 将 DDD 建模产物转换为交互式事件风暴流程图

## 版本：v2.0.0

**模板文件**：`skills/ddd-event-storm-visualizer/template-v2.0.0.html`  
**主题配置**：`skills/ddd-event-storm-visualizer/themes.json`

## 定位

- 本 skill 是**可视化生成器**，不负责建模
- 输入：`ddd-modeling-workflow` 的输出（事件、命令、聚合、Policy）
- 输出：交互式 HTML 流程图（基于标准模板 v2.1.0）
- 不负责建模逻辑，不负责业务分析

## 核心特性

### 1. 统一模板标准
- ✅ 使用单一标准模板（template-v2.1.0.html）
- ✅ 确保同一领域多次生成结果一致
- ✅ 支持主题切换，满足不同场景需求

### 2. 主题系统（v2.1.0 新增）
- ✅ **Bootstrap 主题**（默认）：柔和商务风格，适合长时间工作场景
- ✅ **Vibrant 主题**：鲜艳展示风格，适合演示和展示场景
- ✅ 通过 URL 参数动态切换主题
- ✅ 通过 workflow 参数指定默认主题

### 3. 基于节点类型的分层高亮
- **Command** → 1层：高亮 聚合 + 事件
- **Event** → 2层：高亮 产生者 + 监听者 + 触发的命令
- **Policy** → 2层：高亮 监听事件 + 触发命令 + 命令的聚合
- **Aggregate** → 1层：高亮 所有操作它的命令 + 产生的事件

### 4. 交互功能
- ✅ 整个画布可拖拽
- ✅ 滚轮和按钮缩放（30% - 300%）
- ✅ 点击节点查看详情
- ✅ 边的联动高亮和变暗

---

## 执行流程

### 步骤 1：数据校验（Verify）

**目标**：确保建模数据完整、一致，可以正常生成流程图

#### 1.1 完整性检查
```javascript
✓ commands 对象存在且不为空
✓ events 对象存在且不为空
✓ aggregates 对象存在且不为空
✓ policies 对象存在（可以为空）
```

#### 1.2 引用一致性检查
```javascript
✓ 每个命令引用的 aggregate 存在于 aggregates 中
✓ 每个命令引用的 events 都存在于 events 中
✓ 每个策略监听的 listenEvents 都存在于 events 中
✓ 每个策略触发的 triggerCommands 都存在于 commands 中
✓ 每个事件的 aggregate 存在于 aggregates 中
```

#### 1.3 必填字段检查

**Command**：`id`, `name`, `className`, `aggregate`, `events`  
**Event**：`id`, `name`, `className`, `meaning`, `aggregate`  
**Aggregate**：`id`, `name`  
**Policy**：`id`, `name`, `className`, `listenEvents`, `triggerCommands`, `rule`

**校验失败示例**：
```
❌ 数据校验失败

引用一致性问题：
  • 命令 C1 引用的聚合 'OrderAggregate' 不存在
  • 命令 C2 引用的事件 'E99' 不存在

必填字段问题：
  • 命令 C3 缺少 className 字段
  • 事件 E1 缺少 meaning 字段

请修正建模数据后重试。
```

---

### 步骤 2：生成 Mermaid 图表代码

**生成规则**：
1. 定义四种样式类
2. 添加聚合节点
3. 添加命令节点并连接到聚合
4. 添加事件节点
5. 连接聚合到事件
6. 添加策略节点并建立连接
7. 应用样式类

---

### 步骤 3：填充模板并输出 HTML

**操作**：
1. 读取 `template-v1.0.0.html`
2. 替换 `{{DOMAIN_NAME}}`
3. 替换 `{{MODEL_DATA}}`（完整 JSON）
4. 输出 `event-storm-{domain_name}.html`

---

## 输入格式

从 `ddd-modeling-workflow` 的输出中提取：

```markdown
## 领域命令清单
| 编号 | 命令名称 | 类名 | 触发者 | 输入数据 | 前置条件 | 产生事件 |
|------|---------|------|--------|---------|---------|---------|
| C1   | 创建订单 | CreateOrderCommand | 用户 | 商品列表、收货地址 | 商品库存充足 | E1 |

## 领域事件清单
| 编号 | 事件名称 | 类名 | 业务含义 | 前置事件 |
|------|---------|------|---------|---------|
| E1   | 已创建订单 | OrderCreatedEvent | 用户成功下单 | - |

## Policy 清单
| 编号 | 策略名称 | 类名 | 监听事件 | 触发命令 | 业务规则描述 |
|------|---------|------|---------|---------|-------------|
| P1   | 通知发货 | NotifyShipmentPolicy | E2 | C2 | 支付成功后自动通知 |

## 聚合清单
### 聚合：订单 (Order)
- 聚合根：Order
- 聚合 ID：OrderId
- 命令-事件映射：C1 → E1, C2 → E2
```

---

## 输出格式

**文件名**：`event-storm-{domain_name}.html`

**内容**：完整的独立 HTML 文件，包含：
- 完整的 CSS 样式（固定）
- Mermaid 图表代码
- 建模数据 JSON
- 交互逻辑（固定）

**特性**：
- ✅ 可在浏览器中独立运行
- ✅ 无需外部依赖（除 CDN 的 Mermaid.js）
- ✅ 所有交互功能正常工作
- ✅ 样式和行为完全一致

---

## 主题切换

### 可用主题

| 主题名称 | 标识符 | 风格特点 | 适用场景 |
|---------|--------|---------|---------|
| Bootstrap | `bootstrap` | 柔和商务风格，低饱和度配色 | 长时间工作场景，降低视觉疲劳 |
| Vibrant | `vibrant` | 鲜艳展示风格，高对比度配色 | 演示和展示场景，视觉冲击力强 |

### 使用方法

#### 方法 1：通过 Workflow 参数指定

在运行 workflow 时指定 `theme` 参数：

```bash
# 使用默认主题 (bootstrap)
workflow run ddd-visual-modeling

# 使用 vibrant 主题
workflow run ddd-visual-modeling --args '{"theme": "vibrant"}'
```

#### 方法 2：通过 URL 参数切换

生成 HTML 后，可以通过 URL 参数动态切换主题（无需重新生成）：

```
# Bootstrap 主题（默认）
http://localhost:8000/event-storm.html?theme=bootstrap

# Vibrant 主题
http://localhost:8000/event-storm.html?theme=vibrant
```

### 主题配置

主题配置文件位于 `themes.json`，包含每个主题的颜色定义：

```json
{
  "version": "1.0.0",
  "default": "bootstrap",
  "themes": {
    "bootstrap": {
      "name": "Bootstrap (柔和商务风格)",
      "command": { "fill": "#fff3cd", "stroke": "#ffc107", ... },
      "event": { "fill": "#f8d7da", "stroke": "#dc3545", ... },
      ...
    },
    "vibrant": { ... }
  }
}
```

### 自定义主题（高级）

可以修改 `themes.json` 添加自定义主题，每个主题需要定义：
- `command`：命令节点样式（矩形）
- `event`：事件节点样式（圆角矩形）
- `aggregate`：聚合节点样式（圆柱体）
- `policy`：策略节点样式（菱形）

每种节点样式包含：
- `fill`：填充颜色
- `stroke`：边框颜色
- `strokeWidth`：边框宽度
- `color`：文字颜色

---

## 检查清单

### 生成前
- [ ] 建模数据已通过完整性检查
- [ ] 建模数据已通过引用一致性检查
- [ ] 建模数据已通过必填字段检查
- [ ] 模板文件存在且版本正确（v2.1.0）
- [ ] 主题配置文件存在（themes.json）

### 生成后
- [ ] HTML 文件成功创建
- [ ] themes.json 已复制到输出目录
- [ ] 文件大小合理（> 30KB）
- [ ] 在浏览器中可以打开
- [ ] Mermaid 图表正常渲染
- [ ] 所有节点可点击
- [ ] 高亮逻辑正常工作
- [ ] 详情面板显示正确
- [ ] 缩放和拖拽正常工作
- [ ] 图例颜色与节点颜色一致
- [ ] URL 参数 `?theme=bootstrap` 生效
- [ ] URL 参数 `?theme=vibrant` 生效

---

## 扩展方向（V2）

1. **数据变更展示**：显示聚合状态的前后对比
2. **多子域支持**：为每个子域生成独立的流程图，支持子域间跳转
3. **导出功能**：支持导出为 PNG、SVG、PDF
4. **过滤功能**：按聚合、命令、事件过滤显示
5. **时序视图**：除了静态流程图，还提供时序图视图

---

## 参考文档

- [template-v1.0.0.html](template-v1.0.0.html) - 标准模板文件（带占位符）
- [demo.html](demo.html) - 完整可运行示例
