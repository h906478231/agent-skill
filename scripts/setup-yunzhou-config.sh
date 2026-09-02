#!/bin/bash

# 云舟 DevOps 自动化配置脚本
# 用途：快速配置云舟 CLI 和 DevOps Automation Loop 工作流
# 支持多项目配置和管理

set -e

# 使用全局 .yunzhou 目录
CONFIG_DIR="$HOME/.yunzhou"
CONFIG_FILE="$CONFIG_DIR/config.json"

echo "========================================="
echo "云舟 DevOps 自动化配置向导"
echo "========================================="
echo ""

# 检查 flows-cli 是否已安装
if ! command -v flows-cli &> /dev/null; then
    echo "❌ 错误：flows-cli 未安装"
    echo "请先从云舟 Web 的"插件"页面下载 CLI 安装包，然后运行："
    echo "  npm install -g ~/Downloads/flows-cli-*.tgz"
    exit 1
fi

# 检查版本
echo "✅ flows-cli 已安装"
FLOWS_VERSION=$(flows-cli version --json | jq -r '.data.version')
echo "   版本：$FLOWS_VERSION"
echo ""

# 检查登录状态
echo "检查登录状态..."
if flows-cli auth whoami --json > /dev/null 2>&1; then
    USER_NAME=$(flows-cli auth whoami --json | jq -r '.data.user.name')
    USER_EMAIL=$(flows-cli auth whoami --json | jq -r '.data.user.email')
    echo "✅ 已登录"
    echo "   用户：$USER_NAME ($USER_EMAIL)"
    echo ""
else
    echo "❌ 未登录，请先执行："
    echo "  flows-cli auth login-web --json"
    echo "或"
    echo "  flows-cli auth login --email <邮箱> --json"
    exit 1
fi

# 检查是否已有配置文件
if [ -f "$CONFIG_FILE" ]; then
    echo "发现已有配置文件"
    echo ""

    # 检查项目数量
    PROJECT_COUNT=$(cat "$CONFIG_FILE" | jq '.projects | length')

    if [ "$PROJECT_COUNT" -gt 0 ]; then
        echo "当前配置的项目："
        cat "$CONFIG_FILE" | jq -r '.projects[] | "  - \(.name) (ID: \(.projectId))"'
    else
        echo "当前配置的项目："
        echo "  （暂无项目）"
    fi

    echo ""
    echo "请选择操作："
    echo "  1. 添加新项目"
    echo "  2. 修改已有项目"
    echo "  3. 删除项目"
    echo "  4. 设置默认项目"
    echo "  5. 查看当前配置"
    echo "  6. 重新生成配置文件"
    echo ""
    read -p "请输入选项（1-6）: " ACTION

    case $ACTION in
        1)
            MODE="add"
            ;;
        2)
            MODE="edit"
            ;;
        3)
            MODE="delete"
            ;;
        4)
            MODE="set-default"
            ;;
        5)
            echo ""
            echo "当前配置："
            cat "$CONFIG_FILE" | jq
            exit 0
            ;;
        6)
            echo ""
            read -p "确认重新生成配置文件？已有配置将被备份 (y/N): " CONFIRM
            if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
                echo "操作已取消"
                exit 0
            fi
            cp "$CONFIG_FILE" "$CONFIG_FILE.backup.$(date +%Y%m%d%H%M%S)"
            echo "已备份到 $CONFIG_FILE.backup.*"
            MODE="init"
            ;;
        *)
            echo "❌ 无效的选项"
            exit 1
            ;;
    esac
else
    MODE="init"
fi

# 初始化配置文件结构
init_config() {
    mkdir -p "$CONFIG_DIR"
    cat > "$CONFIG_FILE" <<EOF
{
  "version": "1.2.0",
  "yunzhou": {
    "profile": "default"
  },
  "projects": [],
  "defaultProjectId": null,
  "workflow": {
    "autoCommit": false,
    "skipAnalysis": false
  }
}
EOF
}

# 获取项目列表
get_projects() {
    PROJECTS_JSON=$(flows-cli project list --json)

    if [ "$(echo "$PROJECTS_JSON" | jq -r '.ok')" != "true" ]; then
        echo "❌ 获取项目列表失败"
        echo "$PROJECTS_JSON" | jq
        exit 1
    fi

    echo "$PROJECTS_JSON"
}

