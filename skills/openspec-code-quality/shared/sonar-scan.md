# Sonar 扫描（唯一事实源）

> `/opsx:quality`（skill `openspec-code-quality`）在双轴评审之后执行的 Sonar 扫描：何时适用、怎样扫描、只处理哪些问题、结果的记录格式，以及 Standards 因此不评的检查项。
> `SKILL.md` 用 skill 内相对路径 `shared/sonar-scan.md` 引用本文件，`roles/standards.md` 用 `<SKILL_DIR>/shared/sonar-scan.md`；其他 skill 跨 skill 引用 `../openspec-code-quality/shared/sonar-scan.md`；读不到时 Glob 搜 `**/openspec-code-quality/shared/sonar-scan.md`。
> `<GATE>` = `../../openspec-technical-review/scripts/implementation-gate.mjs`（相对本文件解析）。

## 何时适用

下列三项全部满足时，Sonar 状态为 `已配置`：

1. 项目配置了 Sonar：仓库根目录有 `sonar-project.properties`，或构建文件（`pom.xml`、`build.gradle`、`build.gradle.kts`）声明了 `sonar.projectKey`；
2. 环境变量 `SONAR_HOST_URL` 与 `SONAR_TOKEN` 已设置；
3. `curl -sf "$SONAR_HOST_URL/api/system/status"` 返回的 `status` 为 `UP`。

不满足时，Sonar 状态为 `不适用：<原因>`：Standards 照常评全部检查项，不执行扫描。

`/opsx:quality` 在生成基线之前判定一次，把结果写入 Standards 子 agent 的 prompt；同一轮的 Step 5 使用同一个判定。

## Standards 跳过的检查项

Sonar 状态为 `已配置` 时，Standards（`roles/standards.md`）不评下列检查项，由 Sonar 扫描：

| Standards 检查项（`roles/standards.md`「审查清单」） | Sonar 对应 |
|---|---|
| 1. 重复与复用：本次修改内部的复制粘贴 | 重复代码检测 |
| 4. 复杂度热点：圈复杂度或认知复杂度过高的方法 | 认知复杂度规则 |
| 3. 死代码与未使用：未使用的私有方法、私有字段、局部变量与导入；被注释掉的代码块 | 未使用代码与注释代码规则 |
| 2. 可读性（异常处理）：空 catch 块 | 空代码块规则 |

- 列表按 SonarQube 内置质量配置 Sonar way 默认启用的规则确定。项目的质量配置关闭了其中的规则时，主 agent 在 Standards 的 prompt 中写明这些项不跳过。
- 其他检查项 Standards 照常评，例如应复用而未复用、同一逻辑多层重复实现、命名是否表意、魔法值、嵌套深度、注释、吞掉异常后把失败记为成功（Blocker 判据 B5）、新增公开方法没有调用方、测试可维护性与项目约定。这些项要读仓库中的其他代码或理解业务含义，或者 Sonar way 默认不启用对应规则。

## 扫描

1. 扫描前运行 `node <GATE> fingerprint <changeRoot>`，取当前实现指纹。扫描期间不改代码。
2. 运行项目约定的 SonarScanner：`sonar-scanner` 命令行，或构建工具插件（`mvn sonar:sonar`、`gradle sonar`）。Java 项目先编译；质量门有新代码覆盖率条件时，先运行带覆盖率的测试。
3. 必须带分支或 PR 参数，结果不能写入主分支的分析：
   - PR 分析：`sonar.pullRequest.key`、`sonar.pullRequest.branch`、`sonar.pullRequest.base`；
   - 分支分析：`sonar.branch.name=<当前分支>`。

   服务器不支持分支分析、扫描报错时，结果为 `无法运行`，不得删除参数后重扫。
4. 加 `-Dsonar.qualitygate.wait=true`，扫描等待质量门结果。
5. token 只从环境变量 `SONAR_TOKEN` 读取。命令中需要写 token 时写 `$SONAR_TOKEN`，记录命令时保留变量名。不得把 token 写入文件、日志或回复。

## 只处理本次修改的行

本次修改的行：评审基线的 `Base Commit` 到当前工作区之间，`git diff -U0 <Base Commit> -- <文件>` 中新增或修改的行；新增文件（包含未跟踪文件）的全部行。这个范围不依赖服务器的新代码定义，在各版本 SonarQube 上结果相同。

