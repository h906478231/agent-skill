---
name: opsx-code-quality
description: OpenSpec 实现层代码质量评审（Phase 5.5）。在 openspec apply 编码完成之后、verify 校验之前，对本次变更的 git diff 做重复率、可读性、死代码、复杂度热点与设计偏离五项审查，产出 review/code-quality.md。只报告不改代码，修复走 tasks 勾选。填补五个设计层评审维度不覆盖实现代码的空档。
---

# 实现层代码质量评审（Code Quality Review）

## 定位

技术评审门禁的五个维度（架构/并发/性能/数据库/安全）审的是 **`design.md` 里的方案**，`/opsx:verify` 查的是 **Completeness / Correctness / Coherence 三维一致性**。两者都不看**实现出来的代码本身写得怎么样**。本 skill 补这个空档。

```
/opsx:apply（编码）──> 【/opsx:quality 本 skill】──> /opsx:verify ──> openspec archive
```

- **输入**：本次变更实际产生的 `git diff`，不是设计文档。
- **输出**：`openspec/changes/<name>/review/code-quality.md`。
- **不改代码**。

## 与内置 `/simplify` 的区别

| | `/simplify` | 本 skill |
|---|---|---|
| 动作 | 直接编辑代码 | 只报告 + 分级 + 留痕 |
| 范围 | 当前关注的代码 | 本次变更的完整 diff |
| 产物 | 代码改动 | `review/code-quality.md` |
| 修复路径 | 就地改完 | 回 `tasks.md` 加勾选项再改 |

保持「评审与实现分离」：评审只出结论，修复动作有据可查、可被验收。想直接改可以另行用 `/simplify`，但那不构成本门禁的闭环证据。

## 适用范围分级

沿用 [门禁分级标准](../../shared/workflow/gate-levels.md)：

| 层级 | 是否跑 |
|------|-------|
| L0（纯文案/配置/注释） | 豁免 |
| L1 及以上 | 都跑 —— 单 agent，成本低 |

## 前置

1. 解析变更名，`openspec status --change "<name>" --json` 取 `changeRoot`。
2. 取本次变更的 diff。按可用性依次尝试：
   ```bash
   git diff --stat
   git diff
   ```
   若变更已提交，用变更起点到 HEAD 的范围（`git log` 定位起点 commit）。**diff 为空则中止**，提示先完成 `/opsx:apply`。
3. 读取 `design.md` 与 `tasks.md` —— 第 5 项「与设计的偏离」需要它们作对照。

## finding 格式

**完全沿用** 兄弟 skill `opsx-technical-review` 的 `shared/finding-format.md`：七字段（`ID | 严重级别 | 位置 | 一句话白话 | 触发场景 | 不修的后果 | 建议修复`）、三条硬规则、`通过 / 有条件通过 / 打回` 三值结论。

> **路径解析**：所有 skill 平铺在同一个 skills 根目录下，因此相对本 SKILL.md 的路径恒为 `../opsx-technical-review/shared/finding-format.md`。**不要写死绝对路径** —— skills 根目录随 agent 而不同（Claude Code `~/.claude/skills/`、Codex `~/.codex/skills/`、opencode `~/.config/opencode/skills/`、Cursor `~/.cursor/skills/`、项目级 `.claude/skills/`、直接使用本仓时的 `skills/`）。相对路径读不到时，用 Glob 搜 `**/opsx-technical-review/shared/finding-format.md`。

本维度参数：

- finding ID 前缀：`CQ-`
- 「位置」写 `文件路径:行号`，必须指到具体行，不接受「XXX 类里」这种粒度。
- **「触发场景」在本维度的含义放宽**：质量问题往往不在运行时爆炸，而是在**维护时**出事。允许写维护场景 —— 例如「下次改这段折扣规则时要同步改 3 处，漏一处就出现两套算法并存」。但仍必须具体到「改什么会漏什么」，写不出的 Blocker 照样降级 Major。

## 审查清单

### 1. 重复率

- **本次改动内部的复制粘贴**：diff 内出现结构近似的代码块（阈值参考：连续 5 行以上高度相似）。
- **应复用而未复用**：新写的工具方法在既有工具类/基础能力里已经有了。**这一项必须实际搜索仓库确认**，不能凭印象 —— 搜同名方法、搜相同关键逻辑。
- **同一逻辑多层重复实现**：同一条校验/转换在 Controller、Service、Mapper 各写一遍。

### 2. 可读性

- **命名**：是否表意；有无 `data` / `info` / `temp` / `list1` 这类无信息量命名；缩写是否是团队公认的。
- **函数长度与嵌套深度**：过长函数、深层 if 嵌套（参考阈值：嵌套 ≥4 层）。
- **魔法值**：字面量数字/字符串直接出现在逻辑中，未提取为常量或枚举（项目已有「禁止魔法值」约定）。
- **注释**：注释是否为中文；是否解释「为什么」而不是复述「做了什么」；有无与代码已不一致的过期注释。
- **异常处理**：catch 块是否打印堆栈；有无吞异常（空 catch、只 `return null`）；异常信息是否包含定位所需的上下文。

### 3. 死代码与未使用

新增但无调用方的方法 / 字段 / 常量 / 参数；被注释掉的代码块；引入但未使用的依赖。

### 4. 复杂度热点

圈复杂度过高的方法；条件分支组合爆炸；难以单测的构造（静态调用链、隐藏依赖、构造函数里干活）。

### 5. 与设计的偏离

对照 `design.md`，实现是否引入了设计未提及的**新依赖 / 新表 / 新接口 / 新配置项**。有偏离不等于错，但**必须回记到 `design.md`**，否则下一轮评审与归档后的 spec 都会与真实实现脱节。

## 输出

写入 `<changeRoot>/review/code-quality.md`，结构：

1. **摘要**：三句话说清「代码质量如何 / 能不能进 verify / 卡在哪」。
2. **审查范围**：diff 涉及的文件数与行数，起止 commit 或工作区状态。
3. **Findings 表**：按 `finding-format.md` 的七字段，按严重级别降序。
4. **重复率专项**：重复块清单 —— `位置A ↔ 位置B | 相似行数 | 建议抽取到哪里`。
5. **与设计的偏离清单**：`偏离项 | 设计中有无 | 建议：回记 design / 撤销实现`。
6. 末尾结论行：`代码质量评审结论：通过 / 有条件通过 / 打回`。

## 裁决与闭环

- 判定规则沿用兄弟 skill 的 `../opsx-technical-review/shared/gate-policy.md`（路径解析同上，不写死绝对路径）。
- **存在未闭环 Blocker 时不得 `openspec archive`**。
- 「有条件通过」的每个条件必须映射到 `tasks.md` 的一个勾选项，**映射不到视同 Blocker**。
- 修复后重跑本命令，对上轮 Blocker 逐条核实：**要指到具体行确认改动已落地**，只看提交说明不算闭环。
- 误报或知情接受：按 `gate-policy.md` 的驳回 / risk accepted 留痕格式记录在 `review/code-quality.md`，写明决策人与理由，不改代码就不重跑。

## 产物的 git 归属

与门禁产物同策略：`review/code-quality.md` 提交 git，随 `openspec archive` 整体进 `changes/archive/<name>/`，不进 `specs/`。
