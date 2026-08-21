---
status: accepted
---

# ADR 0005: 非阻塞预热（claim-if-ready）——后台化 session bootstrap 的叠加允许项

Date: 2026-08-21

## Status

Accepted — 修订 ADR 0003 的「本仓不预热」表述。非阻塞预热（claim-if-ready）是 ADR 0001 / ADR 0003 已批准的「bootstrap 后台化」之上的**叠加允许项**：预热仍在草稿期后台完成，发送热路径不等待就绪，故不构成 ADR 0003 回退对象的「把等待搬进发送热路径」回归。实现见 spec #74 / ticket T1 #75（PR #79），池安全语义（TTL / 上限 1 / 已 claim 免疫 / cancel 幂等）为 T2 #77，配置预写联动为 T3 #78。

## Context

ADR 0001 规定每会话一个独立 `cursor-agent acp` 子进程 + 独立隔离配置目录；ADR 0003 因 [`736d392fc`] 在 IPC / 发送路径 `await prewarm.ready`（等完整 bootstrap ~6s）把 UI 卡死而整体回退预热，回到「startSession 立即返回 + bootstrap 后台化 + pendingPrompt 排队」。

### 关键事实：等待的形态与位置，而非「是否预热」

ADR 0003 回退根因是**预热被放进发送热路径的 await 链**（`claimCursorPrewarmSession` → `await prewarm.ready`），不是预热本身。cursor `send()` 在 bootstrap 未就绪时本就走 `pendingPrompt` 排队（不阻塞、不丢消息），bootstrap 就绪自动 flush——这提供了天然兜底：只要发送热路径不 await 就绪，预热「碰巧就绪就拿走、没就绪也绝不挡路」，体验不会劣于纯后台化。

### 实测前置（本会话探针，`scripts/cursor-acp-same-process-probe.mjs`）

同进程（同一 `cursor-agent` 子进程内）连续 `session/new`：

| 第几次 `session/new` | 中位耗时 |
| --- | --- |
| #1 | 4.90s |
| #2 / #3 | ~2.1s |
| 空闲 60s / 180s 后 | 不衰减 |

ADR 0004 已把冷目录的账号身份段预置热，新建会话的 `session/new` 约为上表 #1。本任务让草稿期做掉 #1，claim 命中即首条 turn 0 等待。**跨会话进程池**（复用 #2 的 ~2.1s）因配置目录绑定墙暂不做（见下）。

## Decision

**非阻塞预热（claim-if-ready）**：用户打开本地普通 Cursor 草稿时，客户端在后台把 Cursor 会话完整 bootstrap（spawn + initialize + 首个 `session/new` + 初始档位下发），到「会话就绪」。发送时 claim-if-ready：

- **预热 IPC 只接受请求、立即返回**，不在 IPC 栈上等 bootstrap（修复 ADR 0003 回退根因的关键）。
- **claim IPC 返回布尔**（已就绪才 true），发送热路径任何地方都不 `await` 会话就绪。
- 命中（已就绪）→ 直接接管预热句柄，首条 turn 0 等待；未命中（未就绪 / 不存在）→ 回退普通创建（`pendingPrompt` 排队兜底，不阻塞）。

### 范围与守卫

- **覆盖入口 = 仅本地普通草稿**：非 device-link / remote / worktree 的 Cursor 分支。
- **触发时机 = 草稿打开 + 400ms debounce**（草稿期打字不触发重复预热）。
- **预热深度 = 完整 bootstrap**，等于普通会话创建的 bootstrap 全流程。
- **回收 = 显式事件回收（离开路由 / 切 vendor / 发送失败）**；TTL 兜底（60s）为 T2。
- **并发上限 = 同一时刻最多一个预热句柄**，新草稿抢占旧的（先回收再起新）——上限 1 为 T2 落地的完整语义；T1 已实现的池层天然支持。

### 池安全语义（T1 已实现；TTL / 上限 / 免疫归 T2）

T1 池层已实现：

1. `prewarmSession` 立即返回（不 await bootstrap，后台 watcher 置 ready 标记，失败静默回收）；
2. `claimPrewarmedSession` 只查就绪标志、非阻塞返回布尔，已 claim 的句柄对迟到重预热免疫；
3. `cancelPrewarmedSession` 幂等；
4. `createSessionOnce` 的 reusedPrewarm 接管分支（同 id / 同 workingDir / 已 claim / 已就绪才 0 等待接管）。

T2（#77）补：TTL 60s 兜底、全局上限 1 抢占、已 claim 免疫 TTL 的显式断言。

### 配置预写联动（claim 不 reconcile）

预热的档位预写与草稿最新配置变更联动（debounce 窗口内取最新 model / effort / fast 等），尽量让预热会话就绪时的档位即发送时档位；claim 热路径不做逐项 reconcile，万一漂了由现有 bootstrap 收尾 / 既有机制兜底。完整联动为 T3（#78）；T1 的 renderer effect 已在 debounce 内取草稿最新档位，配置变化会回收旧预热并换新档位重新预热。

### `waitForSessionBootstrap` 不变

仍只查 `activeSessions`，不认识预热池（标题错峰行为与现状一致）。

### 隔离约束不变

预热仍是每会话一个独立 `CURSOR_CONFIG_DIR`（业务 sessionId 即 stableKey），遵守 ADR 0001 / ADR 0004 隔离约束；`CURSOR_CONFIG_DIR` 进程启动即固定，不在已 spawn 进程上更换。

## 跨会话进程池：明确暂不做

复用同进程 `session/new` #2 的 ~2.1s 收益，撞两堵墙，本任务不做、另立项：

- **CURSOR_CONFIG_DIR 进程启动即固定**（`isolatedConfig.ts` spawn 时 env 注入）：不能把已 spawn 进程的配置目录换给另一个业务会话；
- **ADR 0004 禁共享 cli-config**：多会话并发写同一份 `cli-config.json` 会互盖模型档位。

## Consequences

- 用户感知：本地普通 Cursor 草稿打字足够久（>bootstrap 时长）再发送时，首条回复几乎立即开始，不再先等 4-6s「正在启动…」；没赶上预热则行为与 ADR 0003 后台化完全一致（不报错、不更慢）。
- 发送热路径零 await 就绪：无论预热成功与否，体验不劣于纯后台化（这是与 736d392fc 回退对象的本质区别）。
- 预热创建失败（鉴权 / 网络 / 进程错误）静默放弃、退回普通流程，不打扰用户。
- worktree / device-link / remote 分支行为不变（不预热）。
- 不触发兼容性红线：prewarm 三 IPC channel 纯内部使用，非 wire protocol，无插件 / 协议 / device-link 外部引用。
- 不违反 ADR 0001：仍每会话独立 `cursor-agent acp` 子进程 + 独立隔离配置目录；预热句柄是一个「已就绪的会话」，不是可复用的进程。

## 血脉

修订 ADR 0003「本仓不预热」表述；叠加于 ADR 0001（进程/配置隔离）与 ADR 0004（冷目录身份预置）。与 736d392fc（已回退）的关系：同一「预热」目标，但以**非阻塞契约**修复其发送阻塞根因。spec #74 / tickets #75（T1）/ #76（T4，本文）/ #77（T2）/ #78（T3）。
