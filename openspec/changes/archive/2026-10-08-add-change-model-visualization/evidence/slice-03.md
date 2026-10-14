# Slice 03 新鲜证据

- Slice: 03
- Behavior: /opsx:overview 嵌入派生 Mermaid 并链接 overview.html
- Seam: `node change-model.mjs mermaid <changeRoot>`、`/opsx:overview` skill 入口
- Recorded At: 2026-10-08T07:06:52Z
- Fingerprint: git-tree:2706d4050ae9b059bd1a041f11c4669fd5503d05
- Fingerprint Source: node skills/openspec-technical-review/scripts/implementation-gate.mjs fingerprint openspec/changes/add-change-model-visualization
- Result: PASS

## 变更文件
- skills/openspec-change-overview/scripts/change-model.mjs
- skills/openspec-change-overview/SKILL.md
- claude/commands/opsx/overview.md
- scripts/test-change-model.mjs
- openspec/changes/add-change-model-visualization/overview.md
- openspec/changes/add-change-model-visualization/overview.html

## 验证命令
| 命令 | 结果 | 摘要 |
|------|------|------|
| `npm run -s test:change-model` | PASS | 29 tests, 29 pass, 0 fail（含本切片 mermaid 3 个用例） |
| `node --check skills/openspec-change-overview/scripts/change-model.mjs` | PASS | 语法检查通过（JS 项目无类型检查，以语法检查替代） |
| `npm run -s verify` | PASS | 155 条资产引用全部可达 |
| Mermaid 12.1.0（npm 发布包，本地文件）在 Chrome headless 中 `mermaid.render` 本变更与文档示例的 3 段派生 Mermaid | PASS | 3 段全部解析成功；classDef 着色、删除连线虚线、➕ / ✏️ / ❌ 前缀正常显示 |
| 按仓库 `openspec-change-overview/SKILL.md` 执行 `/opsx:overview add-change-model-visualization`：`render` → `mermaid` → 写 overview.md | PASS | render 退出码 0 写入 overview.html；overview.md 第 2 块标记之间的文本与 `mermaid` 输出逐字节一致，标记后附 overview.html 链接 |
| `npm test`（全部切片完成后刷新指纹） | PASS | verify 168 条引用可达；orchestration 15 + migration 24 + gate 22 + ste 41 + change-model 30（含本切片全部用例），全部通过 |

## 覆盖的验收行为
- change-model-rendering / Overview with a change model → 实际运行：本变更 overview.md 第 2 块含 `<!-- change-model:begin -->` / `<!-- change-model:end -->` 之间的派生 Mermaid 与 overview.html 链接
- change-model-rendering / Overview without a change model → SKILL.md 第 2 块「没有变更模型时」保持 ASCII；「render：没有变更模型时不创建 overview.html，退出码 0」；「mermaid：……没有变更模型时输出为空」
- overview.md SHALL embed derived Mermaid（着色与前缀）→ 「mermaid：状态机输出 stateDiagram-v2，变动状态用 classDef 着色，迁移标签带 ➕ / ✏️ / ❌ 前缀」「mermaid：流程输出 flowchart TD，节点用 classDef 着色，连线按顺序用 linkStyle 着色」
- 切片行为：确定性与阻断 → 「mermaid：两次输出一致；模型存在阻断项时输出检查报告并退出码 1；没有变更模型时输出为空」

## 剩余风险
- 已安装到 `~/.claude/skills/openspec-change-overview` 的是旧版本 skill，本次按仓库中的 SKILL.md 执行；重新安装前，`/opsx:overview` 斜杠命令仍走旧流程。
- GitHub 等平台内置的 Mermaid 版本可能低于 12.1，旧版本对 `stateDiagram-v2` 的 `class` 语句支持不完整时只影响着色，不影响结构。

## 豁免记录
| From Fingerprint | To Fingerprint | 变化文件 | 不影响本切片行为的理由 | 判定人 | 日期 |
|------------------|----------------|---------|--------------------|-------|------|
