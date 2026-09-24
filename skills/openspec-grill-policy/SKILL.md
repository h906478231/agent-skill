---
name: openspec-grill-policy
description: OpenSpec Grill 门禁助手：创建标准化模板、验证完整性、生成健康度报告。跨 agent 通用，无需配置。
---

# OpenSpec Grill 门禁助手

跨 coding agent 通用的 Grill 门禁助手 skill。

## 使用方式

```bash
# 安装 skill（一次性，根据你的 agent）
npx skills add h906478231/agent-skill --skill openspec-grill-policy -a claude-code
npx skills add h906478231/agent-skill --skill openspec-grill-policy -a codex
npx skills add h906478231/agent-skill --skill openspec-grill-policy -a opencode

# 直接使用（在项目根目录）
/openspec-grill-policy <change-name>           # 创建 Grill
/openspec-grill-policy validate <change-name>  # 验证完整性
/openspec-grill-policy report                  # 生成报告
```

---

## 三大功能

### 1. 创建标准化 Grill（最常用）

```bash
/openspec-grill-policy <change-name>
# 或
/openspec-grill-policy create <change-name>
```

效果：
- 创建 `openspec/changes/grill-<change-name>/discussion-log.md`
- 使用标准模板
- 自动填充基本信息（风险等级、日期、BREAKING）
- 提示下一步：`/openspec-grill`

**用户调用此 skill = 需要 Grill**，无需判断。

---

### 2. 验证完整性

```bash
/openspec-grill-policy validate <change-name>
```

检查：
- 必须章节是否存在
- 风险标注是否完整
- 门禁决策是否明确

---

### 3. 生成报告

```bash
/openspec-grill-policy report
```

输出：
- Grill 完成率
- 问题清单
- 建议行动

---

## 执行逻辑

### 当调用 `<name>` 或 `create <name>` 时

1. 检查当前目录是否有 `openspec/changes/` 目录
2. 读取 `openspec/changes/<name>/proposal.md`（如果存在）
3. 提取信息：
   - 风险等级（正则匹配：`等级：L[0-3]`、`level: L[0-3]`、`风险等级：L[0-3]`）
   - BREAKING 标记（正则匹配：`BREAKING`、`破坏性变更`）
4. 创建目录 `openspec/changes/grill-<name>/`
5. 使用内置模板生成 `discussion-log.md`
6. 自动填充：
   - 变更名称
   - 风险等级（已提取或标注为"待确认"）
   - BREAKING 状态（是/否/待确认）
   - 当前日期

**路径查找规则**：
- 从当前工作目录开始
- 查找 `openspec/changes/` 目录
- 如不存在，提示用户确认项目根目录
- 所有路径使用相对路径

---

### 内置模板结构

```markdown
# {变更名称} Grill 访谈记录

## 访谈基本信息
| 项目 | 内容 |
|------|------|
| 变更名称 | {自动填充} |
| 风险等级 | {自动提取或"待确认"} |
| BREAKING | {自动提取或"待确认"} |
| 访谈开始日期 | {当前日期} |

## 讨论轮次记录
| 轮次 | 日期 | 子agent | 结论 | 未决 |
|------|------|---------|------|------|
| D1 | ... | ... | ... | ... |

## 事实依据
### 现有能力
- **能力1**: {描述}

## 关键决策问题
### Q1: {第一个关键问题}
**背景**: {为什么要问}
**候选答案**: A/B/C
**用户回答**: {等待确认}

## 识别的假设
### 假设H1: {假设描述}
**风险等级**: 🔴 HIGH / 🟡 MEDIUM / 🟢 LOW
**验证方法**: {如何验证}
**当前状态**: 未验证 / 验证中 / 已验证

## 术语沉淀
### 术语1: {术语名称}
**定义**: {精确定义}
**已同步**: 待同步到 CONTEXT.md

## Grill总结（访谈结束后补充）
### ✓ 已验证的假设
### ✗ 未验证的假设
### 建议行动
  1. **立即修复**（阻塞实施）
  2. **发布前修复**（不阻塞开发）
### Grill门禁决策
**状态**: ✓ 通过 / ⚠️ 附加条件通过 / ✗ 拒绝
**签字**: {名字}
**日期**: YYYY-MM-DD
```

---

### 当调用 `validate <name>` 时

