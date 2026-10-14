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
  $0 openspec-technical-review -o /tmp/packages

EOF
}

pack_skill() {
  local skill=$1
  local output_dir=${2:-$DIST_DIR}

  # 统一转成绝对路径：下面要 cd 进 $output_dir/tmp 再执行 tar，
  # 相对路径在切换目录后无法解析，-o 传相对路径时打包必然失败。
  if [[ "$output_dir" != /* ]]; then
    output_dir="$PWD/$output_dir"
  fi

  local skill_src="$PROJECT_ROOT/skills/${skill}"
  local temp_dir="$output_dir/tmp/${skill}"
  local output_file="$output_dir/${skill}.tar.gz"

  # 检查 skill 是否存在
  if [ ! -d "$skill_src" ]; then
    echo "❌ 错误: Skill '$skill' 不存在于 $PROJECT_ROOT/skills/"
    return 1
  fi

  echo "📦 开始打包 skill: $skill"

  # 1. 创建临时目录
  mkdir -p "$temp_dir"

  # 2. 复制 skill 目录
  echo "   📋 复制 skill 文件..."
  cp -r "$skill_src" "$temp_dir/"

  # 3. skill 已自包含：引用的 shared/ roles/ hooks/ 资产都在 skill 目录内部，
  #    引用一律写成相对 skill 目录的形式，因此不需要再复制任何外部模块。
  echo "   ℹ️  skill 自包含，无需复制外部模块"

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

- ${skill}/          # Skill 主目录（含其 shared/ roles/ hooks/ 资产）

## 说明

本 skill 自包含：引用的资产都在 skill 目录内部，解压后可直接使用。

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
