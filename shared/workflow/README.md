# OpenSpec 研发流程 - Shared 模块索引

本目录包含 OpenSpec + AI Agent 研发流程的核心知识模块，供各个 skill 引用。

## 核心原则

- **需求未明确，不分析性能；方案未确定，不开始编码。**
- **质量保障理念：第一性原理（Phase 1 确保方向正确）+ 交叉验证（Phase 2/3/6 多维度互证）。**

## 模块列表

| 文件 | 内容 | 被引用的 skills |
|------|------|---------------|
| [phases.md](phases.md) | Phase 1-6 各阶段职责、产物、全景流程图 | openspec-explore, opsx-technical-review |
| [gate-levels.md](gate-levels.md) | 门禁适用范围分级（L0/L1/L2/L3）、耗时预期 | opsx-technical-review, opsx-code-quality |
| [first-principles.md](first-principles.md) | Phase 1 第一性原理分析框架与检查点 | openspec-explore |
| [cross-validation.md](cross-validation.md) | Phase 2 候选方案交叉验证矩阵 | openspec-explore |
| [phase3-gate.md](phase3-gate.md) | Phase 3 技术评审门禁多维度交叉验证 | opsx-technical-review |
| [phase6-verification.md](phase6-verification.md) | Phase 6 实现与设计交叉核对 | opsx-technical-review |
| [quality-framework.md](quality-framework.md) | 质量保障体系总览与检查点汇总 | 所有 opsx skills |

## 引用方式

### 在 skill 中引用

使用相对路径从 skill 目录引用 shared 模块：

```markdown
完整的质量保障体系见 `shared/workflow/quality-framework.md`。
门禁分级标准见 `shared/workflow/gate-levels.md`。
```

### 在文档中引用

如果是项目级文档（如 workflow/ 目录下的汇总文档），可以这样引用：

```markdown
详见 [门禁分级](../shared/workflow/gate-levels.md)。
```

## 维护原则

1. **单一事实源**：同一知识点只在一个文件中维护
2. **模块化拆分**：按主题拆分，每个文件职责单一
3. **引用而非复制**：skills 通过引用使用这些模块，不复制内容
4. **向后兼容**：修改时保持文件路径和主要章节结构稳定

## 完整流程文档

如需查看完整的研发流程文档（面向人类阅读的汇总版本），见项目根目录的 `workflow/OpenSpec-AI-研发流程.md`。
