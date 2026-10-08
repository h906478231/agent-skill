---
name: openspec-ste
description: OpenSpec STE 检查（中文 Simplified Technical English）。以 ASD-STE100 Issue 9 为骨架的中文写作规则、自编通用受控词表与模糊词清单，加上确定性检查脚本 ste-lint.mjs：在 propose、update、apply、verify 四个卡点检查变更产物中的禁用别名（CONTEXT.md `_Avoid_`）、非受控通用词与模糊词并阻断，句长等启发式规则只告警；提供 text 子命令检查纯文本；提供 Claude Code Stop hook 阻断对话回复中的禁用别名。用于让产物与对话回复做到一词一义、表述可度量。
---

# OpenSpec STE 检查

## 定位

开发者阅读 AI 产出的方案时，同一概念出现多种叫法、表述含「适当」这类不可度量的词，会误读方案边界。本 skill 把 ASD-STE100 的写作规则改写为中文（保留原规则编号），并用确定性脚本在 OpenSpec 四个卡点机械拦截：

- **禁用别名**：CONTEXT.md 中术语 `_Avoid_` 列出的其他叫法（ADR-0003）。
- **非受控通用词、模糊词**：随 skill 内置的通用受控词表与模糊词清单（ADR-0005）。
- **启发式规则**：名词串、被动语态、句长、程序步骤、安全提示，只告警。

## 资产结构

```
openspec-ste/
├── SKILL.md                 # 本文件：何时使用、卡点、调用方式
├── shared/
│   ├── ste-rules.md         # 中文 STE 规则表（唯一事实源，C-R 编号 ← STE R 编号）
│   ├── vocabulary.yaml      # 通用受控词表 + 模糊词清单 + 默认阈值
│   ├── gate-check.md        # 四个卡点的检查结果处理口径（唯一事实源）
│   └── reply-rules.md       # 对话回复规则（供 CLAUDE.md / AGENTS.md 引用）
├── scripts/ste-lint.mjs     # 检查脚本（只依赖 Node.js ≥ 16 内置模块与 vendor/）
└── vendor/
    ├── js-yaml.mjs          # 内置 YAML 解析库 js-yaml 5.4.2（MIT），目标项目无需 npm install
    └── js-yaml.LICENSE      # js-yaml 许可证原文
```

## 检查脚本

脚本位置：本 skill 的 `scripts/ste-lint.mjs`。其他 skill 用相对路径 `../openspec-ste/scripts/ste-lint.mjs` 引用；读不到时 Glob 搜 `**/openspec-ste/scripts/ste-lint.mjs`。下文记为 `<STE>`。

```bash
node <STE> check <changeRoot> [--repo <dir>]   # 检查变更产物；repo 缺省为 changeRoot 的上三级
node <STE> text [--repo <dir>] < input.txt      # 检查 stdin 纯文本；repo 缺省为当前目录
node <STE> reply-hook                           # Claude Code Stop hook，stdin 读事件（见下文）
node <STE> config-snippet                       # 由规则表生成 openspec/config.yaml 的 rules 片段
```

- **扫描范围**（`check`）：`proposal.md`、`design.md`、`tasks.md`、`specs/**/*.md`。不扫描 `review/`、`evidence/`、`overview.md`、主规格目录与 archive 目录。
- **`text`**：按产物级分级检查 stdin 文本，`file` 字段为 `<stdin>`，行号取输入行号。供变更模型检查、分镜检查等非产物文本调用。
- **输出**：一个 JSON 对象。

```json
{
  "verdict": "BLOCKED",
  "blocking": [{ "file": "design.md", "line": 12, "rule": "C-R1.11", "text": "退单", "replacement": "取消" }],
  "warnings": [],
  "exemptions": 0
}
```

- **退出码**：`0` 无阻断项（可能有告警）；`1` 存在阻断项；`2` 参数或环境错误（变更目录不存在、CONTEXT.md 有 1 个字的别名、`openspec/ste.yaml` 非法等）。

## 排除与豁免

