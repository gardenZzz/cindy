---
status: accepted
---

# ADR 0004: 冷隔离配置目录是 Cindy 自伤，不是上游限制

Date: 2026-08-19

## Status

Accepted — 纠正 ADR 0003 Consequences 里「`session/new` ~6-9s 是上游限制、改不动」这句判断。ADR 0003 的**决策**（不预热、bootstrap 后台化）仍然成立，本文不改 0003。

## Context

ADR 0001 规定每个 Cursor 会话一个独立 `cursor-agent acp` 子进程、不预热、不复用。Cindy 为此给每个会话发一个全新的隔离 `CURSOR_CONFIG_DIR`。ADR 0003 据此把 bootstrap 后台化，并在 Consequences 里写：首条到 token 的总时长不变，因为 `session/new` ~6-9s 是上游限制（spec #40）。

2026-08-19 实测（grok-4.6 / xhigh，探针 A/B 每组 3 次）推翻了这句性能判断：

| 场景 | `session/new` |
| --- | --- |
| 用户全局 Cursor CLI 配置目录（热） | 5.2 / 5.8 / 6.5s |
| 全新隔离配置目录（Cindy 每次新建会话） | 8.3 / 8.6 / 8.3s |
| 同一隔离目录补上账号身份段 | 5.1 / 5.6 / 5.4s |

生产日志（`session ready` 的 `sessionMs`，08-18 起）：新建中位 9.3s（n=35），恢复中位 6.8s（n=16）。恢复走同一隔离目录，上一次已经把账号身份写热。

同时坐实的否定结论：MCP 注入不在建会话关键路径（懒连接）；工作目录仓库大小与建会话耗时无关；服务端配置缓存、隐私模式缓存、实验开关缓存预置后耗时无变化。

剩余约 5.4s 是 cursor-agent 每进程首个会话的服务端握手，被网络放大。这块仍认 ADR 0001。

## Decision

保留每会话一个隔离配置目录（ADR 0001）。冷目录缺的那份账号身份，在创建入口按鉴权门已经拿到的 email 比对后预置进去；对不上、读不到、调用方没传期望身份，一律 fail-closed，静默退回现状。

不拆成共享配置目录：多会话并发写同一份 `cli-config.json` 会互相盖掉模型档位，症状隐蔽。不重开进程预热（ADR 0001 / 0003）。

详见 spec #70。

## Consequences

- 新建会话的隔离目录不再为账号身份向服务端再问一遍。恢复路径本来就是热的，行为不变。
- 权限列表、审批模式、沙箱设置仍每会话从零开始。
- ADR 0003 的决策与验收口径（点发送到 navigate < 200ms；首 token 不设硬门槛）继续有效。

## 血脉

ADR 0001 → spec #40 / ADR 0003 → spec #70 / 本 ADR。
