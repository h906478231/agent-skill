# Slice 01 新鲜证据

- Slice: 01
- Behavior: 产物中的禁用别名被阻断（检查脚本端到端）
- Seam: `node ste-lint.mjs check <changeRoot>`、`node ste-lint.mjs text`
- Recorded At: 2026-10-08T06:02:01Z
- Fingerprint: git-tree:26b9ff0be36d8ec033a14060924e9b177f2cea57
- Fingerprint Source: node skills/openspec-technical-review/scripts/implementation-gate.mjs fingerprint openspec/changes/add-ste-gate
- Result: PASS

## 变更文件
- skills/openspec-ste/SKILL.md
- skills/openspec-ste/scripts/ste-lint.mjs
- skills/openspec-ste/vendor/js-yaml.mjs
- skills/openspec-ste/vendor/js-yaml.LICENSE
- skills/openspec-grill/shared/context-format.md
- scripts/test-ste-lint.mjs
- package.json

## 验证命令
| 命令 | 结果 | 摘要 |
|------|------|------|
| `node --test scripts/test-ste-lint.mjs` | PASS | 14 tests, 14 pass, 0 fail |
| `node --check skills/openspec-ste/scripts/ste-lint.mjs` | PASS | 语法检查通过（JS 项目无类型检查，以语法检查替代） |

| `node --test scripts/test-ste-lint.mjs` + `npm run verify`（全部切片完成后刷新指纹） | PASS | ste 41 tests 全部通过（含本切片全部用例）；153 条引用可达。完整 `npm test` 此时因另一个变更 add-change-model-visualization 进行中的 `test:change-model` 失败（4 fail），与本变更无关，未作为本切片的验证命令 |
## 覆盖的验收行为
- ste-lint / Archived change is not scanned → 「check：只扫描四类产物，不扫描 review、evidence、overview.md 与 archive」
- ste-lint / Forbidden alias blocks → 「check：design.md 第 12 行的禁用别名被阻断，报告文件、行号、规则、别名与替代词」
- ste-lint / Missing change root → 「check：变更目录不存在时退出码 2」
- ste-lint / JSON output → 「check：输出一个 JSON 对象，含 verdict、blocking、warnings、exemptions；无阻断项退出码 0」
- ste-lint / Forbidden alias in stdin text → 「text：stdin 第 3 行的禁用别名被阻断，file 为 <stdin>」
- ste-lint / Clean stdin text → 「text：没有阻断项时退出码 0，blocking 为空」
- ste-lint / Old name in inline code → 「check：代码块、行内代码与 URL 中的别名不报告」
- ste-lint / Explicit exemption → 「check：term-allow 豁免该行的别名并计数」
- ste-lint / Alias is part of a defined term → 「check：别名只出现在术语表中更长的术语内时不报告」
- ste-lint / No CONTEXT.md（降级与告警部分）→ 「check：没有 CONTEXT.md 时跳过禁用别名规则并告警」「text：没有 CONTEXT.md 时与 check 相同降级」
- ste-rules / Avoid entry becomes a forbidden alias → 同 Forbidden alias blocks
- ste-rules / Term declares a category → 「check：术语声明 _Category_: 技术动词 时，解析结果记为技术动词」
- 切片行为：1 个字的别名报环境错误 → 「check：1 个字的别名报环境错误，退出码 2」；CONTEXT-MAP.md 告警 → 「check：存在 CONTEXT-MAP.md 时只读根 CONTEXT.md 并告警」

## 剩余风险
- ste-lint / No CONTEXT.md 场景中「`适当` 报为阻断」部分依赖模糊词清单，由 Slice 02 覆盖。

## 豁免记录
| From Fingerprint | To Fingerprint | 变化文件 | 不影响本切片行为的理由 | 判定人 | 日期 |
|------------------|----------------|---------|--------------------|-------|------|
