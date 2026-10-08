# Spec Fidelity Review（add-ste-gate）

## 评审基线

- Change: add-ste-gate
- Base Commit: 7fe02f4b4d43943bd2fa9091da081ec1c00b4f3a
- Fingerprint: git-tree:c919e951f0ce56d7734bdeffb68ed9bdd770e618
- Review Scope: 7fe02f4b4d43..工作区（含已暂存 / 未暂存 / 未跟踪文件，排除 openspec）
- Baseline Recorded At: 2026-10-07T02:54:38.692Z

> 六份切片证据的 `Fingerprint` 都是 `git-tree:c919e951…`，与基线一致。
> 辅助核实（只读运行）：`node --test scripts/test-ste-lint.mjs` 41/41 通过；`node skills/openspec-ste/scripts/ste-lint.mjs check openspec/changes/add-ste-gate` 退出码 0（blocking 0、warnings 64、exemptions 0）；`openspec validate add-ste-gate` 通过；`config-snippet` 输出与 `openspec/config.yaml` 第 3 行起的内容逐字一致。
> **基线漂移说明（不属于本变更）**：评审时实测指纹为 `git-tree:6f67f993615fffbf720d95ab1fb94bd12b2e0e6a`，与基线不同。基线记录之后变化的文件只有 `skills/openspec-change-overview/vendor/js-yaml.mjs`、`vendor/js-yaml.LICENSE`、`shared/change-model.md`，属于 `add-change-model-visualization`。`npm run verify` 当前因 `change-model.md` 引用尚不存在的 `scripts/change-model.mjs` 报 3 条断链，与 `evidence/slice-06.md:26` 记录的「verify 149 全部通过」不同。本变更涉及的文件（`skills/openspec-ste/**`、`scripts/test-ste-lint.mjs`、四个 skill 与四个命令）在基线之后没有变化，本轮结论按基线内容给出。到 `/opsx:verify` 时，切片证据会因为这次漂移判为过期，需要按 `changedSinceEvidence` 登记豁免，或者先隔离另一个变更的改动。

## 上轮闭环验证

第 2 轮的 SPEC-07～SPEC-09 由 `tasks.md` Slice 06（tasks.md:60-68）承接。按本轴闭环判据逐条核实：「已补实现」要能指出实现行与测试，「已回记」要能指出 design / 规格小节。SPEC-01～SPEC-06 只确认没有回退。

| 历史 finding ID | 结论 | 判断依据 |
|----------------|------|---------|
| SPEC-01 | 已闭环（未回退） | `ste-lint.mjs:347-369`（`TOKEN`、`IDENTIFIER`、`IDENTIFIER_SHAPE`、`PATH_HEAD`、`isFilePath`）、`:410-411`（预处理依次删除路径与标识符）。`scripts/test-ste-lint.mjs:439-458` 的三个用例仍通过 |
| SPEC-02 | 已闭环（未回退） | `ste-lint.mjs:194` `envWarning` 的 `file` 与 `line` 为 `null`。`specs/ste-lint/spec.md:29` 与 design.md:97、:105 不变 |
| SPEC-03 | 已闭环（未回退） | `skills/openspec-apply-change/SKILL.md:36` 与 `claude/commands/opsx/apply.md:32` 先运行 `openspec status --change "<name>" --json` 取 `changeRoot`。design.md:148 不变 |
| SPEC-04 | 已闭环（未回退） | design.md:95-96 用 `C-R1.11` 与 `C-R6.3`，与 `ste-lint.mjs:41`、`:55` 一致 |
| SPEC-05 | 已闭环（未回退） | design.md:120-121、:134、:158、:162-164 不变。`test-ste-lint.mjs:396-404`、`:460-469` 仍通过 |
| SPEC-06 | 已闭环（未回退） | `evidence/slice-02.md:39-40` 与 design.md:247-249 不变 |
| SPEC-07 | 已闭环 | **实现**：`ste-lint.mjs:356` 新增 `PATH_HEAD = /^[\w.*@~-]*$/`。`:363-369` `isFilePath` 对含「/」的片段，要求第一个「/」之前全是英文路径字符，并且片段含英文字母，才算路径。**测试**：`scripts/test-ste-lint.mjs:492-497` 用 `check` 断言「用户A/用户B退单后通知。」「退单/refund 两种写法。」两行都报 `退单`，`logs/退单/app.log` 不报。41/41 通过。**规格**：`specs/ste-lint/spec.md:49` 写明 ASCII 首段口径。**design**：§4 第 1 步（design.md:126）写明新口径，design.md:127 把残余风险（英文开头的「API/退单」、无空格的中英混排）写成已接受的取舍。**复跑上轮的触发输入**（临时 CONTEXT.md：`退单` 为 `取消` 的禁用别名，`text --repo`）：「用户A/用户B退单后通知。」「退单/refund 两种写法。」「取消/退单二选一。」「方案a/退单」都报 `退单`；「API/退单」「v2/退单」「查看日志退单.md」不报，与 design.md:127 记录的残余风险一致 |
| SPEC-08 | 已闭环 | `specs/ste-reply-guard/spec.md:25` 的跳过范围增加了 `identifiers`，并写明「with the same file-path and identifier rules as the artifact check」。实现 `ste-lint.mjs:672` 回复检查与产物检查共用 `preprocess`。`test-ste-lint.mjs:453-458` 断言回复中的标识符不阻断，与规格一致 |
| SPEC-09 | 已闭环 | `skills/openspec-grill/shared/context-format.md:31` 列出「、」「,」「，」「;」「；」五种分隔符，与 `ste-lint.mjs:160` `splitList` 和 design.md:134 一致。`context-format.md:32` 写明其他 `_Category_` 取值会让 STE 检查以退出码 2 报错、apply 因此停止，与 `gate-check.md:32` 退出码 2 一行一致（propose / update 按该行「不得当作通过」处理，verify 记为 CRITICAL） |

