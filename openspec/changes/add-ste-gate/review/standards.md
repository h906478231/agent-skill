# Standards Review（add-ste-gate）

## 评审基线

- Change: add-ste-gate
- Base Commit: 7fe02f4b4d43943bd2fa9091da081ec1c00b4f3a
- Fingerprint: git-tree:c919e951f0ce56d7734bdeffb68ed9bdd770e618
- Review Scope: 7fe02f4b4d43..工作区（含已暂存 / 未暂存 / 未跟踪文件，排除 openspec）
- Baseline Recorded At: 2026-10-07T02:54:38.692Z

## 评审范围与辅助验证

- 第 3 轮（重跑）。上轮报告基线指纹 `git-tree:7d089e8f…`，上轮 open 的 STD-10、STD-11 由 `tasks.md` Slice 06 的 6.4 承接；本轮重点审查 Slice 06 新增改动（6.1 `ste-lint.mjs` 的 `PATH_HEAD` / `isFilePath` 与 1 个测试用例，6.3 `context-format.md`，6.4 verify / propose 的卡点文案，4 个命令文件的空格笔误）。
- 已跟踪改动：`CLAUDE.md`、`README.md`、`package.json`、`claude/commands/opsx/{apply,propose,update,verify}.md`、`skills/openspec-{apply-change,propose,update-change,verify-change}/SKILL.md`、`skills/openspec-grill/shared/context-format.md`。
- 新增文件：`skills/openspec-ste/**`（`vendor/js-yaml.mjs` 为第三方原样拷贝，不逐行评审）、`scripts/test-ste-lint.mjs`。
- 不在范围：`CONTEXT.md`、`docs/**`、`openspec/changes/add-change-model-visualization/`、`openspec/changes/add-explainer-video/`。
- 辅助验证（只读）：
  - `node --test scripts/test-ste-lint.mjs`：41/41 通过（上轮 40 条，本轮新增 1 条）。
  - `npm run verify`：失败，3 条断链全部来自 `skills/openspec-change-overview/shared/change-model.md`（引用 `scripts/change-model.mjs`）。该文件与 `skills/openspec-change-overview/vendor/` 是基线记录之后（本地 10:55）新出现的未跟踪文件，属于 add-change-model-visualization，不在本变更范围；本变更新增的 `gate-check.md`、`ste-lint.mjs`、`reply-rules.md` 等引用未出现在断链清单中。
  - 当前实现指纹 `git-tree:6f67f993…` 与基线 `c919e951…` 不同。用 `find -newermt` 核对，基线时间之后变动的文件只有上述 3 个 change-overview 文件，本变更范围内的文件在基线之后没有修改，本报告结论对基线有效。
  - `ste-lint.mjs` 中 `'blocking'` / `'warning'` 字面量只剩 `LEVEL` 定义处（:68）；`MIN_WORD_LENGTH`（:71，调用方 :133、:134、:227）、`longerNames`（:191，调用方 :182、:327）、`THRESHOLD_KEYS`（:253，调用方 :264、:265）均在；`ls -d skills/*/` 为 40，与 `README.md:8`、`:31` 一致。
  - 新增 `PATH_HEAD`（:356）只被 `isFilePath`（:363-369）使用，`isFilePath` 只被 `preprocess`（:410）调用，无死代码。

## 上轮闭环验证

