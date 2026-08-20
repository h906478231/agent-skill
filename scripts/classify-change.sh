#!/bin/bash

# OpenSpec 变更分级工具 - Shell 包装器
# 使用方法：
#   ./scripts/classify-change.sh <change-name>
#   或：openspec classify-change <change-name>

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_SCRIPT="$SCRIPT_DIR/classify-change.js"

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "错误：未找到 node 命令"
    echo "请安装 Node.js: https://nodejs.org/"
    exit 1
fi

# 检查脚本文件
if [ ! -f "$NODE_SCRIPT" ]; then
    echo "错误：未找到 classify-change.js"
    echo "路径：$NODE_SCRIPT"
    exit 1
fi

# 运行 Node.js 脚本
node "$NODE_SCRIPT" "$@"
