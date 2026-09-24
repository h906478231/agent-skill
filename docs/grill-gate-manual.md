# Grill 门禁操作手册

OpenSpec Grill 门禁的完整操作依据：从判断是否需要访谈，到放行实施。每一步都给出**自动路径**（skill / 脚本）与**人工路径**（检查清单）两条走法。

本文档合并自 lokra 项目的 `grill-checklist.md` 与 `grill-system-usage.md`，并校准到 skill 的实际形态。

---

## 0. 路径约定

本文档中的 `scripts/…`、`docs/…` 指**安装到你项目中的路径**（`install.sh` 会把脚本扁平复制到 `scripts/`，不带子目录）。若你直接在本 skill 仓库内操作，对应文件位于 `scripts/grill/`、`docs/`。

```text
你的项目/                         本 skill 仓库/
├── .claude/                      ├── skills/openspec-grill-policy/
│   ├── grill-policy.yml          │   ├── grill-policy.yml
│   └── templates/                │   └── templates/
├── scripts/                      ├── scripts/grill/
│   ├── grill-check.js            │   ├── grill-check.js
│   └── create-grill.js           │   └── create-grill.js
└── docs/                         └── docs/
    └── grill-gate-manual.md          └── grill-gate-manual.md
```

**推荐路径是 skill**：调用 `/openspec-grill-policy` 即表示需要 Grill，无需判断、无需安装脚本。脚本路径是为需要批量检查或接入 CI 的场景准备的。

---

## 1. 判断是否需要 Grill

### 自动路径（推荐）

```bash
node scripts/grill-check.js check-required <change-name>
```

### 人工路径

| 问题 | 回答 | 结论 |
|------|------|------|
| 风险等级是 L3 吗？ | 是 | **强制 Grill** ✓ |
| 风险等级是 L2 吗？ | 是 | **强制 Grill** ✓ |
| 是 BREAKING 变更吗？ | 是 | **强制 Grill** ✓ |
| 新增独立模块吗？ | 是 | **强制 Grill** ✓ |
| 涉及安全敏感变更吗？ | 是 | **强制 Grill** ✓ |
| 涉及数据迁移吗？ | 是 | **强制 Grill** ✓ |
| 对外 API 变更吗？ | 是 | **强制 Grill** ✓ |
| 协议变更吗？ | 是 | **强制 Grill** ✓ |
| 认证/授权变更吗？ | 是 | **强制 Grill** ✓ |
| 核心数据模型变更吗？ | 是 | **强制 Grill** ✓ |
| **以上全是"否"** | - | 可选 Grill |

### 风险等级参考

| 等级 | 定义 | 示例 | Grill |
|------|------|------|-------|
| L3 | 核心变更 | 认证流程、会话隔离、数据隔离 | 强制 |
| L2 | 跨域变更 | HTTP 契约、跨模块协议、数据库 schema | 强制 |
| L1 | 单模块变更 | 内部重构、工具函数 | 建议 |
| L0 | 文档/配置 | README、配置调整 | 不需要 |

**结论**：
- 需要 Grill → 前往第 2 步
- 不需要 → 走 `/openspec-explore` 直接设计（L1 若含重要假设，仍建议 Grill）

---

## 2. 创建 Grill

### 自动路径（推荐）

```bash
/openspec-grill-policy <change-name>
```

### 脚本路径

```bash
node scripts/create-grill.js <change-name>
```

### 人工路径

```bash
mkdir -p openspec/changes/grill-<change-name>
touch openspec/changes/grill-<change-name>/discussion-log.md
```

创建后按 `templates/grill-discussion-log-template.md` 补全结构。

---

## 3. 访谈过程检查

### 每轮访谈后检查

- [ ] **记录到 `discussion-log.md`**
  - [ ] 记录轮次、日期、子 agent（如有）
  - [ ] 记录用户回答
  - [ ] 记录未决问题

- [ ] **识别假设并标注风险**
  - [ ] 🔴 HIGH 风险假设
  - [ ] 🟡 MEDIUM 风险假设
  - [ ] 🟢 LOW 风险假设

- [ ] **同步术语**
  - [ ] 新术语立即更新 `CONTEXT.md`
  - [ ] 记录 `_Avoid_` 混淆词

- [ ] **考虑 ADR**
  - [ ] 是否满足 ADR 三条件？（难以撤销 / 无上下文会显得反常 / 存在真实权衡）
  - [ ] 如满足 → 创建 `docs/adr/NNNN-<slug>.md`

### 访谈结束前检查

- [ ] 所有关键决策问题（Q1-QN）都有用户回答
- [ ] 所有 🔴 HIGH 风险假设有验证计划
- [ ] 未决问题清空（没有阻塞性遗留）
- [ ] 用户显式确认共识

---

## 4. 补充 Grill 总结

在 `discussion-log.md` 末尾补充以下章节：

```markdown
## Grill总结（YYYY-MM-DD）

### ✓ 已验证的假设
- 假设V1: XXX [证据]

### ✗ 未验证的假设（或 ⚠️ 已识别但未完全解决的问题）
- 假设H1: XXX
  - 风险等级：🔴 HIGH / 🟡 MEDIUM / 🟢 LOW
  - 建议补救：XXX

### 建议行动
1. **立即修复**（阻塞实施）：
2. **发布前修复**（不阻塞开发）：

### Grill门禁决策

**状态**: ✓ 通过 / ⚠️ 附加条件通过 / ✗ 拒绝

**签字**：
- Grill执行人: [名字]
- 日期: YYYY-MM-DD
- 决策: [具体说明]
```

