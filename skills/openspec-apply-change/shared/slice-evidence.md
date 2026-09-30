# 切片新鲜证据规则（唯一事实源）

> 每个垂直切片在勾选完成前必须留下的、绑定当前实现版本的验证证据：模板、生成时机、新鲜度判定与豁免格式。
> 本文件**住在它的内容领域**（证据在 apply 阶段产生，规则随 skill 走）。`skills/openspec-apply-change/SKILL.md` 用 skill 内相对路径 `shared/slice-evidence.md` 引用本文件，`claude/commands/opsx/apply.md` 以 skill 名定位引用；其他 skill 跨 skill 引用 `../openspec-apply-change/shared/slice-evidence.md`；Glob 兜底搜 `**/openspec-apply-change/shared/slice-evidence.md`。
> 确定性校验脚本（下文 `<GATE>`）= `../openspec-technical-review/scripts/implementation-gate.mjs`（相对本 skill 目录解析；解析不到时 Glob 搜 `**/openspec-technical-review/scripts/implementation-gate.mjs`），运行需 Node.js ≥ 16。

## 为什么需要

`tasks.md` 的 checkbox 只能说明「任务被标记完成」，说明不了「这个切片在**当前这版代码**上验证通过过」。代码在勾选之后还会被后续切片、评审修复改动，旧的测试结果可能已不再代表当前实现。证据把「跑了什么命令、结果如何、覆盖了哪些行为」与实现指纹绑定，Verify 才能判断它是否仍然有效。

## 适用范围

| 情况 | 要求 |
|------|------|
| tasks.md 按切片组织且切片声明了 `Evidence:` 引用（`/opsx:propose` 按新规则生成） | **启用**：每个切片一份 `evidence/slice-<id>.md`，缺一不可 |
| tasks.md 为平铺清单、没有 `## Slice` 切片（L0 / 小型 L1） | 不强制创建空的 `evidence/` 目录；Verify 必须写明「不适用：无垂直切片」 |
| 历史变更：有切片但没有任何 `Evidence:` 引用 | **不追溯**；Verify 必须写明「不适用：未启用切片证据的历史变更」 |

「不适用」必须由 Verify 明文写出理由，**不得把缺证据静默当作通过**。

## tasks.md 的 Evidence 引用

`Evidence:` 行与 `Blocked by:` / `Seam:` 同处切片标题区，**写在 checkbox 之外**，checkbox 行格式保持 `- [ ]` / `- [x]` 不变（切片格式规则见 `../openspec-propose/shared/task-slicing.md`）：

```markdown
## Slice 01: 用户可以创建订单（端到端）
Blocked by: 无（可立即开始）
Seam: POST /orders（HTTP API，见 design.md「测试 Seam 决策」）
Evidence: evidence/slice-01.md

- [ ] 1.1 订单表 schema 与迁移脚本
- [ ] 1.2 POST /orders 接口实现与集成测试
```

路径相对 `changeRoot`，固定为 `evidence/slice-<id>.md`，`<id>` 取切片标题 `## Slice <id>:` 中的编号。

## 证据模板

```markdown
# Slice 01 新鲜证据

- Slice: 01
- Behavior: 用户可以创建订单（端到端）
- Seam: POST /orders
- Recorded At: 2026-09-30T10:00:00Z
- Fingerprint: git-tree:<sha>
- Fingerprint Source: node <GATE> fingerprint <changeRoot>
- Result: PASS

## 变更文件
- src/main/java/com/example/order/OrderController.java
- src/test/java/com/example/order/OrderApiTest.java

## 验证命令
| 命令 | 结果 | 摘要 |
|------|------|------|
| `mvn -q test -Dtest=OrderApiTest` | PASS | 6 tests, 0 failures |
| `mvn -q compile` | PASS | 编译通过 |

## 覆盖的验收行为
- Scenario: 创建订单成功 → OrderApiTest.createsOrder

## 剩余风险
- 无

## 豁免记录
| From Fingerprint | To Fingerprint | 变化文件 | 不影响本切片行为的理由 | 判定人 | 日期 |
|------------------|----------------|---------|--------------------|-------|------|
```

| 字段 | 要求 |
|------|------|
| `Slice` | 与切片编号一致 |
| `Behavior` | 切片交付的用户行为（通常取切片标题） |
| `Seam` | 验证所走的公共边界，须与切片 `Seam:` 行声明一致 |
| `Recorded At` | 记录时间（ISO 8601） |
| `Fingerprint` | 验证命令全部跑完、不再改代码时运行 `node <GATE> fingerprint <changeRoot>` 的输出，原样粘贴 |
| `Fingerprint Source` | 生成指纹的命令，说明指纹口径 |
| `Result` | `PASS` / `FAIL`；只有「验证命令」全部 `PASS` 才能写 `PASS` |
| 变更文件 | 本切片改动的文件，至少一项 |
| 验证命令 | **实际执行**的命令与真实结果，至少一行；摘要写关键数字，不贴完整日志（大日志引用构建产物） |
| 覆盖的验收行为 | 对应的 spec Scenario 或切片行为，写到测试名，至少一项 |
| 剩余风险 | 已知未覆盖或延期的风险；没有写「无」 |
| 豁免记录 | 只由 Verify 按下文「豁免记录格式」追加，Apply 阶段保留空表头 |

