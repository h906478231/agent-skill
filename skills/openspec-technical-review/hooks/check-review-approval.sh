#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# OpenSpec Apply 门禁 Hook（PreToolUse）—— 全局版
#
# 职责：在执行 `openspec apply <change>` / `/opsx:apply <change>` 之前，
#       检查该变更 review-summary.md 的「Gate-Verdict:」裁决行是否为 BLOCKED，
#       以及「Technical Review Approved:」签字行是否仍为空白占位（连续下划线）。
#       任一命中即 block，避免未经技术评审确认就进入编码实现阶段。
#
# 部署：本脚本随 skill openspec-technical-review 一起安装，位于该 skill 的 hooks/ 子目录。
#       skills 根目录随 agent 而不同（Claude Code ~/.claude/skills、Codex ~/.codex/skills、
#       opencode ~/.config/opencode/skills、Cursor ~/.cursor/skills、项目级 .claude/skills 等），
#       注册时用 `realpath` 取本脚本的实际绝对路径，不要照抄任何一个写死的路径。
#       hook 注册本身是 Claude Code 特有机制：在 ~/.claude/settings.json 的 PreToolUse(Bash) 中登记。
#       项目根通过 Claude Code 注入的 $CLAUDE_PROJECT_DIR 获取（兜底当前工作目录），
#       禁止从脚本自身路径反推项目根（全局部署下会错误指向 $HOME）。
#
# 输入：stdin 为 Claude Code 传入的 PreToolUse 事件 JSON，含 tool_input.command。
# 输出：放行则 exit 0；拦截则输出 deny 决策 JSON 并 exit 0（由 permissionDecision 决定）。
#
# 覆盖边界（重要，勿误以为本 hook 拦得住一切）：
#   ✔ 拦得住：Bash 工具执行 `openspec apply <name>` / `opsx apply <name>`
#   ✘ 拦不住：`/opsx:apply` 斜杠命令与 openspec-apply-change skill 调用
#             —— 它们是 Skill/Command 调用，不产生 Bash 命令，PreToolUse(Bash) 永不触发。
#             该路径由 openspec-apply-change/SKILL.md 的「Technical Review Gate check」一步兜底（提示词级约束）。
#   ✘ 拦不住：Agent 直接用 Edit/Write 改业务代码而完全不调 apply。
# 结论：本 hook 是「机制层」防线之一，不是唯一防线，也不能替代人工 code review。
# ---------------------------------------------------------------------------
set -euo pipefail

# 读取事件 JSON
INPUT="$(cat)"

# 仅处理 Bash 工具的命令
COMMAND="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')"
[ -z "$COMMAND" ] && exit 0

# 仅拦截「正在执行」的 openspec apply / opsx apply，其余命令一律放行。
# 只看每条子命令的可执行位置（子命令开头），不对整条命令做子串匹配：
# `git log --grep=openspec apply x`、`echo openspec apply x >> log.txt` 只是提到 apply，不能被拦。
#   - 拆分：按 | & ; ( ) ` { } 与换行把整条命令切成子命令（覆盖管道、&&、||、$( )、子 shell）。
#     引号内的同类字符也会被切开（如 echo "x; openspec apply demo now"），此时仍可能误拦；
#     多数这类写法会解析出带引号的变更名、定位不到 summary 而放行。不做引号解析，换取脚本简单可测。
#   - heredoc 正文是数据不是命令：命令含 << 时只看首行，避免写入含「openspec apply x」行的文档被误拦。
#   - 前缀：子命令开头允许环境变量赋值（FOO=1）、常见包装命令（sudo/env/npx/pnpm dlx 等）及其选项。
# 兼容形式：openspec apply NAME、/opsx:apply NAME、opsx apply NAME、npx openspec apply NAME、
#           node_modules/.bin/openspec apply NAME。
# 已知盲区：`bash -c "openspec apply x"` 这类把命令包在字符串里的写法不识别，由 apply skill 兜底。
CMD_TEXT="$COMMAND"
# 用参数展开取首行，不走管道：超长 heredoc 下 printf | head 会因 SIGPIPE 在 pipefail 下让 hook 报错退出
case "$CMD_TEXT" in *'<<'*) CMD_TEXT="${CMD_TEXT%%$'\n'*}" ;; esac
APPLY_SEGMENT="$(printf '%s\n' "$CMD_TEXT" \
  | tr '|&;()`{}' '\n\n\n\n\n\n\n\n' \
  | sed -E -e 's/^[[:space:]]+//' \
      -e ':strip' \
      -e 's/^([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*|sudo|command|exec|env|time|nohup|npx|bunx|pnpm[[:space:]]+(dlx|exec)|yarn([[:space:]]+dlx)?|npm[[:space:]]+exec|-[^[:space:]]*)[[:space:]]+//' \
      -e 't strip' \
  | grep -m1 -iE '^(([^[:space:]]*/)?openspec(@[^[:space:]]+)?[[:space:]]+apply|/?opsx(:|[[:space:]]+)apply)([[:space:]]|$)' || true)"
[ -z "$APPLY_SEGMENT" ] && exit 0