1. 查找 `openspec/changes/grill-<name>/discussion-log.md`（相对路径）
2. 检查必须章节：
   - [ ] `## Grill总结`
   - [ ] `### ✓ 已验证的假设` 或 `### ✗ 未验证的假设`
   - [ ] `### Grill门禁决策`
3. 检查风险标注（🔴/🟡/🟢）
4. 检查门禁决策状态（✓/⚠️/✗）
5. 输出验证结果

---

### 当调用 `report` 时

1. 扫描 `openspec/changes/` 下所有子目录（相对路径）
2. 对每个非 `grill-*` 的变更：
   - 检查是否有对应的 `grill-<name>/` 目录
   - 如有，验证其完整性
3. 统计：
   - 变更总数
   - 有 Grill 的数量
   - 完整 Grill 的数量
4. 计算 Grill 完成率
5. 列出问题清单
6. 给出建议

**路径解析规则**：
- 所有路径从当前工作目录开始
- 使用相对路径
- 不依赖任何特定 agent 的目录结构

---

## 与 openspec-grill 的配合

```text
openspec-grill（访谈执行）
  ↓ 读取
openspec/changes/grill-<name>/discussion-log.md（本 skill 创建）
  ↓ 验证
openspec-grill-policy validate（本 skill 检查）
```

两者配合使用，互不冲突。

---

## 跨 Agent 兼容性

### 支持的 Coding Agent

| Agent | 全局目录 | 兼容性 |
|-------|----------|--------|
| Claude Code | `~/.claude/skills/` | ✅ 完全支持 |
| Codex CLI | `~/.codex/skills/` | ✅ 完全支持 |
| opencode | `~/.config/opencode/skills/` | ✅ 完全支持 |
| Cursor | `~/.cursor/skills/` | ✅ 完全支持 |
| Gemini CLI | `~/.gemini/skills/` | ✅ 完全支持 |

**工作方式**：
- Skill 安装到各 agent 的全局目录
- 执行时从当前工作目录查找 `openspec/` 目录
- 不依赖任何特定 agent 的配置文件

---

## 路径查找策略

### 自动检测项目根目录

1. 从当前工作目录开始
2. 查找 `openspec/changes/` 目录
3. 如果找到，使用该目录
4. 如果未找到，向上查找父目录（最多3层）
5. 如果仍未找到，询问用户确认

**示例**：
```text
当前目录: /path/to/project/subdir/

查找顺序:
  1. /path/to/project/subdir/openspec/changes/  ← 先查这里
  2. /path/to/project/openspec/changes/         ← 再查父目录
  3. /path/to/openspec/changes/                 ← 最多向上3层
```

---

## 门禁规则（内置）

### 强制 Grill 条件（供参考）

虽然本 skill 不再执行"判断是否需要 Grill"的功能，但提供以下参考规则：

| 条件 | 说明 |
|------|------|
| L3 | 核心变更（认证、授权、隔离） |
| L2 | 跨域变更（HTTP契约、跨模块） |
| BREAKING | 破坏性变更 |

### 门禁检查点

| 检查项 | 阻塞性 |
|--------|--------|
| discussion-log.md 存在 | 是 |
| Grill 总结存在 | 是 |
| 风险等级标注 | 是 |
| 门禁决策明确 | 是 |

---

## 完整工作流

```text
1. /openspec-explore
   产出: proposal.md + design.md
   
2. /openspec-grill-policy my-feature
   创建: grill-my-feature/discussion-log.md（自动填充基本信息）
   
3. /openspec-grill
   执行: 访谈（填写 discussion-log.md）
   
4. /openspec-grill-policy validate my-feature
   验证: ✅ 完整 or ❌ 缺失XXX
   
5. openspec propose my-feature
   实施
```

**核心简化**：调用 skill = 需要 Grill，直接创建即可。

---

## 优势

### ✅ 简单

- 无需安装脚本
- 无需复制文件
- 无需配置文件
- 直接调用即可

### ✅ 跨平台

- 支持所有主流 coding agent
- 不依赖特定目录结构
- 使用相对路径

### ✅ 标准化

- 统一的模板
- 统一的检查规则

---

## 示例对话

