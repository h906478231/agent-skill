# tigger-asset-home Specification

## Purpose
本机资产集中安装：`~/.tigger` 存储 skill、命令、workflow 与 agent 的实际文件，`~/.claude` 与 `~/.agents` 两处工具入口用链接指向它。日常同步只发布 Claude Code 格式的 agent 定义，不让旧版覆盖新版，并保留第三方的更新责任与来源记录。

## Requirements

### Requirement: 集中存储实际文件

系统 MUST 将受管资产的实际文件保存到 `~/.tigger`。普通 skill 放在 `skills/`，命令放在 `commands/`，agent 定义放在 `agents/`，流程资源放在 `workflows/`。工具入口 MUST 通过软链接使用这些文件。首次迁移 MUST 复制本仓受管资产当前内容，保留仓库开发源。后续仓库修改 MUST 仅在用户手动运行脚本时同步。工具内置与插件管理的资产不属于普通 skill。

#### Scenario: 日常同步本仓资产
- **WHEN** 用户运行日常同步
- **THEN** 系统按版本保护规则将本仓受管资产当前文件写入 `~/.tigger` 的对应目录
- **AND** 系统不向 `~/.cc-switch` 写入资产
- **AND** 已覆盖项备份在 `~/.tigger/.backups`，既有目录校验和清理范围保持不变

#### Scenario: 复制资产已引用的配套文件
- **WHEN** 仓库资产的本地 Markdown 引用指向仓库 docs、scripts 或根说明文件
- **THEN** 系统按引用复制对应文件到安装根下的相同相对位置
- **AND** 系统不为这些配套文件创建额外工具入口
- **AND** 系统不复制整个仓库、变更产物或缓存

#### Scenario: 仓库修改等待手动同步
- **WHEN** 首次迁移后用户修改仓库受管资产，但没有运行同步脚本
- **THEN** `~/.tigger` 中已安装的内容不因该仓库修改而变化
- **AND** 用户再次手动运行同步脚本后，系统才按版本保护规则复制当前文件
- **AND** 系统不安装监听器或启动 hook 自动跟踪仓库

#### Scenario: 预览不改变文件
- **WHEN** 用户运行 `--dry-run`
- **THEN** 系统只输出计划与冲突
- **AND** 源、目标、锁文件、配置、备份目录和工具入口均不发生变化

### Requirement: 普通 skill 对工具全部可见

系统 MUST 将整个 `~/.agents/skills` 链接到 `~/.tigger/skills`。Claude Code MUST 得到每个普通 skill 的链接。Codex 与 opencode MUST 经这两处入口读取普通 skill。系统 MUST 不在 `~/.config/opencode` 与 `~/.codex` 下创建、改写或删除入口。重复运行时，系统 MUST 识别已经正确的链接，不制造额外入口。

#### Scenario: 全部普通 skill 可见
- **WHEN** 系统完成入口同步
- **THEN** `~/.agents/skills` 解析到 `~/.tigger/skills`
- **AND** Claude Code 的各普通 skill 入口解析到同一目录
- **AND** `~/.config/opencode` 与 `~/.codex` 下的文件与链接保持原状
- **AND** Codex 的工具内置 `.system` 目录保持原状

#### Scenario: 入口存在无关文件
- **WHEN** 待创建的工具入口已有不属于迁移清单的文件或链接
- **THEN** 系统报告冲突并以非零状态退出
- **AND** 系统不覆盖该项，不删除无关入口

#### Scenario: 其他工具目录的已有链接保持原状
- **WHEN** `~/.config/opencode/skills`、`~/.config/opencode/agents` 或 `~/.codex/agents` 有上次同步创建、指向 `~/.tigger` 的链接
- **THEN** 日常同步不删除、不改写这些链接
- **AND** 新的来源记录不登记这些链接
- **AND** `--check` 不因这些链接存在或缺失而失败

#### Scenario: 删除仓库资产只清理两处入口
- **WHEN** 仓库删除一个上次已发布的 skill，`~/.claude/skills` 与 `~/.config/opencode/skills` 都有指向它的链接
- **THEN** 系统备份并删除 `~/.tigger` 中的旧副本
- **AND** 系统删除 `~/.claude/skills` 下指向它的链接
- **AND** `~/.config/opencode/skills` 与 `~/.cc-switch` 下的链接保持原状

