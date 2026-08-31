# JSON Data Output Specification

## ADDED Requirements

### Requirement: 输出标准化的 ddd-model.json 格式

系统必须输出符合标准 JSON Schema 的 `ddd-model.json` 文件，包含 commands、events、aggregates、policies 四个顶层对象。

#### Scenario: 标准 JSON 结构

- **WHEN** 系统完成数据转换
- **THEN** 输出的 JSON 文件包含四个顶层键：`commands`、`events`、`aggregates`、`policies`，每个键对应一个对象（非数组）

#### Scenario: 命令对象格式

- **WHEN** 输出 commands 对象
- **THEN** 每个命令的键为命令编号（如 "C1"），值为包含以下字段的对象：`id`、`name`、`className`、`trigger`、`input`、`precondition`、`aggregate`、`events`（数组）

#### Scenario: 事件对象格式

- **WHEN** 输出 events 对象
- **THEN** 每个事件的键为事件编号（如 "E1"），值为包含以下字段的对象：`id`、`name`、`className`、`meaning`、`aggregate`

#### Scenario: 聚合对象格式

- **WHEN** 输出 aggregates 对象
- **THEN** 每个聚合的键为聚合名称（如 "Order"），值为包含以下字段的对象：`id`、`name`、`description`、`entities`（可选）、`valueObjects`（可选）

#### Scenario: Policy 对象格式

- **WHEN** 输出 policies 对象
- **THEN** 每个 Policy 的键为 Policy 编号（如 "P1"），值为包含以下字段的对象：`id`、`name`、`className`、`listenEvents`（数组）、`triggerCommands`（数组）、`rule`

### Requirement: 数据完整性校验

系统必须在输出前校验数据的完整性和一致性。

#### Scenario: 引用一致性检查

- **WHEN** 命令引用的 `aggregate` 字段值为 "Order"
- **THEN** 系统检查 `aggregates` 对象中是否存在键为 "Order" 的聚合，不存在则报错

#### Scenario: 事件引用一致性检查

- **WHEN** 命令的 `events` 数组包含 "E1"
- **THEN** 系统检查 `events` 对象中是否存在键为 "E1" 的事件，不存在则报错

#### Scenario: Policy 监听事件一致性检查

- **WHEN** Policy 的 `listenEvents` 数组包含 "E2"
- **THEN** 系统检查 `events` 对象中是否存在键为 "E2" 的事件，不存在则报错

#### Scenario: Policy 触发命令一致性检查

- **WHEN** Policy 的 `triggerCommands` 数组包含 "C3"
- **THEN** 系统检查 `commands` 对象中是否存在键为 "C3" 的命令，不存在则报错

### Requirement: 文件输出路径配置

系统必须支持配置 `ddd-model.json` 的输出路径。

#### Scenario: 默认输出路径

- **WHEN** 用户未指定 `outputJsonPath` 参数
- **THEN** 系统输出文件到项目根目录的 `ddd-model.json`

#### Scenario: 自定义输出路径

- **WHEN** 用户通过 `args.outputJsonPath` 指定路径为 `docs/ddd/ddd-model.json`
- **THEN** 系统输出文件到指定路径，如果目录不存在则创建

#### Scenario: 相对路径解析

- **WHEN** 用户指定相对路径 `./output/model.json`
- **THEN** 系统相对于工作目录解析该路径并输出文件

### Requirement: JSON 格式化和可读性

系统必须输出格式化的、易读的 JSON 文件。

#### Scenario: 缩进和换行

- **WHEN** 系统输出 JSON 文件
- **THEN** 使用 2 空格缩进，每个键值对独占一行

#### Scenario: 键排序

- **WHEN** 系统输出 JSON 对象
- **THEN** 顶层键按固定顺序排列：`commands`、`events`、`aggregates`、`policies`

#### Scenario: 中文字符处理

- **WHEN** 数据中包含中文字符（如命令名称、业务含义）
- **THEN** JSON 文件中正确保留中文字符，不转义为 Unicode 编码

### Requirement: 增量更新支持

系统必须支持在已有 `ddd-model.json` 的基础上进行增量更新。

#### Scenario: 检测已有文件

- **WHEN** 输出路径已存在 `ddd-model.json` 文件
- **THEN** 系统提示用户该文件将被覆盖，除非用户指定 `--force` 参数

#### Scenario: 保留未变更的部分

- **WHEN** 用户指定 `--incremental` 参数且 `domain-model.md` 中某些聚合未变动
- **THEN** 系统仅更新变动的部分，保留已有 JSON 中未变动的聚合数据（未来扩展功能）

### Requirement: Git 友好性

系统输出的 JSON 文件必须便于 Git diff 和版本管理。

#### Scenario: 稳定的键排序

- **WHEN** 多次运行转换且数据内容未变
- **THEN** 输出的 JSON 文件内容完全一致（字节级别），避免无意义的 diff

#### Scenario: 换行符一致性

- **WHEN** 系统输出 JSON 文件
- **THEN** 使用 LF（`\n`）作为换行符，符合 Unix 标准

#### Scenario: 文件末尾换行

- **WHEN** 系统输出 JSON 文件
- **THEN** 文件末尾包含一个换行符，符合 POSIX 标准
