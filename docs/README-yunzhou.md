# 云舟自动化 Loop 文档中心

> 完整的云舟任务管理平台集成文档

## 📚 文档导航

### 🚀 快速开始

如果你是第一次使用，从这里开始：

- **[云舟自动化 Loop 使用指南](./yunzhou-automation-loop-readme.md)** ⭐ **推荐**
  - 完整的使用指南，包含快速开始、配置管理、使用方式、故障排除
  - 适合所有用户，从入门到高级用法

- **[快速开始指南](./devops-automation-quickstart.md)**
  - 5分钟快速上手
  - 环境准备、配置、第一次运行

### 📖 核心文档

- **[DevOps 自动化循环完整文档](./devops-automation-loop.md)**
  - 工作流程映射
  - 完整实现代码
  - 子工作流实现
  - 高级功能（多任务并行、增量开发、失败重试）
  - 监控与日志
  
- **[云舟集成方案总结](./yunzhou-integration-summary.md)**
  - 云舟 CLI 集成架构
  - 核心优势对比
  - 关键技术实现
  - 安全与合规
  - 性能优化
  - 扩展性设计

### 🔧 配置管理

- **[多项目配置管理指南](./yunzhou-multi-project-guide.md)**
  - 配置文件结构
  - 配置管理操作（添加、修改、删除、设置默认）
  - 工作流调用方式（7种方式）
  - 配置优先级
  - 实际使用场景
  
- **[工作流参数完整说明](./yunzhou-workflow-parameters.md)**
  - 完整参数列表
  - 调用示例（7个示例）
  - 参数组合场景
  - 参数验证规则
  - 错误处理
  - 配置优先级

### 🛡️ 安全与验证

- **[项目匹配验证功能说明](./yunzhou-project-match-implementation-summary.md)**
  - 智能项目匹配功能
  - 自动切换 vs 严格模式
  - 使用示例
  - 当前限制和建议
  - 完整工作流程
  
- **[跨项目问题分析](./yunzhou-cross-project-issue.md)**
  - 问题场景描述
  - 当前行为分析
  - 潜在风险等级
  - 4种改进方案
  - 推荐实现方案
  - 使用建议

### 📝 变更日志

- **[代码仓库配置变更 - v1.2.0](./yunzhou-coderepo-changelog.md)**
  - 配置脚本升级（4个改动）
  - 工作流文件升级（4个改动）
  - 配置文件格式变化
  - 使用方式变化
  - 配置步骤
  - 验证与测试
  - 向后兼容性

## 🎯 按需求查找文档

### 我想...

#### 第一次使用
👉 阅读 **[云舟自动化 Loop 使用指南](./yunzhou-automation-loop-readme.md)**

#### 快速上手
👉 阅读 **[快速开始指南](./devops-automation-quickstart.md)**

#### 配置多个项目
👉 阅读 **[多项目配置管理指南](./yunzhou-multi-project-guide.md)**

#### 了解所有参数
👉 阅读 **[工作流参数完整说明](./yunzhou-workflow-parameters.md)**

#### 理解项目匹配机制
👉 阅读 **[项目匹配验证功能说明](./yunzhou-project-match-implementation-summary.md)**

#### 解决跨项目问题
👉 阅读 **[跨项目问题分析](./yunzhou-cross-project-issue.md)**

#### 了解技术架构
👉 阅读 **[云舟集成方案总结](./yunzhou-integration-summary.md)**

#### 查看完整实现
👉 阅读 **[DevOps 自动化循环完整文档](./devops-automation-loop.md)**

#### 查看版本变更
👉 阅读 **[代码仓库配置变更](./yunzhou-coderepo-changelog.md)**

## 📋 文档对比

