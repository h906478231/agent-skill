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

# 找不到变更名或 summary：保守放行（可能是 openspec apply 的其他子形态），但打印提示
if [ -z "$CHANGE_NAME" ] || [ ! -f "$SUMMARY" ]; then
  exit 0
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
