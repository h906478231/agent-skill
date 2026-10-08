## Slice 01: 产物中的禁用别名被阻断（检查脚本端到端）
Blocked by: 无（可立即开始）
Seam: `node ste-lint.mjs check <changeRoot>`、`node ste-lint.mjs text`（见 design.md「测试 Seam 决策」）
Evidence: evidence/slice-01.md

- [x] 1.1 创建 `skills/openspec-ste/` 骨架与 SKILL.md 初稿；内置 js-yaml 到 `vendor/`，记录版本与 MIT 许可证
- [x] 1.2 实现 CONTEXT.md 解析：术语、`_Avoid_`、`_Category_`；1 个字的别名报环境错误；存在 CONTEXT-MAP.md 时告警
- [x] 1.3 实现 `check` 子命令：扫描范围（四类产物）、预处理排除（代码块、行内代码、URL、路径）、`term-allow` 豁免、长术语去误报、JSON 输出与退出码 0 / 1 / 2
- [x] 1.4 实现 `text` 子命令：从 stdin 读取文本，按产物级分级检查，输出与 `check` 相同的 JSON，行号取输入行号；供 `add-change-model-visualization` 与 `add-explainer-video` 调用
- [x] 1.5 缺少 CONTEXT.md 时跳过禁用别名规则并告警（`check` 与 `text` 相同）
- [x] 1.6 新增 `scripts/test-ste-lint.mjs`，覆盖本切片全部 Scenario；`package.json` 增加 `test:ste` 并纳入 `test`
- [x] 1.7 修改 `openspec-grill/shared/context-format.md`：`_Avoid_` 为禁用别名并引用 ADR-0003；术语可选 `_Category_: 技术名词 / 技术动词` 并引用 ADR-0005

## Slice 02: STE 规则表、通用受控词表与模糊词生效
Blocked by: Slice 01
Seam: `node ste-lint.mjs check <changeRoot>`、`node ste-lint.mjs config-snippet`（见 design.md「测试 Seam 决策」）
Evidence: evidence/slice-02.md

- [x] 2.1 编写 `shared/ste-rules.md`：对照 ASD-STE100 Issue 9 原文逐条核对编号，只引用编号、自行复述；列出不采纳的英文专属规则
- [x] 2.2 编写 `shared/vocabulary.yaml`：通用受控词表（100～200 条，含例外短语）、模糊词清单、默认阈值 40 / 30 / 6；提交前请用户抽查词条
- [x] 2.3 实现非受控通用词与模糊词阻断，以及名词串、被动语态、句长、程序步骤、安全提示五类告警（`check` 与 `text` 同时生效）
- [x] 2.4 实现 `openspec/ste.yaml` 合并（`add` / `remove` / `thresholds`）与非法文件退出码 2
- [x] 2.5 实现 `config-snippet` 子命令，由 `ste-rules.md` 生成 rules 片段；本仓库 `openspec/config.yaml` 写入该片段
- [x] 2.6 补充测试：词表阻断、例外短语、各类告警只告警、配置合并、非法配置、片段跟随规则表

## Slice 03: OpenSpec 四个卡点调用 STE 检查
Blocked by: Slice 02
Seam: `/opsx:propose`、`/opsx:update`、`/opsx:apply`、`/opsx:verify` skill 入口（见 design.md「测试 Seam 决策」）
Evidence: evidence/slice-03.md

- [x] 3.1 `openspec-propose` 与 `openspec-update-change`：写完产物后运行 `check`，修正阻断项并重跑到退出码 0
- [x] 3.2 `openspec-apply-change` Step 2（开始任何任务前）：`check` 退出码 1 时列出问题并停止
- [x] 3.3 `openspec-verify-change`：每个阻断项记为 CRITICAL；找不到 `openspec-ste` 时写明已跳过及原因（四个 skill 统一）
- [x] 3.4 运行 `npm run verify`，确认新增的跨 skill 引用无断链；确认 `scripts/pack-skill.sh` 打包包含 `vendor/`
- [x] 3.5 实际运行验证：对本变更目录运行 `check`，退出码为 0

