#!/bin/bash

# 云舟 DevOps 自动化快速启动脚本

# 使用全局配置文件
CONFIG_FILE="$HOME/.yunzhou/config.json"

if [ ! -f "$CONFIG_FILE" ]; then
    echo "❌ 配置文件不存在，请先运行 scripts/setup-yunzhou-config.sh"
    exit 1
fi

# 读取配置
DEFAULT_PROJECT_ID=$(jq -r '.defaultProjectId' "$CONFIG_FILE")

if [ "$DEFAULT_PROJECT_ID" == "null" ] || [ -z "$DEFAULT_PROJECT_ID" ]; then
    echo "❌ 未配置默认项目，请先运行 scripts/setup-yunzhou-config.sh"
    exit 1
fi

DEFAULT_PROJECT=$(jq -r ".projects[] | select(.projectId == \"$DEFAULT_PROJECT_ID\")" "$CONFIG_FILE")
PROJECT_NAME=$(echo "$DEFAULT_PROJECT" | jq -r '.name')
COLUMN_TITLE=$(echo "$DEFAULT_PROJECT" | jq -r '.defaultColumnTitle')

echo "========================================="
echo "云舟 DevOps 自动化循环"
echo "========================================="
echo "项目：$PROJECT_NAME"
echo "清单：$COLUMN_TITLE"
echo ""

# 检查是否指定任务ID：当前 workflow 实现要求显式传入 taskId 与 intent，
# 不会再自动拉取待办任务，因此缺参数时直接给出正确用法而不是打印无效调用。
if [ -n "$1" ]; then
    TASK_ID="$1"
    echo "指定任务：#$TASK_ID"
    echo ""
    echo "请在 Claude Code 中执行（intent 按需要替换为 discuss / investigate / plan / implement）："
    echo ""
    echo "workflow('devops-automation-loop-yunzhou', { taskId: $TASK_ID, intent: 'implement' })"
else
    echo "❌ 未指定任务 ID。当前实现不会自动拉取待办任务。"
    echo ""
    echo "用法：$0 <task-id>"
fi

echo ""