```
用户: /openspec-grill-policy add-auth

Claude:
✅ 创建 Grill: add-auth

检测项目根目录: /path/to/project
查找: openspec/changes/add-auth/proposal.md
读取成功！

提取信息：
  • 风险等级: L3
  • BREAKING: 是

创建文件: openspec/changes/grill-add-auth/discussion-log.md

已自动填充：
  ✓ 变更名称: add-auth
  ✓ 风险等级: L3
  ✓ BREAKING: 是
  ✓ 开始日期: 2026-09-24

📋 标准模板章节已创建：
  ✓ 访谈基本信息
  ✓ 讨论轮次记录
  ✓ 识别的假设
  ✓ Grill总结（待补充）

🚀 下一步:
  /openspec-grill  ← 开始访谈
```

---

**零配置，跨 agent 通用，开箱即用！**

---

## 三大功能

### 1. 创建标准化 Grill（最常用）

```bash
/openspec-grill-policy <change-name>
# 或
/openspec-grill-policy create <change-name>
```

效果：
- 创建 `openspec/changes/grill-<change-name>/discussion-log.md`
- 使用标准模板
- 自动填充基本信息（风险等级、日期、BREAKING）
- 提示下一步：`/openspec-grill`

**用户调用此 skill = 需要 Grill**，无需判断。

---

### 2. 验证完整性

```bash
/openspec-grill-policy validate <change-name>
```

检查：
- 必须章节是否存在
- 风险标注是否完整
- 门禁决策是否明确

---

### 3. 生成报告

```bash
/openspec-grill-policy report
```

输出：
- Grill 完成率
- 问题清单
- 建议行动

---

## 执行逻辑

### 当调用 `<name>` 或 `create <name>` 时

1. 检查 `openspec/changes/grill-<name>/` 是否已存在
2. 创建目录
3. 从内置模板生成 `discussion-log.md`
4. 自动填充：
   - 变更名称
   - 风险等级（从 proposal.md 提取）
   - BREAKING 状态
   - 当前日期

**内置模板结构**：
```markdown
# {变更名称} Grill 访谈记录

## 访谈基本信息
| 项目 | 内容 |
|------|------|
| 变更名称 | {自动填充} |
| 风险等级 | {自动提取} |
| BREAKING | {自动提取} |

## 讨论轮次记录
## 事实依据
## 关键决策问题
## 识别的假设
## 术语沉淀
## Grill总结（必须补充）
```

---

### 当调用 `validate <name>` 时

1. 读取 `openspec/changes/grill-<name>/discussion-log.md`
2. 检查必须章节：
   - [ ] `## Grill总结`
   - [ ] `### ✓ 已验证的假设`
   - [ ] `### ✗ 未验证的假设`
   - [ ] `### Grill门禁决策`
3. 检查风险标注（🔴/🟡/🟢）
4. 检查门禁决策状态（✓/⚠️/✗）
5. 输出验证结果

---

### 当调用 `report` 时

1. 扫描 `openspec/changes/` 下所有变更
2. 对每个变更：
   - 判断是否需要 Grill
   - 检查是否有 grill-<name>/
   - 验证完整性
3. 统计：
   - 需要 Grill 的变更数
   - 已有 Grill 的数量
   - 完整 Grill 的数量
4. 计算 Grill 完成率
5. 列出问题清单
6. 给出建议

---

## 与 openspec-grill 的配合

```text
openspec-grill（访谈执行）
  ↓ 读取
grill-<name>/discussion-log.md（本 skill 创建）
  ↓ 验证
openspec-grill-policy validate（本 skill 检查）
```

两者配合使用，互不冲突。

---

## 门禁规则（内置）

### 强制 Grill 条件

| 条件 | 说明 |
|------|------|
| L3 | 核心变更（认证、授权、隔离） |
| L2 | 跨域变更（HTTP契约、跨模块） |
| BREAKING | 破坏性变更 |
| 新增模块 | 独立模块 |
| 安全敏感 | 认证/授权/加密 |
| 协议变更 | HTTP/RPC 协议 |

### 门禁检查点

| 检查项 | 阻塞性 |
|--------|--------|
| discussion-log.md 存在 | 是 |
| Grill 总结存在 | 是 |
| 风险等级标注 | 是 |
| 门禁决策明确 | 是 |

---

## 标准模板（内置）

完整模板见 `templates/grill-discussion-log-template.md`

