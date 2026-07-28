# Domain 文档

工程类 skill 在探索代码库时，应该如何消费本仓的领域文档。

本仓采用**单 context** 布局：根目录一个 `CONTEXT.md` + `docs/adr/`。虽然是 pnpm
monorepo，但模块级规则已经由 `docs/dev-rules/`、`docs/product-rules/`、
`docs/design-rules/` 和各目录的嵌套 `AGENTS.md` 承担，不再按 package 拆
`CONTEXT.md`。

## 探索前先读

- 根目录 **`CONTEXT.md`** —— 领域词汇表。
- **`docs/adr/`** —— 读与本次改动区域相关的 ADR。

这两个文件不存在时**静默继续**：不要提示缺失，也不要建议提前创建。
`/domain-modeling`（经由 `/grill-with-docs` 与 `/improve-codebase-architecture` 触发）
会在术语或决策真正落定时惰性创建它们。

## 文件结构

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-xxx.md
│   └── 0002-xxx.md
├── apps/
└── packages/
```

## 用词汇表里的词

输出里点到领域概念时（issue 标题、重构提案、假设、测试名），用 `CONTEXT.md` 里定义的
术语，不要漂移到词汇表明确回避的同义词。

产品术语另有硬门禁：UI 文案里的术语先查 `i18n/GLOSSARY.md`，规则见
`docs/dev-rules/engineering-conventions.md` §5.1。两者不冲突时以 `i18n/GLOSSARY.md`
为准——它是有 CI 门禁的正本。

需要的概念还不在词汇表里，本身就是信号：要么你在发明项目不用的语言（重新考虑），要么
确实有缺口（记下来交给 `/domain-modeling`）。

## ADR 冲突要显式说出来

输出与现有 ADR 矛盾时，明确点出来，不要静默覆盖：

> _与 ADR-0007（xxx）冲突——但值得重开，因为……_
