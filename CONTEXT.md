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
按 `phases.md` 阶段表的输入与产出，检查各分支能否走到 archive 的确定性测试，不运行 agent。与链式用例无关。
_Avoid_: 链路完整性测试、链路检查

**Trace Summary（轨迹摘要）**:
从一次评测运行的 `trace.jsonl` 归类出的工具调用汇总，按 6 类归类，按子 agent 分组，写入 `trace-summary.json`。与链式用例的「步骤」无关。
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
实现后修改按性质分成的三档：`非行为`（`classify` 判定只有注释差异）、`等价`（不改输入、输出、数据写入、外部调用与异常路径）、`行为`（其他全部情况）；决定该修改的最少动作。与 overview.md 的变更分级（L0–L3）无关。
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

**Forbidden Alias（禁用别名）**:
CONTEXT.md 中某术语 `_Avoid_` 列出的其他叫法，是 STE 规则「一词一义」的项目侧落点；在产物与对话回复中出现即被 lint 阻断，显式豁免除外（见 ADR-0003）。
_Avoid_: 禁词、敏感词、黑名单词