## 生成时机（Apply）

在 `tdd-discipline.md` 的「反馈节奏」之上，**每个任务项勾选前**按顺序执行：

1. 按 TDD 纪律完成该任务项（一个失败测试 → 最小实现）；
2. 运行该任务相关的单个测试文件 + 类型检查 / 编译等价的静态检查；
3. 运行 `node <GATE> fingerprint <changeRoot>` 取当前指纹；
4. 创建或更新该切片证据：追加命令与结果，刷新 `Fingerprint` / `Recorded At` / 变更文件 / 覆盖的验收行为；
5. 证据 `Result: PASS` 后，**才**勾选该任务项。

- **切片最后一个任务项勾选前**，证据必须覆盖该切片的全部验收行为。
- **全部切片完成、跑完整测试套件时**，同步刷新各切片证据的指纹（重跑各切片命令，或把确实覆盖该切片测试的完整套件命令记为该切片的验证命令）—— 否则先完成的切片会因后续切片的改动被判过期。
- 测试 / 编译命令按**项目自身约定**选择（`design.md`「测试 Seam 决策」、项目 README / `CLAUDE.md` / CI 配置），本规则不规定命令，只要求记录实际执行的命令与真实结果。**未运行不能写 `PASS`**；项目确实没有的检查（如无类型检查）在摘要写明原因与替代验证。

## 新鲜度判定（Verify）

| 情况 | 判定 |
|------|------|
| 证据 `Fingerprint` 与当前实现指纹一致 | 新鲜 |
| 不一致，但存在从证据指纹连到当前指纹的有效豁免链 | 新鲜（经豁免） |
| 不一致，且变化可能影响该切片行为 | **过期**：重跑该切片验证并更新证据 |
| 不一致，且无法判断变化是否影响该切片 | **过期**（同上） |

证据缺失、字段不完整、`Result: FAIL` 或过期的已完成切片，Verify 一律记 **CRITICAL**，不得归档。

## 豁免记录格式（行为无关变更）

只有当两个指纹之间的变化**全部**不影响本切片行为时（纯文案、注释、文档，或与本切片无依赖关系的其他文件），Verify 才可在该切片证据的「豁免记录」表追加一行，而不重跑验证：

| 列 | 要求 |
|----|------|
| `From Fingerprint` | 上一个被认可的指纹（首行即证据的 `Fingerprint`） |
| `To Fingerprint` | 新的实现指纹 |
| `变化文件` | 两个指纹之间**实际变化的全部文件**（`<GATE> evidence` 输出的 `changedSinceEvidence`）；漏列一个即整行无效 |
| `不影响本切片行为的理由` | 逐项说明为什么不影响本切片行为 |
| `判定人` | 做出判定的人或 agent（如 `/opsx:verify（agent）`）；影响核心切片时建议人工复核 |
| `日期` | 判定日期 |

- 多次变化可串成链（A→B、B→C），链能从证据指纹连到当前指纹时有效。
- **无法证明不影响本切片行为时不得登记**，按过期重跑。豁免只是省一次重跑，不是绕过验证的通道。
- 校验脚本用 `git diff-tree` 核对「变化文件」是否列全；两个指纹的对象已被 git gc 回收、无法核对时，豁免按无效处理。

## 命令级校验

```bash
node <GATE> evidence <changeRoot>
```

输出 JSON：`applicable` / `reason`（不适用时的理由，Verify 原样写进报告）、`currentFingerprint`、每个切片的 `status`（`fresh` / `exempted` / `stale` / `missing` / `incomplete` / `failed` / `pending` / `no-reference`）、`changedSinceEvidence`、`issues`（CRITICAL）与 `warnings`。退出码 `0` 通过；`1` 存在 CRITICAL；`2` 参数或环境错误。

- `pending`：切片尚无已勾选任务，暂不要求证据。
- 切片部分勾选时，缺证据文件仍记 CRITICAL（勾选先于证据）；字段、结果或新鲜度问题只记 warning，待切片全部勾选后升级为 CRITICAL。

## 产物的 git 归属与边界

`evidence/*.md` 提交 git，随 `openspec archive` 整体进 `changes/archive/<name>/`，不进 `specs/`；证据是一次变更的临时验证记录，**不升级为跨变更的长期领域事实**。记录证据不执行 push、PR、部署或任何外部任务回写。
