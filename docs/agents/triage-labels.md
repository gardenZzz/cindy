# Triage 标签

skill 内部用五个规范角色说话，本文件把这些角色映射到本仓 issue tracker 里实际使用的
label 字符串。

| skill 里的角色 | 本仓 label | 含义 |
| -------------- | ---------- | ---- |
| `needs-triage` | `needs-triage` | 需要维护者评估 |
| `needs-info` | `needs-info` | 等报告者补充信息 |
| `ready-for-agent` | `ready-for-agent` | 已完整定义，可交给 AFK agent |
| `ready-for-human` | `ready-for-human` | 需要人来实现 |
| `wontfix` | `wontfix` | 不予处理 |

skill 提到某个角色时（例如「打上 AFK-ready 的 triage 标签」），用表里右列对应的 label
字符串。

fork 继承的默认标签里只有 `wontfix` 已存在，其余四个首次使用时需要先建：

```sh
gh label create needs-triage   --description "需要维护者评估"
gh label create needs-info     --description "等报告者补充信息"
gh label create ready-for-agent --description "已完整定义，可交给 AFK agent"
gh label create ready-for-human --description "需要人来实现"
```

右列可以改成你实际使用的任何词汇。
