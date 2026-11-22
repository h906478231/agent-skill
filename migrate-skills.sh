#!/bin/bash

set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
command -v node >/dev/null 2>&1 || {
  printf '%s\n' '错误: 迁移资产需要 Node.js >=16.15' >&2
  exit 1
}
# fs.cpSync 的 verbatimSymlinks 选项从 Node.js 16.15 开始支持，低于该版本时在写入前退出。
NODE_VERSION="$(node -p 'process.versions.node')"
IFS=. read -r NODE_MAJOR NODE_MINOR _ <<<"$NODE_VERSION"
if (( NODE_MAJOR < 16 || (NODE_MAJOR == 16 && NODE_MINOR < 15) )); then
  printf '错误: 迁移资产需要 Node.js >=16.15（当前 %s）\n' "$NODE_VERSION" >&2
  exit 1
fi
exec node "$REPO/scripts/migrate-assets.mjs" "$@"
