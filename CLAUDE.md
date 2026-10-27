@AGENTS.md

> 通用协作规则的唯一事实源是 `AGENTS.md`（Codex CLI、opencode、Cursor 等直接读取），Claude Code 通过上面一行导入。本文件只写 Claude Code 专属规则；通用规则改 `AGENTS.md`，不要复制到这里。

## Workflow 编写规范

- **禁止使用 CommonJS**：Workflow 运行环境不支持 CommonJS 的 `require()`，必须使用 ES6 模块语法或通过 agent 执行文件系统操作。
- **文件系统操作**：不能直接使用 `fs`、`path` 等 Node.js 模块，需要通过 `agent()` 调用来执行文件读写、目录检查等操作。
- **环境变量**：不能直接访问 `process.cwd()`、`process.env` 等 Node.js API，需要通过 agent 获取。
- **示例**：
  ```javascript
  // ❌ 错误：使用 require
  const fs = require('fs')
  const config = JSON.parse(fs.readFileSync('config.json', 'utf8'))
  
  // ✅ 正确：通过 agent 读取文件
  const configContent = await agent(
    '读取文件 config.json，返回完整 JSON 内容。如果文件不存在返回 "FILE_NOT_FOUND"',
    { label: 'read-config' }
  )
  const config = JSON.parse(configContent)
  ```
