# 云舟 Workflow：步骤与逻辑伪代码

本文解释 [执行脚本](devops-automation-loop-yunzhou.workflow.js) 的**当前实际行为**，不是另一套待实施方案。判定规则直接内置于阶段提示词，确定性校验由脚本执行，不依赖额外编排 skill；本文按代码 A–E 分区阅读，仅供维护与核对。

## 1. 总体结构

```text
A 定义与执行包装
          |
B 参数校验 -> Fetch：确认任务与仓库
          |
C Route：读取已有共识、事实、产物、风险、批准
          |
          +-- explore ----------> 定向调查 --------> 回 Route
          +-- grill ------------> 输出问题 --------> 暂停等用户
          +-- propose / update -> 生成/更新产物 ---> 回 Route
          +-- 非实施意图 -------> 本次规划/讨论收口
          +-- 产物缺失 ---------> 阻塞
          +-- gate / 未批准 ----> 评审或等待批准 --> 回 Route 或暂停
          |
          v
       GateCheck：独立检查批准、裁决和输入版本
          |
D Apply（按需恢复） -> Quality -> Verify
          |                         |
          +-- 未完成/偏离/失败 ------+--> 返回主控处理
                                    |
E 显式 autoCommit=true ? 本地提交 : 保留未提交
          |
       返回分项状态；不推送、不发 PR、不回写、不归档
```

图中 Route 的分支不是全部必跑。代码中的 `return` 结束本次调用；`continue` 表示本次调用内重新路由。

## 2. 输入与输出

| 输入 | 作用与默认值 |
|---|---|
| `taskId` | 必填，正的安全整数；不自动领取其他任务 |
| `codeRepo` | 指定代码仓库；缺省由 Fetch 根据项目配置核实 |
| `intent` | `discuss` / `investigate` / `plan` / `implement`，默认 `plan` |
| `autoCommit` | 仅严格等于 `true` 时允许本地提交，默认不提交 |
| `skipAnalysis` | 不跳过路由、风险、产物或批准检查 |
| 其他项目参数 | 原样传入 Agent，供任务、配置与仓库匹配使用 |

| 结果 | 含义 |
|---|---|
| `completed` | 本次授权范围内已完成；规划完成不代表代码完成 |
| `needs_decision` | 等待用户决策，不模拟答案 |
| `needs_investigation` | 当前阶段发现需要进一步查证的事实 |
| `blocked` | 前置条件不满足、结果无效、验证未通过或无进展 |
| `failed` | 阶段调用抛出异常 |

`history` 是本次调用内的阶段返回记录，不是持久化断点数据库；提交状态与验证状态分别返回。

## 3. 公共调用包装（A）

```text
FUNCTION RUN(阶段, 指令):
    通知宿主展示阶段
    给 Agent 注入内置结果契约、本次输入、已有 history、权限边界
    尝试调用 Agent
    IF 调用抛错:
        RETURN failed

    解析对象或 JSON 文本
    IF 状态未知 OR evidence/blockers 类型不合法:
        RETURN blocked
    IF status=completed AND (evidence 为空 OR blockers 非空):
        RETURN blocked

    将校验后的返回加入 history
    RETURN 校验结果
```

正常返回文本不等于通过；`evidence` 的非空检查是结构检查，不证明其内容真实。内容查证依赖阶段 Agent 与独立复核，仍需 CI 和人工把关。

## 4. 前置检查（B）

```text
IF taskId 非正安全整数 OR intent 非法:
    RETURN blocked

fetched = RUN(Fetch, 只读获取指定任务并确认项目、仓库)
IF fetched 未完成 OR 返回任务 ID 不匹配 OR 仓库不是绝对路径:
    RETURN blocked

进入 Route
```

脚本检查任务 ID 和绝对路径形态；仓库确实存在、项目确实匹配由 Fetch 查证并提供依据。

## 5. 路由与门禁（C）

以下顺序与代码一致，尤其注意：**grill 在讨论意图收口之前处理；规划意图在实施门禁之前收口。**

