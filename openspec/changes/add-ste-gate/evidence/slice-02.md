# Slice 02 新鲜证据

- Slice: 02
- Behavior: STE 规则表、通用受控词表与模糊词生效
- Seam: `node ste-lint.mjs check <changeRoot>`、`node ste-lint.mjs config-snippet`
- Recorded At: 2026-10-08T06:02:01Z
- Fingerprint: git-tree:26b9ff0be36d8ec033a14060924e9b177f2cea57
- Fingerprint Source: node skills/openspec-technical-review/scripts/implementation-gate.mjs fingerprint openspec/changes/add-ste-gate
- Result: PASS

## 变更文件
- skills/openspec-ste/shared/ste-rules.md
- skills/openspec-ste/shared/vocabulary.yaml
- skills/openspec-ste/scripts/ste-lint.mjs
- scripts/test-ste-lint.mjs
- openspec/config.yaml

## 验证命令
| 命令 | 结果 | 摘要 |
|------|------|------|
| `node --test scripts/test-ste-lint.mjs` | PASS | 27 tests, 27 pass, 0 fail |
| `node --check skills/openspec-ste/scripts/ste-lint.mjs` | PASS | 语法检查通过（JS 项目无类型检查，以语法检查替代） |
| `openspec instructions specs --change add-ste-gate` | PASS | 输出含 37 条 C-R 规则，config.yaml 的 YAML 锚点被 OpenSpec 正确解析 |

| `node --test scripts/test-ste-lint.mjs` + `npm run verify`（全部切片完成后刷新指纹） | PASS | ste 41 tests 全部通过（含本切片全部用例）；153 条引用可达。完整 `npm test` 此时因另一个变更 add-change-model-visualization 进行中的 `test:change-model` 失败（4 fail），与本变更无关，未作为本切片的验证命令 |
## 覆盖的验收行为
- ste-rules / Adopted rule is traceable、English-only rule is excluded → `shared/ste-rules.md` 人工核对：37 条采纳规则均含 ← STE 编号、复述、检查方法、产物 / 对话级别；16 条不采纳规则写明原因；编号已对照 ASD-STE100 Issue 9 原文逐条核对
- ste-rules / Non-approved word has one replacement → 「check：非受控通用词被阻断，报告规则 C-R1.1 与唯一替代词」
- ste-rules / Exception phrase is not a violation → 「check：词表条目的例外短语不报告」
- ste-rules / Default thresholds apply without project configuration → 「check：55 字的描述句只告警，退出码 0」「check：没有 ste.yaml 时使用默认阈值 30 字指令句与 6 句段落，均只告警」
- ste-rules / Project adds a vague word → 「ste.yaml：增加模糊词、删除词表条目、增加词表条目、覆盖阈值」
- ste-rules / Invalid project file → 「ste.yaml：YAML 非法时退出码 2，并写明文件与解析错误」「ste.yaml：不符合 schema 时退出码 2，不静默使用默认值」
- ste-rules / Snippet follows the rule table → 「config-snippet：生成覆盖四类产物的 rules 片段，内容跟随规则表」
- ste-lint / Long sentence only warns → 「check：55 字的描述句只告警，退出码 0」
- ste-lint / No CONTEXT.md → 「check：没有 CONTEXT.md 时模糊词仍阻断，并告警缺少术语表」
- ste-lint / Findings SHALL be graded（启发式只告警）→ 「check：名词串、被动语态、程序步骤、安全提示只告警」「check：「被动」「并发」不触发被动语态与程序步骤告警；以命令开头的安全提示不告警」
- 切片行为：`text` 同样执行词表与模糊词规则 → 「text：词表与模糊词规则同样生效」

## 用户抽查记录
- 2026-10-07：用户按类别抽查通用受控词表（182 条）与模糊词清单（33 个），全部认可。单独列出的高频词、行话与高频模糊词决定保留。（对应 tasks 5.4，来源 /opsx:quality SPEC-06）

## 剩余风险
- 通用受控词表 182 条与模糊词 33 个为自行编写，已由用户抽查认可；高频词阻断的实际噪声需在后续变更中观察。
- 启发式规则（名词串、被动语态、程序步骤、安全提示）在真实文档上的误报率未统计；已全部降为告警。

## 豁免记录
| From Fingerprint | To Fingerprint | 变化文件 | 不影响本切片行为的理由 | 判定人 | 日期 |
|------------------|----------------|---------|--------------------|-------|------|
