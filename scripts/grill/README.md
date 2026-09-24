# Grill 门禁系统脚本

自动化 Grill 门禁检查脚本集合。

---

## 在哪里运行这些命令

脚本支持两种运行形态，命令写法不同：

| 形态 | 场景 | 命令写法 |
|------|------|----------|
| **安装形态** | 已通过 `install.sh` 安装到业务项目 | `node scripts/grill-check.js ...` |
| **仓库形态** | 直接在 agent-skills 仓库内调试脚本本身 | `node scripts/grill/grill-check.js ...` |

两种形态下脚本都能正确定位 `openspec/`、`grill-policy.yml` 与模板：先看脚本上一级目录，再从当前工作目录逐级上溯。**但仓库形态必须用带 `grill/` 的路径**，本节以下的示例统一按安装形态书写，在本仓内运行时请自行补上 `grill/` 目录层级。

初始化一个临时验证项目：

```bash
mkdir -p /tmp/grill-sandbox/openspec/changes/demo && cd /tmp/grill-sandbox && git init
bash /path/to/agent-skills/scripts/grill/install.sh /tmp/grill-sandbox
```

---

## 脚本清单

### 1. grill-check.js

**功能**: 自动化检查脚本（3个命令）

**用法**:
```bash
# 判断是否需要 Grill
node scripts/grill-check.js check-required <change-name>

# 验证 Grill 完整性
node scripts/grill-check.js validate <change-name>

# 生成健康度报告
node scripts/grill-check.js health-report
```

---

### 2. create-grill.js

**功能**: 快速创建 Grill（从模板）

**用法**:
```bash
node scripts/create-grill.js <change-name>
```

**效果**:
- 创建 `grill-<name>/discussion-log.md`
- 自动填充基本信息（风险等级、日期）
- 使用标准模板结构

---

### 3. install.sh

**功能**: 一键安装 Grill 系统到项目

**用法**:
```bash
# 在目标项目根目录
bash /path/to/agent-skills/scripts/grill/install.sh

# 或指定目标目录
bash install.sh /path/to/target-project
```

**安装内容**:
- `.claude/grill-policy.yml`
- `.claude/templates/grill-discussion-log-template.md`
- `scripts/grill-check.js`
- `scripts/create-grill.js`
- `docs/grill-gate-manual.md`、`docs/grill-quickstart.md`、`docs/openspec-workflow-guide.md`
- `CONTEXT.md`（如不存在）

**注意**：安装源全部取自本仓 `skills/openspec-grill-policy/` 与 `docs/`，通过脚本自身位置推导，不依赖仓库外任何绝对路径。若某个源文件缺失会明确报错，不会静默跳过。

---

## 依赖

```bash
npm install --save-dev js-yaml
```

---

## 将门禁接入流水线（工具维护者）

> 本节面向**给整个仓库装门禁的维护者**。若你只是要过某次变更的 Grill，看 `docs/grill-gate-manual.md` 即可，流程里没有"配 CI"这一步。

### Git Hook（pre-commit）

创建 `.git/hooks/pre-commit`：

```bash
#!/bin/bash
# Grill 门禁 pre-commit hook

echo "🔍 检查 Grill 门禁..."

changed_changes=$(git diff --cached --name-only | grep "^openspec/changes/" | cut -d'/' -f3 | sort -u)

for change in $changed_changes; do
  # 跳过 grill 目录本身
  if [[ $change == grill-* ]]; then
    continue
  fi

  result=$(node scripts/grill-check.js check-required "$change" 2>&1)

  if echo "$result" | grep -q "需要 Grill"; then
    if ! node scripts/grill-check.js validate "$change" > /dev/null 2>&1; then
      echo "❌ $change 需要 Grill 但不完整"
      echo "$result"
      exit 1
    fi
  fi
done

echo "✅ Grill 门禁检查通过"
```

### GitLab CI

在 `.gitlab-ci.yml` 中添加：

```yaml
grill-gate:
  stage: validate
  script:
    - npm install
    - node scripts/grill-check.js health-report
  only:
    - merge_requests
  allow_failure: false
```

### GitHub Actions

在 `.github/workflows/grill-check.yml` 中：

```yaml
name: Grill Gate Check

on:
  pull_request:
    paths:
      - 'openspec/changes/**'

jobs:
  grill-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm install
      - run: node scripts/grill-check.js health-report
```

### 团队推进节奏

若团队成员尚未养成习惯，三步渐进：

1. **第一周**：人工检查清单（教育阶段）
2. **第二周**：每次 MR 前手动跑脚本检查
3. **第三周**：在 CI 中强制检查

---

## 使用流程

```text
1. 安装到项目
   bash scripts/grill/install.sh

2. 判断是否需要 Grill
   node scripts/grill-check.js check-required <name>

3. 创建 Grill
   node scripts/create-grill.js <name>

4. 验证完整性
   node scripts/grill-check.js validate <name>

5. 生成报告
   node scripts/grill-check.js health-report
```

---

## 与 openspec-grill skill 的关系

```text
openspec-grill（访谈执行）
  ↓ 读取配置
grill-policy.yml（规则）
  ↓ 使用
grill-check.js（验证）
```

---

## 完整文档

安装后查看：
- `docs/grill-gate-manual.md` - 门禁操作手册（含放行检查与人工清单）
- `docs/grill-quickstart.md` - 2 分钟快速开始
- `docs/openspec-workflow-guide.md` - 工作流选择

---

维护者: agent-skills 团队
版本: 1.1.0
最后更新: 2026-09-24
