#!/bin/bash

set -euo pipefail
shopt -s nullglob

usage() {
  printf '%s\n' "用法: $0 [--dry-run] [--help]" \
    '将 skills、workflow 资源、claude/commands 和 claude/agents 复制到 ~/.cc-switch，并链接到 ~/.claude。' \
    'commands 按顶层命令文件或命令组目录迁移（例如 commands/opsx）。' \
    'agents 迁移顶层 .md 定义，跳过 opencode 专用的 ddd-architect.md。' \
    '  --dry-run  校验并预览复制、备份和清理，不写入任何文件' \
    '  --help     显示帮助' \
    '默认覆盖同名文件、目录和符号链接；覆盖前将旧项移入 ~/.cc-switch/.migration-backups/。' \
    '只清理指向对应 ~/.cc-switch 路径且源已移除的链接；其他无关安装保持不变。' \
    'workflow 下的非隐藏文件和目录作为资源同步，隐藏资源应放在资源子目录中。'
}

fail() {
  printf '错误: %s\n' "$*" >&2
  exit 1
}

path_exists() {
  [[ -e "$1" || -L "$1" ]]
}

dry_run=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=true ;;
    -h|--help) usage; exit 0 ;;
    *) fail "未知参数: $arg（使用 --help 查看用法）" ;;
  esac
done

REPO="$(cd "$(dirname "$0")" && pwd)"
[[ "${HOME:-}" == /* && -d "$HOME" ]] || fail 'HOME 必须是已存在的绝对目录'
DEST_BASE="$HOME/.cc-switch"
CLAUDE_BASE="$HOME/.claude"
[[ -d "$REPO/skills" ]] || fail "缺少源目录: $REPO/skills"
if [[ -e "$REPO/workflow" || -L "$REPO/workflow" ]]; then
  [[ -d "$REPO/workflow" ]] || fail 'workflow 源路径不是目录'
fi
if path_exists "$REPO/claude/commands"; then
  [[ -d "$REPO/claude/commands" ]] || fail 'claude/commands 源路径不是目录'
fi
if path_exists "$REPO/claude/agents"; then
  [[ -d "$REPO/claude/agents" ]] || fail 'claude/agents 源路径不是目录'
fi

for base in "$DEST_BASE" "$CLAUDE_BASE"; do
  for dir in "$base" "$base/skills" "$base/workflows" "$base/commands" "$base/agents"; do
    [[ ! -L "$dir" ]] || fail "目标目录不能是符号链接: $dir"
    [[ ! -e "$dir" || -d "$dir" ]] || fail "目标路径不是目录: $dir"
  done
done

keys=()
sources=()
stale=()
count=0
workflow_count=0
resource_count=0
command_count=0
agent_count=0

for skill_dir in "$REPO/skills"/*; do
  [[ -d "$skill_dir" ]] || continue
  skill_name="${skill_dir##*/}"
  if [[ ! -f "$skill_dir/SKILL.md" ]]; then
    printf '跳过 %s: 缺少 SKILL.md\n' "$skill_name"
    continue
  fi
  [[ -s "$skill_dir/SKILL.md" && -r "$skill_dir/SKILL.md" ]] || fail "SKILL.md 为空或不可读: $skill_name"
  keys+=("skills/$skill_name")
  sources+=("$skill_dir")
  count=$((count + 1))
done

for source in "$REPO/workflow"/*; do
  [[ -f "$source" || -d "$source" ]] || fail "无效 workflow 资源: $source"
  name="${source##*/}"
  if [[ "$name" == *.workflow.js ]]; then
    [[ -f "$source" && -s "$source" && -r "$source" ]] || fail "workflow 为空或不可读: $source"
    command -v node >/dev/null 2>&1 || fail '校验 workflow 需要 Node.js（项目要求 >=16）'
    # 宿主允许顶层 return/await，不能直接用 node --check 按普通模块校验。
    node - "$source" <<'NODE' || fail "workflow 校验失败: $source"
const fs = require('fs');
const source = fs.readFileSync(process.argv[2], 'utf8');
const metaExport = /^\s*export\s+const\s+meta\s*=/m;
if (!metaExport.test(source)) throw new Error('缺少 export const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
new AsyncFunction('args', 'agent', 'phase', 'log', source.replace(metaExport, 'const meta ='));
NODE
    workflow_count=$((workflow_count + 1))
  else
    resource_count=$((resource_count + 1))
  fi
  keys+=("workflows/$name")
  sources+=("$source")
done

for source in "$REPO/claude/commands"/*; do
  [[ -f "$source" || -d "$source" ]] || fail "无效 command 资源: $source"
  keys+=("commands/${source##*/}")
  sources+=("$source")
  command_count=$((command_count + 1))
done

for source in "$REPO/claude/agents"/*.md; do
  name="${source##*/}"
  # 此文件是 opencode 版本，其 permission 配置不能当作 Claude 的权限约束。
  if [[ "$name" == ddd-architect.md ]]; then
    printf '跳过 %s: opencode 专用，请使用 ddd-architect-claude.md\n' "$name"
    continue
  fi
  [[ -f "$source" && -s "$source" && -r "$source" ]] || fail "agent 定义无效、为空或不可读: $source"
  keys+=("agents/$name")
  sources+=("$source")
  agent_count=$((agent_count + 1))
done

