# STE 检查卡点的处理口径（唯一事实源）

> OpenSpec 四个卡点运行 `ste-lint.mjs check` 后如何处理结果。`openspec-propose`、`openspec-update-change`、`openspec-apply-change`、`openspec-verify-change` 四个 skill 与 `claude/commands/opsx/` 下对应的四个命令都只写一行引用，不复制本文件内容。
> 脚本 `<STE>` = `../scripts/ste-lint.mjs`（相对本文件）；其他 skill 用 `../openspec-ste/scripts/ste-lint.mjs` 解析，读不到时 Glob 搜 `**/openspec-ste/scripts/ste-lint.mjs`。规则编号与含义见 `shared/ste-rules.md`。

## 运行

```bash
node <STE> check <changeRoot>
```

`<changeRoot>` 取 `openspec status --change "<name>" --json` 输出的 `changeRoot`（通常为 `openspec/changes/<name>`）。

## 找不到脚本

各卡点的引用行自带这条提示（找不到本 skill 时也读不到本文件）：输出「STE 检查已跳过：未找到 openspec-ste（<原因>）」，不得静默跳过。

## 阻断项的修正方式

| 规则 | 修正 |
|---|---|
| C-R1.11 禁用别名、C-R1.1 非受控通用词 | 改用报告中的 `replacement` |
| C-R4.1 模糊词 | 改写为具体数值、条件或对象 |
| 必须引用旧词（迁移说明、兼容映射） | 用行内代码写旧词，或在该行加 `<!-- term-allow: 旧词 -->` |

## 各卡点的处理

| 退出码 | Propose（全部产物写完后、输出总结前） | Update（修改产物后；没有写入修改时不运行） | Apply（开始任何任务前） | Verify（与切片证据、双轴评审校验同一阶段） |
|---|---|---|---|---|
| `0` | 输出总结；`warnings` 只告警，按需改写 | 继续；`warnings` 只告警 | 放行；`warnings` 只展示 | 报告 STE 行写 PASS；每条 `warnings` 记为 SUGGESTION |
| `1` | 按上表修正 `blocking`，重跑，**直到退出码 `0` 才输出总结** | 按上表给出修正，与其他修改一样经用户确认后写入，重跑到退出码 `0` | 逐项列出 `blocking`（文件:行号、规则、命中词、替代词）并**停止**，不开始任何任务；建议 `/opsx:update` 修正后重新 apply | 每条 `blocking` 记为 **CRITICAL**（文件:行号、规则、命中词、替代词），建议 `/opsx:update` 修正 |
| `2` | 原样报告错误，不得当作通过 | 原样报告错误，不得当作通过 | 报告错误并停止 | 记为 CRITICAL，附错误信息 |

退出码 `2` 表示参数或环境错误，例如变更目录不存在、CONTEXT.md 有 1 个字的别名、`openspec/ste.yaml` 非法。