### Requirement: 同步禁止旧版覆盖新版

首次迁移与后续手动同步 MUST 使用同一版本保护规则。内容相同的同名项 MUST 合并。内容不同且声明版本可按同一规则比较时，系统 MUST 保留较新版本，MUST 不按修改时间判断新旧。没有可比较版本但安装副本可确认为本仓旧内容，或与上次同步记录的摘要一致时，系统 MUST 使用仓库当前文件。无法判定的差异 MUST 报告为冲突，在解决前不写入；候选来源选择 MUST 不绕过已确认的版本防降级规则。

#### Scenario: 云舟已安装版本不降级
- **WHEN** 本仓 `flows-role-comment` 为 v7，实际安装为 v8
- **THEN** 首次迁移及后续手动同步均保留 v8 的文件内容
- **AND** 迁移后的自动更新脚本通过解析软链接定位 `~/.tigger/skills/flows-role-comment`

#### Scenario: 仓库版本可确认为较新
- **WHEN** 用户手动同步，仓库声明版本可按同一规则比较且高于安装版本
- **THEN** 系统备份旧内容后复制仓库较新版本
- **AND** 系统不因该 skill 曾由第三方更新而永久跳过它

#### Scenario: 已知旧副本使用当前仓库内容
- **WHEN** 安装副本可确认为本仓旧内容，或与上次同步记录的摘要一致，且没有证据表明安装版本更高
- **THEN** 系统使用仓库当前受管文件，含未提交修改
- **AND** 系统不将未提交修改本身视为冲突

### Requirement: 第三方保留自己的更新责任

系统 MUST 将飞书 skill 和 `flows-role-comment` 的实际文件放在 `~/.tigger/skills`。系统 MUST 保留 `~/.agents/.skill-lock.json`。第三方更新 MUST 继续通过原安装器或更新机制完成。日常同步 MUST 不删除未由本仓发布的普通 skill；本仓同名候选 MUST 遵守版本保护。

#### Scenario: 飞书更新经过目录链接
- **WHEN** 安装器经 `~/.agents/skills/lark-im` 删除旧目录并复制新目录
- **THEN** 实际变化发生在 `~/.tigger/skills/lark-im`
- **AND** `~/.agents/skills` 本身仍为目录软链接
- **AND** 安装锁文件仍在 `~/.agents` 下

#### Scenario: 手动同步保留外部独有项
- **WHEN** 用户再次运行仓库同步，目标有本仓不存在且未由本仓发布的普通 skill
- **THEN** 系统保留其实际内容和工具入口
- **AND** 系统不将其作为仓库已删除项清理

### Requirement: 日常同步保留来源记录

系统 MUST 在每次成功同步后记录实际同步项、内容摘要、来源路径和来源提交。工作区有修改时，系统 MUST 标明来源含工作区修改，不得仅用提交号表示所部署内容。保留或迁入的外部资产 MUST 不被记录为本次仓库发布项。

#### Scenario: 同步来自有修改的工作区
- **WHEN** 用户从含未提交修改的仓库运行首次迁移或日常同步
- **THEN** 来源记录包含工作区标记与实际文件的摘要
- **AND** 来源记录不声称内容等于该提交的原始内容

### Requirement: 只发布 Claude Code 格式的 agent 定义

系统 MUST 只把 Claude Code 格式的 agent 定义同步到 `~/.tigger/agents/claude`，并在 `~/.claude/agents` 下创建链接。opencode 与 Codex 格式的 agent 定义 MUST 不复制、不创建链接。`~/.tigger/agents/opencode` 与 `~/.tigger/agents/codex` 中已有的文件 MUST 保持原状。

#### Scenario: 仓库含 opencode 格式的 agent
- **WHEN** 仓库 `claude/agents` 同时有 Claude Code 格式与 opencode 格式的定义
- **THEN** 系统只复制 Claude Code 格式的定义，并在 `~/.claude/agents` 下创建链接
- **AND** 输出说明跳过了 opencode 格式的定义
- **AND** `~/.config/opencode/agents` 保持原状

#### Scenario: 其他工具的 agent 副本不再更新
- **WHEN** `~/.tigger/agents/opencode` 或 `~/.tigger/agents/codex` 有上次同步留下的文件
- **THEN** 日常同步不更新、不删除这些文件
- **AND** 新的来源记录不登记这些文件
