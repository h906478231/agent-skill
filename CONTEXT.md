# OpenSpec 工作流 Skills

本仓库为 coding agent 提供 OpenSpec 变更工作流（explore → grill → propose → review → apply → quality → verify → archive）的 skill 资产。

## Language

**Change Model（变更模型）**:
design.md 中 `change-model` 代码块，用结构化数据描述本次变更涉及的状态、迁移与流程步骤及其变动标记（新增 / 修改 / 删除）；是状态图、流程图、交互式 HTML 与视频场景数据的唯一事实源。
_Avoid_: 状态模型、图模型、可视化数据

**Union Layout（并集布局）**:
对变更前与变更后两张图的并集只做一次布局，使前后与对比视图共用同一套坐标（见 ADR-0004）。
_Avoid_: 合并布局、统一布局

**Explainer Video（讲解视频）**:
按人工要求为复杂变更生成的配音加中文字幕视频，聚焦单一主题，由人工确认的分镜驱动渲染；不进入默认流程，视频与音频不进 git。
_Avoid_: 解释视频、说明视频

**Storyboard（分镜）**:
讲解视频的结构化脚本 `storyboard.md`：按段落列出旁白与镜头动作，镜头动作只引用变更模型中的元素 ID；人工签署确认后才能渲染。
_Avoid_: 剧本、视频脚本、台本

**STE Rules（STE 规则）**:
以 ASD-STE100 为骨架、逐条改写为中文并保留原规则编号的写作规则；CONTEXT.md 作为其技术名词（R1.5）与技术动词（R1.12）扩展。约束产物与对话回复。
_Avoid_: 受控语言规则、写作规范、中文 STE

**Approved Vocabulary（通用受控词表）**:
按 STE 原则（一词一义、单一词性）自行编写的中文通用词对照表，列出非受控词与其受控替代词；随 skill 内置，项目可在 `openspec/ste.yaml` 增删。不是 ASD 官方词典（见 ADR-0005）。
_Avoid_: 受控词典、白名单、STE 词典

**Eval Case（评测用例）**:
验证工作流行为的一组固定输入与预期：需求原文、起始阶段、阶段快照与预期结果。
_Avoid_: 品味用例、评测样例

**Stage Snapshot（阶段快照）**:
评测用例从某一阶段开始运行时预置的变更目录与代码库状态。与 explore 的「检查点」（检查清单）无关。
_Avoid_: 存档点、阶段存档

**Eval Run（评测运行）**:
一个评测用例在一个 skill 版本上的一次执行，产出运行轨迹、产物快照与断言结果。
_Avoid_: 品味测试、评测跑次

**Approved Result（认可结果）**:
经人工认可、用于后续对比的评测结果汇总，只保存在本地，不进 git。与评审基线、基线失败清单无关。
_Avoid_: 评测基准、基准结果

**Stage Handoff Check（阶段交接检查）**:
按 `phases.md` 阶段表的输入与产出，检查各分支能否走到 archive 的确定性测试，不运行 agent。
_Avoid_: 链路完整性测试、链路检查

**Trace Summary（轨迹摘要）**:
从一次评测运行的 `trace.jsonl` 归类出的工具调用汇总，按 6 类归类，按子 agent 分组，写入 `trace-summary.json`。
_Avoid_: 调用清单、轨迹日志

**Read Hit（读取命中）**:
一个修改过的规则文件，在路由选中的评测用例的已完成 WORKTREE 评测运行中被读取的次数，写成 `<命中数>/<总数>`；为 0 时告警，不改变退出码。
_Avoid_: 改动命中、读取覆盖

**Test Run Record（测试运行记录）**:
一键测试每次运行后写入 `<评测数据目录>/reports/<时间>/`（默认 `evals/reports/`）的一组文件，入口为 `report.md`；`node evals/report.mjs --run` 为已有的结果目录写入同样的一组文件。与评测运行的结果目录无关。
_Avoid_: 测试报告、测试日志

**Post-implementation Change Ledger（实现后修改登记）**:
tasks.md 中 `## 实现后修改登记` 表：逐行记录不在未勾选任务内进行的代码修改及其修改档位；不含勾选项，不改变任务进度。与评审报告的 Finding 台账无关。
_Avoid_: 修改台账、事后登记、补登记

**Change Class（修改档位）**:
实现后修改按性质分成的四档：`非行为`（`classify` 判定只有注释差异）、`仅测试`（只改测试路径下的文件，由脚本按路径判定，见 ADR-0010）、`等价`（不改输入、输出、数据写入、外部调用与异常路径）、`行为`（其他全部情况）；决定该修改的最少动作。与 overview.md 的变更分级（L0–L3）无关。
_Avoid_: 修改等级、修改分级、风险档位

