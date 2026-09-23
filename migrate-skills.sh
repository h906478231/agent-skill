#!/bin/bash
# Migrate skills and workflows to Claude Code

set -e

# 以脚本自身位置推算仓库根目录，不写死个人绝对路径
REPO="$(cd "$(dirname "$0")" && pwd)"
DEST_BASE="$HOME/.cc-switch"
CLAUDE_BASE="$HOME/.claude"

# Create destination directories
mkdir -p "$DEST_BASE/skills"
mkdir -p "$DEST_BASE/workflows"
mkdir -p "$CLAUDE_BASE/skills"
mkdir -p "$CLAUDE_BASE/workflows"

echo "Starting migration from: $REPO"
echo "Destination: $DEST_BASE"
echo ""
# 1. Migrate individual skills
count=0
echo "Migrating skills..."
for skill_dir in "$REPO/skills"/*/; do
  [ -d "$skill_dir" ] || continue

  skill_name=$(basename "$skill_dir")

  # Skip hidden directories (like .DS_Store)
  [[ "$skill_name" == .* ]] && continue

  # 跳过没有 SKILL.md 的目录：这类残留目录不是有效 skill，装到目标目录会被扫描器误判
  if [ ! -f "$skill_dir/SKILL.md" ]; then
    echo "  - $skill_name (跳过：缺少 SKILL.md)"
    continue
  fi

  echo "  → $skill_name"
  rm -rf "$DEST_BASE/skills/$skill_name"
  cp -R "$skill_dir" "$DEST_BASE/skills/$skill_name"
  ln -sfn "$DEST_BASE/skills/$skill_name" "$CLAUDE_BASE/skills/$skill_name"

  ((count++))
done

# 2. Migrate workflows
workflow_count=0
if [ -d "$REPO/workflow" ]; then
  echo ""
  echo "Migrating workflows..."
  for workflow_file in "$REPO/workflow"/*.workflow.js; do
    [ -f "$workflow_file" ] || continue

    workflow_name=$(basename "$workflow_file")

    echo "  → $workflow_name"
    cp "$workflow_file" "$DEST_BASE/workflows/$workflow_name"
    ln -sfn "$DEST_BASE/workflows/$workflow_name" "$CLAUDE_BASE/workflows/$workflow_name"

    ((workflow_count++))
  done
fi

echo ""
echo "✓ Migration complete!"
echo "  - $count skills"
echo "  - $workflow_count workflows"
echo ""
echo "Symlinks created in: $CLAUDE_BASE"
