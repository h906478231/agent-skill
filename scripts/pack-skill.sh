#!/bin/bash
# Skills 打包脚本 - 将 skill 及其依赖的 shared 模块打包为自包含分发包

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$PROJECT_ROOT/dist"

usage() {
  cat <<EOF
用法: $0 <skill-name> [options]

将指定 skill 及其依赖的 shared 模块打包为 tar.gz

选项:
  -o, --output DIR    输出目录 (默认: dist/)
  -h, --help          显示此帮助信息

示例:
  $0 openspec-explore
  $0 opsx-technical-review -o /tmp/packages

EOF
}

pack_skill() {
  local skill=$1
  local output_dir=${2:-$DIST_DIR}

  local skill_src="/Users/macbook/.claude/skills/${skill}"
  local temp_dir="$output_dir/tmp/${skill}"
  local output_file="$output_dir/${skill}.tar.gz"

  # 检查 skill 是否存在
  if [ ! -d "$skill_src" ]; then
    echo "❌ 错误: Skill '$skill' 不存在于 /Users/macbook/.claude/skills/"
    return 1
  fi

  echo "📦 开始打包 skill: $skill"

  # 1. 创建临时目录
  mkdir -p "$temp_dir"

  # 2. 复制 skill 目录
  echo "   📋 复制 skill 文件..."
  cp -r "$skill_src" "$temp_dir/"

  # 3. 分析并复制依赖的 shared/ 文件
  echo "   🔍 分析 shared 依赖..."
  local shared_files=$(grep -r "shared/workflow/" "$temp_dir/" 2>/dev/null | \
    sed -n 's/.*shared\/workflow\/\([^)]*\.md\).*/\1/p' | \
    sort -u)

  if [ -n "$shared_files" ]; then
    echo "   📚 复制 shared 模块:"
    mkdir -p "$temp_dir/shared/workflow"

    while IFS= read -r file; do
      if [ -f "$PROJECT_ROOT/shared/workflow/$file" ]; then
        cp "$PROJECT_ROOT/shared/workflow/$file" "$temp_dir/shared/workflow/"
        echo "      ✓ $file"
      else
        echo "      ⚠️  未找到: $file"
      fi
    done <<< "$shared_files"
  else
    echo "   ℹ️  无 shared 依赖"
  fi

  # 4. 创建 README
  cat > "$temp_dir/README.md" <<EOF
# ${skill}

自动打包于: $(date '+%Y-%m-%d %H:%M:%S')

## 安装

\`\`\`bash
# 解压到 skills 目录
tar -xzf ${skill}.tar.gz -C ~/.claude/skills/
\`\`\`

## 包含内容

- ${skill}/          # Skill 主目录
$([ -n "$shared_files" ] && echo "- shared/workflow/   # 依赖的知识模块")

## 依赖的 shared 模块

$(if [ -n "$shared_files" ]; then
  while IFS= read -r file; do
    echo "- shared/workflow/$file"
  done <<< "$shared_files"
else
  echo "无"
fi)

---
由 pack-skill.sh 自动生成
EOF

  # 5. 打包
  echo "   📦 压缩打包..."
  cd "$output_dir/tmp"
  tar -czf "$output_file" "${skill}"
  cd - > /dev/null

  # 6. 清理临时文件
  rm -rf "$temp_dir"

  # 7. 输出结果
  local size=$(du -h "$output_file" | cut -f1)
  echo "✅ 打包完成: $output_file ($size)"
  echo ""
}

# 主程序
main() {
  local skill=""
  local output_dir="$DIST_DIR"

  while [[ $# -gt 0 ]]; do
    case $1 in
      -o|--output)
        output_dir="$2"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      -*)
        echo "❌ 未知选项: $1"
        usage
        exit 1
        ;;
      *)
        skill="$1"
        shift
        ;;
    esac
  done

  if [ -z "$skill" ]; then
    echo "❌ 错误: 请指定 skill 名称"
    usage
    exit 1
  fi

  mkdir -p "$output_dir"
  pack_skill "$skill" "$output_dir"
}

main "$@"
