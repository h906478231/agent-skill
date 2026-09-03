# DevOps-OpenSpec 集成工作流使用指南

## 概述

本文档说明云舟任务自动化工作流与 OpenSpec 研发流程的集成方案。

## 新流程图

```
┌─────────────────────────────────────────────────────────────┐
│ Fetch（拉取云舟任务）                                        │
└────────────────────┬────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────────────┐
│ Route（路由决策）                                            │
│ - 判断任务信息完整性                                         │
│ - 快速复杂度分类（trivial/simple/medium/complex/epic）      │
│ - 决策：proceed / clarify / reject                          │
└────────────────────┬────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────────────┐
│ OpenSpec Explore（需求澄清与方案设计）                       │
│ - 生成 proposal.md（含第一性原理分析）                       │
│ - 生成 design.md（含候选方案对比矩阵）                       │
└────────────────────┬────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────────────┐
│ Gate Decision（门禁分级决策）                                │
│ - trivial → L0（豁免）                                       │
│ - simple → L1（database + security）                         │
│ - medium → L2（4维度）                                       │
│ - complex/epic → L3（5维度）                                 │
└────────────────────┬────────────────────────────────────────┘
                     ↓
                 ┌───┴───┐
                 │ L0?   │
                 └───┬───┘
                     │
            No ──────┴────── Yes（跳过 Review）
            │                │
            ↓                │
┌─────────────────────────┐ │
│ OpenSpec Review         │ │
│ - 多维度技术评审        │ │
│ - 生成 review-summary   │ │
└────────────┬────────────┘ │
             │               │
             └───────┬───────┘
                     ↓
┌─────────────────────────────────────────────────────────────┐
│ Human Gate（人工门禁）                                       │
│ - 等待在 review-summary.md 中签字                            │
│ - 未签字：暂停工作流                                         │
│ - 已签字：继续自动化                                         │
└────────────────────┬────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────────────┐
│ OpenSpec Apply（代码实施）                                   │
│ - 按已评审通过的设计实现代码                                 │
└────────────────────┬────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────────────┐
│ OpenSpec Verify（三维校验）                                  │
│ - Completeness：任务完整性                                   │
│ - Correctness：实现正确性                                    │
│ - Coherence：与设计一致性                                    │
└────────────────────┬────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────────────┐
│ Commit（代码提交）                                           │
│ - Git 提交                                                   │
│ - 可选：创建 PR                                              │
└────────────────────┬────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────────────┐
│ Sync（回写云舟）                                             │
│ - 添加包含 OpenSpec 变更信息的评论                           │
└─────────────────────────────────────────────────────────────┘
```

## 核心改进

### 1. 消除重复分析
- **之前**：Analyze phase 做深度分析，OpenSpec 再做一次
- **现在**：Route 只做快速分类，所有深度分析由 OpenSpec 统一完成

### 2. 灵活分级门禁
- **L0 豁免**：简单任务跳过技术门禁，记录豁免理由
- **L1 轻量**：只评审 database + security（2维度）
- **L2 标准**：评审 4 维度
- **L3 全量**：评审全部 5 维度

### 3. 人工门禁后自动化
- 人工签字确认后，自动执行 Apply → Verify → Commit → Sync
- 只在关键决策点（技术评审通过）需要人工介入

## 配置说明

### 门禁映射规则

在 `workflow/devops-automation-loop-yunzhou.workflow.js` 文件开头的 `CONFIG` 对象中：

```javascript
const CONFIG = {
  // 复杂度到门禁级别的映射
  GATE_LEVEL_MAP: {
    trivial: 'L0',   // 可调整为 'L1' 如果希望所有任务都评审
    simple: 'L1',
    medium: 'L2',
    complex: 'L3',
    epic: 'L3',
  },

  // 门禁级别到评审维度的映射
  REVIEW_ROLES: {
    L0: [],
    L1: ['database', 'security'],
    L2: ['architecture', 'database', 'security', 'performance'],
    L3: ['architecture', 'concurrency', 'performance', 'database', 'security'],
  },

  // 变更 ID 前缀
  CHANGE_ID_PREFIX: 'yunzhou-',  // 可修改为项目特定前缀
}
```

### 如何调整规则

**场景 1：希望所有任务都至少经过轻量评审**

```javascript
GATE_LEVEL_MAP: {
  trivial: 'L1',  // 改为 L1
  simple: 'L1',
  // ...
}
```

**场景 2：降低 medium 任务的评审级别**

```javascript
GATE_LEVEL_MAP: {
  // ...
  medium: 'L1',  // 从 L2 降为 L1
  // ...
}
```

