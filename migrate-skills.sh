#!/bin/bash
# Migrate skills and shared directories to Claude Code

set -e

REPO=/Users/macbook/Documents/ideaProject/agent-skills
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

# 1. Migrate root-level shared directory
if [ -d "$REPO/shared" ]; then
  echo "Migrating root shared directory..."
  rm -rf "$DEST_BASE/shared"
  cp -R "$REPO/shared" "$DEST_BASE/shared"
  ln -sfn "$DEST_BASE/shared" "$CLAUDE_BASE/shared"
  echo "✓ Root shared directory migrated"
  echo ""
fi

# 2. Migrate individual skills
count=0
echo "Migrating skills..."
for skill_dir in "$REPO/skills"/*/; do
  [ -d "$skill_dir" ] || continue

  skill_name=$(basename "$skill_dir")

  # Skip hidden directories (like .DS_Store)
  [[ "$skill_name" == .* ]] && continue

  echo "  → $skill_name"
  rm -rf "$DEST_BASE/skills/$skill_name"
  cp -R "$skill_dir" "$DEST_BASE/skills/$skill_name"
  ln -sfn "$DEST_BASE/skills/$skill_name" "$CLAUDE_BASE/skills/$skill_name"

  ((count++))
done

# 3. Migrate workflows
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
echo "  - 1 shared directory"
echo "  - $count skills"
echo "  - $workflow_count workflows"
echo ""
echo "Symlinks created in: $CLAUDE_BASE"
