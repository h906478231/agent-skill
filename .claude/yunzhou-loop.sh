#!/bin/bash

# 云舟 DevOps 自动化快速启动脚本

# 使用全局配置文件
CONFIG_FILE="$HOME/.claude/yunzhou-config.json"

if [ ! -f "$CONFIG_FILE" ]; then
    echo "❌ 配置文件不存在，请先运行 ./setup-yunzhou-config.sh"
    exit 1
fi

# 读取配置
DEFAULT_PROJECT_ID=$(jq -r '.defaultProjectId' "$CONFIG_FILE")

if [ "$DEFAULT_PROJECT_ID" == "null" ] || [ -z "$DEFAULT_PROJECT_ID" ]; then
    echo "❌ 未配置默认项目，请先运行 ./setup-yunzhou-config.sh"
    exit 1
fi

DEFAULT_PROJECT=$(jq -r ".projects[] | select(.projectId == \"$DEFAULT_PROJECT_ID\")" "$CONFIG_FILE")
PROJECT_NAME=$(echo "$DEFAULT_PROJECT" | jq -r '.name')
COLUMN_ID=$(echo "$DEFAULT_PROJECT" | jq -r '.defaultColumnId')
COLUMN_TITLE=$(echo "$DEFAULT_PROJECT" | jq -r '.defaultColumnTitle')
PROFILE=$(jq -r '.yunzhou.profile' "$CONFIG_FILE")

echo "========================================="
echo "云舟 DevOps 自动化循环"
echo "========================================="
echo "项目：$PROJECT_NAME"
echo "清单：$COLUMN_TITLE"
echo ""

# 检查是否指定任务ID
if [ -n "$1" ]; then
    TASK_ID="$1"
    echo "指定任务：#$TASK_ID"
    echo ""

    # 使用 Claude Code workflow 命令执行
    echo "执行工作流..."
    echo "请在 Claude Code 中执行："
    echo ""
    echo "workflow('devops-automation-loop-yunzhou', { projectId: '$DEFAULT_PROJECT_ID', taskId: $TASK_ID, profile: '$PROFILE' })"
else
    echo "自动拉取待办任务"
    echo ""

    echo "请在 Claude Code 中执行："
    echo ""
    echo "workflow('devops-automation-loop-yunzhou', { projectId: '$DEFAULT_PROJECT_ID', columnId: '$COLUMN_ID', profile: '$PROFILE' })"
fi

echo ""