# 获取看板信息
get_board() {
    local project_id=$1

    # 直接执行命令，输出到临时文件
    TEMP_FILE=$(mktemp)

    flows-cli board show --project-id "$project_id" --json > "$TEMP_FILE" 2>&1
    local exit_code=$?

    if [ $exit_code -ne 0 ]; then
        >&2 echo "❌ flows-cli 命令执行失败（退出码：$exit_code）"
        >&2 echo "输出："
        cat "$TEMP_FILE" >&2
        rm -f "$TEMP_FILE"
        exit 1
    fi

    # 先验证原始 JSON 是否有效
    if jq empty "$TEMP_FILE" 2>/dev/null; then
        BOARD_JSON=$(cat "$TEMP_FILE")
    else
        # 只清理真正有问题的控制字符，使用 LC_ALL=C 确保字节级处理
        BOARD_JSON=$(LC_ALL=C tr -d '\000-\010\013\014\016-\037\177' < "$TEMP_FILE")

        # 再次验证
        if ! echo "$BOARD_JSON" | jq empty 2>/dev/null; then
            >&2 echo "❌ 清理后 JSON 仍然无效"
            >&2 echo "原始文件前 1000 字符："
            head -c 1000 "$TEMP_FILE" >&2
            rm -f "$TEMP_FILE"
            exit 1
        fi
    fi

    rm -f "$TEMP_FILE"

    if [ "$(echo "$BOARD_JSON" | jq -r '.ok')" != "true" ]; then
        >&2 echo "❌ 获取看板失败"
        echo "$BOARD_JSON" | jq >&2
        exit 1
    fi

    echo "$BOARD_JSON"
}

