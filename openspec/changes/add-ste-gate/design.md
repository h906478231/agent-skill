## Context

- 现状：CONTEXT.md 的 `_Avoid_` 只是约定（`openspec-grill/shared/context-format.md`）。产物与对话回复中没有任何术语检查。
- 先例：`openspec-technical-review/scripts/implementation-gate.mjs` 是确定性校验脚本。它只依赖 Node.js 内置模块，输出 JSON，退出码 0 / 1 / 2，由 `scripts/test-implementation-gate.mjs` 在临时目录中测试。`hooks/check-review-approval.sh` 是随 skill 分发、由用户手动注册的 hook。本变更沿用这两个先例。
- 已定决策：grill 共识 Q2～Q4、Q8～Q11、Q18～Q22；ADR-0003（禁用别名阻断）、ADR-0005（STE 规则基线）。本文件引用 ADR，不复述理由。
- 下游：`add-change-model-visualization` 需要调用本变更的术语检查。

## Goals / Non-Goals

**Goals:**

- 产物中的禁用别名、非受控通用词、模糊词被机械阻断。
- Claude Code 对话回复中的禁用别名被 Stop hook 阻断，最多重试 1 次。
- STE 规则表是唯一事实源：`config.yaml` 规则片段、对话规则文件都由它生成或引用。
- 目标项目不执行 `npm install` 也能运行检查。

**Non-Goals:**

- 不检查历史变更、主规格目录与 archive 目录。
- 不支持多领域术语表（`CONTEXT-MAP.md`）。存在时只读根 CONTEXT.md 并告警。
- 不做中文分词。名词串、被动语态等规则只做启发式告警。
- 不自动修改 `settings.json`，不自动改写违规文字（由 AI 按报告修改）。
- 不检查 `change-model` 代码块。该规则由 `add-change-model-visualization` 增加。

## 可视化判定

- 状态变动：未命中（本变更不新增或修改状态机）
- 流程变动：命中 → flows: propose-checkpoint（四个卡点形态相同，以 propose 为代表）

```change-model
version: 1
flows:
  - id: propose-checkpoint
    name: 编写产物后的 STE 检查
    steps:
      - { id: P1, name: 写入产物 }
      - id: P2
        name: 运行 STE 检查
        kind: decision
        diff: added
        scenarios: [ste-lint/Propose fixes blocking findings]
      - id: P3
        name: 修正阻断项
        diff: added
        scenarios: [ste-lint/Propose fixes blocking findings]
      - { id: P4, name: 输出总结 }
    edges:
      - { from: P1, to: P4, diff: removed }
      - { from: P1, to: P2, diff: added }
      - { from: P2, to: P3, label: 阻断, diff: added }
      - { from: P3, to: P2, diff: added }
      - { from: P2, to: P4, label: 通过, diff: added }
```

本变更实现时变更模型检查尚未存在。该代码块按 `add-change-model-visualization` 的格式编写，供后者实现后验证。

## Decisions

### 1. 新增独立 skill `openspec-ste`

目录结构：

```
skills/openspec-ste/
├── SKILL.md                     # 何时使用、四个卡点、hook 注册片段、跨 agent 差异
├── shared/
│   ├── ste-rules.md             # 中文 STE 规则表（唯一事实源，C-R ← STE R 编号对照）
│   ├── vocabulary.yaml          # 通用受控词表 + 模糊词清单 + 默认阈值
│   ├── gate-check.md            # 四个卡点的检查结果处理口径（唯一事实源，/opsx:quality STD-01 后增加）
│   └── reply-rules.md           # 对话回复规则（供 CLAUDE.md / AGENTS.md 引用）
├── scripts/ste-lint.mjs         # check / text / reply-hook / config-snippet 四个子命令
└── vendor/
    ├── js-yaml.mjs              # 内置 YAML 解析库（MIT），固定版本 5.4.2
    └── js-yaml.LICENSE          # js-yaml 许可证原文
```

- 不放进 `openspec-grill`：grill 负责访谈，检查是独立职责，并且被四个 skill 调用。
- 不放进 `openspec-technical-review`：该 skill 是评审门禁，STE 检查在 propose 阶段就要运行。
- 其他 skill 用相对路径 `../openspec-ste/scripts/ste-lint.mjs` 引用，读不到时 Glob 搜 `**/openspec-ste/scripts/ste-lint.mjs`，与现有 `<GATE>` 写法一致。

### 2. 检查脚本的子命令与输出

```
node ste-lint.mjs check <changeRoot> [--repo <dir>]   # 产物检查，输出 JSON
node ste-lint.mjs text [--repo <dir>]                 # 纯文本检查，stdin 读文本，产物级分级，输出 JSON
node ste-lint.mjs reply-hook                          # Stop hook，stdin 读事件
node ste-lint.mjs config-snippet                      # 打印 config.yaml rules 片段
```

