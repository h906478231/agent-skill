#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# OpenSpec Apply 门禁 Hook（PreToolUse）—— 全局版
#
# 职责：在执行 `openspec apply <change>` / `/opsx:apply <change>` 之前，
#       检查该变更 review-summary.md 的「Technical Review Approved:」签字行是否
#       仍为空白占位（连续下划线）。若仍空白，说明人工硬门禁未签署，直接 block，
#       避免未经技术评审确认就进入编码实现阶段。
#
# 部署：本脚本位于 ~/.claude/skills/opsx-technical-review/hooks/（全局，跨项目复用），
#       在 ~/.claude/settings.json 的 PreToolUse(Bash) 中注册。
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
#             该路径由 openspec-apply-change/SKILL.md 的 Step 0 前置校验兜底（提示词级约束）。
#   ✘ 拦不住：Agent 直接用 Edit/Write 改业务代码而完全不调 apply。
# 结论：本 hook 是「机制层」防线之一，不是唯一防线，也不能替代人工 code review。
# ---------------------------------------------------------------------------
set -euo pipefail

# 读取事件 JSON
INPUT="$(cat)"

# 仅处理 Bash 工具的命令
COMMAND="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')"
[ -z "$COMMAND" ] && exit 0

# 仅拦截 openspec apply / opsx:apply，其余命令一律放行
# 兼容形式：openspec apply NAME、/opsx:apply NAME、opsx apply NAME
if ! printf '%s' "$COMMAND" | grep -qiE '(openspec[[:space:]]+apply|opsx[:[:space:]]+apply)'; then
  exit 0
fi

# 提取变更名（apply 后的第一个非选项参数）
CHANGE_NAME="$(printf '%s' "$COMMAND" \
  | sed -E 's#/?opsx[: ]+apply#openspec apply#I' \
  | grep -oiE 'openspec[[:space:]]+apply[[:space:]]+[^[:space:]]+' \
  | awk '{print $3}' | head -n1 || true)"

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
# 这是本 hook 的已知盲区，apply skill 的 Step 0 会做第二道校验。
if [ -z "$CHANGE_NAME" ]; then
  exit 0
fi

# summary 不存在 → 门禁压根没跑过 → 拦截。
# 注意：绝不能在这里放行，否则「从未跑门禁」的变更反而畅通无阻，
# 门禁就只拦得住「跑过但没签字」的，形同虚设。
if [ ! -f "$SUMMARY" ]; then
  deny "变更 [$CHANGE_NAME] 未找到 review-summary.md（期望路径：openspec/changes/$CHANGE_NAME/review-summary.md），技术评审门禁尚未执行，禁止 apply。请先运行 /opsx:review $CHANGE_NAME 完成门禁并人工签字。若该变更属于 L0 豁免范围，请在 review-summary.md 中记录豁免理由并签字。"
fi

# 取签字行
SIGN_LINE="$(grep -m1 'Technical Review Approved:' "$SUMMARY" || true)"

# 无签字行 → 视为门禁产物不完整，拦截
if [ -z "$SIGN_LINE" ]; then
  deny "变更 [$CHANGE_NAME] 的 review-summary.md 缺少「Technical Review Approved:」签字行，技术评审门禁产物不完整，禁止 apply。"
fi

# 取冒号后、首个「签署人」之前的内容作为签字值
SIGN_VALUE="$(printf '%s' "$SIGN_LINE" | sed -E 's/.*Technical Review Approved:[[:space:]]*//; s/签署人.*//' | tr -d '[:space:]')"

# 空白占位判定：为空 / 仅由下划线组成 / 仍含「＜签名＞」「<签名>」类模板占位符 → 未签字
# 注：占位符用 grep -F 做字节级子串匹配，避免全角字符在正则字符类中按字节拆分导致误判
if [ -z "$SIGN_VALUE" ] \
  || printf '%s' "$SIGN_VALUE" | grep -qE '^[_＿]+$' \
  || printf '%s' "$SIGN_VALUE" | grep -qF '＜签名＞' \
  || printf '%s' "$SIGN_VALUE" | grep -qF '<签名>'; then
  deny "变更 [$CHANGE_NAME] 技术评审门禁未签字：review-summary.md 的「Technical Review Approved:」仍是空白占位（____）。请人工审阅 review/*.md 后在该行写入批准人姓名，再执行 apply。签字前禁止 /opsx:apply。"
fi

# 已签字，放行
exit 0
