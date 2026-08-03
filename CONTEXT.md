# Cindy 客户端

Cindy 桌面/移动客户端:连接人与外部编码 Agent、模型和工具,自己不重造智能。
本文件只是领域词汇表(参见 `docs/agents/domain.md`);UI 文案术语的正本是
`i18n/GLOSSARY.md`,两者冲突时以后者为准。

## Language

**Agent**:
由 Cindy 连接与编排的外部编码智能体运行时(Claude Code、Codex 等),Agent Loop
属于上游厂商,Cindy 只负责连接层。
_Avoid_: 智能体、代理(UI 译法裁决见 `i18n/GLOSSARY.md` 的 Agent / Subagent / Proxy 条)

**ACP (Agent Client Protocol)**:
Zed / JetBrains 主导的开放标准,规定「客户端 ↔ Agent CLI」之间基于 stdio + JSON-RPC
的会话协议;Cindy 在此扮演 ACP client。
_Avoid_: 不带限定词的「协议」——本仓另有 `cindy-protocol`(Cindy 客户端↔服务端的
自有 wire protocol),两者互不相干

**Cursor**:
经官方 ACP 通道接入的第三个 Agent(上游产品 Cursor 的编码 agent,二进制名
`cursor-agent`);产品面统一称 "Cursor",kind 标识为 `cursor`。
_Avoid_: Cursor Agent、Cursor CLI(通道/二进制是实现细节,不作产品名)

**oneShot**:
maker-core 里不开会话、不进事件流的一次性 LLM 调用(起标题、生成摘要等辅助任务)。
_Avoid_: 单轮对话(那是会话内的一个 turn)

**session bootstrap（后台化）**:
Agent 子进程从 spawn 到可接收首条 turn 的就绪过程(spawn + initialize + session/new
+ 初始配置)。对齐 Claude Code `sdkQuery` 形态:`startSession` 立即返回 handle,
bootstrap 在后台进行;首条消息经 accept 语义立刻接收,bootstrap 未就绪时进
`pendingPrompt` 排队,就绪后自动 flush。UI 用「正在启动…」状态覆盖,用户不空等。
见 ADR 0003;与「预热(pre-warm)」相对--后者在草稿期提前完成 bootstrap,本仓不采用
(ADR 0001 排除进程预热/复用)。