## Slice 04: Claude Code 对话回复中的禁用别名被阻断
Blocked by: Slice 03
Seam: `node ste-lint.mjs reply-hook`（stdin 事件，见 design.md「测试 Seam 决策」）
Evidence: evidence/slice-04.md

- [x] 4.1 实现 `reply-hook` 子命令：读取最后一条用户消息之后的 assistant 文本块；排除代码、引用块、URL、路径；命中禁用别名输出 block 决策
- [x] 4.2 `stop_hook_active` 为 true 时放行；没有 CONTEXT.md、transcript 缺失或解析失败时放行
- [x] 4.3 补充测试：使用 transcript 示例文件覆盖阻断、放行、重试一次、引用块排除、降级放行
- [x] 4.4 编写 `shared/reply-rules.md`（引用 `ste-rules.md`）；SKILL.md 写明 `settings.json` 注册片段、`CLAUDE.md` / `AGENTS.md` 引用行、非 Claude Code agent 只有规则约束
- [x] 4.5 本仓库 `CLAUDE.md` 增加一行引用 `reply-rules.md`；在 Claude Code 中手动注册 hook，用一条含禁用别名的回复做实际运行验证

## Slice 05: 双轴评审条件闭环（/opsx:quality 第 1 轮）
Blocked by: Slice 04
Seam: `node ste-lint.mjs check <changeRoot>`、`node ste-lint.mjs text`、`node ste-lint.mjs reply-hook`；文档类条件人工核对（见 design.md「测试 Seam 决策」）
Evidence: evidence/slice-05.md

- [x] 5.1 SPEC-01：`ste-lint.mjs` 排除裸标识符与含中文段的文件路径，补 `check` 与 `reply-hook` 用例，design §4 写明标识符判定口径
- [x] 5.2 SPEC-02、SPEC-04、SPEC-05：design 与 ste-lint 规格写明 ENV 告警的空值约定、规则编号示例、hook 告警输出、目录回退、配置降级、分隔符与类别校验、指令句口径
- [x] 5.3 SPEC-03、STD-02：apply 的 SKILL 与命令写明 Step 2 中 `changeRoot` 的来源，不引用后续步骤；design §6 与任务 3.2 的步骤编号与实现一致
- [x] 5.4 SPEC-06：用户抽查词表与模糊词清单，结论写入 evidence/slice-02.md 与 design 的 Open Questions
- [x] 5.5 STD-01：卡点处理口径抽取到 `skills/openspec-ste/shared/gate-check.md`，四个 skill 与四个命令改为一行引用，`npm run verify` 通过
- [x] 5.6 STD-03～STD-09：命名常量、级别常量、长术语判定去重、阈值一致性测试、reply-hook 告警与降级用例、README 登记 skill、中文注释

## Slice 06: 双轴评审条件闭环（/opsx:quality 第 2 轮）
Blocked by: Slice 05
Seam: `node ste-lint.mjs check <changeRoot>`、`node ste-lint.mjs text`；文档类条件人工核对（见 design.md「测试 Seam 决策」）
Evidence: evidence/slice-06.md

- [x] 6.1 SPEC-07：收紧路径判定，只有首段为英文路径段的片段才算路径，补「用户A/用户B退单」与「退单/refund」两个 `check` 用例，design §4 同步口径
- [x] 6.2 SPEC-08：ste-reply-guard 规格的跳过范围增加标识符
- [x] 6.3 SPEC-09：`context-format.md` 写明全部分隔符与类别取值非法时的报错
- [x] 6.4 STD-10、STD-11：verify 报告的 STE 行增加 `ERROR` 取值，CRITICAL 清单写明环境错误；propose 的护栏改为引用 `gate-check.md`，命令文件补同一条；proposal 的 Impact 补 README.md

## Slice 07: 双轴评审条件闭环（/opsx:quality 第 3 轮）
Blocked by: Slice 06
Seam: 文档类条件人工核对（`skills/openspec-ste/SKILL.md`）
Evidence: evidence/slice-07.md

- [x] 7.1 SPEC-10：`skills/openspec-ste/SKILL.md` 的文件路径定义与 ste-lint 规格一致，写明「API/退单」类残余风险
