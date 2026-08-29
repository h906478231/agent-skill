---
name: ddd-flow-generator
description: 一键生成 DDD 事件风暴流程图。从代码/文档分析到交互式 HTML，完全自动化。
---

# DDD 流程图生成器

> 一键生成交互式事件风暴流程图

## 快速开始

```bash
# 基础用法
/ddd-flow-generator 订单管理 ./src/order

# 完整用法
/ddd-flow-generator 订单管理 ./src/order --doc ./docs/order.md --output ./order-flow.html
```

## 参数说明

1. **scope** (必需)：分析范围，如"订单管理"、"用户管理"
2. **codePath** (必需)：代码路径
3. **--doc**：需求文档路径（可选）
4. **--output**：输出文件路径（可选，默认 `event-storm-{scope}.html`）

## 执行流程

当你调用这个 skill 时，会自动：

1. ✅ 调用 workflow/ddd-visual-modeling.workflow.js
2. ✅ 分析代码和文档
3. ✅ 进行 DDD 建模
4. ✅ 生成交互式 HTML 流程图
5. ✅ 保存文件到指定位置

## 输出

生成的 HTML 文件包含：
- 🖱️ 滚轮缩放（30% - 300%）
- 🖐️ 整个画布拖拽
- 👆 点击节点查看详情
- 🔦 自动高亮处理链路
- 🎨 颜色分类：命令=黄色、事件=红色、聚合=蓝色、策略=紫色

## 示例

```bash
# 分析订单模块
/ddd-flow-generator 订单管理 ./src/order --doc ./docs/order.md

# 分析用户模块（无文档）
/ddd-flow-generator 用户管理 ./src/user

# 指定输出路径
/ddd-flow-generator 支付 ./src/payment --output ./payment-flow.html
```

## 实现细节

本 skill 实际上是 workflow 的封装，执行逻辑在：
- `workflow/ddd-visual-modeling.workflow.js`

如果需要更细粒度的控制，可以直接调用 workflow。