关键章节：
1. 访谈基本信息
2. 讨论轮次记录
3. 事实依据
4. 关键决策问题（Q1-QN）
5. 识别的假设（H1-HN，风险等级）
6. 术语沉淀
7. **Grill总结**（必须）
   - ✓ 已验证的假设
   - ✗ 未验证的假设
   - 建议行动
   - **Grill门禁决策**

---

## 完整工作流

```text
1. /openspec-explore
   产出: proposal.md + design.md
   
2. /openspec-grill-policy my-feature
   创建: grill-my-feature/discussion-log.md（自动填充基本信息）
   
3. /openspec-grill
   执行: 访谈（填写 discussion-log.md）
   
4. /openspec-grill-policy validate my-feature
   验证: ✅ 完整 or ❌ 缺失XXX
   
5. openspec propose my-feature
   实施
```

**核心简化**：调用 skill = 需要 Grill，直接创建即可。

---

## 优势

### ✅ 简单

- 无需安装脚本
- 无需复制文件
- 无需 npm 依赖
- 直接调用即可

### ✅ 标准化

- 统一的模板
- 统一的规则
- 统一的检查

### ✅ 可追溯

- 自动生成报告
- 健康度可视化

---

## 示例对话

```
用户: /openspec-grill-policy add-auth

Claude:
✅ 创建 Grill: add-auth

读取 openspec/changes/add-auth/proposal.md...
提取信息：
  • 风险等级: L3
  • BREAKING: 是

创建文件: openspec/changes/grill-add-auth/discussion-log.md

已自动填充：
  ✓ 变更名称: add-auth
  ✓ 风险等级: L3
  ✓ BREAKING: 是
  ✓ 开始日期: 2026-09-24

📋 标准模板章节已创建：
  ✓ 访谈基本信息
  ✓ 讨论轮次记录
  ✓ 识别的假设
  ✓ Grill总结（待补充）

🚀 下一步:
  /openspec-grill  ← 开始访谈
```

---

**零配置，开箱即用！**

## 使用场景

### 场景1: 判断是否需要 Grill

```bash
node scripts/grill-check.js check-required <change-name>
```

输出：
- ✅ 需要 Grill（理由：L2/L3/BREAKING）
- ✅ 不需要 Grill

### 场景2: 快速创建 Grill

```bash
node scripts/create-grill.js <change-name>
```

效果：
- 创建 `grill-<name>/discussion-log.md`
- 自动填充基本信息
- 使用标准模板

### 场景3: 验证 Grill 完整性

```bash
node scripts/grill-check.js validate <change-name>
```

检查：
- 必须章节是否存在
- 门禁决策是否明确
- HIGH 风险假设是否有验证计划

### 场景4: 生成健康度报告

```bash
node scripts/grill-check.js health-report
```

报告：
- Grill 完成率
- 问题清单
- 建议行动

## 与 openspec-grill 的关系

```text
openspec-grill（访谈执行）
  ↓ 读取配置
openspec-grill-policy（规则和工具）

协作：
  1. 用户运行 /openspec-grill
  2. openspec-grill 读取 grill-policy.yml
  3. 按规则执行访谈
  4. 生成符合模板的 discussion-log.md
  5. 用 grill-check.js 验证完整性
```

## 安装到项目

### 方式1: 使用安装脚本（推荐）

```bash
# 在你的项目根目录
cd /path/to/your/project

# 运行安装脚本
bash ~/.claude/skills/openspec-grill-policy/install.sh
```

安装内容：
- `.claude/grill-policy.yml`
- `.claude/templates/grill-discussion-log-template.md`
- `scripts/grill-check.js`
- `scripts/create-grill.js`
- `docs/grill-gate-manual.md`
- `docs/grill-quickstart.md`
- `docs/openspec-workflow-guide.md`

### 方式2: 手动复制

```bash
# 复制配置
cp ~/.claude/skills/openspec-grill-policy/grill-policy.yml \
   your-project/.claude/

# 复制模板
cp -r ~/.claude/skills/openspec-grill-policy/templates \
      your-project/.claude/

# 复制脚本
cp ~/.claude/skills/openspec-grill-policy/scripts/*.js \
   your-project/scripts/
```

## 门禁规则

### 强制 Grill 的变更类型

| 类型 | 条件 | 示例 |
|------|------|------|
| 风险等级 | L3 或 L2 | 认证、跨模块协议 |
| 变更属性 | BREAKING | 破坏性变更 |
| 影响范围 | 对外 API、协议变更 | HTTP 契约、数据模型 |

