# ADR 0003: Cursor 会话启动不预热，bootstrap 后台化（回退 ACP 预热）

Date: 2026-08-03

## Status

Accepted — 纠正 [`736d392fc`]（回退对象） 对 ADR 0001 / spec #40 设计意图的偏离。

> 2026-08-21 修订：ADR 0005 将「预热」重述为**非阻塞预热（claim-if-ready）**——后台化
> session bootstrap 的叠加允许项，发送热路径零 await 就绪，不构成本文回退对象的发送
> 阻塞回归。本文决策（纯后台化）仍成立，是 0005 的兜底基线。

## Context

ADR 0001 明确排除 cursor 进程预热 / 复用：每 session 一个独立 `cursor-agent acp` 子进程。
spec #40 据此落地「startSession 立即返回、bootstrap 后台化」：冷启动被 turn 内
「正在启动…」状态覆盖，用户从不空等。提交 `8c600e0d`(#42) 完成后台化，
`aaa3f23b`(#41) 把会话 id / 模型回写改事件驱动。

随后 [`736d392fc`] 为修复「首条发送卡顿 ~1-2s」引入 ACP 预热：草稿期提前 spawn
cursor-agent + `session/new`，发送前 `claimCursorPrewarmSession` 锁定预热句柄。该 commit
同时含两项独立优化（发送热路径去 `cursor-agent status` 同步 spawn、标题生成错峰），
但预热机制本身与 ADR 0001 / spec #40「不做预热」相悖。

### 回归证据（日志 + 源码双重坐实）

- `NewMakerDraftRoute.tsx` `claimCursorPrewarmSession` 在发送链路 `await prewarm.ready`
  （等 cursor-agent bootstrap，~6s）。草稿打开后 prewarm effect 经 400ms debounce 才起
  预热；打字快（bootstrap 未完成就点发送）时该 await 阻塞 UI 5-10s。
- 但 cursor `send()` 在 bootstrap 未就绪时本就走 `pendingPrompt` 排队（不阻塞、不丢消息），
  bootstrap 好了自动 flush；`reconcilePrewarmedSession` 的 setter 在 bootstrap 未就绪时
  只存 desired、bootstrap 收尾 initial config 用 desired apply（值不丢、不崩）。
- 故 `await prewarm.ready` 是过度等待，下游全部不需要它。codex / claude-code 无 prewarm、
  draft route 全程不 await bootstrapReady，发送永不卡。

## Decision

回退 ACP 预热，回到 spec #40 的纯后台化：

- 草稿期不再提前 spawn cursor-agent / `session/new`。
- 发送时 navigate 先走，cursor `startSession` 立即返回 handle，bootstrap 后台进行。
- 首条消息经 `setPending` 交 SessionView，`consumePending` 调 `sendMessage` -> cursor
  `send()` 在 bootstrap 未就绪时进 `pendingPrompt` 排队，状态栏推「正在启动…」。
- bootstrap 就绪后 flush pendingPrompt，自动发出首条（无需用户重发）。

### 保留项（与预热无关的独立优化，不回退）

- 发送热路径不 spawn `cursor-agent status`（同步读 `peekCursorAvailability` /
  `peekCursorAuthState` 快照，未知态乐观放行，由 ACP `session/new` 权威裁决）。
- 标题生成错峰：`makerChatStore` cursor 会话 `scheduleAutoName` 延后到 enqueue 接受后；
  `generateCursorSessionTitle` 经 `maker.waitForSessionBootstrap` 等 session/new 就绪再起
  oneShot。`waitForSessionBootstrap` 改走 `activeSessions` 路径（prewarm 句柄不再存在）。

### 清理范围

移除 prewarm 机制（仅普通本地草稿分支使用；worktree / device-link / remote 本就不预热）：

- `maker.ts`：`prewarmSession` / `claimPrewarmedSession` / `cancelPrewarmedSession` /
  `prewarmedSessionHandles` / `reconcilePrewarmedSession` / `canAdoptPrewarmedSession`、
  `createSessionOnce` 的 `reusedPrewarm` 分支。
- `NewMakerDraftRoute.tsx`：`claimCursorPrewarmSession` / `releaseCursorPrewarmClaim` /
  `cursorPrewarmRef` / `cursorPrewarmClaimedRef` / prewarm effect（含 debounce）。
- IPC：`maker:prewarm-session` / `maker:claim-prewarm-session` / `maker:cancel-prewarm-session`
  channel + preload 暴露 + vite-env 类型。
- 测试：`maker.test.ts` prewarm 用例、`cursorDraftPrewarmContract.test.ts`。

`waitForSessionBootstrap`（#3 标题错峰用）保留；其 `prewarmedSessionHandles` 查询分支随
prewarm 一并删除，只留 `activeSessions` 路径。

### 配置不丢

cursor `startSession` 直接消费 opts 做 initial config（`mutableModel` / `desiredModel` /
`mutableEffort` / `desiredEffort` / `mutableFastMode` / `mutablePermissionMode` /
`mutablePlanMode` 均由 opts 初始化），bootstrap 收尾按 desired apply。回退后走
`agent.startSession({...startOpts})`，配置与 prewarm 接管时一致。

## Consequences

- 用户感知：点发送立刻跳转 + 显示「正在启动…」，不再冻结 5-10s。
- 首条到 token 的总时长不变（cursor-agent `session/new` ~6-9s，上游限制，spec #40 已确认
  改不动）；等待形态从「死界面」变「有反馈」。
- 预热命中时省下的 ~6s bootstrap 不再获得（每次发送都付完整 bootstrap），但由后台化 +
  排队覆盖，UI 不空等。与 codex / claude-code 行为对齐。
- 验收口径：点发送到 navigate < 200ms（UI 不冻结）；首 token 时长不设硬门槛。
- 不触发兼容性红线：prewarm 三 IPC channel 纯内部使用，非 wire protocol，无插件 / 协议 /
  device-link 外部引用。
- 不违反 ADR 0001：仍每 session 独立 `cursor-agent acp` 子进程，无预热池、无进程复用。

## 血脉

纠正 [`736d392fc`] 对 spec #40（`8c600e0d` #42 + `aaa3f23b` #41）的偏离；#40 保持 closed。
