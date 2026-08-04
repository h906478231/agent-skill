# apply 前置门禁校验（唯一事实源）

> 进入代码实现前必须执行的人工签字校验。`skills/openspec-apply-change/SKILL.md` 与 `claude/commands/opsx/apply.md` 两条调用路径都引用本文件，不各写一份。
> 路径：`<SKILL_DIR>/shared/apply-gate-check.md`

## 何时执行

**写任何代码之前**，且项目启用了技术评审门禁时 —— 判据：存在 `openspec/changes/<name>/review-summary.md`，或项目的 `workflow/OpenSpec-AI-研发流程.md` 中定义了门禁。

## 校验动作

```bash
grep -m1 'Technical Review Approved:' "openspec/changes/<name>/review-summary.md"
```

| 情况 | 处理 |
|------|------|
| **无 `review-summary.md`** | 门禁从未执行。**停止**，提示先运行 `/opsx:review <name>`。例外：该变更属 L0 豁免范围 —— 但豁免理由本身也须记录并签字在 `review-summary.md` |
| **签字行仍是空白占位**（空、`____`、`<签名>`） | 门禁跑过但无人批准。**停止**，请用户审阅 `review/*.md` 后签字 |
| **裁决为 `BLOCKED`** | 即使有签字也**停止**。未闭环 Blocker 必须先回 `design.md` 闭环并重走门禁 |
| **已签字且 `READY_FOR_HUMAN_APPROVAL`** | 放行，继续实现 |

## 禁止事项

- 禁止代替用户签字
- 禁止修改签字行
- 禁止劝说用户跳过本步骤

Bash 侧的 `PreToolUse` hook 只拦得住 `openspec apply` 命令，**看不到 `/opsx:apply` 斜杠命令与 skill 调用这条路径** —— 本校验是该路径上唯一的检查点，不得跳过。

## 放行后必须做的事

把 `review-summary.md` 中「有条件通过」的条件带入实现：**每条条件对应 `tasks.md` 的一个任务项，条件满足后才可勾选该任务。** 条件不落地，门禁等于白跑。