| 文档 | 适合人群 | 内容深度 | 阅读时间 |
|------|---------|---------|---------|
| [使用指南](./yunzhou-automation-loop-readme.md) | 所有用户 | ⭐⭐⭐ 中 | 15分钟 |
| [快速开始](./devops-automation-quickstart.md) | 新手 | ⭐ 浅 | 5分钟 |
| [完整文档](./devops-automation-loop.md) | 高级用户 | ⭐⭐⭐⭐⭐ 深 | 30分钟 |
| [集成方案](./yunzhou-integration-summary.md) | 架构师 | ⭐⭐⭐⭐ 深 | 25分钟 |
| [多项目管理](./yunzhou-multi-project-guide.md) | 中级用户 | ⭐⭐⭐ 中 | 15分钟 |
| [参数说明](./yunzhou-workflow-parameters.md) | 开发者 | ⭐⭐⭐ 中 | 10分钟 |
| [项目匹配](./yunzhou-project-match-implementation-summary.md) | 中级用户 | ⭐⭐⭐ 中 | 10分钟 |
| [跨项目分析](./yunzhou-cross-project-issue.md) | 高级用户 | ⭐⭐⭐⭐ 深 | 15分钟 |
| [变更日志](./yunzhou-coderepo-changelog.md) | 升级用户 | ⭐⭐ 中 | 10分钟 |

## 🔗 相关资源

### 源码

- [工作流源码](../workflow/devops-automation-loop-yunzhou.workflow.js)
- [配置向导脚本](../scripts/setup-yunzhou-config.sh)
- [项目编码规范](../CLAUDE.md)

### 配置文件

- 配置文件位置：`~/.yunzhou/config.json`
- 配置版本：v1.2.0

### 云舟 CLI

- 安装：`npm install -g ~/Downloads/flows-cli-1.2.0.tgz`
- 登录：`flows-cli auth login-web --json`
- 验证：`flows-cli auth whoami --json`

## 📞 获取帮助

### 故障排除

查看各文档的"故障排除"章节：
- [使用指南 - 故障排除](./yunzhou-automation-loop-readme.md#故障排除)
- [快速开始 - 故障排除](./devops-automation-quickstart.md#故障排除)

### 常见问题

1. **flows-cli 命令未找到**
   ```bash
   npm install -g ~/Downloads/flows-cli-*.tgz
   ```

2. **API 调用失败（401）**
   ```bash
   flows-cli auth logout
   flows-cli auth login-web --json
   ```

3. **未指定项目ID**
   ```bash
   ./setup-yunzhou-config.sh
   # 或在调用时指定 projectName
   ```

4. **项目不匹配**
   - 启用 `autoSwitchProject: true`
   - 或明确指定 `projectName` 参数

### 诊断命令

```bash
# 健康检查
flows-cli health check --json

# 验证配置
cat ~/.yunzhou/config.json | jq

# 测试项目访问
flows-cli project list --json

# 测试看板访问
flows-cli board show --project-id <project-id> --json
```

## 🎉 快速命令参考

### 配置管理

```bash
# 运行配置向导
./setup-yunzhou-config.sh

# 查看配置
cat ~/.yunzhou/config.json | jq

# 验证配置格式
cat ~/.yunzhou/config.json | jq '.'
```

### 工作流调用

```javascript
// 默认配置
workflow('devops-automation-loop-yunzhou')

// 指定任务
workflow('devops-automation-loop-yunzhou', {
  projectName: 'Lokra 后端',
  taskId: 12345
})

// 快速修复
workflow('devops-automation-loop-yunzhou', {
  taskId: 12345,
  skipAnalysis: true,
  autoCommit: true
})
```

## 📊 版本历史

### v1.2.0 (2026-09-01)
- ✅ 新增智能项目匹配功能
- ✅ 支持代码仓库路径配置
- ✅ 新增自动切换模式
- ✅ 完善项目验证机制

### v1.1.0
- ✅ 支持多项目管理
- ✅ 优化配置文件结构

### v1.0.0
- ✅ 基础工作流实现
- ✅ 云舟 CLI 集成

---

## 💡 最佳实践提示

1. **首次使用**：先阅读[使用指南](./yunzhou-automation-loop-readme.md)，再运行配置向导
2. **多项目环境**：配置完整的清单信息以支持智能匹配
3. **调用建议**：明确指定 `projectName` 参数以避免错误
4. **安全第一**：不要盲目开启 `autoCommit`，先人工审查
5. **定期维护**：备份配置文件，保持 flows-cli 版本最新

---

**更新时间**：2026-09-01  
**文档版本**：v1.2.0  
**维护团队**：DevOps Automation Team