# 添加项目配置
add_project() {
    echo ""
    echo "========================================="
    echo "添加项目配置"
    echo "========================================="
    echo ""

    # 获取项目列表
    echo "获取云舟项目列表..."
    PROJECTS_JSON=$(get_projects)

    PROJECT_COUNT=$(echo "$PROJECTS_JSON" | jq '.data.projects | length')
    echo "✅ 找到 $PROJECT_COUNT 个项目"
    echo ""

    # 显示项目列表
    echo "可用项目："
    echo "$PROJECTS_JSON" | jq -r '.data.projects[] | "\(.id) - \(.name)"' | nl -w2 -s". "
    echo ""

    # 让用户选择项目
    read -p "请输入项目编号（1-$PROJECT_COUNT）: " PROJECT_INDEX

    if [ -z "$PROJECT_INDEX" ] || [ "$PROJECT_INDEX" -lt 1 ] || [ "$PROJECT_INDEX" -gt "$PROJECT_COUNT" ]; then
        echo "❌ 无效的项目编号"
        exit 1
    fi

    PROJECT_ID=$(echo "$PROJECTS_JSON" | jq -r ".data.projects[$((PROJECT_INDEX - 1))].id")
    PROJECT_NAME=$(echo "$PROJECTS_JSON" | jq -r ".data.projects[$((PROJECT_INDEX - 1))].name")

    echo ""
    echo "已选择项目：$PROJECT_NAME"
    echo "项目ID：$PROJECT_ID"
    echo ""

    # 检查项目是否已存在
    if [ -f "$CONFIG_FILE" ]; then
        EXISTING=$(cat "$CONFIG_FILE" | jq -r ".projects[] | select(.projectId == \"$PROJECT_ID\") | .projectId")
        if [ "$EXISTING" == "$PROJECT_ID" ]; then
            echo "⚠️  项目已存在于配置中"
            read -p "是否覆盖现有配置？(y/N): " OVERWRITE
            if [ "$OVERWRITE" != "y" ] && [ "$OVERWRITE" != "Y" ]; then
                echo "操作已取消"
                exit 0
            fi
            # 删除现有配置
            cat "$CONFIG_FILE" | jq ".projects |= map(select(.projectId != \"$PROJECT_ID\"))" > "$CONFIG_FILE.tmp"
            mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
        fi
    fi

    # 获取看板信息
    echo "获取项目看板..."

    # 使用临时文件避免子 shell 输出缓冲问题
    BOARD_TEMP_FILE=$(mktemp)
    get_board "$PROJECT_ID" > "$BOARD_TEMP_FILE"
    BOARD_JSON=$(cat "$BOARD_TEMP_FILE")
    rm -f "$BOARD_TEMP_FILE"

    # columns 是对象，需要转换为数组，并清理控制字符
    COLUMNS_ARRAY=$(echo "$BOARD_JSON" | jq -c '[.data.columns | to_entries | .[] | .value]' | tr -d '\000-\037' | tr -d '\177')
    COLUMN_COUNT=$(echo "$COLUMNS_ARRAY" | jq 'length')
    echo "✅ 找到 $COLUMN_COUNT 个清单"
    echo ""

    # 显示清单列表
    echo "可用清单："
    echo "$COLUMNS_ARRAY" | jq -r '.[] | "\(.id) - \(.title)"' | nl -w2 -s". "
    echo ""

    read -p "请输入默认清单编号（1-$COLUMN_COUNT，用于拉取待办任务）: " COLUMN_INDEX

    if [ -z "$COLUMN_INDEX" ] || [ "$COLUMN_INDEX" -lt 1 ] || [ "$COLUMN_INDEX" -gt "$COLUMN_COUNT" ]; then
        echo "❌ 无效的清单编号"
        exit 1
    fi

    COLUMN_ID=$(echo "$COLUMNS_ARRAY" | jq -r ".[$((COLUMN_INDEX - 1))].id")
    COLUMN_TITLE=$(echo "$COLUMNS_ARRAY" | jq -r ".[$((COLUMN_INDEX - 1))].title")

    echo ""
    echo "已选择清单：$COLUMN_TITLE"
    echo "清单ID：$COLUMN_ID"
    echo ""

# ============ 新增：配置代码仓库路径 ============
echo "----------------------------------------"
echo "配置代码仓库路径（可选）"
echo "----------------------------------------"
echo ""
echo "说明："
echo "  - 如果配置，工作流将自动在该目录执行开发任务"
echo "  - 如果不配置，执行工作流时需要手动指定 codeRepo 参数"
echo ""
read -p "请输入代码仓库路径（留空跳过）: " CODE_REPO

# 验证路径
if [ -n "$CODE_REPO" ]; then
    # 展开 ~ 为 home 目录
    CODE_REPO="${CODE_REPO/#\~/$HOME}"

    if [ ! -d "$CODE_REPO" ]; then
        echo "⚠️  警告：目录不存在：$CODE_REPO"
        read -p "是否仍然保存此路径？(y/N): " SAVE_ANYWAY
        if [ "$SAVE_ANYWAY" != "y" ] && [ "$SAVE_ANYWAY" != "Y" ]; then
            CODE_REPO=""
            echo "已跳过代码仓库路径配置"
        fi
    elif [ ! -d "$CODE_REPO/.git" ]; then
        echo "⚠️  警告：$CODE_REPO 不是 Git 仓库"
        read -p "是否仍然保存此路径？(y/N): " SAVE_ANYWAY
        if [ "$SAVE_ANYWAY" != "y" ] && [ "$SAVE_ANYWAY" != "Y" ]; then
            CODE_REPO=""
            echo "已跳过代码仓库路径配置"
        fi
    else
        echo "✅ 代码仓库路径已验证"
    fi
fi

if [ -n "$CODE_REPO" ]; then
    echo ""
    echo "代码仓库路径：$CODE_REPO"
fi
echo ""

    # 提取所有清单信息（columns 是对象，需要转换）
    COLUMNS=$(echo "$BOARD_JSON" | jq -c '[.data.columns | to_entries | .[] | .value | {id: .id, title: .title}]')

# 添加到配置文件
if [ -n "$CODE_REPO" ]; then
    # 包含 codeRepo 字段
    cat "$CONFIG_FILE" | jq \
        --arg pid "$PROJECT_ID" \
        --arg pname "$PROJECT_NAME" \
        --arg cid "$COLUMN_ID" \
        --arg ctitle "$COLUMN_TITLE" \
        --arg crepo "$CODE_REPO" \
        --argjson cols "$COLUMNS" \
        '.projects += [{
            projectId: $pid,
            name: $pname,
            defaultColumnId: $cid,
            defaultColumnTitle: $ctitle,
            codeRepo: $crepo,
            columns: $cols
        }]' > "$CONFIG_FILE.tmp"
