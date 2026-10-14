# Slice 04 新鲜证据

- Slice: 04
- Behavior: Claude Code 对话回复中的禁用别名被阻断
- Seam: `node ste-lint.mjs reply-hook`（stdin 事件）
- Recorded At: 2026-10-08T06:02:01Z
- Fingerprint: git-tree:26b9ff0be36d8ec033a14060924e9b177f2cea57
- Fingerprint Source: node skills/openspec-technical-review/scripts/implementation-gate.mjs fingerprint openspec/changes/add-ste-gate
- Result: PASS

## 变更文件
- skills/openspec-ste/scripts/ste-lint.mjs
- skills/openspec-ste/shared/reply-rules.md
- skills/openspec-ste/shared/ste-rules.md
- skills/openspec-ste/SKILL.md
- scripts/test-ste-lint.mjs
- CLAUDE.md
- .claude/settings.local.json（本机注册 Stop hook，git 忽略，不随变更提交）

## 验证命令
| 命令 | 结果 | 摘要 |
|------|------|------|
| `node --test scripts/test-ste-lint.mjs` | PASS | 35 tests, 35 pass, 0 fail（其中 reply-hook 8 个） |
| `node --check skills/openspec-ste/scripts/ste-lint.mjs` | PASS | 语法检查通过（JS 项目无类型检查，以语法检查替代） |
| `npm run verify` | PASS | 全部 144 条引用可达 |
| 本会话真实 transcript 副本追加一条含「状态模型」的 assistant 条目后运行 `reply-hook` | PASS | `stop_hook_active=false` 输出 block，reason 含「状态模型 → 变更模型」；`=true` 放行无输出；行内代码中的「图模型」未报告；原始 transcript 只输出 systemMessage 告警，退出码均为 0 |
| `npm test` | PASS | verify + orchestration 15 + migration 24 + gate 22 + ste 35，全部通过 |
| Claude Code 2.1.285 实际运行：注册 hook 后回复一条含「状态模型」的消息 | PASS | 2026-10-06T11:46:56.771Z 的 stop_hook_summary 记录 hasOutput=true，会话收到「状态模型 → 变更模型」的拦截提示，Claude 改用术语重写一次 |

| `node --test scripts/test-ste-lint.mjs` + `npm run verify`（全部切片完成后刷新指纹） | PASS | ste 41 tests 全部通过（含本切片全部用例）；153 条引用可达。完整 `npm test` 此时因另一个变更 add-change-model-visualization 进行中的 `test:change-model` 失败（4 fail），与本变更无关，未作为本切片的验证命令 |
## 覆盖的验收行为
- ste-reply-guard / Reply with a forbidden alias → 「reply-hook：回复含禁用别名时输出 block 决策，原因列出「别名 → 术语」」
- ste-reply-guard / Reply without findings → 「reply-hook：回复没有禁用别名时退出码 0，不输出 block 决策」
- ste-reply-guard / Second stop after a forced rewrite → 「reply-hook：stop_hook_active 为 true 时放行，最多重试一次」
- ste-reply-guard / Vague word in a reply → 「reply-hook：模糊词与非受控通用词只告警，不阻断」
- ste-reply-guard / User text quoted in a blockquote → 「reply-hook：引用块、代码块与行内代码中的别名不报告」
- ste-reply-guard / Transcript missing → 「reply-hook：transcript 不存在、无法解析或没有 CONTEXT.md 时放行」
- 切片行为：最后一条回复尚未写入 transcript 时检查 `last_assistant_message` → 「reply-hook：最后一条回复尚未写入 transcript 时，检查事件中的 last_assistant_message」
- 切片行为：只读最后一条用户消息之后的回复，tool_result 与 meta 条目不作为分界 → 「reply-hook：只检查最后一条用户消息之后的 assistant 文本，tool_result 与 meta 条目不算用户消息」
- ste-reply-guard / Installing the skill、Codex project → SKILL.md「对话回复检查」一节与 `shared/reply-rules.md`「各 agent 的约束方式」（文档类要求，人工核对）

## 剩余风险
- 已修复问题（记录在此供评审追溯）：第一次真实运行时 hook 已执行但未阻断（stop_hook_summary 记录 hasOutput=false）。原因是触发 hook 时最后一条回复尚未写入 transcript。修复方式：补充复现用例（red），合并事件的 `last_assistant_message`（green），修复后重新实测通过。
- `last_assistant_message` 是 Claude Code 新版本的可选字段；旧版本没有该字段时只能读 transcript，最后一条回复仍可能漏检，产物检查是后备。
- 只有告警时 hook 输出 `systemMessage`，在用户界面中可见；如果噪声过大，可改为不输出。

## 豁免记录
| From Fingerprint | To Fingerprint | 变化文件 | 不影响本切片行为的理由 | 判定人 | 日期 |
|------------------|----------------|---------|--------------------|-------|------|
