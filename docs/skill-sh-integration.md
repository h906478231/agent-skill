# skill.sh 接入指南

本文档说明如何让 agent-skills 项目被 [skill.sh](https://skill.sh) 收录，让其他开发者可以直接通过 `npx skills` 命令下载使用。

## skill.sh 是什么

[skill.sh](https://skill.sh) 是 Vercel Labs 维护的开放式 agent skills 目录和排行榜，提供统一的 CLI (`npx skills`) 用于在 Claude Code、Cursor、Codex CLI、Windsurf 等 70+ AI 编码工具之间共享和安装技能。

## 收录机制

skill.sh 采用**被动索引**机制，没有提交表单。当用户通过 `npx skills add <owner>/<repo>` 安装你的仓库时，匿名安装遥测数据会自动触发索引，并按每周安装量排名。

## 已完成的接入准备

本项目已满足 skill.sh 的所有核心要求：

### ✅ 1. 仓库公开
- 仓库地址：https://github.com/h906478231/agent-skill
- 状态：公开（public）

### ✅ 2. 规范的 SKILL.md 文件
所有 33 个 skills 都符合规范：
- `name` 字段：小写字母 + 连字符，匹配目录名（如 `ddd-overview`）
- `description` 字段：非空，描述清晰具体
- 位置：`skills/` 目录下（优先级最高的发现路径）

### ✅ 3. 开源协议
- 已添加 `LICENSE` 文件（Apache 2.0）

### ✅ 4. package.json 元数据
- 已创建 `package.json`，包含仓库信息、关键词、协议等
- 关键词覆盖：agent-skills, ddd, openspec, claude-code, cursor 等

## 如何让项目被收录

### 第一步：推送到 GitHub

确保所有更改已提交并推送：

```bash
git add .
git commit -m "feat: 添加 skill.sh 集成配置"
git push origin main
```

### 第二步：让用户安装

当有人通过以下命令安装时，skill.sh 会自动索引：

```bash
# 安装所有 skills 到全局（推荐）
npx skills add h906478231/agent-skill -g -a '*'

# 安装到 Claude Code
npx skills add h906478231/agent-skill -g -a claude-code

# 安装到多个 agent
npx skills add h906478231/agent-skill -g -a claude-code -a cursor -a codex
```

### 第三步：验证安装

用户可以通过以下命令验证：

```bash
# 预览会安装哪些 skills（不实际安装）
npx skills add h906478231/agent-skill --list

# 查看已安装的 skills
npx skills list

# 更新已安装的 skills
npx skills update
```

## 推广建议

为了让项目被更多人安装（从而提升 skill.sh 排名），可以：

1. **在 README.md 中突出安装命令**
   - 当前已有清晰的安装说明
   - 建议在顶部添加快速安装徽章

2. **社交媒体分享**
   - 在 Twitter、LinkedIn 等平台分享
   - 使用标签：#AgentSkills #ClaudeCode #DDD #OpenSpec

3. **技术博客/文章**
   - 撰写使用教程
   - 分享 DDD 和 OpenSpec 实践案例

4. **开源社区**
   - 在相关 GitHub 仓库的 Discussions 中介绍
   - 参与 AI 编码工具社区讨论

5. **实际使用案例**
   - 录制演示视频
   - 分享实际项目中的应用效果

## 技能发现路径

skill.sh CLI 按以下优先级扫描：

1. ✅ 根目录（如果单个 skill）
2. ✅ `skills/` ← **本项目使用此路径**
3. `skills/.curated/`
4. `skills/.experimental/`
5. `.claude/skills/`
6. `.cursor/skills/`

本项目所有 33 个 skills 位于 `skills/` 目录，会被优先发现。

## 技能分类

本项目提供的 33 个 skills 分为四大类：

### DDD 建模（19 个）
从概览、聚合、值对象到事件溯源、CQRS、Saga 等完整 DDD 实践体系

### OpenSpec 工作流（8 个）
提议、探索、应用、更新、归档、验证等变更管理流程

### OpenSpec 流程增强（4 个）
技术评审、变更总览、代码质量、讨论同步等工程化能力

### 其他（2 个）
并发分析、PM 编排等通用能力

## 验证 SKILL.md 规范

项目已包含验证脚本：

```bash
# 验证所有 skills 的引用完整性
bash scripts/verify-references.sh

# 打包单个 skill（含依赖）
bash scripts/pack-skill.sh openspec-explore
```

## 参考资料

- [skills.sh 官网](https://skill.sh)
- [Vercel Labs skills CLI](https://github.com/vercel-labs/skills)
- [SKILL.md 规范文档](https://github.com/vercel-labs/skills#readme)
- [skill.sh 索引机制说明](https://github.com/product-on-purpose/pm-skills/blob/main/docs/internal/distribution/2026-04-22_skills-sh.md)

## 监控收录状态

收录后可以：

1. 访问 [skill.sh](https://skill.sh) 搜索 "agent-skill" 或 "h906478231"
2. 查看安装排名和统计数据
3. 获取用户反馈和 issue

---

最后更新：2026-08-20
