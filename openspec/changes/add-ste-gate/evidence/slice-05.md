# Slice 05 新鲜证据

- Slice: 05
- Behavior: 双轴评审条件闭环（/opsx:quality 第 1 轮）
- Seam: `node ste-lint.mjs check <changeRoot>`、`node ste-lint.mjs text`、`node ste-lint.mjs reply-hook`；文档类条件人工核对
- Recorded At: 2026-10-08T06:02:01Z
- Fingerprint: git-tree:26b9ff0be36d8ec033a14060924e9b177f2cea57
- Fingerprint Source: node skills/openspec-technical-review/scripts/implementation-gate.mjs fingerprint openspec/changes/add-ste-gate
- Result: PASS

## 变更文件
- skills/openspec-ste/scripts/ste-lint.mjs（5.1 路径与标识符排除；5.6 MIN_WORD_LENGTH、LEVEL、longerNames、阈值注释）
- skills/openspec-ste/shared/gate-check.md（5.5 新增，卡点处理口径唯一事实源）
- skills/openspec-ste/SKILL.md、skills/openspec-ste/shared/ste-rules.md（5.1 标识符说明；5.5 卡点表改为引用）
- skills/openspec-propose/SKILL.md、skills/openspec-update-change/SKILL.md、skills/openspec-apply-change/SKILL.md、skills/openspec-verify-change/SKILL.md（5.3、5.5）
- claude/commands/opsx/propose.md、update.md、apply.md、verify.md（5.3、5.5）
- scripts/test-ste-lint.mjs（5.1、5.6 用例）
- README.md（5.6 STD-08）

## 验证命令
| 命令 | 结果 | 摘要 |
|------|------|------|
| `node --test scripts/test-ste-lint.mjs` | PASS | 40 tests, 40 pass, 0 fail；5.1 的 3 个新用例先确认失败再实现 |
| `node --check skills/openspec-ste/scripts/ste-lint.mjs` | PASS | 语法检查通过（JS 项目无类型检查，以语法检查替代） |
| `npm run verify` | PASS | 全部 149 条引用可达，含新增的 `../openspec-ste/shared/gate-check.md` 引用 |
| 临时把 ste-rules.md 的「一段不超过 6 句」改为 5 后运行一致性测试，再恢复 | PASS | 改动后用例失败（fail 1），恢复后通过，证明 STD-06 的一致性测试能发现漂移 |
| `node skills/openspec-ste/scripts/ste-lint.mjs check openspec/changes/add-ste-gate` | PASS | blocking 0、warnings 58 |
| `openspec validate add-ste-gate` | PASS | Change 'add-ste-gate' is valid |
| `npm test` | PASS | verify 149 + orchestration 15 + migration 24 + gate 22 + ste 40，全部通过 |

| `node --test scripts/test-ste-lint.mjs` + `npm run verify`（全部切片完成后刷新指纹） | PASS | ste 41 tests 全部通过（含本切片全部用例）；153 条引用可达。完整 `npm test` 此时因另一个变更 add-change-model-visualization 进行中的 `test:change-model` 失败（4 fail），与本变更无关，未作为本切片的验证命令 |
## 覆盖的验收行为
- 5.1 / SPEC-01 → 「check：含中文段的路径与文件名不报告；不含英文字母的「订单/单子」仍报告」「check：驼峰、下划线、点调用形式的标识符不报告；正文中的英文别名仍报告」「reply-hook：回复中路径与标识符里的别名不阻断」；design §4 第 1 步、ste-lint 规格「Code, paths and explicit exemptions」写明判定口径
- 5.2 / SPEC-02、SPEC-04、SPEC-05 → design §1 目录树、§2 规则编号与 ENV 空值约定、§3 指令句与句子切分、§4 分隔符与类别校验、§7 hook 告警输出、目录回退与配置降级；ste-lint 规格「Findings SHALL be machine-readable」增加 ENV 空值约定（人工核对）
- 5.3 / SPEC-03、STD-02 → apply 的 SKILL 与命令先运行 `openspec status` 取 `changeRoot`；design §6 与 tasks 3.2 写明 Step 2（人工核对）
- 5.4 / SPEC-06 → 用户抽查词表与模糊词清单，结论写入 evidence/slice-02.md「用户抽查记录」与 design Open Questions
- 5.5 / STD-01 → `skills/openspec-ste/shared/gate-check.md` 为唯一事实源，8 个文件各一行引用；`npm run verify` 通过
- 5.6 / STD-03～STD-09 → 「reply-hook：模糊词与非受控通用词只告警，不阻断」增加 systemMessage 断言；「reply-hook：ste.yaml 非法时仍阻断禁用别名，词表告警降级为不检查」；「规则表中的阈值与 vocabulary.yaml、名词串判定一致」；README 登记 openspec-ste 并更新数量

## 剩余风险
- 文件路径判定依赖空白或标点分隔：中文与英文路径之间没有空格时（如「用户退单后查看日志app.log」），整个片段会被当作路径删除，别名可能漏检。本仓写作风格在中英文之间加空格，已在 design §4 写明判定口径。
- README.md:153 中「6 个 `openspec-*` 流程增强 skill」的数量在本变更之前就与表格（7 个）不一致，本变更没有修改。

## 豁免记录
| From Fingerprint | To Fingerprint | 变化文件 | 不影响本切片行为的理由 | 判定人 | 日期 |
|------------------|----------------|---------|--------------------|-------|------|
