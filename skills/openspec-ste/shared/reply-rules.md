# 对话回复 STE 规则

> 供项目 `CLAUDE.md` / `AGENTS.md` 用一行引用，约束 AI 的对话回复。完整规则与编号以 `shared/ste-rules.md` 为唯一事实源，本文件只列出对话回复适用的部分与级别，不重复规则说明。

## 适用规则

| 规则 | 回复中的要求 | 级别 |
|---|---|---|
| C-R1.11 禁用别名 | 项目根 CONTEXT.md 中术语 `_Avoid_` 列出的叫法不得出现，改用该术语 | 阻断（Claude Code） |
| C-R1.1 非受控通用词 | 优先使用通用受控词表（`shared/vocabulary.yaml`）的受控替代词 | 告警 |
| C-R4.1 模糊词 | 不用不可度量的词，写出具体数值、条件或对象 | 告警 |
| 其他写作规则 | 短句、一句一个指令、主动语态等，按 `shared/ste-rules.md` 生成，不检查 | — |

## 引用旧词

- 引用用户原话：用 markdown 引用块（`>` 开头的行），检查跳过引用块。
- 提到旧名称或代码标识：用行内代码或代码块，检查跳过代码。
- 其他必须写旧词的位置：在该行加 `<!-- term-allow: 旧词 -->`。

## 各 agent 的约束方式

| agent | 回复约束 | 产物约束 |
|---|---|---|
| Claude Code | 本规则 + Stop hook（`ste-lint.mjs reply-hook`）阻断禁用别名，最多重试 1 次 | `ste-lint.mjs check` 在四个卡点阻断 |
| Codex CLI、opencode、Cursor 等 | **只有本规则约束，没有回复阻断** | 同上，产物检查是后备 |