# 提取变更名：apply 后的第一个非选项参数
CHANGE_NAME="$(printf '%s' "$APPLY_SEGMENT" \
  | sed -E 's#^([^[:space:]]*/)?openspec(@[^[:space:]]+)?[[:space:]]+apply##I; s#^/?opsx(:|[[:space:]]+)apply##I' \
  | awk '{for (i = 1; i <= NF; i++) if ($i !~ /^-/) { print $i; exit }}' || true)"

# 项目根：全局部署后不再位于项目内，优先取 Claude Code 注入的 $CLAUDE_PROJECT_DIR，
# 兜底用当前工作目录（PreToolUse hook 以项目根为 cwd 执行）
ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"

# 定位 review-summary.md
if [ -n "$CHANGE_NAME" ]; then
  SUMMARY="$ROOT/openspec/changes/$CHANGE_NAME/review-summary.md"
else
  SUMMARY=""
fi

deny() {
  # 输出 PreToolUse deny 决策，reason 会回传给 Claude
  jq -n --arg reason "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

# 变更名解析不出来（apply 的其他子形态，如无参数交互式）：无法定位 summary，只能放行。
# 这是本 hook 的已知盲区，apply skill 的「Technical Review Gate check」一步会做第二道校验。
if [ -z "$CHANGE_NAME" ]; then
  exit 0
fi

# summary 不存在 → 该变更未启用技术门禁 → 放行。
# 设计取舍：不是所有变更都需要走技术评审（小改动、文档、L0 豁免、MVP 未命中升级信号等）。
# review-summary.md 的存在即「本变更已纳入门禁管辖」的开关：
#   有 summary → 门禁已启动，裁决不得为 BLOCKED 且必须签字才能 apply（下面的检查负责）
#   无 summary → 门禁未启动，apply 不受阻
# 是否该走门禁由 gate-levels.md 分级决定，提醒放在 propose / ff 的收尾输出；豁免在 overview.md 留分级行。
# 口径与 shared/apply-gate-check.md「何时执行」一致，改动时两处同步。
if [ ! -f "$SUMMARY" ]; then
  exit 0
fi

# 裁决行：Gate-Verdict: BLOCKED 时即使已签字也拦截（格式见 shared/gate-policy.md「机器可读裁决行」）。
# 允许行首有列表 / 引用标记，值去掉反引号、星号与 CR（CRLF 文件）后取第一个词。
# 缺该行的旧版 summary 只校验签字行，兼容此前生成的产物。
VERDICT="$(grep -m1 -E '^[-*>[:space:]]*Gate-Verdict:' "$SUMMARY" \
  | sed -E 's/.*Gate-Verdict:[[:space:]]*//' | tr -d '`*\r' | awk '{print $1}' || true)"
if [ "$VERDICT" = "BLOCKED" ]; then
  deny "变更 [$CHANGE_NAME] 的技术评审裁决为 BLOCKED（review-summary.md 的 Gate-Verdict 行）：未闭环 Blocker 必须先回 design.md 闭环并重走门禁，签字不能替代闭环。禁止 apply。"
fi

# 取签字行
SIGN_LINE="$(grep -m1 'Technical Review Approved:' "$SUMMARY" || true)"

# 无签字行 → 视为门禁产物不完整，拦截
if [ -z "$SIGN_LINE" ]; then
  deny "变更 [$CHANGE_NAME] 的 review-summary.md 缺少「Technical Review Approved:」签字行，技术评审门禁产物不完整，禁止 apply。"
fi

# 取冒号后、首个「签署人」之前的内容作为签字值
SIGN_VALUE="$(printf '%s' "$SIGN_LINE" | sed -E 's/.*Technical Review Approved:[[:space:]]*//; s/签署人.*//' | tr -d '[:space:]')"

# 空白占位判定：为空 / 仅由下划线组成 / 以下划线开头但后面跟着括号说明 / 仍含「＜签名＞」「<签名>」类模板占位符 → 未签字
# 注：占位符用 grep -F 做字节级子串匹配，避免全角字符在正则字符类中按字节拆分导致误判；
#     下划线开头的判定同样用固定字面前缀（`^(__|＿＿)`），不进字符类，规避同一问题。
#     「以下划线开头」覆盖「保留占位符、后面补一句（签字 / 日期）」这类写法——
#     这类行没写任何批准人，若按已签字放行等于绕过人工门禁（真实签名不会以连续下划线开头）。
if [ -z "$SIGN_VALUE" ] \
  || printf '%s' "$SIGN_VALUE" | grep -qE '^[_＿]+$' \
  || printf '%s' "$SIGN_VALUE" | grep -qE '^(__|＿＿)' \
  || printf '%s' "$SIGN_VALUE" | grep -qF '＜签名＞' \
  || printf '%s' "$SIGN_VALUE" | grep -qF '<签名>'; then
  deny "变更 [$CHANGE_NAME] 技术评审门禁未签字：review-summary.md 的「Technical Review Approved:」仍是空白占位（____）。请人工审阅 review/*.md 后在该行写入批准人姓名，再执行 apply。签字前禁止 /opsx:apply。"
fi

# 已签字，放行
exit 0