## Findings

| ID | 严重级别 | 影响业务功能 | 位置 | 涉及代码模块 | 一句话白话 | 触发场景 | 不修的后果 | 建议修复 | 闭环状态 |
|----|---------|------------|------|------------|-----------|---------|-----------|---------|---------|
| SPEC-10 | Minor | 产物 STE 检查的使用说明（agent 加载 `openspec-ste` 后按它判断哪些写法会被跳过） | skills/openspec-ste/SKILL.md:60 | `skills/openspec-ste/SKILL.md`「排除与豁免」小节；对照 `ste-lint.mjs:356-369`、`specs/ste-lint/spec.md:49`、design.md:126-127 | Slice 06 收紧了路径判定，规格、design 和脚本都改了，但 skill 自己的说明仍写旧口径：「含英文字母、并且含『/』」的片段都算路径。读说明的人会以为「用户A/用户B退单」这类写法会被跳过，实际仍会被检查 | 按 SKILL.md:60，「用户A/用户B退单后通知。」「退单/refund 两种写法。」含英文字母又含「/」，应当是路径、不检查。实测（`text --repo`，`退单` 为禁用别名）两句都报告 `退单`。SKILL.md 也没有写出 design.md:127 的残余风险（「API/退单」这类英文开头的并列写法会被当作路径删除） | 加载本 skill 的 agent 与使用方按说明判断写法，结果和实际检查不一致：以为会被跳过的写法被阻断，要回查脚本或 design 才知道原因。已经接受的漏检风险也不出现在使用方实际阅读的文档里。没有行为错误，只是说明与规格不一致 | **改哪里**：`skills/openspec-ste/SKILL.md:60`。**怎么改**：把文件路径的定义改成和 `specs/ste-lint/spec.md:49` 相同：「含『/』的片段，第一个『/』之前是英文路径段并且片段含英文字母才算路径（如 `docs/单子/readme`）；不含『/』的片段以扩展名结尾时按文件名处理（如 `单子.md`）；『取消/退单』『用户A/用户B退单』『退单/refund』不算路径」，并补一句残余风险：「英文开头的并列写法（如『API/退单』）会被当作路径跳过」。**为什么**：6.1 要求 design §4 同步口径，SKILL.md 是 agent 运行时实际读取的说明，必须和规格保持同一口径 | open |

## 规格覆盖矩阵

