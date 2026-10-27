# eval-snapshot-check Specification

## Purpose
阶段快照检查：用确定性的脚本检查阶段快照是否符合当前 skill 的产物格式。
## Requirements
### Requirement: 阶段快照用确定性脚本检查

阶段快照检查 SHALL 对每个评测用例阶段快照中的每个变更目录运行以下脚本。脚本 SHALL 取自工作区，即当前要测的 skill 版本。检查 MUST NOT 启动 Claude Code。

- `openspec validate <change>`，在阶段快照目录中运行。
- `skills/openspec-ste/scripts/ste-lint.mjs check <changeRoot>`。
- `skills/openspec-change-overview/scripts/change-model.mjs check <changeRoot>`，只在 `design.md` 有 `change-model` 代码块时运行。

任一脚本的退出码不为 `0` 时，检查失败。失败信息 SHALL 包含评测用例名、变更名、脚本名与脚本的错误输出。

阶段快照检查 SHALL 可以用 `node --test` 单独运行，不消耗用量额度。

#### Scenario: 全部阶段快照通过

- **WHEN** 9 个评测用例的阶段快照都符合当前 skill 的格式
- **THEN** `node --test 'evals/test/*.test.mjs'` 中阶段快照检查的测试全部通过

#### Scenario: skill 修改后阶段快照过时

- **WHEN** `CONTEXT.md` 新增一个禁用别名，某份阶段快照的 `design.md` 使用了该别名
- **THEN** 阶段快照检查失败，输出该评测用例名、变更名、`ste-lint.mjs` 与命中的行

#### Scenario: 没有变更模型的阶段快照

- **WHEN** 阶段快照的 `design.md` 没有 `change-model` 代码块
- **THEN** 阶段快照检查不运行 `change-model.mjs check`