for kind in skills workflows commands agents; do
  case "$kind" in
    skills) source_base="$REPO/skills" ;;
    workflows) source_base="$REPO/workflow" ;;
    commands) source_base="$REPO/claude/commands" ;;
    agents) source_base="$REPO/claude/agents" ;;
  esac
  # 可选源目录整体缺失不表示授权卸载已安装的资源。
  [[ -d "$source_base" ]] || continue
  for link in "$CLAUDE_BASE/$kind"/*; do
    [[ -L "$link" ]] || continue
    name="${link##*/}"
    [[ "$(readlink "$link")" == "$DEST_BASE/$kind/$name" ]] || continue
    [[ ! -e "$source_base/$name" && ! -L "$source_base/$name" ]] || continue
    stale+=("$kind/$name")
  done
done

[[ ! -L "$DEST_BASE/.migration-backups" ]] || fail '备份目录不能是符号链接'
[[ ! -e "$DEST_BASE/.migration-backups" || -d "$DEST_BASE/.migration-backups" ]] || fail '备份路径不是目录'

printf '迁移来源: %s\n目标目录: %s\n' "$REPO" "$DEST_BASE"
# Bash 3.2 的 nounset 不允许直接展开空数组。
for key in ${keys[@]+"${keys[@]}"}; do
  printf '复制并链接: %s\n' "$key"
  if path_exists "$DEST_BASE/$key"; then
    printf '  备份并覆盖旧副本: %s\n' "$DEST_BASE/$key"
  fi
  link="$CLAUDE_BASE/$key"
  if path_exists "$link"; then
    if [[ ! -L "$link" || "$(readlink "$link")" != "$DEST_BASE/$key" ]]; then
      printf '  备份并覆盖同名安装项: %s\n' "$link"
    fi
  fi
done
for key in ${stale[@]+"${stale[@]}"}; do
  printf '清理受管残留链接并备份旧副本: %s\n' "$key"
done
printf '共 %s skills、%s workflows、%s 个 workflow 资源、%s 个 commands 条目（文件或命令组）、%s agents、%s 个残留链接\n' \
  "$count" "$workflow_count" "$resource_count" "$command_count" "$agent_count" "${#stale[@]}"
if "$dry_run"; then
  printf '%s\n' '预览完成，未写入任何文件。'
  exit 0
fi

stage=''
backup=''
locked=false
cleanup() {
  local status=$?
  trap - EXIT
  [[ -z "$stage" ]] || rm -rf "$stage"
  if "$locked"; then rmdir "$DEST_BASE/.migration-lock"; fi
  if [[ "$status" -ne 0 ]]; then
    printf '迁移未完成；已完成的项目可能已更新。旧副本备份: %s\n' "${backup:-尚未创建}" >&2
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$DEST_BASE"
mkdir "$DEST_BASE/.migration-lock" 2>/dev/null || fail '已有迁移正在运行或遗留锁，请检查 ~/.cc-switch/.migration-lock'
locked=true
stage="$(mktemp -d "$DEST_BASE/.migration-stage.XXXXXX")"
mkdir -p "$stage/skills" "$stage/workflows" "$stage/commands" "$stage/agents"

for ((i = 0; i < ${#keys[@]}; i++)); do
  # 仅解引用入口符号链接，内部链接保持原样，避免把源入口链接当作安装副本。
  cp -R -H -p "${sources[$i]}" "$stage/${keys[$i]}"
done

mkdir -p "$DEST_BASE/skills" "$DEST_BASE/workflows" "$DEST_BASE/commands" "$DEST_BASE/agents" \
  "$CLAUDE_BASE/skills" "$CLAUDE_BASE/workflows" "$CLAUDE_BASE/commands" "$CLAUDE_BASE/agents"

backup_target() {
  local key=$1 base=${2:-$DEST_BASE} prefix=${3:-}
  path_exists "$base/$key" || return 0
  if [[ -z "$backup" ]]; then
    mkdir -p "$DEST_BASE/.migration-backups" || return 1
    backup="$(mktemp -d "$DEST_BASE/.migration-backups/run.XXXXXX")" || return 1
    printf '旧项备份: %s\n' "$backup"
  fi
  mkdir -p "$backup/$prefix${key%/*}" || return 1
  # 移动链接本身而非其指向的数据，避免覆盖外部安装或仓库源文件。
  mv "$base/$key" "$backup/$prefix$key"
}

restore_target() {
  local key=$1 base=${2:-$DEST_BASE} prefix=${3:-}
  if [[ -n "$backup" ]] && path_exists "$backup/$prefix$key"; then
    mv "$backup/$prefix$key" "$base/$key"
  fi
}

for key in ${keys[@]+"${keys[@]}"}; do
  target="$DEST_BASE/$key"
  link="$CLAUDE_BASE/$key"
  backup_target "$key"
  if ! mv "$stage/$key" "$target"; then
    restore_target "$key"
    fail "安装失败: $key"
  fi
  if [[ -L "$link" && "$(readlink "$link")" == "$target" ]]; then
    continue
  fi
  if ! backup_target "$key" "$CLAUDE_BASE" 'claude/'; then
    mv "$target" "$stage/$key"
    restore_target "$key"
    fail "备份同名安装项失败: $link"
  fi
  if ! ln -s "$target" "$link"; then
    mv "$target" "$stage/$key"
    restore_target "$key"
    restore_target "$key" "$CLAUDE_BASE" 'claude/'
    fail "创建链接失败: $link"
  fi
done

for key in ${stale[@]+"${stale[@]}"}; do
  backup_target "$key"
  if ! rm "$CLAUDE_BASE/$key"; then
    restore_target "$key"
    fail "清理链接失败: $key"
  fi
done

printf '迁移完成。符号链接目录: %s\n' "$CLAUDE_BASE"