| Requirement / Scenario | 实现位置 | 验证证据（测试或 evidence 文件） | 状态 |
|---|---|---|---|
| ste-lint / Requirement：只扫描当前变更产物 | ste-lint.mjs:94-95、:568-586 | — | 已覆盖 |
| └ Scenario：Archived change is not scanned | ste-lint.mjs:568-586 | test-ste-lint.mjs:82-93；evidence/slice-01.md | 已覆盖 |
| ste-lint / Requirement：阻断与告警分级、退出码 0/1/2 | ste-lint.mjs:29、:325-334、:508-566、:743-764、:775-785 | — | 已覆盖 |
| └ Scenario：Forbidden alias blocks | ste-lint.mjs:169-189、:444-471 | test-ste-lint.mjs:49-61、:492-497；evidence/slice-01.md、slice-06.md | 已覆盖（上轮 SPEC-07 漏检已收紧） |
| └ Scenario：Long sentence only warns | ste-lint.mjs:508-566 | test-ste-lint.mjs:226-235；evidence/slice-02.md | 已覆盖 |
| └ Scenario：Missing change root | ste-lint.mjs:750 | test-ste-lint.mjs:75-80；evidence/slice-01.md | 已覆盖 |
| ste-lint / Requirement：JSON 可机读（含 ENV 空值约定） | ste-lint.mjs:194、:588-607、:763 | — | 已覆盖 |
| └ Scenario：JSON output | ste-lint.mjs:763 | test-ste-lint.mjs:63-73；evidence/slice-01.md | 已覆盖 |
| ste-lint / Requirement：`text` 检查 stdin | ste-lint.mjs:98、:754-756 | — | 已覆盖 |
| └ Scenario：Forbidden alias in stdin text | ste-lint.mjs:754-756 | test-ste-lint.mjs:160-167；evidence/slice-01.md | 已覆盖 |
| └ Scenario：Clean stdin text | ste-lint.mjs:754-756、:763 | test-ste-lint.mjs:169-174；evidence/slice-01.md | 已覆盖 |
| ste-lint / Requirement：排除代码、路径、标识符与显式豁免 | ste-lint.mjs:341-415 | test-ste-lint.mjs:439-451、:492-497；evidence/slice-05.md、slice-06.md | 已覆盖（SKILL.md:60 的说明未同步，见 SPEC-10） |
| └ Scenario：Old name in inline code | ste-lint.mjs:343、:410 | test-ste-lint.mjs:95-105；evidence/slice-01.md | 已覆盖 |
| └ Scenario：Explicit exemption | ste-lint.mjs:371、:401、:444-471 | test-ste-lint.mjs:107-113；evidence/slice-01.md | 已覆盖 |
| ste-lint / Requirement：更长术语内的命中不报告 | ste-lint.mjs:182、:191、:327、:426-442 | — | 已覆盖 |
| └ Scenario：Alias is part of a defined term | 同上 | test-ste-lint.mjs:115-123；evidence/slice-01.md | 已覆盖 |
| ste-lint / Requirement：缺少术语表时显式降级；CONTEXT-MAP.md 告警 | ste-lint.mjs:100-101、:169-174 | test-ste-lint.mjs:141-158、:176-181 | 已覆盖 |
| └ Scenario：No CONTEXT.md | ste-lint.mjs:169-174、:325-334 | test-ste-lint.mjs:216-224；evidence/slice-02.md | 已覆盖 |
| ste-lint / Requirement：四个卡点运行 STE 检查 | openspec-propose/SKILL.md:92、:124；openspec-update-change/SKILL.md:69；openspec-apply-change/SKILL.md:36、:162；openspec-verify-change/SKILL.md:86、:139、:148；claude/commands/opsx/propose.md:88、:120，update.md:65，apply.md:32、:158，verify.md:81、:134、:143；处理口径 skills/openspec-ste/shared/gate-check.md:28-32 | — | 已覆盖（6.4 后 propose 护栏与 verify 的 `ERROR` 取值、退出码 2 的 CRITICAL 已同步，与 gate-check.md:32 一致） |
| └ Scenario：Propose fixes blocking findings | openspec-propose/SKILL.md:92、:124；gate-check.md:31 | evidence/slice-03.md（实际运行：退出码 1 → 修正 → 0）；评审实测本变更 `check` 退出码 0 | 已覆盖（提示词流程，实际运行验证） |
| └ Scenario：Apply stops on blocking findings | openspec-apply-change/SKILL.md:36；gate-check.md:31「Apply」列 | evidence/slice-03.md、slice-05.md（文档核对；design 声明该 Seam 无法自动化） | 已覆盖（文档核对） |
| └ Scenario：STE skill not installed | openspec-verify-change/SKILL.md:86、:139 及另外三个 skill 的引用行 | evidence/slice-03.md（文档核对） | 已覆盖（文档核对） |
| ste-reply-guard / Requirement：禁用别名阻断回复（含合并 `last_assistant_message`） | ste-lint.mjs:622-643、:645-677 | — | 已覆盖 |
| └ Scenario：Reply with a forbidden alias | ste-lint.mjs:673-677 | test-ste-lint.mjs:355-361、:370-387；evidence/slice-04.md | 已覆盖 |
| └ Scenario：Reply without findings | ste-lint.mjs:682 | test-ste-lint.mjs:363-368；evidence/slice-04.md | 已覆盖 |
| ste-reply-guard / Requirement：最多重试 1 次 | ste-lint.mjs:653 | — | 已覆盖 |
| └ Scenario：Second stop after a forced rewrite | ste-lint.mjs:653 | test-ste-lint.mjs:389-394；evidence/slice-04.md | 已覆盖 |
| ste-reply-guard / Requirement：回复只因禁用别名阻断（跳过代码、引用块、URL、路径、标识符） | ste-lint.mjs:326、:672、:678-681 | — | 已覆盖（上轮 SPEC-08 规格已同步） |
| └ Scenario：Vague word in a reply | ste-lint.mjs:326、:678-681 | test-ste-lint.mjs:396-404；evidence/slice-05.md | 已覆盖 |
| └ Scenario：User text quoted in a blockquote | ste-lint.mjs:394、:672 | test-ste-lint.mjs:406-412；evidence/slice-04.md | 已覆盖 |
| ste-reply-guard / Requirement：显式降级 | ste-lint.mjs:646-657、:666-670、:766-773 | — | 已覆盖 |
| └ Scenario：Transcript missing | ste-lint.mjs:656-657 | test-ste-lint.mjs:414-432；evidence/slice-04.md | 已覆盖 |
| ste-reply-guard / Requirement：hook 手动启用 | skills/openspec-ste/SKILL.md:108 起 | — | 已覆盖 |
| └ Scenario：Installing the skill | SKILL.md:108（「安装本 skill 不会修改任何 settings.json」）及注册片段 | evidence/slice-04.md（文档核对）；仓库内没有写 settings.json 的代码 | 已覆盖（文档核对） |
| ste-reply-guard / Requirement：其他 agent 用共享规则约束 | shared/reply-rules.md；SKILL.md:128-134；CLAUDE.md 引用行 | — | 已覆盖 |
| └ Scenario：Codex project | SKILL.md:134 | evidence/slice-04.md（文档核对） | 已覆盖（文档核对） |
| ste-rules / Requirement：以 ASD-STE100 为基线、编号可追溯 | shared/ste-rules.md 规则表 | design.md:249（编号核对结论） | 已覆盖 |
| └ Scenario：Adopted rule is traceable | ste-rules.md:41（C-R4.1 行含 R4.1、复述、检查方法、产物 / 对话级别） | evidence/slice-02.md（人工核对） | 已覆盖（文档核对） |
| └ Scenario：English-only rule is excluded | ste-rules.md「不采纳」小节 | evidence/slice-02.md（人工核对） | 已覆盖（文档核对） |
| ste-rules / Requirement：自编通用受控词表 | shared/vocabulary.yaml | evidence/slice-02.md:39-40（用户抽查） | 已覆盖 |
| └ Scenario：Non-approved word has one replacement | vocabulary.yaml；ste-lint.mjs:330 | test-ste-lint.mjs:190-198；evidence/slice-02.md | 已覆盖 |
| └ Scenario：Exception phrase is not a violation | vocabulary.yaml；ste-lint.mjs:327、:426-442 | test-ste-lint.mjs:200-206；evidence/slice-02.md | 已覆盖 |
| ste-rules / Requirement：模糊词清单与默认阈值，注明 1.5 字/词折算未经验证 | vocabulary.yaml；ste-rules.md 阈值小节 | test-ste-lint.mjs:471-489（规则表与词表阈值一致性） | 已覆盖 |
| └ Scenario：Default thresholds apply without project configuration | ste-lint.mjs:273-287、:306-323 | test-ste-lint.mjs:226-246；evidence/slice-02.md | 已覆盖 |
| ste-rules / Requirement：openspec/ste.yaml 覆盖默认值 | ste-lint.mjs:289-323 | — | 已覆盖 |
| └ Scenario：Project adds a vague word | ste-lint.mjs:306-323 | test-ste-lint.mjs:277-290；evidence/slice-02.md | 已覆盖 |
| └ Scenario：Invalid project file | ste-lint.mjs:201-217 | test-ste-lint.mjs:292-308；evidence/slice-02.md | 已覆盖 |
| ste-rules / Requirement：config.yaml rules 片段由规则表生成 | ste-lint.mjs:690-724；openspec/config.yaml:3 起 | — | 已覆盖 |
| └ Scenario：Snippet follows the rule table | ste-lint.mjs:700-724 | test-ste-lint.mjs:310-327；evidence/slice-02.md；评审实测片段与 config.yaml 逐字一致 | 已覆盖 |
| ste-rules / Requirement：CONTEXT.md 作为技术词扩展 | skills/openspec-grill/shared/context-format.md:20、:31-32；ste-lint.mjs:116-162 | — | 已覆盖（上轮 SPEC-09 已同步） |
| └ Scenario：Avoid entry becomes a forbidden alias | ste-lint.mjs:116-151、:169-189 | test-ste-lint.mjs:49-61；evidence/slice-01.md | 已覆盖 |
| └ Scenario：Term declares a category | ste-lint.mjs:91、:116-151 | test-ste-lint.mjs:125-131；evidence/slice-01.md | 已覆盖 |