### 门禁检查点

| 检查项 | 阻塞性 | 说明 |
|--------|--------|------|
| discussion-log.md 存在 | 是 | 必须有访谈记录 |
| Grill 总结存在 | 是 | 必须有总结章节 |
| 关键问题都有回答 | 是 | Q1-QN 都有确认 |
| HIGH 风险假设有计划 | 是 | 🔴 假设必须验证 |
| CONTEXT.md 已更新 | 建议 | 新术语同步 |
| ADR 已创建 | 建议 | 重大决策记录 |

### 门禁决策状态

- **✓ 通过** - 无条件放行
- **⚠️ 附加条件通过** - 修复指定问题后放行
- **✗ 拒绝** - 阻塞，回到 explore 修改

## 模板结构

标准 `discussion-log.md` 包含：

```markdown
## 访谈基本信息
## 讨论轮次记录
## 事实依据
## 关键决策问题
## 识别的假设         ← 风险等级标注
## 术语沉淀           ← 同步到 CONTEXT.md
## Grill总结          ← 必须章节
  ├─ ✓ 已验证的假设
  ├─ ✗ 未验证的假设
  ├─ 建议行动
  └─ Grill门禁决策    ← 明确决策
```

## 自动化脚本

### grill-check.js

```bash
# 判断是否需要 Grill
node scripts/grill-check.js check-required <name>

# 验证 Grill 完整性
node scripts/grill-check.js validate <name>

# 生成健康度报告
node scripts/grill-check.js health-report
```

### create-grill.js

```bash
# 快速创建 Grill（从模板）
node scripts/create-grill.js <name>

# 自动填充：
# - 变更名称
# - 风险等级（从 proposal.md 提取）
# - BREAKING 状态
# - 开始日期
```

## 工作流集成

### 标准流程

```text
1. /openspec-explore
   ↓
2. 判断是否需要 Grill
   node scripts/grill-check.js check-required <name>
   ↓
3. 如需要，创建 Grill
   node scripts/create-grill.js <name>
   ↓
4. 执行访谈
   /openspec-grill
   ↓
5. 验证完整性
   node scripts/grill-check.js validate <name>
   ↓
6. 通过后实施
   openspec propose <name>
```

### CI/CD 集成

```yaml
# .gitlab-ci.yml
grill-gate:
  stage: validate
  script:
    - npm install
    - node scripts/grill-check.js health-report
  only:
    - merge_requests
```

## 度量指标

### 健康度指标

| 指标 | 目标 | 说明 |
|------|------|------|
| Grill 完成率 | >= 80% | L2/L3 变更的 Grill 覆盖率 |
| HIGH 风险假设验证 | 100% | 🔴 假设必须有验证计划 |
| CONTEXT.md 更新率 | >= 90% | 新术语同步比例 |
| ADR 创建率 | >= 70% | 重大决策记录比例 |

## 文档

安装后可查看完整文档：

- `docs/grill-gate-manual.md` - 门禁操作手册（放行检查 / 人工清单 / 度量）
- `docs/grill-quickstart.md` - 2 分钟快速开始
- `docs/openspec-workflow-guide.md` - 工作流选择
- `scripts/grill/README.md` - 脚本说明与 CI / Git Hook 集成

## 依赖

```bash
# 需要 js-yaml（用于解析 grill-policy.yml）
npm install --save-dev js-yaml
```

## 示例项目

参考 lokra 项目：
- 完整的 Grill 门禁实施
- 多个真实 Grill 案例
- 标准化流程实践

## 维护

- 版本：1.0.0
- 最后更新：2026-09-23
- 维护者：agent-skills 团队
- 源项目：lokra (内部 SCRM 项目)

## 常见问题

### Q: 每个变更都要 Grill 吗？

A: 不需要。只有高风险变更（L2/L3/BREAKING）强制 Grill。

### Q: 不用脚本可以吗？

A: 可以。脚本只是辅助工具，可以手动创建 discussion-log.md。

### Q: 如何更新规则？

A: 编辑项目根目录的 `.claude/grill-policy.yml`。

### Q: 与 openspec-grill 冲突吗？

A: 不冲突。openspec-grill 执行访谈，本 skill 提供规则和工具。
