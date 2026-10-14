# ADR-0001: Grill 门禁的 skill 职责划分与文档单一事实源

- 状态：已接受
- 日期：2026-09-24
- 决策者：agent-skills 团队

## 背景

Grill 门禁系统原先在 lokra 项目内实现，包含三份文档（`grill-checklist.md`、`grill-system-usage.md`、`grill-integration-plan.md`）与一组脚本。整合为跨项目可复用的 agent skill 时暴露出三类问题：

1. **职责边界模糊**：`openspec-grill`（访谈执行）与 `openspec-grill-policy`（门禁规则与工具）功能重叠，使用者不清楚该调哪个。
2. **文档失去可执行性**：三份文档互相引用不存在的文件，命令名与实际脚本不符，且 checklist 内部整段自我重复（两版判定表并存）。
3. **安装流程静默失败**：`install.sh` 用绝对路径引用 lokra 的 docs 目录、`grill-check.js` 用 `__dirname/../.claude/` 定位配置（脚本在 `scripts/grill/` 下必然解析错误），两者在非原作者机器上都失效，且失败时不报错。

## 决策

**1. 两个 skill 的职责按"执行 vs 规则"切分，单向依赖**

```text
openspec-grill（访谈执行）
  ↓ 读取
openspec-grill-policy（规则 + 模板 + 检查工具）
```

- `openspec-grill`：分轮访谈、消除隐含假设、沉淀术语与 ADR，产出 `discussion-log.md`。
- `openspec-grill-policy`：定义门禁规则、提供模板、提供自动化检查，产出配置与检查报告。
- 两者不互相调用，policy 不执行访谈，grill 不内置规则。

**2. agent-skills 是唯一事实源，lokra 不再保留副本**

```text
agent-skills/                          lokra/
├── skills/openspec-grill-policy/       └── 仅保留 lokra 特有的变更与 openspec 数据
├── scripts/grill/
└── docs/grill-{gate-manual,quickstart}.md
```

lokra 的 `grill-{checklist,system-usage,integration-plan}.md` 已删除，内容合并进 `docs/grill-gate-manual.md`（操作手册）与 `scripts/grill/README.md`（工具维护者内容）。lokra 作为原型与测试场，改进通过回灌 agent-skills 生效，不再维护第二份文档。

**3. 安装源只允许从脚本自身位置推导，禁止跨仓绝对路径**

`install.sh` 全部从 `REPO_ROOT` 定位源文件；`grill-check.js` 按「使用者项目 `.claude/` → 仓库内 skill 目录」顺序探测配置。任一源文件缺失必须明确报错，不得静默跳过。

**4. 文档分层：手册面向执行人，README 面向工具维护者**

- `docs/grill-gate-manual.md`：判断 → 创建 → 访谈 → 总结 → 放行检查 → 放行决策。读者是某次变更的执行人。
- `scripts/grill/README.md`：脚本用法、CI / Git Hook 接入、依赖、团队推进节奏。读者是给仓库装门禁的维护者。
- `docs/grill-quickstart.md`：2 分钟上手与常见问答。读者是首次使用者。

## 后果

**正面**

- 规则改动只改一处，跨项目分发不再依赖原始机器路径。
- 执行人拿到单一入口，流程步骤编号连续，人工路径与自动路径并列，不再需要在多份文档间比对"哪个才是最新"。

**代价**

- lokra 侧失去本地文档副本，贡献者需跳转 agent-skills 才能查手册。
- `install.sh` 的文档复制清单与 `docs/` 实际内容解耦，新增文档时需同步更新 `copy_doc` 调用。
- 两 skill 的单向依赖要求使用者理解"policy 是规则、grill 是执行"，新成员有学习成本。

## 备选方案

- **保留 lokra 副本 + 定期同步**：否决。已经发生过副本漂移，且是本次问题的直接成因。
- **三份文档合一（含整合过程稿）**：否决。`grill-integration-plan.md` 是一次性执行记录，其"已完成 / 待办"语气会污染流程文档。
- **为旧脚本名做兼容层（symlink / 转发）**：否决。`check-grill-required.js`、`validate-grill.js`、`grill-health-report.js` 从未真实存在，为其做兼容等于把错误固化为契约。

## 相关

- `../../skills/openspec-grill-policy/SKILL.md`
- `docs/grill-gate-manual.md`
- `scripts/grill/README.md`
