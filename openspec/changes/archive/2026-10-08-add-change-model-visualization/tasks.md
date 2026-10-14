## Slice 01: 变更模型可以被检查（格式与 6 项阻断端到端）
Blocked by: 无（外部依赖：`add-ste-gate` 的 Slice 01 提供 `text` 子命令）
Seam: `node change-model.mjs check <changeRoot>`（见 design.md「测试 Seam 决策」）
Evidence: evidence/slice-01.md

- [x] 1.1 编写 `openspec-change-overview/shared/change-model.md`：字段表、Scenario 引用格式、可视化判定小节格式、完整示例、6 项检查说明
- [x] 1.2 内置 js-yaml 到 `vendor/`；实现 `change-model.mjs check`：提取代码块、schema 与引用（规则 1）、Scenario 覆盖（规则 3）、`before`（规则 4）、可视化判定双向比较（规则 5）、已删除元素指向（规则 6）
- [x] 1.3 实现规则 2：调用 `ste-lint.mjs text`；找不到 `openspec-ste` 时跳过并告警
- [x] 1.4 新增 `scripts/test-change-model.mjs` 覆盖 `change-model` 能力全部 Scenario；`package.json` 增加 `test:change-model` 并纳入 `test`

## Slice 02: 并集布局生成离线 overview.html
Blocked by: Slice 01
Seam: `node change-model.mjs layout|render <changeRoot>`（见 design.md「测试 Seam 决策」）
Evidence: evidence/slice-02.md

- [x] 2.1 原样内置 elkjs 与 LICENSE 到 `vendor/`，用 `createRequire` 加载；在 SKILL.md 写明许可证
- [x] 2.2 实现 `layout`：并集输入、按 ID 排序、固定随机种子、节点尺寸规则、输出布局 JSON
- [x] 2.3 编写 `assets/overview-template.html`：三个视图切换、差异着色（含连线）、点击侧栏、`causes` 联动高亮；不引用外部资源
- [x] 2.4 实现 `render`：先 `check`，失败不写文件；生成 SVG 与内联布局 JSON，写入 `overview.html`
- [x] 2.5 补充测试：两次输出字节一致、未变元素坐标一致、无效模型不写文件、HTML 无外部 URL
- [x] 2.6 人工验证：对本变更运行 `render`，离线打开 `overview.html`，检查视图切换、侧栏与联动高亮；视觉样式初稿请用户确认

## Slice 03: /opsx:overview 嵌入派生 Mermaid 并链接 overview.html
Blocked by: Slice 02
Seam: `node change-model.mjs mermaid <changeRoot>`、`/opsx:overview` skill 入口（见 design.md「测试 Seam 决策」）
Evidence: evidence/slice-03.md

- [x] 3.1 实现 `mermaid`：machine 输出 `stateDiagram-v2`（`classDef` 着色、迁移标签前缀），flow 输出 `flowchart TD`（`classDef` 与 `linkStyle` 着色）
- [x] 3.2 修改 `openspec-change-overview/SKILL.md`：有变更模型时运行 `render`，把 `mermaid` 输出原样插入第 2 块固定标记之间并附链接；无变更模型时保持 ASCII
- [x] 3.3 补充 `mermaid` 子命令测试
- [x] 3.4 实际运行验证：对本变更运行 `/opsx:overview`，确认 overview.md 嵌入 Mermaid 并生成 `overview.html`

## Slice 04: OpenSpec 卡点运行变更模型检查，design 编写说明包含变更模型
Blocked by: Slice 03；外部依赖 `add-ste-gate` 的 Slice 03（卡点位置）
Seam: `/opsx:propose`、`/opsx:update`、`/opsx:apply`、`/opsx:verify` skill 入口（见 design.md「测试 Seam 决策」）
Evidence: evidence/slice-04.md

- [x] 4.1 四个 skill 在 STE 检查之后运行 `change-model.mjs check`，阻断行为相同
- [x] 4.2 `openspec-propose` 的 design 编写说明：必须写「可视化判定」小节；命中时按 `shared/change-model.md` 编写变更模型
- [x] 4.3 运行 `npm run verify` 确认跨 skill 引用无断链；确认 `scripts/pack-skill.sh` 打包包含 `assets/` 与 `vendor/`
- [x] 4.4 实际运行验证：对本变更目录运行 `check`，退出码为 0

## Slice 05: 双轴评审条件闭环（/opsx:quality 第 1 轮）
Blocked by: Slice 04
Seam: `node change-model.mjs check <changeRoot>`；文档类条件人工核对（见 design.md「测试 Seam 决策」）
Evidence: evidence/slice-05.md

- [x] 5.1 SPEC-01：命中行允许行末括号备注，解析前删除备注；design §3 第 6 步与 `shared/change-model.md` 写明；补 `check` 测试
- [x] 5.2 SPEC-02：Migration Plan 写明在途变更需补「可视化判定」小节；经用户确认后，为 `add-dual-axis-review-evidence` 与 `ddd-visualization-data-separation` 补小节
- [x] 5.3 STD-01：`vendor/NOTICE` 写明 elkjs 与 js-yaml 的版本、上游源码地址、npm 包来源与 sha256；SKILL.md 引用该文件