**场景 3：自定义评审维度**

```javascript
REVIEW_ROLES: {
  // ...
  L2: ['database', 'security', 'performance'],  // 移除 architecture
  // ...
}
```

## 使用方式

### 基本用法

```javascript
// 自动拉取云舟任务并执行完整流程
workflow('devops-automation-loop-yunzhou', {
  projectName: 'Lokra',
})
```

### 指定任务

```javascript
// 处理特定任务
workflow('devops-automation-loop-yunzhou', {
  projectName: 'Lokra',
  taskId: 12345,
})
```

### 跳过路由决策（直接使用已有分析）

```javascript
workflow('devops-automation-loop-yunzhou', {
  projectName: 'Lokra',
  taskId: 12345,
  skipAnalysis: true,  // 跳过 Route phase
})
```

## 常见问题

### Q1: 工作流在人工门禁处暂停了，如何继续？

**A**: 
1. 打开 `openspec/changes/yunzhou-<task-id>/review-summary.md`
2. 审阅技术评审内容
3. 在文件末尾的"人工确认区"填写签字：
   ```
   Technical Review Approved: 张三  2026-09-03
   ```
4. 重新运行工作流（会自动从后续阶段继续）

### Q2: 如何重新运行工作流？

**A**: 使用相同的参数再次调用：

```javascript
workflow('devops-automation-loop-yunzhou', {
  projectName: 'Lokra',
  taskId: 12345,
})
```

工作流会检测已完成的阶段（如已签字），自动跳过并从下一阶段继续。

### Q3: 如何查看 OpenSpec 产物？

**A**: 所有产物位于 `openspec/changes/yunzhou-<task-id>/` 目录：

- `proposal.md` - 需求澄清
- `design.md` - 技术方案
- `review/*.md` - 各维度评审报告
- `review-summary.md` - 评审汇总（含人工签字）

### Q4: L0 豁免的任务也需要签字吗？

**A**: 是的。即使是 L0 豁免，也会生成 `review-summary.md` 并要求签字。这确保所有变更都有明确的责任人。

### Q5: 如何调整某个任务的门禁级别？

**A**: 有两种方式：

**方式 1**：修改 Route phase 的返回结果（需要重新运行 Route）

**方式 2**：在 `review-summary.md` 开头手动标注实际级别，人工签字时按实际级别评审

### Q6: 工作流失败了怎么办？

**A**: 查看错误信息中的 `reason` 字段：

- `clarification_needed` - 任务信息不完整，需要在云舟补充信息
- `openspec_explore_failed` - OpenSpec Explore 失败，查看日志定位问题
- `openspec_review_failed` - 技术评审失败，可能是评审 Agent 错误
- `openspec_apply_failed` - 代码实施失败
- `openspec_verify_failed` - 验证失败，需要修复后重新验证

大多数情况下，修复问题后重新运行工作流即可。

### Q7: 如何跳过某些步骤？

**A**: 
- 跳过 Route：`skipAnalysis: true`
- 跳过技术评审：不支持（这违反流程设计）
- 跳过人工门禁：不支持（这是安全关键点）

如果确实需要紧急绕过，可以直接使用 OpenSpec 工作流手动执行各个阶段。

### Q8: 变更 ID 的命名规则是什么？

**A**: 默认为 `yunzhou-<task-id>`，例如 `yunzhou-12345`。

可以通过修改 `CONFIG.CHANGE_ID_PREFIX` 自定义前缀。

## 故障排查

### 问题：提示 "openspec-explore workflow not found"

**原因**：OpenSpec 工作流未正确安装

**解决**：
```bash
# 检查 OpenSpec workflows 是否存在
ls -la workflow/openspec-*.workflow.js
```

### 问题：人工签字后重新运行仍提示未签字

**原因**：签字格式不正确或仍是占位符

**解决**：确保签字行格式正确，不是占位符 `__________`：
```
Technical Review Approved: 张三  2026-09-03
```

### 问题：工作流运行很慢

**原因**：可能的原因：
1. OpenSpec 工作流本身需要时间（特别是 L3 评审）
2. 网络问题影响云舟 API 调用

**解决**：
- L3 全量评审通常需要 4-8 分钟，这是正常的
- 检查网络连接和 flows-cli 配置

## 变更记录

- **2026-09-03**：初始版本，完成 DevOps-OpenSpec 集成重构

## 相关文档

- [OpenSpec AI 研发流程](../workflow/OpenSpec-AI-研发流程.md)
- [集成规格文档](./specs/devops-openspec-integration.md)
- [云舟配置指南](./yunzhou-opencode-quickstart.md)