**Change Head（变更终点）**:
tasks.md 中 `## 变更终点` 区块写出的提交：本变更实现的最后一个提交，只能由用户写。声明后评审范围为 `Base Commit..变更终点`，`classify` 不传 `--to` 时与它的指纹比较，终点之后其他变更的修改不要求登记；切片证据仍与当前实现比较（见 ADR-0008）。与评审基线的 `Base Commit`（评审起点）无关。
_Avoid_: 截止提交、结束提交

**Test Category（测试分类）**:
按测试运行时依赖的环境分成三类：单元测试（不启动外部进程）、集成测试（需要真实的数据库、MQ、Redis 等中间件）、e2e 测试（需要部署后的完整系统）；决定测试在哪里运行、是否阻断归档。与 Seam（测试从哪个公共接口观察行为）是两个独立的维度（见 ADR-0007）。
_Avoid_: 测试类型、测试层级

**Pending Environment Re-test（待环境补测）**:
切片声明了 `Environment:`，集成测试在本地无法运行时（记录证据时无法运行，或证据过期后无法重跑），在证据中登记的补测计划；登记成立并且确认人由用户填写时，切片状态为 `pending-environment`，只记 WARNING，不阻断归档。不是豁免记录：补测仍要在环境中完成。
_Avoid_: 环境豁免、延期验证、待补测

**Acceptance Deployment Document（验收部署文档）**:
变更目录下的 `deployment.md`：用四节表格（发布前检查、部署与回滚、上线后验收、交接项）记录归档后才执行的工作，每项写明负责人与状态，不用勾选项。Migration Plan 有在生产环境执行的步骤，或 Risk Accepted 写了上线后的复查条件，或「测试 Seam 决策」有 e2e 测试时才需要；编写它是任务，执行其中的条目不是任务，archive 不等待。
_Avoid_: 发布说明、上线文档

**Change Recap（完成清单）**:
已归档变更的归档目录中的 `recap.md`：按新增、修改、删除、修复、没做与遗留 5 类列出事项并写出落点，以已勾选任务、delta specs、切片证据与评审结论为准，proposal 只作参考。archive 归档后由一个子 agent 生成，是派生视图，可以用 `/opsx:recap <变更名>` 重新生成；跨变更总表只读取它的 4 个头部字段，由脚本打印。agent 不提交它，也不修改 `.gitignore`。
_Avoid_: 交付清单、变更回顾、完成报告

**Verify Verdict（verify 结论）**:
`/opsx:verify` 在 `verification.md` 头部 `Fingerprint` 行之后写的两个字段：`Verify-Verdict`（`PASS` / `FAIL`）与 `Critical-Count`（报告中 CRITICAL 的条数）。有 CRITICAL、「评审条件」有未闭环的条件，或第 9 步人工核对有不通过的项时为 `FAIL`。门禁 `archive` 子命令与 `facts` 读取它：`FAIL`、条数大于 0 或字段无法识别时阻断归档，进度视图给出 R10；两个字段都没有的旧报告不阻断。与技术评审的 `Gate-Verdict`（编码前评审的裁决）无关。
_Avoid_: verify 裁决、验收结论

**Progress View（进度视图）**:
当前项目活跃变更的阶段、卡点与下一步命令的只读输出：`/opsx:progress` 运行 `progress.mjs`，为每个活跃变更输出一行分级、阶段、任务勾选数、待决定条数、卡点与下一步，`--json` 供 agent 读取；已归档变更只列名称与日期。阶段按 `progress.mjs` 的 `RULES` 常量推导，分级、签字、证据与 verify 报告的指纹和结论字段读取门禁脚本 `facts` 的输出。不写变更目录；verify 结论由门禁脚本读取，进度视图不解析报告。
_Avoid_: 进度看板、状态面板、进度报告

**Forbidden Alias（禁用别名）**:
CONTEXT.md 中某术语 `_Avoid_` 列出的其他叫法，是 STE 规则「一词一义」的项目侧落点；在产物与对话回复中出现即被 lint 阻断，显式豁免除外（见 ADR-0003）。
_Avoid_: 禁词、敏感词、黑名单词

**Trace Field（留痕字段）**:
`/opsx:quality` 写的处理记录中写决策人的三个字段：双轴原始报告中驳回记录的「驳回人」、risk accepted 记录的「接受人」，以及 `review/sonar.md` 的「决策人」。agent 可以按用户对该 finding ID 或该 Sonar 行的 AskUserQuestion 回复写入，并写明回复来源（见 ADR-0009）。与签署字段无关。
_Avoid_: 代填字段、决策字段