```text
最多执行 6 轮:
    routing = RUN(Route, 读取实际产物并选择下一步)
    IF routing 未完成:
        RETURN routing
    IF action/gateLevel 非法 OR fingerprint 为空:
        RETURN blocked
    IF action + fingerprint 与紧邻上一轮相同:
        RETURN blocked（无进展）

    IF action=grill:
        questions = RUN(Grill, 当前 frontier 问题和推荐)
        IF questions.status=completed:
            改为 needs_decision
        RETURN questions

    IF intent 是 discuss/investigate AND action != explore:
        RETURN completed（讨论/调查范围收口）

    IF action 属于 explore/propose/update:
        result = RUN(Explore 或 Plan, 调用对应 skill)
        IF result 未完成:
            RETURN result
        CONTINUE

    IF intent != implement:
        RETURN completed（规划完成，待实施授权）
    IF artifactsReady != true OR changeRoot 非绝对路径:
        RETURN blocked

    IF action=gate OR approvalValid != true:
        gate = RUN(Gate, 检查/执行评审，必要时等待人工)
        IF gate 未完成:
            RETURN gate
        CONTINUE

    checked = RUN(GateCheck, 独立读取实际门禁和输入版本)
    IF L0:
        批准有效 = verdict=EXEMPT AND exemptionValid=true
    ELSE:
        批准有效 = verdict=READY_FOR_HUMAN_APPROVAL AND humanApproved=true

    IF checked 未完成 OR 批准无效 OR blockerCount != 0
       OR conditionsMapped != true OR inputsCurrent != true:
        RETURN blocked

    plannedAction = action
    IF action 是 verify/done:
        plannedAction = quality（恢复也重查完整 diff）
    BREAK

IF 未选出 plannedAction:
    RETURN blocked（轮次耗尽）
```

GateCheck 与 Route 是不同调用，但仍由 Agent 检查版本与签字；不是脚本自行计算文件哈希或验证签字身份。无进展检测只比较相邻状态，多状态循环由六轮上限兜底。

## 6. 实施与验证（D）

```text
WHILE plannedAction != done:
    result = RUN(plannedAction 对应阶段和 skill)
    IF result 未完成:
        RETURN result

    IF plannedAction=apply:
        checked = RUN(Route, 独立核对任务完成且批准未失效)
        IF checked 未完成 OR tasksComplete != true OR approvalValid != true:
            RETURN blocked

    IF plannedAction=verify:
        REQUIRE criticalCount=0
        REQUIRE testsPassed=true
        REQUIRE testsEvidence 是非空的非空字符串数组
        任一不满足 -> RETURN blocked
        verified = true

    plannedAction = NEXT[plannedAction]
    # apply -> quality -> verify -> done
```

实施发现关键偏离时，当前调用返回 `needs_decision` 或 `needs_investigation`，**不会在这个循环里自动跳回 grill/explore**。用户或主控处理后重新运行，由 Route 根据实际产物恢复。

## 7. 提交与收口（E）

```text
IF verified != true:
    RETURN blocked

commit.status = not_authorized
IF autoCommit 严格等于 true:
    commit = RUN(Commit, 仅授权本地提交已确认的本次文件)
    IF commit 未完成 OR commitSha 不满足格式检查:
        RETURN blocked

RETURN completed:
    changeId、codeRepo、verified、commit、history
    外部操作未执行说明
```

提交 Agent 负责核对实际 commit；脚本对 SHA 做格式检查，格式正确不等于仓库证据已被独立校验。推送、PR、评论、归档、关闭任务均不在本次自动执行范围内。

## 8. 如何定位修改点

| 要理解或调整的内容 | 阅读位置 |
|---|---|
| 哪种未知交给哪个技能 | C1–C4 的内置路由指令 |
| 人工等待、批准失效 | C2、C5–C6 |
| 重跑是否覆盖旧产物 | C1 的 Route 指令与 A 的暂停交接规则 |
| 代码实施后如何推进 | D 与 `NEXT` |
| 结果为什么被阻塞 | A 的 `decode` + 阶段专用检查 |
| 何时允许提交 | E 与 `allowCommit` |

离线控制流测试：`npm run test:orchestration`。测试不调用真实云舟、模型、Git 或 workflow 宿主。
