# Slice 02 新鲜证据

- Slice: 02
- Behavior: 并集布局生成离线 overview.html
- Seam: `node change-model.mjs layout|render <changeRoot>`
- Recorded At: 2026-10-08T07:06:52Z
- Fingerprint: git-tree:2706d4050ae9b059bd1a041f11c4669fd5503d05
- Fingerprint Source: node skills/openspec-technical-review/scripts/implementation-gate.mjs fingerprint openspec/changes/add-change-model-visualization
- Result: PASS

## 变更文件
- skills/openspec-change-overview/vendor/elk.bundled.js
- skills/openspec-change-overview/vendor/elk.LICENSE.md
- skills/openspec-change-overview/vendor/package.json
- skills/openspec-change-overview/scripts/change-model.mjs
- skills/openspec-change-overview/assets/overview-template.html
- skills/openspec-change-overview/SKILL.md
- scripts/test-change-model.mjs
- openspec/changes/add-change-model-visualization/overview.html

## 验证命令
| 命令 | 结果 | 摘要 |
|------|------|------|
| `npm run -s test:change-model` | PASS | 26 tests, 26 pass, 0 fail（含本切片 layout 4 个、render 4 个用例） |
| `node --check skills/openspec-change-overview/scripts/change-model.mjs` | PASS | 语法检查通过（JS 项目无类型检查，以语法检查替代） |
| `cmp vendor/elk.bundled.js <npm pack elkjs@0.12.0>/lib/elk.bundled.js` | PASS | 与上游发布包逐字节一致（原样内置） |
| `node change-model.mjs render openspec/changes/add-change-model-visualization` | PASS | 写入 overview.html（1 个流程），layout 耗时约 0.3 秒 |
| Chrome headless + DevTools 协议驱动 `overview.html`（file://，离线） | PASS | 视图切换：变更前只显示未变 / 修改 / 删除元素与旧路线 `T2@before`，变更后不显示删除元素与旧路线；选中 S5 高亮 `T5`；选中 T2 侧栏显示 guard「创建后 15 分钟 → 创建后 30 分钟」与终点「CLOSED → CANCELLED」及 Scenario；页面无脚本异常、无非 file:// 网络请求 |
| 用户审阅视觉初稿（2026-10-08） | PASS | 确认：白底、低对比度配色、字重 500；视图切换用标签页；多图纵向排列 + 顶部跳转链接（对比了一图一页原型后选定）。按确认结果修改模板后，用 Chrome headless 重新驱动验证：选中 S5 同时高亮两个状态机中的 T5 与 R1，无脚本异常、无网络请求 |
| `npm test`（全部切片完成后刷新指纹） | PASS | verify 168 条引用可达；orchestration 15 + migration 24 + gate 22 + ste 41 + change-model 30（含本切片全部用例），全部通过 |

## 覆盖的验收行为
- change-model-rendering / Unchanged state keeps its position → 「render：两次输出字节一致；每个元素在 SVG 中只出现一次，未变元素的坐标取自同一次布局」「layout：并集布局包含删除与新增的元素，每个元素只有一组坐标；改了终点的迁移另有旧路线」；浏览器中切换视图后 PENDING 的 transform 不变
- change-model-rendering / Render twice → 「layout：两次运行输出字节一致」「render：两次输出字节一致……」
- change-model-rendering / Blocking finding exists → 「render：模型存在阻断项时退出码 1，不创建也不覆盖 overview.html」「layout：模型存在阻断项时输出检查报告并退出码 1」
- change-model-rendering / Layout JSON contains diff data → 「layout：T3 修改时，T3 的条目含 diff: changed、路径点与 before 旧值」
- change-model-rendering / No external resources → 「render：写入单个 overview.html，内联 SVG 与布局 JSON，不引用任何外部 URL、字体、脚本或样式表」；浏览器无网络请求
- change-model-rendering / Select a changed transition → 浏览器驱动：选中 T2 侧栏显示新旧 guard 与 Scenario 引用
- change-model-rendering / Select a step that causes a transition → 浏览器驱动：选中 S5 后 `machine/order-status/T5` 带 is-linked
- change-model-rendering / Overview without a change model（render 部分）→ 「render：没有变更模型时不创建 overview.html，退出码 0」

## 剩余风险
- 浏览器交互没有纳入自动化测试（design.md「测试 Seam 决策」：人工验证）；本次用 Chrome headless 做了一次性驱动验证，脚本不进仓库。

## 豁免记录
| From Fingerprint | To Fingerprint | 变化文件 | 不影响本切片行为的理由 | 判定人 | 日期 |
|------------------|----------------|---------|--------------------|-------|------|