| 历史 finding ID | 结论 | 判断依据 |
|----------------|------|---------|
| STD-01～STD-09 | 已闭环（无回退） | 本轮核对：`gate-check.md:28-32` 四列处理表仍是唯一口径，8 个卡点仍各只有一段引用（`skills/openspec-propose/SKILL.md:92`、`skills/openspec-update-change/SKILL.md:69`、`skills/openspec-apply-change/SKILL.md:36`、`skills/openspec-verify-change/SKILL.md:86`、`claude/commands/opsx/propose.md:88`、`update.md:65`、`apply.md:32`、`verify.md:81`）；apply 引用段仍先取 `changeRoot`（STD-02）；`LEVEL` / `MIN_WORD_LENGTH` / `longerNames` / `THRESHOLD_KEYS` 及其调用方见上节；阈值一致性测试 `scripts/test-ste-lint.mjs:471-486` 与 systemMessage 断言 `:401-403`、`:460-469` 仍在且通过；README 计数 40 / 8 与实际一致 |
| STD-10 | 已闭环 | `skills/openspec-verify-change/SKILL.md:139` 与 `claude/commands/opsx/verify.md:134` 的 STE 行改为 `PASS/BLOCKED/ERROR (or 已跳过: reason)`，环境错误有了独立取值，不再需要借用 BLOCKED 或「已跳过」；CRITICAL 清单 `SKILL.md:148` 与 `verify.md:143` 改为「STE check blocking findings, one CRITICAL per finding; STE check exit code 2 (environment error) as one CRITICAL」，与 `gate-check.md:31-32` Verify 列（阻断项逐条 CRITICAL、退出码 2 记 CRITICAL）一致。两处镜像内容逐字相同。原触发场景（`ste.yaml` 非法 → 退出码 2 → 记法不确定）已有唯一记法。建议修复第 3 点（gate-check.md Verify 列写明 BLOCKED / ERROR 取值）未采纳，见「其他观察」，不影响闭环 |
| STD-11 | 已闭环 | `skills/openspec-propose/SKILL.md:124` 护栏改为「STE 检查按 `../openspec-ste/shared/gate-check.md` 的「Propose」列处理后才输出完成总结」，不再自行改写「退出码为 0 前不输出总结」，与 `gate-check.md:32`（退出码 2 原样报告错误）不再冲突；`claude/commands/opsx/propose.md:120` 新增同一条护栏（路径按命令文件惯例写成 skill `openspec-ste` 的 `shared/gate-check.md`），skill 与命令两条入口一致，写法与 apply 护栏（`SKILL.md:162` ↔ `apply.md:158`）对齐 |

另：上轮「其他观察」中 4 个命令文件「按 该 skill」的多余空格已修正，`grep -rn "按 该" skills claude` 无结果。

## Findings

| ID | 严重级别 | 影响业务功能 | 位置 | 涉及代码模块 | 一句话白话 | 触发场景 | 不修的后果 | 建议修复 | 闭环状态 |
|----|---------|------------|------|------------|-----------|---------|-----------|---------|---------|
| 无 | | | | | | | | | |

本轮新增改动审查要点（均未立项）：

- `skills/openspec-ste/scripts/ste-lint.mjs:355-369`：`PATH_HEAD` 带中文说明；`isFilePath` 的 JSDoc 写清两条判定分支，并说明为什么要求首段是英文路径段（避免「用户A/用户B退单」「退单/refund」漏检别名）。函数只有 2 层分支，没有新增魔法值，符合 CLAUDE.md 对中文注释与「解释为什么」的要求。含「/」分支里的 `/[A-Za-z]/.test(token)` 仍有作用（首段为空的 `/单子`、首段为 `.` 的 `./单子` 依靠它排除），不是冗余条件。
- `scripts/test-ste-lint.mjs:492-497`：新用例通过 `check` 入口观察行为，一个输入覆盖中文开头并列、中文/英文并列、真实路径三种情况；期望值 `['1:退单', '2:退单']` 由输入文本直接推出，不是对实现的同义反复；复用既有 `fixture`，没有复制样板。
- `skills/openspec-grill/shared/context-format.md:31-32`：别名分隔符「、」「,」「，」「;」「；」与 `ste-lint.mjs:161` `splitList` 的正则 `/[、,，;；]/` 一致；`_Category_` 取值与 `ste-lint.mjs:91` `CATEGORIES` 一致，非法取值走 `:144` 抛 `LintError`（退出码 2），文档描述与实现相符。

## 本轴特有内容：重复率专项

