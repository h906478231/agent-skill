# Static Template Rendering Specification

## ADDED Requirements

### Requirement: 静态 HTML 模板支持外部 JSON 加载

系统必须提供一个静态 HTML 模板（`template-v2.0.0.html`），能够从外部 JSON 文件加载领域模型数据并动态渲染事件风暴流程图。

#### Scenario: 页面加载时自动获取 JSON 数据

- **WHEN** 用户在浏览器中打开 `template-v2.0.0.html`
- **THEN** 页面自动发起请求，从相对路径 `./ddd-model.json` 加载数据

#### Scenario: 成功渲染流程图

- **WHEN** JSON 数据加载成功且格式正确
- **THEN** 页面渲染完整的事件风暴流程图，包括命令、事件、聚合、Policy 的可视化卡片

#### Scenario: 数据加载失败时的错误提示

- **WHEN** JSON 文件不存在或加载失败（如网络错误、同源策略限制）
- **THEN** 页面显示友好的错误提示："无法加载 ddd-model.json，请确保文件存在且使用 HTTP 服务器打开此页面"

#### Scenario: JSON 格式错误时的错误提示

- **WHEN** JSON 文件内容不符合预期格式（如缺少顶层键、字段类型错误）
- **THEN** 页面显示详细的错误信息，指出哪个字段有问题

### Requirement: 支持可配置的 JSON 文件路径

系统必须支持通过 URL 参数配置 JSON 文件的路径。

#### Scenario: 默认路径

- **WHEN** 用户打开 `template-v2.0.0.html` 且 URL 无参数
- **THEN** 系统从 `./ddd-model.json` 加载数据

#### Scenario: 通过 URL 参数指定路径

- **WHEN** 用户打开 `template-v2.0.0.html?data=docs/ddd/ddd-model.json`
- **THEN** 系统从 `docs/ddd/ddd-model.json` 加载数据

#### Scenario: 绝对路径支持

- **WHEN** 用户指定绝对路径 `?data=/Users/user/project/model.json`
- **THEN** 系统尝试从该绝对路径加载数据（受浏览器同源策略限制）

### Requirement: 保留原有的交互功能

系统必须保留 `template-v1.0.0.html` 中的所有交互功能。

#### Scenario: 卡片点击展开详情

- **WHEN** 用户点击命令卡片
- **THEN** 展开该命令的详细信息，包括输入数据、前置条件、产生的事件

#### Scenario: 聚合分组显示

- **WHEN** 页面渲染完成
- **THEN** 命令和事件按所属聚合分组显示，每个聚合有独立的视觉区域

#### Scenario: Policy 连线可视化

- **WHEN** 页面渲染完成
- **THEN** Policy 通过连线展示"监听事件 → Policy → 触发命令"的流转关系

#### Scenario: 搜索和过滤功能

- **WHEN** 用户在搜索框输入关键词
- **THEN** 页面过滤显示包含该关键词的命令、事件、Policy

### Requirement: 支持本地和远程 HTTP 服务器部署

系统必须能够在本地 HTTP 服务器和远程服务器上正常工作。

#### Scenario: VS Code Live Server 环境

- **WHEN** 用户使用 VS Code Live Server 打开 HTML 文件
- **THEN** 页面成功加载 JSON 数据并渲染流程图

#### Scenario: Python HTTP Server 环境

- **WHEN** 用户运行 `python -m http.server` 并通过 `http://localhost:8000` 访问
- **THEN** 页面成功加载 JSON 数据并渲染流程图

#### Scenario: 远程服务器部署

- **WHEN** HTML 和 JSON 文件部署到远程服务器（如 GitHub Pages）
- **THEN** 页面成功加载 JSON 数据并渲染流程图

#### Scenario: file:// 协议限制提示

- **WHEN** 用户通过 `file:///` 协议直接打开 HTML 文件且浏览器阻止 JSON 加载
- **THEN** 页面显示明确提示："检测到 file:// 协议，请使用 HTTP 服务器打开此页面。推荐方式：VS Code Live Server 或 `python -m http.server`"

### Requirement: 响应式布局

系统必须支持不同屏幕尺寸的响应式布局。

#### Scenario: 桌面端显示

- **WHEN** 用户在桌面浏览器（宽度 > 1200px）中打开页面
- **THEN** 流程图以多列布局显示，充分利用屏幕空间

#### Scenario: 平板端显示

- **WHEN** 用户在平板设备（宽度 768px - 1200px）中打开页面
- **THEN** 流程图以两列布局显示，卡片大小适配

#### Scenario: 移动端显示

- **WHEN** 用户在手机（宽度 < 768px）中打开页面
- **THEN** 流程图以单列布局显示，卡片宽度占满屏幕

### Requirement: 数据刷新机制

系统必须支持在数据变更后刷新页面查看最新内容。

#### Scenario: 浏览器刷新

- **WHEN** 用户修改了 `ddd-model.json` 文件并刷新浏览器
- **THEN** 页面重新加载 JSON 数据并渲染最新的流程图

#### Scenario: 缓存处理

- **WHEN** 浏览器缓存了旧的 JSON 数据
- **THEN** 页面在加载 JSON 时添加缓存破坏参数（如时间戳），确保获取最新数据

#### Scenario: 热更新支持（未来扩展）

- **WHEN** 系统检测到 `ddd-model.json` 文件变化（通过 WebSocket 或轮询）
- **THEN** 页面自动重新加载 JSON 数据并更新流程图，无需手动刷新

### Requirement: 向后兼容性

系统必须保持与 `template-v1.0.0.html` 的向后兼容性。

#### Scenario: 保留 v1.0.0 模板

- **WHEN** 用户仍希望使用旧版本的模板（数据烘焙模式）
- **THEN** 系统保留 `template-v1.0.0.html` 文件，不影响其使用

#### Scenario: 版本选择提示

- **WHEN** 用户运行 workflow 生成可视化文件
- **THEN** 系统提示用户可以选择 `template-v1.0.0.html`（嵌入数据）或 `template-v2.0.0.html`（外部加载数据）

### Requirement: 性能优化

系统必须优化页面加载和渲染性能，确保流畅的用户体验。

#### Scenario: 大规模数据渲染

- **WHEN** JSON 包含超过 100 个命令和事件
- **THEN** 页面仍能在 2 秒内完成渲染，不出现明显卡顿

#### Scenario: 虚拟滚动支持（未来扩展）

- **WHEN** JSON 包含超过 500 个元素
- **THEN** 系统采用虚拟滚动技术，仅渲染可见区域的元素