### 任务真实完成核对（本轮只列 Slice 06；Slice 01～05 与上轮结论相同）

| 任务 | diff 中的对应改动 | 结论 |
|---|---|---|
| 6.1 | ste-lint.mjs:356-369；test-ste-lint.mjs:492-497；design.md:126-127；specs/ste-lint/spec.md:49 | 完成（skill 说明 SKILL.md:60 未同步，见 SPEC-10） |
| 6.2 | specs/ste-reply-guard/spec.md:25 | 完成 |
| 6.3 | skills/openspec-grill/shared/context-format.md:31-32 | 完成 |
| 6.4 | openspec-verify-change/SKILL.md:139、:148；claude/commands/opsx/verify.md:134、:143；openspec-propose/SKILL.md:124；claude/commands/opsx/propose.md:120；proposal.md:62 | 完成（STD 事项，本轴只核对存在性与规格一致性） |

### Seam 一致性

- 六份切片证据的 `Seam` 字段与 tasks.md 切片 `Seam:` 行一致（只省略「见 design.md」括注，与 `slice-evidence.md` 示例写法相同）。evidence/slice-06.md:5 对 tasks.md:62。
- Slice 06 新用例（test-ste-lint.mjs:492-497）通过 CLI 子进程调用 `check`，没有测试脚本内部函数，符合 design「测试 Seam 决策」（design.md:199-226）。
- 6.2～6.4 是文档类条件，按 Slice 06 `Seam:` 行声明的方式人工核对，与 design 一致。

