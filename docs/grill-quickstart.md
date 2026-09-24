# Grill 门禁系统 - 快速开始

2分钟上手 OpenSpec Grill 门禁系统。

---

## 第一步：安装 Skill

```bash
# 根据你使用的 agent 选择（一次性）
npx skills add h906478231/agent-skill --skill openspec-grill-policy -a claude-code
npx skills add h906478231/agent-skill --skill openspec-grill-policy -a codex
npx skills add h906478231/agent-skill --skill openspec-grill-policy -a opencode
```

---

## 第二步：使用三个命令

### 1. 创建 Grill

```bash
/openspec-grill-policy my-feature
```

输出：
```
✅ 创建 Grill: my-feature

创建文件: openspec/changes/grill-my-feature/discussion-log.md

已自动填充：
  ✓ 变更名称: my-feature
  ✓ 风险等级: L2
  ✓ BREAKING: 是
  ✓ 开始日期: 2026-09-24

🚀 下一步: /openspec-grill
```

---

### 2. 验证完整性

```bash
/openspec-grill-policy validate my-feature
```

输出：
```
✅ Grill 产出完整

⚠️  建议补充:
  • 缺少签字
```

---

### 3. 生成报告

```bash
/openspec-grill-policy report
```

输出：
```
📊 Grill 健康度报告

📈 总体统计
  变更总数: 20
  有 Grill: 15
  完整 Grill: 12

✅ Grill 完成率: 80% (达标)
```

---

## 完整工作流

```text
1. /openspec-explore
   → 产出 proposal.md

2. /openspec-grill-policy my-feature
   → 创建 grill-my-feature/discussion-log.md

3. /openspec-grill
   → 执行访谈

4. /openspec-grill-policy validate my-feature
   → 验证完整性

5. openspec propose my-feature
   → 实施
```

---

## 关键要点

### ✅ 做

- 调用 skill = 需要 Grill（无需判断）
- 标注风险等级（🔴 HIGH / 🟡 MEDIUM / 🟢 LOW）
- 补充完整的「Grill总结」
- 新术语同步到 CONTEXT.md

### ❌ 不做

- 不要跳过关键问题（Q1-QN）
- 不要在 HIGH 风险假设未验证时放行
- 不要忘记门禁决策

---

## 门禁决策参考

### ✓ 通过
- 所有检查通过
- 无 HIGH 风险假设未验证

### ⚠️ 附加条件通过
- 有明确的待修复问题清单

### ✗ 拒绝
- 关键问题未回答
- HIGH 风险假设无验证计划

---

## 智能特性

### 自动路径检测

可以在任何子目录调用：
```bash
cd /path/to/project/subdir/
/openspec-grill-policy my-feature
# 自动查找 openspec/changes/ 目录（向上最多3层）
```

### 跨 Agent 通用

支持所有主流 coding agent：
- Claude Code
- Codex CLI  
- opencode
- Cursor
- 其他 70+ agent

---

## 常见问题

### Q: 低风险变更也要 Grill 吗？

A: 不需要。调用 skill 即表示需要 Grill。

### Q: 需要项目配置吗？

A: 不需要。零配置，开箱即用。

### Q: 在子目录调用可以吗？

A: 可以。自动向上查找项目根目录。

---

## 下一步

查看完整文档：
- `../skills/openspec-grill-policy/SKILL.md` - 完整说明
- `skills/openspec-grill-policy/README.md` - 使用指南

---

2分钟快速开始完成！现在可以开始使用 Grill 门禁系统了。