- 不检查：围栏代码块、行内代码、URL、文件路径、标识符、HTML 注释。文件路径按空白与标点切出片段判定：含「/」时，第一个「/」之前必须是英文路径段（如 `docs/单子/readme`）；不含「/」时，以扩展名结尾才算文件名（如 `单子.md`）。「取消/退单」「用户A/用户B退单」「退单/refund」这类中文开头的写法不算路径，照常检查。标识符指含驼峰、下划线或点调用的英文词（`STE` 这类普通英文词照常检查）。
- 残余风险：英文开头的并列写法（如「API/退单」）按路径删除，其中的别名会漏检；中英文之间不加空格时（如「查看日志app.log」），整个片段按文件名删除。写作时在中英文之间加空格可以避免。
- 显式豁免：在该行写 `<!-- term-allow: 旧词 -->`，该行不报告这个词；豁免次数计入 `exemptions`，评审时可见。
- 长术语去误报：命中位置落在 CONTEXT.md 中更长的术语内时不报告。

## 降级

- 项目根没有 CONTEXT.md：跳过禁用别名规则，其他规则照常执行，并告警「未建立术语表，一词一义无法校验」。
- 存在 `CONTEXT-MAP.md`：只读根 CONTEXT.md，并告警不支持多领域术语表。

## OpenSpec 四个卡点

`openspec-propose`、`openspec-update-change`、`openspec-apply-change`、`openspec-verify-change` 四个 skill 与对应的 `/opsx:*` 命令在各自的时机运行 `check`，检查结果的处理口径（退出码 0 / 1 / 2、阻断项修正方式）只写在 `shared/gate-check.md`，各卡点只保留一行引用。找不到本 skill 时，各卡点输出「STE 检查已跳过：未找到 openspec-ste（<原因>）」，不静默跳过。

## 项目覆盖：openspec/ste.yaml

内置 `shared/vocabulary.yaml` 是默认值。项目在 `openspec/ste.yaml` 中增删条目、覆盖阈值：

```yaml
vocabulary:
  add:
    - { word: 下发, replacement: 发送, exceptions: [下发量] }
  remove: [沉淀]
vague:
  add: [酌情]
  remove: [相关]
thresholds:
  descriptive: 50
```

- 顶层只允许 `version`、`vocabulary`、`vague`、`thresholds`；`add` 中与默认值同名的条目覆盖默认值。
- 词至少 2 个字；阈值为正整数。文件不是合法 YAML 或不符合格式时退出码 `2`，不静默回退到默认值。

## config.yaml 规则注入

`node <STE> config-snippet` 由 `shared/ste-rules.md` 的「采纳的规则」表生成 `rules` 片段（四类产物共用同一列表），把输出粘贴到项目 `openspec/config.yaml`。规则表修改后重新生成，不直接编辑片段。

## 对话回复检查

### Claude Code：Stop hook

`reply-hook` 读取 Stop hook 事件，从 transcript 中取最后一条用户消息之后的全部 assistant 文本，并合并事件的 `last_assistant_message`（触发 hook 时最后一条回复可能尚未写入 transcript），检查 `$CLAUDE_PROJECT_DIR/CONTEXT.md` 的禁用别名：

- 命中禁用别名：输出 `{"decision":"block","reason":"…退单 → 取消"}`，Claude 改用术语重写回复。
- `stop_hook_active` 为 true（已重写过一次）：放行，最多重试 1 次。
- 非受控通用词、模糊词：只输出 `systemMessage` 告警，不阻断；不检查句长与启发式规则。
- 跳过围栏代码块、行内代码、markdown 引用块、URL、文件路径与标识符。
- 没有 CONTEXT.md、transcript 不存在或解析失败：放行，退出码 0，不影响会话。

**安装本 skill 不会修改任何 `settings.json`。** 需要手动在 `~/.claude/settings.json`（全局）或项目 `.claude/settings.json` 中注册，`<STE_DIR>` 换成本 skill 目录的绝对路径（如 `/Users/me/.claude/skills/openspec-ste`）：

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node <STE_DIR>/scripts/ste-lint.mjs reply-hook" }
        ]
      }
    ]
  }
}
```

回退：删除这段注册即可，产物文件不受影响。

### 其他 agent：规则约束

在项目 `CLAUDE.md` 或 `AGENTS.md` 中加一行（`<STE_DIR>` 换成本 skill 的实际安装目录）：

```markdown
- 对话回复遵守 STE 回复规则：`<STE_DIR>/shared/reply-rules.md`（CONTEXT.md 的禁用别名不得出现）。
```

Codex CLI、opencode、Cursor 等没有 Stop hook，**对话回复只有规则约束，没有阻断**；产物仍由 `check` 在四个卡点阻断，是后备。
