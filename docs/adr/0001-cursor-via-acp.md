---
status: accepted
---

# Cursor 经官方 ACP 通道接入

Cindy 需要在 Claude Code / Codex 之外接入第三个 Agent(Cursor)。Cursor CLI 已官方
原生支持 ACP(`cursor-agent acp`,stdio + JSON-RPC + NDJSON,与 Codex app-server
接入同构),因此选择:ACP 作为唯一会话通道(headless `-p` 仅实现 oneShot),在
maker-core 内建 `agents/acp/` 通用层(只实现 ACP 标准面)+ `agents/cursor/` 薄子类
(vendor 扩展、auth、二进制发现),每 session 一个子进程,二进制不随包分发(检测
用户已装 + 引导官方安装,许可确认前不重分发)。

## Considered Options

- headless `-p --output-format stream-json`:无交互式权限回调、无 ask_question /
  plan review 通道,只配做 oneShot,弃。
- 社区 adapter(blowmage/cursor-agent-acp 等):官方已内建 ACP,多一层进程纯属冗余,弃。
- BYO「用户自定义 ACP agent」:量级是独立立项(任意二进制安全边界、capability 参差、
  配置 UI),不进本次范围;通用层为未来第一方 ACP agent(逐个显式加 AgentKind)预留。

## Consequences

- **Cursor 会话不注入任何 Cindy system prompt**(ACP v1 无注入面;经维护者确认,
  不采用「首条消息前置」或「写 workdir 规则文件」两个脏方案)。makerMemory /
  userPrompt 对 cursor 声明为不支持并在 UI 降级;向上游跟踪注入面 feature request。
- usage/token 无数据(上游已确认的 bug + 未实现的 usage_update):UI 优雅降级,
  translator 预接 `PromptResponse.usage` 与 `usage_update` 两通道,上游修复即点亮;
  不做本地估算。
- initialize 必须声明 `_meta.parameterizedModelPicker: true`,否则模型切换有静默
  失效的已知上游 bug;模型目录运行时来自 session/new(含 Auto),effort / fast 由
  参数化 config options 映射进 Cindy 现有 Effort / FastMode。
- 权限三档(Ask/Auto/Full)全部在 Cindy 客户端策略层实现;ACP `allow-always` 的
  持久化作用域待 spike 实测,机器级则退回 allow-once + Cindy 层会话记忆。
- 版本不受 Cindy pin(用户侧自更新),兼容性靠 initialize 握手 + capability 探测
  兜底;tool call 需客户端不活动超时 + `session/cancel` + 孤儿进程清理。
- 一期范围:Desktop 本地 + scheduler + mobile 新建/切换;remote-ssh / IM / Orca
  以 capability 显式不支持;cn / global 两版零区域分支。
