# 领域文档

Engineering skills 探索 codebase 时，应如何消费这个 repo 的 domain documentation。

## 探索前先读取这些

- repo 根目录的 **`CONTEXT.md`**：本仓库的 domain glossary，词条定义在 `## Language` 段。
- **`docs/adr/`**：读取与你即将处理区域相关的 ADRs。

如果这些文件不存在，**静默继续**。不要标记缺失；不要提前建议创建。`/domain-modeling` skill（经由 `/grill-with-docs` 和 `/improve-codebase-architecture` 调用）会在 terms 或 decisions 实际被解决时懒创建它们。

> 本仓库把 glossary 放在 `CONTEXT.md`，而不是 `GLOSSARY.md`。如果将来出现 `GLOSSARY.md` 或 `GLOSSARY-MAP.md`，以它们为准；`GLOSSARY-MAP.md` 表示 multi-context，按其指向读取每个 context。

## 文件结构

Single-context repo（本仓库）：

```text
/
├── CONTEXT.md          ← domain glossary（`## Language`）
├── docs/adr/
│   ├── 0001-...
│   └── 0002-...
└── lib/
```

## 使用 glossary 的词汇

当你的输出命名某个 domain concept 时（issue title、refactor proposal、hypothesis、test name），使用 `CONTEXT.md` 的 `## Language` 段中定义的 term。不要漂移到 glossary 明确避免的 synonyms。

如果你需要的概念还不在 glossary 中，这是一个信号：要么你正在发明项目没有使用的语言（重新考虑），要么确实存在缺口（为 `/domain-modeling` 记录）。

## 标记 ADR 冲突

如果你的输出与现有 ADR 矛盾，明确指出，而不是静默覆盖：

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
