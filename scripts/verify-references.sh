#!/bin/bash
# Skills 引用验证脚本 - 检查所有 shared 模块引用是否可访问

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "╔══════════════════════════════════════════════════════════════════════════════╗"
echo "║            OpenSpec Skills 引用验证                                          ║"
echo "╚══════════════════════════════════════════════════════════════════════════════╝"
echo ""

# 颜色定义
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

success_count=0
error_count=0
warning_count=0

# 检查单个引用
check_reference() {
  local skill_file=$1
  local reference=$2
  local skill_dir=$(dirname "$skill_file")

  # 解析相对路径
  local resolved_path=$(cd "$skill_dir" && cd "$(dirname "$reference")" 2>/dev/null && pwd)/$(basename "$reference")

  if [ -f "$resolved_path" ]; then
    echo -e "  ${GREEN}✓${NC} $reference"
    ((success_count++))
    return 0
  else
    echo -e "  ${RED}✗${NC} $reference ${RED}(未找到: $resolved_path)${NC}"
    ((error_count++))
    return 1
  fi
}

# 检查 skill
check_skill() {
  local skill_name=$1
  local skill_path="/Users/macbook/.claude/skills/${skill_name}/skill.md"

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "检查: $skill_name"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  if [ ! -f "$skill_path" ]; then
    echo -e "${RED}✗ Skill 不存在: $skill_path${NC}"
    ((error_count++))
    return 1
  fi

  echo "位置: $skill_path"
  echo ""

  # 提取所有 shared/workflow/ 引用
  local references=$(grep -o 'shared/workflow/[^)]*\.md' "$skill_path" 2>/dev/null | sort -u)

  if [ -z "$references" ]; then
    echo -e "${YELLOW}⚠ 未找到 shared/workflow/ 引用${NC}"
    ((warning_count++))
    return 0
  fi

  echo "发现 $(echo "$references" | wc -l | xargs) 个引用："
  echo ""

  while IFS= read -r ref; do
    check_reference "$skill_path" "$ref"
  done <<< "$references"

  echo ""
}

# 检查 shared 模块完整性
check_shared_modules() {
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "检查: shared/workflow/ 模块"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  local modules=(
    "README.md"
    "phases.md"
    "gate-levels.md"
    "first-principles.md"
    "cross-validation.md"
    "phase3-gate.md"
    "phase6-verification.md"
    "quality-framework.md"
  )

  for module in "${modules[@]}"; do
    local module_path="$PROJECT_ROOT/shared/workflow/$module"
    if [ -f "$module_path" ]; then
      local lines=$(wc -l < "$module_path" | xargs)
      local size=$(du -h "$module_path" | cut -f1 | xargs)
      echo -e "  ${GREEN}✓${NC} $module ($lines 行, $size)"
      ((success_count++))
    else
      echo -e "  ${RED}✗${NC} $module ${RED}(未找到)${NC}"
      ((error_count++))
    fi
  done

  echo ""
}

# 主程序
main() {
  echo "项目根目录: $PROJECT_ROOT"
  echo ""

  # 检查 shared 模块
  check_shared_modules

  # 检查各个 skill
  check_skill "openspec-explore"
  check_skill "opsx-code-quality"
  check_skill "opsx-change-overview"
  check_skill "opsx-technical-review"

  # 输出总结
  echo "╔══════════════════════════════════════════════════════════════════════════════╗"
  echo "║            验证结果                                                          ║"
  echo "╚══════════════════════════════════════════════════════════════════════════════╝"
  echo ""
  echo -e "${GREEN}✓ 成功: $success_count${NC}"

  if [ $warning_count -gt 0 ]; then
    echo -e "${YELLOW}⚠ 警告: $warning_count${NC}"
  fi

  if [ $error_count -gt 0 ]; then
    echo -e "${RED}✗ 错误: $error_count${NC}"
    echo ""
    echo "❌ 验证失败，请检查上述错误"
    exit 1
  else
    echo ""
    echo "✅ 所有引用验证通过！"

    if [ $warning_count -eq 0 ]; then
      echo ""
      echo "🎉 重构成功！Skills 已完全解除对外部文档的依赖。"
      echo ""
      echo "下一步："
      echo "  1. 测试 skills 功能: /openspec-explore, /opsx:review 等"
      echo "  2. 打包测试: ./scripts/pack-skill.sh openspec-explore"
      echo "  3. 在干净环境验证可移植性"
    fi

    exit 0
  fi
}

main
