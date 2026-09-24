#!/bin/bash
# Grill 门禁系统安装脚本
# 用法: bash install.sh [target-directory]

set -e

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# 获取脚本所在目录
# 目录布局: <REPO_ROOT>/scripts/grill/install.sh
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
SKILL_DIR="$REPO_ROOT/skills/openspec-grill-policy"
# 安装源：配置、模板、脚本、文档全部取自本仓，禁止引用仓库外部的绝对路径，
# 否则分发到其他机器时源文件缺失，复制会被静默跳过、用户拿到残缺安装。
SOURCE_DOCS_DIR="$REPO_ROOT/docs"

# 缺失源文件计数器：任一项缺失即累计，安装末尾以非零退出，
# 避免 CI 里 `bash install.sh && ...` 在残缺安装下假绿。
MISSING_COUNT=0

# 目标目录（默认为当前目录）
TARGET_DIR="${1:-.}"

echo -e "${GREEN}🚀 Grill 门禁系统安装脚本${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 检查目标目录
if [ ! -d "$TARGET_DIR" ]; then
    echo -e "${RED}❌ 目标目录不存在: $TARGET_DIR${NC}"
    exit 1
fi

cd "$TARGET_DIR"
echo -e "📁 安装到: $(pwd)"
echo ""

# 检查是否是 git 仓库
if [ ! -d ".git" ]; then
    echo -e "${YELLOW}⚠️  警告: 当前目录不是 git 仓库${NC}"
    read -p "是否继续？(y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# 创建目录
echo "📦 创建目录..."
mkdir -p .claude/templates
mkdir -p scripts
mkdir -p docs
echo -e "${GREEN}✓${NC} 目录创建完成"
echo ""

# 复制配置文件
echo "📄 复制配置文件..."

if [ -f "$SKILL_DIR/grill-policy.yml" ]; then
    cp "$SKILL_DIR/grill-policy.yml" .claude/
    echo -e "${GREEN}✓${NC} .claude/grill-policy.yml"
else
    echo -e "${RED}✗${NC} grill-policy.yml 未找到: $SKILL_DIR/grill-policy.yml"
    MISSING_COUNT=$((MISSING_COUNT + 1))
fi

# 复制模板
if [ -f "$SKILL_DIR/templates/grill-discussion-log-template.md" ]; then
    cp "$SKILL_DIR/templates/grill-discussion-log-template.md" .claude/templates/
    echo -e "${GREEN}✓${NC} .claude/templates/grill-discussion-log-template.md"
else
    echo -e "${RED}✗${NC} 模板文件未找到: $SKILL_DIR/templates/grill-discussion-log-template.md"
    MISSING_COUNT=$((MISSING_COUNT + 1))
fi

echo ""

# 复制脚本
echo "🔧 复制脚本..."

GRILL_SCRIPTS_DIR="$(dirname "$(dirname "$SKILL_DIR")")/scripts/grill"

if [ -f "$GRILL_SCRIPTS_DIR/grill-check.js" ]; then
    cp "$GRILL_SCRIPTS_DIR/grill-check.js" scripts/
    echo -e "${GREEN}✓${NC} scripts/grill-check.js"
else
    echo -e "${RED}✗${NC} grill-check.js 未找到: $GRILL_SCRIPTS_DIR/grill-check.js"
    MISSING_COUNT=$((MISSING_COUNT + 1))
fi

if [ -f "$GRILL_SCRIPTS_DIR/create-grill.js" ]; then
    cp "$GRILL_SCRIPTS_DIR/create-grill.js" scripts/
    echo -e "${GREEN}✓${NC} scripts/create-grill.js"
else
    echo -e "${RED}✗${NC} create-grill.js 未找到: $GRILL_SCRIPTS_DIR/create-grill.js"
    MISSING_COUNT=$((MISSING_COUNT + 1))
fi

# 使脚本可执行
chmod +x scripts/grill-check.js 2>/dev/null || true
chmod +x scripts/create-grill.js 2>/dev/null || true