1. 用 Web API `api/issues/search` 读取本次修改文件中未解决的问题：`components=<projectKey>:<文件路径>`、`resolved=false`，分支分析加 `branch`，PR 分析加 `pullRequest`。请求写成 `curl -sf -u "$SONAR_TOKEN:" ...`。
2. 只保留位置在本次修改行上的问题，写入 `review/sonar.md`「本次修改行上的问题」。其他问题不修改，也不列出。
3. 用 `api/qualitygates/project_status`（带同样的 `branch` 或 `pullRequest`）读取质量门结果，状态为 `ERROR` 的条件逐条写入「质量门」表。

## 处理

问题与质量门条件的「处理」取下列一项：

| 处理 | 做法 | 谁决定 |
|---|---|---|
| 修复 | 主 agent 在 `tasks.md` 新增修复任务，写出规则与位置（同一文件的问题可以合并为一项），按 apply 规则修改、写证据、勾选，再重跑 `/opsx:quality` | agent |
| 误报 | 用户在 SonarQube 中标记误报，在「说明」写理由 | 用户 |
| 接受 | 用户确认不修改，在「说明」写理由 | 用户 |

- 「决策人」只能由用户填写，agent 不得代填，规则与签字行相同。处理为「修复」的行不写决策人。
- 不得为了通过扫描增加 `NOSONAR` 注释或抑制注解。确实需要时，按 `../../openspec-apply-change/shared/post-implementation-changes.md` 登记为 `等价` 修改，并经用户确认。
- 修复后重跑 `/opsx:quality`：增量评审与重新扫描在同一轮完成。修复后的问题不再出现在新的扫描结果中。
- agent 不调用 SonarQube 的写入接口（标记误报、修改问题状态），这些由用户操作。

## 记录：`review/sonar.md`

```markdown
# Sonar 扫描记录：<change-name>

- Fingerprint: git-tree:<扫描时的实现指纹>
- Base Commit: <评审基线的 Base Commit>
- Scanner: <实际执行的命令，token 写成 $SONAR_TOKEN>
- Analysis: <分支名或 PR 编号；SonarQube 页面链接>
- Quality Gate: PASSED / FAILED / 无法运行：<原因>

## 质量门
| 条件 | 实际值 | 阈值 | 处理 | 说明 | 决策人 |
|---|---|---|---|---|---|

## 本次修改行上的问题
| 规则 | 严重级别 | 位置 | 处理 | 说明 | 决策人 |
|---|---|---|---|---|---|
```

- 「质量门」表只写状态为 `ERROR` 的条件；「位置」写 `文件:行号`。表中没有行时，在表下写「无」。
- 每次扫描原地覆盖，不生成 `-roundN` 副本。
- Sonar 状态为 `不适用` 时不创建本文件。

## Verify 核对

verify 第 5 步（`openspec-verify-change`）读取 `review/sonar.md`：

| 情况 | 记录 |
|---|---|
| Sonar 不适用（「何时适用」第 1 项不成立） | 报告写「Sonar：不适用（<原因>）」，不记问题 |
| 项目配置了 Sonar，但没有 `review/sonar.md` | WARNING：没有运行 Sonar 扫描，Standards 跳过的检查项可能没有被检查 |
| `Quality Gate: 无法运行` | WARNING，写出原因 |
| 「本次修改行上的问题」或「质量门」中，处理不是「误报」「接受」的行 | CRITICAL，每行一条：问题还在当前扫描结果中 |
| 处理为「误报」「接受」，但「说明」或「决策人」为空的行 | CRITICAL，每行一条 |
| `Fingerprint` 与当前实现不一致，并且 `classify --from <Fingerprint>` 的 `other` 不为空 | WARNING：扫描之后代码有变化，重跑 `/opsx:quality` |

报告只在 Summary 写一行 Sonar 结论，不重复列出问题。

## 产物的 git 归属

`review/sonar.md` 随变更归档，不进 `specs/`。扫描不执行 `git add` 或 `git commit`。项目 `.gitignore` 忽略 `openspec/` 时，不得用 `git add -f` 加入产物。
