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

**Forbidden Alias（禁用别名）**:
CONTEXT.md 中某术语 `_Avoid_` 列出的其他叫法，是 STE 规则「一词一义」的项目侧落点；在产物与对话回复中出现即被 lint 阻断，显式豁免除外（见 ADR-0003）。
_Avoid_: 禁词、敏感词、黑名单词
