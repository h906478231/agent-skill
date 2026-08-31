# Domain Model Parser Specification

## ADDED Requirements

### Requirement: Parse domain-model.md structure

系统必须能够解析 `domain-model.md` 文件，提取领域事件、领域命令、Policy 和聚合的结构化数据。

#### Scenario: 成功解析标准格式的 domain-model.md

- **WHEN** 输入符合 `ddd-artifact-contract` 契约的 `domain-model.md` 文件
- **THEN** 系统输出包含 commands、events、policies、aggregates 四个顶层对象的结构化数据

#### Scenario: 解析领域事件清单

- **WHEN** `domain-model.md` 包含 "## 1. 领域事件清单" 表格
- **THEN** 系统提取每行的编号、事件名称、类名、所属聚合、业务含义、前置事件字段

#### Scenario: 解析领域命令清单

- **WHEN** `domain-model.md` 包含 "## 2. 领域命令清单" 表格
- **THEN** 系统提取每行的编号、命令名称、类名、触发者、目标聚合、命令类型、前置条件、产生事件字段

#### Scenario: 解析 Policy 清单

- **WHEN** `domain-model.md` 包含 "## 3. Policy 清单" 表格
- **THEN** 系统提取每行的编号、策略名称、类名、监听事件、触发命令、业务规则描述、是否有状态字段

#### Scenario: 解析聚合设计

- **WHEN** `domain-model.md` 包含 "## 4. 聚合设计" 章节
- **THEN** 系统提取每个聚合的聚合根、聚合 ID、命令-事件映射、内部状态数据、领域服务、不变量字段

### Requirement: 处理事件和命令的数组格式

系统必须将 Markdown 中的事件和命令编号字符串转换为数组格式。

#### Scenario: Policy 的监听事件转为数组

- **WHEN** Policy 表格中 "监听事件" 列的值为 "E1, E2" 或 "E1"
- **THEN** 转换后的 JSON 中 `listenEvents` 字段为数组格式 `["E1", "E2"]` 或 `["E1"]`

#### Scenario: Policy 的触发命令转为数组

- **WHEN** Policy 表格中 "触发命令" 列的值为 "C1" 或 "C1, C2"
- **THEN** 转换后的 JSON 中 `triggerCommands` 字段为数组格式 `["C1"]` 或 `["C1", "C2"]`

#### Scenario: 命令的产生事件转为数组

- **WHEN** 命令表格中 "产生事件" 列的值为 "E1" 或 "E1, E2"
- **THEN** 转换后的 JSON 中 `events` 字段为数组格式 `["E1"]` 或 `["E1", "E2"]`

### Requirement: 错误处理和提示

系统必须在解析失败时提供清晰的错误提示，指出 `domain-model.md` 中的格式问题。

#### Scenario: domain-model.md 文件不存在

- **WHEN** 指定路径的 `domain-model.md` 文件不存在
- **THEN** 系统返回错误信息 "未找到 domain-model.md，请先运行 ddd-modeling-workflow 完成建模"

#### Scenario: 必需章节缺失

- **WHEN** `domain-model.md` 缺少 "## 1. 领域事件清单" 或 "## 2. 领域命令清单" 章节
- **THEN** 系统返回错误信息，指出缺失的章节名称

#### Scenario: 表格格式不正确

- **WHEN** 表格的列数或列名与 `ddd-artifact-contract` 契约不匹配
- **THEN** 系统返回错误信息，指出哪个表格的哪一列有问题，并给出期望的格式

#### Scenario: 必填字段为空

- **WHEN** 表格中的必填字段（如事件名称、类名）为空或只有占位符
- **THEN** 系统返回错误信息，指出哪一行的哪个字段缺失

### Requirement: 支持多子域格式

系统必须支持解析包含多个子域的 `domain-model.md` 文件。

#### Scenario: 单子域文档

- **WHEN** `domain-model.md` 的头部声明 "限界上下文/子域：订单域"
- **THEN** 系统将所有提取的数据归属到该子域

#### Scenario: 多子域文档

- **WHEN** `domain-model.md` 包含多个 "### 4.1 聚合：{名称}" 小节，每个聚合标注 "所属子域：{子域名称}"
- **THEN** 系统按子域分组提取数据，生成嵌套的 JSON 结构或多个 JSON 文件

### Requirement: 保留原始业务语义

系统必须保留 `domain-model.md` 中的业务含义、前置条件、不变量等描述性字段。

#### Scenario: 保留事件的业务含义

- **WHEN** 领域事件表格中的 "业务含义" 列包含描述性文本
- **THEN** 转换后的 JSON 中保留该字段，作为 `meaning` 属性

#### Scenario: 保留命令的前置条件

- **WHEN** 领域命令表格中的 "前置条件" 列包含业务规则
- **THEN** 转换后的 JSON 中保留该字段，作为 `precondition` 属性

#### Scenario: 保留聚合的不变量

- **WHEN** 聚合设计章节中包含 "不变量：{约束列表}"
- **THEN** 转换后的 JSON 中保留这些约束，作为 `invariants` 数组