`check` 输出：

```json
{
  "verdict": "BLOCKED",
  "blocking": [{ "file": "design.md", "line": 12, "rule": "C-R1.11", "text": "退单", "replacement": "取消" }],
  "warnings": [{ "file": "proposal.md", "line": 8, "rule": "C-R6.3", "text": "…", "detail": "描述句 55 字 > 40" },
               { "file": null, "line": null, "rule": "ENV", "text": "", "detail": "未建立术语表，一词一义无法校验" }],
  "exemptions": 1
}
```

退出码与 `implementation-gate.mjs` 相同：0 通过，1 存在阻断项，2 参数或环境错误。

- 规则编号以 `shared/ste-rules.md` 为准，禁用别名为 `C-R1.11`（← STE R1.11 同一事物不用不同名称）。
- 环境告警（`rule` 为 `ENV`，如缺少 CONTEXT.md、存在 CONTEXT-MAP.md）不对应某个文件的某一行，`file` 与 `line` 为 `null`。

### 3. 规则分级与检查方法

| 规则 | 检查方法 | 产物 | 对话 |
|---|---|---|---|
| 禁用别名（CONTEXT.md `_Avoid_`） | 精确匹配 | 阻断 | 阻断 |
| 非受控通用词（词表） | 精确匹配 + 例外短语 | 阻断 | 告警 |
| 模糊词（词表） | 精确匹配 | 阻断 | 告警 |
| 名词串 | 连续 12 个及以上汉字，中间没有虚词或标点 | 告警 | 不检查 |
| 被动语态 | 出现「被」字句 | 告警 | 不检查 |
| 句长 | 描述句 > 40 字，指令句 > 30 字，段落 > 6 句 | 告警 | 不检查 |
| 程序步骤 | 指令句含多个动作（「并」「然后」「；」连接） | 告警 | 不检查 |
| 安全提示 | 「警告」「注意」开头的句子不以动词开头 | 告警 | 不检查 |

- 指令句的判定：任何产物中的 checkbox 行（实际只出现在 `tasks.md`），以及有序列表项。其余句子按描述句处理。这是默认口径，项目可在 `ste.yaml` 调整阈值，不能调整判定方式。
- 句子切分：按「。！？」、英文句末标点（其后为空白或行尾）与换行切分。表格行、标题行不计句长。

### 4. 匹配算法与排除范围

1. 预处理：删除代码块、行内代码、URL、文件路径、标识符、HTML 注释（保留 `term-allow` 注释的内容用于豁免）。对话回复另外删除 markdown 引用块。
   - 文件路径：按空白与标点切出片段。含「/」的片段，首段（第一个「/」之前）必须是英文路径段，并且片段含英文字母，才删除（可含中文段，如 `docs/单子/readme`）。不含「/」的片段以扩展名结尾时按文件名删除（如 `单子.md`）。「取消/退单」「用户A/用户B退单」「退单/refund」这类中文开头的并列写法不算路径，避免漏检别名（/opsx:quality SPEC-07）。
   - 残余风险：英文开头的并列写法（如「API/退单」）仍按路径删除；中英文之间不加空格时（如「查看日志app.log」），整个片段按文件名删除。本仓写作风格在中英文之间加空格。
   - 标识符：含驼峰、下划线或点调用的 ASCII 词（如 `purchaseService`、`purchase_id`、`order.purchase`）。`STE`、`purchase` 这类普通英文词不删除，英文别名在正文中仍能命中。
2. 匹配：对每个禁用别名、非受控词、模糊词做子串匹配，保留原文行号。
3. 去误报：
   - 命中位置落在 CONTEXT.md 中更长的术语内，不报告。
   - 命中位置落在词表条目的例外短语内（如 `利用率`），不报告。
   - 该行有 `<!-- term-allow: 词 -->`，不报告，豁免计数加 1。
4. CONTEXT.md 解析：识别 `**Term（中文）**:` 标题行、其后的 `_Avoid_:` 行与可选 `_Category_:` 行。`_Avoid_` 词以「、」「,」「，」「;」「；」分隔。长度为 1 个字的别名在解析时报环境错误，因为子串匹配会大面积误报。`_Category_` 只能是 `技术名词` 或 `技术动词`，其他取值报环境错误，避免拼写错误的类别被静默忽略。

### 5. 配置合并

- 内置 `shared/vocabulary.yaml` 是默认值。项目 `openspec/ste.yaml` 用 `add` / `remove` 两个列表增删条目，用 `thresholds` 覆盖阈值。
- 项目文件解析失败或不符合 schema 时退出码为 2，不静默回退到默认值。
- YAML 解析用内置的 js-yaml，不依赖目标项目的 `node_modules`。

### 6. 四个卡点的接入方式