**Sign-off Field（签署字段）**:
只能由用户写的字段：签字行 `Technical Review Approved:`、`tasks.md` 的变更终点区块（含「判定人」）、待环境补测登记的「确认人」与分镜签署行 `Storyboard Approved:`。agent 不写入、不修改，AskUserQuestion 的回复不能代替用户写入（见 ADR-0009）。与留痕字段无关。
_Avoid_: 签名字段、手写字段

**Autopilot（托管）**:
用户在会话中完成 review 与签字后（或分级不需要编码前评审时），用 `/opsx:autopilot` 把一个变更交给本机调度脚本，由它按进度规则依次运行 apply、quality、verify、archive，并在归档后执行出口动作。签字仍由用户在会话中手写（见 ADR-0011）。
_Avoid_: 自动驾驶、交接循环

**Autopilot Decision（托管决策）**:
托管中需要用户决定的一件事，写成变更目录 `decisions/D-<四位数字>.json`：提问决策、会话告警、出口决策与出口告警。状态为 `pending`、`answered`、`used`、`void`，按预期状态比较后写入；文件随变更归档，保存提问原文与回复。
_Avoid_: 决策请求、决策记录

**Decision Card（决策卡片）**:
托管决策在飞书中的卡片：问题与选项原样复制，用户点选或填写后由桥接脚本核对并写入回复。只认配置中本人的 `operator_id`；卡片变成「已记录」才算点选成功。
_Avoid_: 审批卡片

**Exit Action（出口动作）**:
托管中变更归档后由调度脚本执行的对外写入：提交与合并、推送。每一项由 agent 只读起草，调度脚本核对计划，用户在决策卡片上确认后执行并回读。
_Avoid_: 收尾动作、外发动作

**Fact Research（事实预调研）**:
explore 之前，由一个只读子 agent 针对一个主题查明代码现状、既有约定与外部事实的步骤，结果按五段契约写入变更根目录的 `research.md`，只写事实与出处，不写推荐方案。与 explore 不同，它不与用户讨论（见 ADR-0012）。`research.md` 与 `discussion-log.md` 分开，后者只记讨论与决策（见 ADR-0014）。
_Avoid_: 预调研、先行调研

**In-flow Agent（流程内 agent）**:
用户启动、在仓库中执行 OpenSpec 阶段的 agent，包括主会话、它派出的子 agent 与托管的阶段会话，与使用哪个工具或模型无关。评审约束它的检查时，默认假设它会出错、会走捷径，不会有意伪造。
_Avoid_: 本机 agent

**External Input（外部输入）**:
不经过流程内 agent、由网络或第三方直接进入脚本的内容，如飞书卡片回调、`lark-cli` 的返回值、业务系统的请求参数与上传文件。把外部文本交给流程内 agent 的入口也算外部输入。评审时按攻击者假设。
_Avoid_: 外来输入

**Shortcut（走捷径）**:
流程内 agent 没有伪造记录，只为让任务或门禁通过而放宽判断、复用以前的同意或改写记录。评审约束流程内 agent 的检查时必须拦住。与有意伪造不同。
_Avoid_: 钻空子

**Deliberate Forgery（有意伪造）**:
流程内 agent 先查明一项检查的做法，再专门构造输入绕开它。门禁类检查默认不防，变更在 design 中声明需要防伪造时除外。
_Avoid_: 恶意绕过

**Finalized Review Round（定稿轮）**:
技术评审首次达到 `READY_FOR_HUMAN_APPROVAL` 的轮次。因方案变更重走门禁后，用再次达到该裁决的轮次替换。定稿轮不等同于签字。
_Avoid_: 审查定版轮、定版评审轮

**Post-approval Planning Change Register（签字后规划修改登记）**:
评审汇总「定稿与签字后修改」节中的登记表。从定稿轮开始记录规划产物的修改，包含签字前的修改。登记行写出关联、规划档位与判定依据。
_Avoid_: 签后计划台账、定稿改稿清单

**Planning Change Tier（规划档位）**:
定稿后规划修改的四种分类：措辞、条件落点、范围收窄、方案变更。用于决定是否重走技术评审，不是用于双轴评审的「修改档位」。
_Avoid_: 规划修改等级、规划变动级别

**Operating Assumptions（运行假设）**:
design.md 中固定三行的区块：使用者、威胁模型、规模上限。是技术评审判断 finding 是否成立的边界，L2/L3 与命中升级信号的 MVP 必须写。
_Avoid_: 运行前提、评审前提

**Out-of-assumption Observation（假设外观察）**:
技术评审中触发方式不属于正常使用、出错、走捷径、外部输入四种之一，或涉及数量超过规模上限的发现。写在维度报告的单独小节，不计数，不影响裁决，不需要用户处理。
_Avoid_: 范围外问题
