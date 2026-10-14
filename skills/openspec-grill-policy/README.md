# OpenSpec Grill 门禁助手 - README

跨 coding agent 通用的 Grill 门禁助手，零配置，开箱即用。

---

## 快速开始

### 安装（一次性）

```bash
# 根据你使用的 agent 选择
npx skills add h906478231/agent-skill --skill openspec-grill-policy -a claude-code
npx skills add h906478231/agent-skill --skill openspec-grill-policy -a codex
npx skills add h906478231/agent-skill --skill openspec-grill-policy -a opencode
```

### 使用（三个命令）

```bash
# 1. 创建 Grill
/openspec-grill-policy <change-name>

# 2. 验证完整性
/openspec-grill-policy validate <change-name>

# 3. 生成报告
/openspec-grill-policy report
```

---

## 核心特性

### ✅ 零配置

- 无需安装脚本
- 无需复制文件
- 无需项目配置
- 自动检测项目路径

### ✅ 跨 Agent

支持所有主流 coding agent：
- Claude Code
- Codex CLI
- opencode
- Cursor
- Gemini CLI
- 其他 70+ agent

### ✅ 智能路径

- 自动查找 `openspec/changes/` 目录
- 支持在子目录调用
- 使用相对路径
- 向上查找最多3层

---

## 工作流

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

## 目录结构

```text
openspec-grill-policy/
├── skill.md                         # Skill 完整描述
├── README.md                        # 本文档
├── grill-policy.yml                 # 门禁规则（供参考）
└── templates/
    └── grill-discussion-log-template.md  # 内置模板
```

---

## 与 openspec-grill 的关系

```text
openspec-grill（访谈执行）
  ↓ 使用
openspec-grill-policy（模板和验证）
```

两者配合使用，互补不冲突。

---

## 完整文档

- [skill.md](SKILL.md) - Skill 完整说明
- [模板](templates/grill-discussion-log-template.md) - 标准模板

---

## 版本

- 版本: 2.0.0
- 最后更新: 2026-09-24
- 变更: 去掉路径依赖，支持跨 agent
- 源项目: lokra (内部 SCRM 项目)

---

## 常见问题

### Q: 在子目录调用可以吗？

A: 可以。Skill 会自动向上查找 `openspec/changes/` 目录（最多3层）。

### Q: 支持哪些 agent？

A: 所有支持 SKILL.md 标准的 agent（70+ 种）。

### Q: 需要项目配置吗？

A: 不需要。完全零配置。

### Q: 如何更新模板？

A: 模板内置在 skill 中，更新 skill 即可：
```bash
npx skills update openspec-grill-policy
```

---

零配置，跨 agent，开箱即用！