### 完整性自检

- [ ] 包含「Grill总结」标题
- [ ] 包含「✓ 已验证的假设」
- [ ] 包含「✗ 未验证的假设」或「⚠️ 已识别但未完全解决的问题」
- [ ] 包含「建议行动」
- [ ] 包含「Grill门禁决策」
- [ ] 有明确的状态（✓ / ⚠️ / ✗）
- [ ] 有签字和日期

---

## 5. 门禁放行检查

### 自动路径（推荐）

```bash
/openspec-grill-policy validate <change-name>
```

### 脚本路径

```bash
node scripts/grill-check.js validate <change-name>
```

### 人工路径

#### 阻塞性检查（任一不满足则拒绝放行）

- [ ] **`discussion-log.md` 存在**
  - 路径：`openspec/changes/grill-<name>/discussion-log.md`

- [ ] **Grill 总结存在**
  - 包含「## Grill总结」章节

- [ ] **关键问题都有答案**
  - Q1-QN 都有用户确认

- [ ] **HIGH 风险假设都有计划**
  - 所有 🔴 HIGH 假设有验证方法
  - 或标注为"接受风险"并说明理由

- [ ] **门禁决策明确**
  - 状态不是 ✗ 拒绝
  - 如果是 ⚠️ 附加条件，列出了具体条件

#### 建议性检查（不阻塞但强烈推荐）

- [ ] **`CONTEXT.md` 已更新** —— 检查是否有新术语未同步
- [ ] **ADR 已创建**（如适用）—— 重大决策有对应 ADR 文件
- [ ] **MEDIUM 风险假设有计划** —— 🟡 假设有验证方法或接受理由

---

## 6. 放行决策

### ✓ 通过 → 可以实施

**条件**：所有阻塞性检查通过 / 无 HIGH 风险假设未验证 / 门禁决策为「✓ 通过」

**下一步**：
```bash
openspec propose <change-name>
```

---

### ⚠️ 附加条件通过 → 修复后放行

**条件**：阻塞性检查基本通过 / 有明确的待修复问题清单 / 门禁决策为「⚠️ 附加条件通过」

**下一步**：
1. 修复「立即修复」清单中的问题
2. 在 `design.md` 补充「发布前修复」项的默认值
3. 更新 `discussion-log.md` 记录修复状态
4. 重新执行第 5 步检查
5. 放行

---

### ✗ 拒绝 → 回到 explore

**条件**：关键问题未回答 / HIGH 风险假设无验证计划 / 门禁决策为「✗ 拒绝」

**下一步**：
1. 回到 `/openspec-explore`
2. 修改 `design.md`
3. 重新进入 Grill，从第 2 步重新开始

---

## 7. 角色与时机

### 谁来检查？

| 角色 | 职责 |
|------|------|
| 变更发起人 | 判断是否需要 Grill（第 1 步） |
| Grill 执行人 | 访谈过程检查（第 3、4 步） |
| 技术评审人 | 门禁放行检查（第 5、6 步） |

### 何时检查？

| 阶段 | 检查点 |
|------|--------|
| Explore 结束 | 判断是否需要 Grill |
| Grill 每轮 | 记录和假设识别 |
| Grill 结束 | 补充总结 |
| Propose 前 | 门禁放行检查 |

---

## 8. 度量与改进

### 月度审查指标

```bash
node scripts/grill-check.js health-report
```

或 `/openspec-grill-policy report`。

| 指标 | 目标 | 说明 |
|------|------|------|
| Grill 完成率 | >= 80% | L2/L3 变更的 Grill 覆盖率 |
| HIGH 风险假设验证 | 100% | 🔴 假设必须有验证计划 |
| `CONTEXT.md` 更新率 | >= 90% | 新术语同步比例 |
| ADR 创建率 | >= 70% | 重大决策记录比例 |

### 团队反馈收集

每月收集：流程是否繁琐 / 模板是否需调整 / 脚本是否有误报。据此调整 `grill-policy.yml`（编辑项目根目录同名文件，脚本每次运行重新加载，无需重启任何东西）。

---

## 附：实战案例

### 案例1: grill-agent-streaming-replies（不及格）

**问题**：
- ✗ 只有 1 轮访谈，Q1-Q3 未回答
- ✗ 无 Grill 总结
- ✗ 5 个 HIGH 风险假设未验证

**结果**：事后补充 Grill 总结，识别遗漏风险

**教训**：不要跳过 Grill 流程。访谈中若用户已授权实施，事后必须补「⚠️ 事后 Grill」：识别遗漏假设 → 标注风险等级 → 补充验证计划 → 记录。

---

### 案例2: grill-business-operations-agent（优秀）

**亮点**：
- ✓ 9 轮完整访谈
- ✓ 所有问题都有用户确认
- ✓ 产出 ADR-0003
- ✓ 术语同步到 `CONTEXT.md`
- ✓ 完整的 Grill 总结

**结果**：⚠️ 附加条件通过（补充 P3 后放行）

**学习**：标杆级 Grill 案例。

---

## 相关文档

- [2 分钟快速开始](./grill-quickstart.md)
- [工作流选择指南](./openspec-workflow-guide.md)
- [脚本说明与 CI 集成](../scripts/grill/README.md)
- [skill 完整说明](../skills/openspec-grill-policy/SKILL.md)

---

最后更新：2026-09-24
维护者：agent-skills 团队