| 位置A ↔ 位置B | 相似行数 | 建议抽取到哪里 |
|---|---|---|
| 4 个 SKILL.md 的 STE 引用段 ↔ 4 个 `claude/commands/opsx/*.md` 的 STE 引用段（:92↔:88、:69↔:65、:36↔:32、:86↔:81） | 每对 1 段，只有脚本定位写法不同 | 已收敛到 `skills/openspec-ste/shared/gate-check.md`（STD-01）。命令镜像 SKILL 是仓库既有约定（`README.md:150`），不立项 |
| skills/openspec-propose/SKILL.md:124 ↔ claude/commands/opsx/propose.md:120 | 1 行护栏 | 镜像约定，内容一致，规则只引用 gate-check.md（STD-11 已闭环），不立项 |
| skills/openspec-apply-change/SKILL.md:162 ↔ claude/commands/opsx/apply.md:158 | 1 行护栏 | 镜像约定，内容一致，不立项 |
| skills/openspec-verify-change/SKILL.md:139、:148 ↔ claude/commands/opsx/verify.md:134、:143 | 各 1 行 | 镜像约定，逐字一致（STD-10 已闭环），不立项 |
| skills/openspec-grill/shared/context-format.md:31（分隔符列表）↔ skills/openspec-ste/scripts/ste-lint.mjs:161（`splitList` 正则） | 1 行文档 ↔ 1 个正则 | 当前一致。文档是 CONTEXT.md 格式的唯一事实源，正则是它的实现，属于文档与实现的正常对应，不立项；以后改分隔符需两处同改 |
| skills/openspec-ste/shared/ste-rules.md 阈值 ↔ vocabulary.yaml、ste-lint.mjs:74 | 4 个阈值数字 | 已由一致性测试 `scripts/test-ste-lint.mjs:471-486` 锁定（STD-06） |
| ste-lint.mjs:235-241（vocabularyEntry）↔ :244-250（vagueEntry） | 5 行结构相似 | 不建议抽取：字段集合与返回结构不同，合并后要加参数分支，可读性下降 |
| ste-lint.mjs:29、:726-741、:743-788 ↔ skills/openspec-technical-review/scripts/implementation-gate.mjs 的 EXIT、parseOptions、入口骨架 | 约 30 行 | 不建议抽取：两个 skill 独立打包安装，跨 skill import 会让单独安装 openspec-ste 时脚本无法加载 |
| scripts/test-ste-lint.mjs:34 ↔ :314 ↔ :348 | `spawnSync(process.execPath, [lint, …])` 2～3 行 | 可选：让 fixture 的 `run` 接受 `env` 参数后由 `hook()` 复用；规模小，不立项 |
| skills/openspec-ste/vendor/js-yaml.mjs ↔ node_modules/js-yaml/dist/js-yaml.mjs | 整文件相同 | 有意内置（目标项目不一定执行 npm install），版本与许可证已记录，不立项 |

结论：本轮新增代码（`isFilePath` 约 10 行、1 个测试用例）没有引入新的复制；卡点文案的重复只剩命令镜像 SKILL 的既有约定。

## 其他观察（不立项）

- `skills/openspec-ste/shared/gate-check.md:30-32` Verify 列只在退出码 0 写了「报告 STE 行写 PASS」，退出码 1、2 没有写对应的 `BLOCKED` / `ERROR`；这两个取值现在由 verify 模板（`SKILL.md:139`、`verify.md:134`）给出，对应关系可从 CRITICAL 清单的「exit code 2 (environment error)」直接看出，不会记错。若希望取值也只在 gate-check.md 定义，可在 :31、:32 的 Verify 列各补「STE 行写 BLOCKED / ERROR」，约 2 处措辞。
- `skills/openspec-ste/scripts/ste-lint.mjs:363-369` 的 `isFilePath` 插在预处理区的常量定义中间，`:369` 结束后直接接 `:370` 的 `TERM_ALLOW` 常量，没有空行。文件内其他函数（如 `:160` `splitList`、`:191` `longerNames`）前后都有空行，且常量集中在函数之前。属排版细节，不影响行为。
- `README.md:154`「本仓自建资产（6 个 `openspec-*` 流程增强 skill …）」在本变更前已与表格数量不符，本变更加入 `openspec-ste` 后差距扩大；属于历史问题，未计入 finding。
- `npm run verify` 当前失败，原因是范围外的 `skills/openspec-change-overview/shared/change-model.md`（基线之后新建）引用了尚不存在的 `scripts/change-model.mjs`，与本变更无关，但会让本仓 `npm test` 整体失败，需要 add-change-model-visualization 那边处理。

## 结论

- 上轮 open 的 STD-10、STD-11 已闭环；STD-01～STD-09 无回退。
- 本轮新增：Blocker 0 条；Major 0 条；Minor 0 条。

Standards Review 结论：通过