echo ""

# 复制文档（从本仓 docs/ 取，缺失或为空时不静默跳过，明确报错）
#
# 空文件同样视为失败：源文档曾被误提交为 0 字节，仅判 -f 会打印绿色 ✓
# 并复制空文件到使用者项目，属于「静默成功」形式的残缺安装。
copy_doc() {
    local src="$SOURCE_DOCS_DIR/$1"
    if [ ! -f "$src" ]; then
        echo -e "${RED}✗${NC} 文档未找到: $src"
        MISSING_COUNT=$((MISSING_COUNT + 1))
        return
    fi
    if [ ! -s "$src" ]; then
        echo -e "${RED}✗${NC} 文档为空文件: $src"
        MISSING_COUNT=$((MISSING_COUNT + 1))
        return
    fi
    cp "$src" docs/
    echo -e "${GREEN}✓${NC} docs/$1"
}

copy_doc "grill-gate-manual.md"
copy_doc "grill-quickstart.md"
copy_doc "openspec-workflow-guide.md"

echo ""

# 检查依赖
echo "🔍 检查依赖..."

if [ -f "package.json" ]; then
    if ! grep -q "js-yaml" package.json; then
        echo -e "${YELLOW}⚠️  package.json 缺少 js-yaml 依赖${NC}"
        echo "   建议运行: npm install --save-dev js-yaml"
    else
        echo -e "${GREEN}✓${NC} js-yaml 依赖已存在"
    fi
else
    echo -e "${YELLOW}⚠️  未找到 package.json${NC}"
    echo "   需要手动安装: npm install --save-dev js-yaml"
fi

echo ""

# 创建 CONTEXT.md（如果不存在）
if [ ! -f "CONTEXT.md" ]; then
    echo "📝 创建 CONTEXT.md..."
    cat > CONTEXT.md << 'EOF'
# 项目领域术语表

跨变更复用，提交 git，不随 openspec archive 归档。

## Language

**术语1**:
定义...
_Avoid_: 混淆词

**术语2**:
定义...
_Avoid_: 混淆词

---

## 术语维护规则

1. **新增术语**: 在 Grill 访谈中敲定后立即更新此文件
2. **术语冲突**: 发现冲突时，记录 `_Avoid_` 并明确新定义
3. **跨变更复用**: 所有变更的 proposal/design 应引用此文件中的术语

最后更新: $(date +%Y-%m-%d)
EOF
    echo -e "${GREEN}✓${NC} CONTEXT.md 已创建"
else
    echo -e "${GREEN}✓${NC} CONTEXT.md 已存在"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 任一源文件缺失或为空即视为安装失败，非零退出。
# 不使用 set -e 兜底的原因：上面的复制分支需要在失败后继续执行其余步骤，
# 以便一次性列出全部缺失项，因此在这里统一判定。
if [ "$MISSING_COUNT" -gt 0 ]; then
    echo -e "${RED}❌ 安装未完成：$MISSING_COUNT 个源文件缺失或为空${NC}"
    echo "   请确认安装源完整（仓库根目录应为 agent-skills），或在 agent-skills 仓库内运行"
    exit 1
fi

echo -e "${GREEN}✅ 安装完成！${NC}"
echo ""
echo "📋 已安装的文件:"
echo "  • .claude/grill-policy.yml"
echo "  • .claude/templates/grill-discussion-log-template.md"
echo "  • scripts/grill-check.js"
echo "  • scripts/create-grill.js"
echo "  • docs/grill-*.md"
echo "  • CONTEXT.md (如不存在)"
echo ""
echo "🚀 下一步:"
echo "  1. 安装依赖: npm install --save-dev js-yaml"
echo "  2. 阅读文档: cat docs/grill-gate-manual.md"
echo "  3. 开始使用:"
echo "     node scripts/grill-check.js check-required <change-name>"
echo ""
echo "📖 完整文档: docs/grill-gate-manual.md"
