---
status: accepted
---

# ADR 0006: Harness 可选集合以运行时 roster 为唯一来源

Date: 2026-09-10

## Status

Accepted。适用于所有让用户挑 Harness 的入口（新建会话、自动化、IM 默认、Hook 工作目录、协同 worker 创建）。

## Context

Cursor 是 fork 专有的 Harness（ADR 0001），上游 `makecindy/cindy` 不认识它。上游 #4061 把各入口的 Harness + 模型选择统一到一个 `ModelSelector` 面板，并在 `docs/product-rules/model-selector-unified.md` 里定下「删除重复的 Harness 控件、经 `onUnifiedSelect` 一次提交」。合流后 Cursor 从五个入口里消失。

根因不是能力缺失，而是**可选集合被各入口分别硬编码成上游那三个值**：

- `useAvailableAgents.ts:50` 有一个与 `AgentKind` 平行的窄类型 `RuntimeAgentKind = 'claude-code' | 'codex' | 'pi'`；
- `useAvailableAgents.ts:82-83` 把被控端上报的 roster 过滤掉 `cursor`，而主进程 `listAvailableAgents()` 本来就返回它；
- `ScheduleChips.tsx:199` 的 `AgentTabs` 在合流中失去全部调用点，自动化入口连 Harness 控件都不剩；
- `ScheduleChips.tsx:1365` 的 `fastModeConfigurable={['codex', 'pi']}` 与派发端 `runner.ts:927`（fastMode 对 cursor 生效）互相矛盾。

派发链路始终是通的：`RemoteScheduleAgentKind = AgentKind` 天然含 `cursor`，`runner.ts` 认这个值。**能力健在，只是选不到。**

同一批入口还叠了第二个 bug：`unifiedModelSelection.ts:826` 的早退发生在 `keepModel` 豁免（:829）之前，于是一条已存 Cursor 模型的存量配置，打开选择器会看到空的 Cursor 段——把用户已有的选择静默抹掉。

移动端自动化入口（`apps/mobile/app/automations/[deviceId].tsx:1409`）没走这套，它的口径是 roster + 未知不过滤 + 存量恒显，一直正确。桌面与移动端因此对同一台被控端给出不同答案。

## Decision

**Harness 的可选集合只有一个来源：运行时 roster**（`maker:list-available-agents` → `useAvailableAgents`）。

1. **禁止入口自行枚举。** 任何 `'claude-code' | 'codex' | 'pi'` 形态的行内字面量、白名单 filter、窄化类型别名都不允许存在于选择器入口。`RuntimeAgentKind` 这类与 `AgentKind` 平行的窄类型删除，统一用 `AgentKind`。
2. **远程与本机同源。** device-link 分支不得再收窄被控端上报的 roster；能力判断归被控端。
3. **未知态 fail-open + 当前已选恒显。** roster 未回或拉取失败时不过滤；无论 roster 如何，用户当前已选中的 Harness 恒可见。理由：把「探测没回」和「确认没装」当同一件事，会在加载帧里抹掉用户的存量选择——这正是 `useCursorAvailability` 三态版注释所说的破坏性动作。可见性判断不再依赖 `useCursorAvailable()`（fail-closed，只适用于新建会话 composer 那种纯露出场景）。
4. **Harness 只在统一面板内切换。** 不保留与面板并行的第二个 Harness 控件（遵从上游 `model-selector-unified.md`）。

### 例外：`remoteProviders.unsupported` 一档

被控端老到连 providers 都枚举不了时（`CreateWorkerPopover.tsx:756` 的 `VendorSegmentedSwitcher` 降级分支），roster 通道大概率同样不可达，fail-open 会变成无依据的全部放开，让用户建出一个到触发时才失败的任务。这一档保持既有窄化（不含 Cursor），以注释说明，不套用第 3 条。

## Consequences

- Cursor 在自动化、IM 默认、Hook 工作目录、协同 worker 创建四处恢复可选；自动化的 Fast 开关与 `runner.ts` 口径一致。
- 桌面与移动端对同一台被控端给出相同的 Harness 集合。
- 存量配置不再被静默抹掉：已存 Cursor 模型的条目在任何加载状态下都列得出来。
- 下一次上游合流的判据变成一句可 grep 的话：入口里出现 Harness 字面量即违反本 ADR。fork 专有 Harness 不再随上游重构逐个掉队。
- 代价：roster 拿不到时列表偏宽，可能选到被控端未安装的 Harness，兜底是触发时的 `requireAgent` 失败。这是明确接受的取舍——宁可失败得晚且可见，不可在加载帧里悄悄改写用户的选择。
- 不在本 ADR 范围：伙伴（Ghost）快问快答。它持久化的 config 类型是三值（`GhostErrandPrefs.tsx:44`），扩到 Cursor 要动存储形状，属另一个决策。

## 血脉

承接 ADR 0001（Cursor 经 ACP 接入）。对应上游 #4061 引入的 `docs/product-rules/model-selector-unified.md`；术语见 `CONTEXT.md` 的 Harness 条与 `i18n/GLOSSARY.md` 的 Harness / Engine 条。