else
    # 不包含 codeRepo 字段
    cat "$CONFIG_FILE" | jq \
        --arg pid "$PROJECT_ID" \
        --arg pname "$PROJECT_NAME" \
        --arg cid "$COLUMN_ID" \
        --arg ctitle "$COLUMN_TITLE" \
        --argjson cols "$COLUMNS" \
        '.projects += [{
            projectId: $pid,
            name: $pname,
            defaultColumnId: $cid,
            defaultColumnTitle: $ctitle,
            columns: $cols
        }]' > "$CONFIG_FILE.tmp"
fi
    mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"

    # 如果是第一个项目，设置为默认
    if [ "$(cat "$CONFIG_FILE" | jq '.defaultProjectId')" == "null" ]; then
        cat "$CONFIG_FILE" | jq --arg pid "$PROJECT_ID" '.defaultProjectId = $pid' > "$CONFIG_FILE.tmp"
        mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
        echo "✅ 已设置为默认项目"
    fi

    echo "✅ 项目配置已添加"
}

# 删除项目配置
delete_project() {
    echo ""
    echo "当前配置的项目："
    cat "$CONFIG_FILE" | jq -r '.projects[] | "\(.projectId) - \(.name)"' | nl -w2 -s". "
    echo ""

    PROJECT_COUNT=$(cat "$CONFIG_FILE" | jq '.projects | length')
    read -p "请输入要删除的项目编号（1-$PROJECT_COUNT）: " PROJECT_INDEX

    if [ -z "$PROJECT_INDEX" ] || [ "$PROJECT_INDEX" -lt 1 ] || [ "$PROJECT_INDEX" -gt "$PROJECT_COUNT" ]; then
        echo "❌ 无效的项目编号"
        exit 1
    fi

    PROJECT_ID=$(cat "$CONFIG_FILE" | jq -r ".projects[$((PROJECT_INDEX - 1))].projectId")
    PROJECT_NAME=$(cat "$CONFIG_FILE" | jq -r ".projects[$((PROJECT_INDEX - 1))].name")

    echo ""
    read -p "确认删除项目「$PROJECT_NAME」的配置？(y/N): " CONFIRM
    if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
        echo "操作已取消"
        exit 0
    fi

    # 删除项目
    cat "$CONFIG_FILE" | jq ".projects |= map(select(.projectId != \"$PROJECT_ID\"))" > "$CONFIG_FILE.tmp"
    mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"

    # 如果删除的是默认项目，清空默认项目
    if [ "$(cat "$CONFIG_FILE" | jq -r '.defaultProjectId')" == "$PROJECT_ID" ]; then
        cat "$CONFIG_FILE" | jq '.defaultProjectId = null' > "$CONFIG_FILE.tmp"
        mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
    fi

    echo "✅ 项目配置已删除"
}

# 设置默认项目
set_default_project() {
    echo ""
    echo "当前配置的项目："
    cat "$CONFIG_FILE" | jq -r '.projects[] | "\(.projectId) - \(.name)"' | nl -w2 -s". "
    echo ""

    CURRENT_DEFAULT=$(cat "$CONFIG_FILE" | jq -r '.defaultProjectId')
    if [ "$CURRENT_DEFAULT" != "null" ]; then
        DEFAULT_NAME=$(cat "$CONFIG_FILE" | jq -r ".projects[] | select(.projectId == \"$CURRENT_DEFAULT\") | .name")
        echo "当前默认项目：$DEFAULT_NAME"
        echo ""
    fi

    PROJECT_COUNT=$(cat "$CONFIG_FILE" | jq '.projects | length')
    read -p "请输入要设置为默认的项目编号（1-$PROJECT_COUNT）: " PROJECT_INDEX

    if [ -z "$PROJECT_INDEX" ] || [ "$PROJECT_INDEX" -lt 1 ] || [ "$PROJECT_INDEX" -gt "$PROJECT_COUNT" ]; then
        echo "❌ 无效的项目编号"
        exit 1
    fi

    PROJECT_ID=$(cat "$CONFIG_FILE" | jq -r ".projects[$((PROJECT_INDEX - 1))].projectId")
    PROJECT_NAME=$(cat "$CONFIG_FILE" | jq -r ".projects[$((PROJECT_INDEX - 1))].name")

    cat "$CONFIG_FILE" | jq --arg pid "$PROJECT_ID" '.defaultProjectId = $pid' > "$CONFIG_FILE.tmp"
    mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"

    echo ""
    echo "✅ 已设置「$PROJECT_NAME」为默认项目"
}