## 设计偏离清单

| 偏离项 | design 中有无 | 建议：回记 design / 撤销实现 |
|---|---|---|
| skill 说明 SKILL.md:60 的路径定义仍是 Slice 05 的旧口径（SPEC-10） | 有（§4 :126-127 是新口径），SKILL.md 未同步 | 同步 SKILL.md（design 不需要改） |
| 路径判定收紧为「首段为英文路径段」，残余漏检「API/退单」与无空格中英混排 | 有（§4 :126-127） | 无需处理（已记录为接受的取舍） |
| verify 报告 STE 行增加 `ERROR`，退出码 2 记一条 CRITICAL | 有（gate-check.md:32；design §6 :153 把处理口径定在 gate-check.md） | 无需处理 |
| README.md 登记 `openspec-ste`、四个命令文件接入卡点 | 有（proposal.md:62 已补） | 无需处理 |
| 新增 `shared/gate-check.md` | 有（§1 :69，§6 :153） | 无需处理 |
| 内置依赖 js-yaml 5.4.2（MIT）与许可证文件 | 有（§1 :72-74、§5；proposal Impact） | 无需处理 |

范围外行为：未发现 proposal / specs 之外的新功能。Slice 06 的改动都对应上轮 finding 或 Standards 轴条件，没有引入新的子命令、配置项或依赖。

## 结论

- 上轮 3 条：SPEC-07、SPEC-08、SPEC-09 都已闭环，没有假闭环；SPEC-01～SPEC-06 没有回退。
- 本轮新增：Blocker 0；Major 0；Minor 1（SPEC-10）。
- 有条件通过的条件（tasks.md 目前没有对应勾选项，主 agent 必须先新增以下勾选项；新增前视同未映射）：
  - 条件 1 → 新增任务「7.1 SPEC-10：`skills/openspec-ste/SKILL.md:60` 的文件路径定义同步为 ste-lint 规格『Code, paths and explicit exemptions』的口径，并写出『API/退单』类残余风险」
- 提醒（不属于本轴 finding）：当前工作区指纹因 `add-change-model-visualization` 的文件漂移，`npm run verify` 当前失败，原因在 `skills/openspec-change-overview/shared/change-model.md`。进入 `/opsx:verify` 前需要处理证据新鲜度。

Spec Fidelity Review 结论：有条件通过