| skill | 时机 | 阻断行为 |
|---|---|---|
| `openspec-propose` | 全部产物写完后、输出总结前 | 修正后重跑，直到退出码 0 |
| `openspec-update-change` | 修改产物后 | 同上 |
| `openspec-apply-change` | Step 2（技术评审门禁之后、Step 3 之前），开始任何任务前；`changeRoot` 由 `openspec status --json` 取得 | 列出问题，不开始任何任务 |
| `openspec-verify-change` | 与 `implementation-gate.mjs` 校验同一阶段 | 每个阻断项记为 CRITICAL |

找不到 `openspec-ste` 时，各 skill 在输出中写明「STE 检查已跳过」与原因，不静默跳过。

检查结果的处理口径（退出码 0 / 1 / 2、阻断项修正方式）只写在 `shared/gate-check.md`，四个 skill 与四个 opsx 命令各保留一行引用；「已跳过」的提示必须写在引用行里，因为找不到 `openspec-ste` 时 `gate-check.md` 也读不到。

### 7. Stop hook 的实现

- hook 命令为 `node <abs>/scripts/ste-lint.mjs reply-hook`，逻辑写在脚本里，不新增 shell 脚本，也不依赖 `jq`。
- 读取最后一条用户消息之后的全部 assistant 文本块，再合并事件中的 `last_assistant_message`，作为本次回复。Claude Code 触发 Stop hook 时，最后一条回复可能还没有写入 transcript，只读 transcript 会漏检（4.5 实际运行时发现）。
- 命中禁用别名时输出 `{"decision":"block","reason":"<别名 → 术语 列表>"}`。
- `stop_hook_active` 为 true 时直接放行，因此最多重试 1 次。
- 没有 CONTEXT.md、transcript 读不到、解析失败时放行，退出码 0，不影响会话。
- 只有非受控通用词或模糊词时输出 `{"systemMessage": "STE 告警（不阻断）：…"}`，让用户看到告警；噪声过大时可改为不输出。
- 项目目录取 `$CLAUDE_PROJECT_DIR`；没有该变量时依次取事件的 `cwd` 与当前目录。
- `openspec/ste.yaml` 非法时不放弃检查：词表只影响告警，降级为只检查禁用别名。

### 8. 规则表的生成关系

```
shared/ste-rules.md（唯一事实源）
   ├──▶ config-snippet 子命令 ──▶ 项目 openspec/config.yaml 的 rules（用户粘贴）
   └──▶ shared/reply-rules.md 引用它 ──▶ CLAUDE.md / AGENTS.md 一行引用
```

`ste-rules.md` 中的规则编号需对照 ASD-STE100 Issue 9 原文核对，只引用编号，规则内容用自己的话复述（ADR-0005）。

## 候选方案交叉验证矩阵

| 维度 | 方案 MVP：只注入 `config.yaml` rules | 方案 A：Node 确定性检查 + 卡点 + Stop hook（推荐） | 方案 B：Vale 文本检查器 + STE 风格包 | 方案 C：LLM 评审 agent 检查 |
|---|---|---|---|---|
| **成本** | 0.5 人日 | 4～5 人日 | 3 人日；每台机器装 Vale 二进制 | 2 人日；每次检查消耗模型调用 |
| **性能** | 无检查开销 | 单个变更 < 1 秒 | < 1 秒 | 数十秒，不适合 Stop hook |
| **复杂度** | 低 | 中：子串匹配、去误报、配置合并 | 中：Vale 正则规则需关闭词边界才能匹配中文 | 低开发、高运维：结果不稳定 |
| **风险** | AI 不遵守时没有后果，不能保证一词一义 | 启发式规则误报，已降为告警 | 新增二进制依赖；中文支持需逐条验证 | 同一文本两次结果可能不同，不能用作阻断 |
| **可测试性** | 不可测 | 高：CLI + 临时目录 | 中 | 低 |
| **上线时间** | 1 天 | 1 周 | 1 周 | 3 天 |

### 推荐方案及决策依据

- **推荐**：方案 A，同时保留 MVP 的 rules 注入作为生成侧约束。
- **决策依据**：
  1. 阻断是已定决策（Q2），只有确定性检查能作为阻断依据。
  2. 沿用 `implementation-gate.mjs` 的形态，运行条件只有 Node.js ≥ 16，与仓库现有要求一致。
  3. 子串匹配加 CONTEXT.md 长术语去误报，能覆盖中文场景，不需要分词。
- **为什么不选 MVP**：只有提示词约束，不能保证一词一义，不解决底层问题。
- **为什么不选方案 B**：新增 Go 二进制依赖，Stop hook 运行环境也要安装；中文匹配要逐条绕过词边界，收益不大于自写脚本。
- **为什么不选方案 C**：结果不确定，不能作为阻断依据；耗时不适合 Stop hook。
- **回溯第一性原理**：底层问题是「读者因一词多义误读方案」。方案 A 在产物写入后、实现开始前、归档前三类时点机械拦截禁用别名，在 Claude Code 对话中实时拦截，直接消除一词多义的来源。