# 修改项目配置
edit_project() {
    echo ""
    echo "当前配置的项目："
    cat "$CONFIG_FILE" | jq -r '.projects[] | "\(.projectId) - \(.name)"' | nl -w2 -s". "
    echo ""

    PROJECT_COUNT=$(cat "$CONFIG_FILE" | jq '.projects | length')
    read -p "请输入要修改的项目编号（1-$PROJECT_COUNT）: " PROJECT_INDEX

    if [ -z "$PROJECT_INDEX" ] || [ "$PROJECT_INDEX" -lt 1 ] || [ "$PROJECT_INDEX" -gt "$PROJECT_COUNT" ]; then
        echo "❌ 无效的项目编号"
        exit 1
    fi

    PROJECT_ID=$(cat "$CONFIG_FILE" | jq -r ".projects[$((PROJECT_INDEX - 1))].projectId")

    # 删除旧配置
    cat "$CONFIG_FILE" | jq ".projects |= map(select(.projectId != \"$PROJECT_ID\"))" > "$CONFIG_FILE.tmp"
    mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"

    # 重新添加
    add_project
}

# 主流程
case $MODE in
    init)
        init_config
        add_project
        ;;
    add)
        add_project
        ;;
    edit)
        edit_project
        ;;
    delete)
        delete_project
        ;;
    set-default)
        set_default_project
        ;;
esac

echo ""
echo "========================================="
echo "配置完成！"
echo "========================================="
echo ""
echo "当前配置："
cat "$CONFIG_FILE" | jq
echo ""

DEFAULT_PROJECT_ID=$(cat "$CONFIG_FILE" | jq -r '.defaultProjectId')
if [ "$DEFAULT_PROJECT_ID" != "null" ]; then
    DEFAULT_PROJECT=$(cat "$CONFIG_FILE" | jq -r ".projects[] | select(.projectId == \"$DEFAULT_PROJECT_ID\")")
    DEFAULT_PROJECT_NAME=$(echo "$DEFAULT_PROJECT" | jq -r '.name')
    DEFAULT_COLUMN_ID=$(echo "$DEFAULT_PROJECT" | jq -r '.defaultColumnId')

    echo "默认项目配置："
    echo "  项目：$DEFAULT_PROJECT_NAME"
    echo "  项目ID：$DEFAULT_PROJECT_ID"
    echo "  默认清单ID：$DEFAULT_COLUMN_ID"
    echo ""

    echo "快速开始："
    echo ""
    echo "1. 从默认项目的默认清单拉取任务："
    echo "   workflow('devops-automation-loop-yunzhou')"
        DEFAULT_CODE_REPO=$(echo "$DEFAULT_PROJECT" | jq -r '.codeRepo // empty')
        if [ -n "$DEFAULT_CODE_REPO" ]; then
            echo "  代码仓库：$DEFAULT_CODE_REPO"
        else
            echo "  ⚠️  未配置代码仓库，需要在调用时指定 codeRepo 参数"
        fi
    echo ""
    echo "2. 指定项目和清单："
    echo "   workflow('devops-automation-loop-yunzhou', {"
    echo "     projectId: '$DEFAULT_PROJECT_ID',"
    echo "     columnId: '$DEFAULT_COLUMN_ID'"
    echo "   })"
    echo ""
    echo "3. 指定任务ID："
    echo "   workflow('devops-automation-loop-yunzhou', {"
    echo "     projectId: '$DEFAULT_PROJECT_ID',"
    echo "     taskId: <任务ID>"
    echo "   })"
    echo ""
fi

echo "管理配置："
echo "  添加项目：   ./setup-yunzhou-config.sh"
echo "  修改项目：   ./setup-yunzhou-config.sh"
echo "  查看配置：   cat $CONFIG_FILE | jq"
echo ""