## 测试 Seam 决策

### 选定的 Seam

| Seam | 类型 | 覆盖的行为 |
|---|---|---|
| `node ste-lint.mjs check <changeRoot>` | CLI（JSON + 退出码） | 扫描范围、分级、豁免、去误报、配置合并、缺少 CONTEXT.md |
| `node ste-lint.mjs text`（stdin 文本） | CLI（JSON + 退出码） | 纯文本产物级分级、行号取输入行号、缺少 CONTEXT.md 降级 |
| `node ste-lint.mjs reply-hook`（stdin 事件） | CLI（Claude Code hook 契约） | 对话阻断、重试一次、引用块排除、降级放行 |
| `node ste-lint.mjs config-snippet` | CLI | 片段由规则表生成 |
| `/opsx:propose`、`/opsx:apply` 等 skill 入口 | 提示词流程 | 四个卡点的调用与阻断行为 |

### 为什么是这些 Seam

- 前四个 Seam 与 `implementation-gate.mjs` 同构，复用 `scripts/test-implementation-gate.mjs` 的临时目录测试写法，新增 `scripts/test-ste-lint.mjs`。
- 不测试脚本内部函数。匹配与去误报都通过 CLI 输出断言。
- skill 入口是提示词，无法自动化测试。用本变更自身产物做实际运行验证：`check` 本变更目录必须退出码 0。

### 每个验收行为挂哪个 Seam

- 禁用别名、非受控词、模糊词阻断，启发式告警 → `check`
- 豁免、代码排除、长术语去误报、例外短语 → `check`
- `ste.yaml` 覆盖与非法文件报错 → `check`
- 缺少 CONTEXT.md 降级、CONTEXT-MAP.md 告警 → `check`
- 纯文本分级与行号、缺少 CONTEXT.md 降级 → `text`
- 对话阻断、`stop_hook_active` 放行、引用块排除、transcript 缺失放行 → `reply-hook`
- 规则片段跟随规则表 → `config-snippet`
- 四个卡点调用 → skill 入口（实际运行）

## Risks / Trade-offs

- [子串匹配误报，例如别名是其他词的一部分] → CONTEXT.md 长术语去误报、例外短语、1 个字的别名直接拒绝；残余误报用 `term-allow` 豁免。
- [启发式规则噪声大] → 全部只告警，不阻断。
- [对话被误拦，回复被强制重写] → 对话只阻断禁用别名，并且排除代码、引用块与路径；最多重试 1 次。
- [豁免语法被滥用] → 输出中统计豁免次数，评审时可见。
- [已有 CONTEXT.md 的项目启用后，历史文档中的禁用别名全部变成阻断项] → 只检查当前变更目录；历史文档在后续变更中被修改时才检查。
- [规则编号与 Issue 9 原文不符] → 编写规则表时逐条对照原文核对；未核对的编号标记「待核对」，不得进入定稿。
- [其他 agent 的对话回复没有阻断] → 文档写明差异；产物检查是后备。

## Migration Plan

1. 发布 `openspec-ste` 与四个 skill 的修改。
2. 本仓库：`openspec/config.yaml` 增加 rules 片段；`CLAUDE.md` 增加一行引用 `reply-rules.md`；`package.json` 增加 `test:ste` 并纳入 `test`。
3. 使用方项目：按 SKILL.md 手动注册 Stop hook，按需创建 `openspec/ste.yaml`。
4. 回退：在 Claude Code 中删除 Stop hook 注册；从四个 skill 中删除卡点段落。产物文件不受影响。

## Open Questions

- 通用受控词表的具体词条（第一版 100～200 条）在实现时编写，提交前请用户抽查。**结论（2026-10-07）**：第一版 182 条。用户逐类抽查后全部认可；单独列出的高频词（`包括`、`添加`、`所以`、`所有`、`确保`、`采用`）与行话（`沉淀`、`落地`、`兜底`、`环节`）决定保留。实现期间用全仓文档扫描删除了 3 条误报词条（现阶段、个数、编制），并为 10 条增加了例外短语。
- 模糊词默认清单在实现时编写，提交前请用户抽查。**结论（2026-10-07）**：33 个，用户抽查后全部认可；单独列出的 `相关`、`优化`、`完善`、`有效` 决定保留。
- ASD-STE100 Issue 9 的规则编号逐条核对结果。**结论（2026-10-06）**：对照官方 Issue 9 PDF 正文中的 53 条规则标题逐条核对：采纳 37 条，不采纳 16 条（见 `shared/ste-rules.md`），规则表中没有「待核对」的编号。
