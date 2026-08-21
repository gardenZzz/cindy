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

**silent stop（静默收尾）**:
一个 turn 干了活却没交出答复,上游却按正常结束收尾(不报错),用户侧表现为「做到一半
看起来正常结束」。判据是**有没有交付答复**这个语义,不是最后一条上游消息长什么形状
--部分网关每轮都会在结束后追加一条零内容消息,按形状判会把已交付的 turn 全部误判。
命中后由桌面 main 的守卫决定自动续跑还是提示耗尽。
_Avoid_: 连接中断(UI 上的「连接中断,已自动继续」只是自动续跑的展示文案,与网络无关);
空响应(那是整轮零产出且用量为 0 的另一种终态)

**session bootstrap（后台化）**:
Agent 子进程从 spawn 到可接收首条 turn 的就绪过程(spawn + initialize + session/new
+ 初始配置)。对齐 Claude Code `sdkQuery` 形态:`startSession` 立即返回 handle,
bootstrap 在后台进行;首条消息经 accept 语义立刻接收,bootstrap 未就绪时进
`pendingPrompt` 排队,就绪后自动 flush。UI 用「正在启动…」状态覆盖,用户不空等。
见 ADR 0003;与「非阻塞预热(pre-warm, claim-if-ready)」相对--后者在草稿期提前
完成 bootstrap,二者都是**后台化**家族:预热被 claim-if-ready 限定为「发送热路径
零 await 就绪」的叠加允许项(ADR 0005),不构成 ADR 0003 回退对象的发送阻塞回归。

**非阻塞预热(pre-warm, claim-if-ready)**:
本地普通 Cursor 草稿打开后,客户端在后台把 Cursor 会话完整 bootstrap(spawn +
initialize + session/new + 档位)到「会话就绪」,发送时 claim-if-ready:已就绪则
直接接管、首条 turn 0 等待;未就绪/无预热则回退普通创建(`pendingPrompt` 排队
兜底,不阻塞)。与「session bootstrap(后台化)」的区别在**触发时机与就绪等待**:
bootstrap 是发送后才起、用户接受「正在启动…」;预热把 bootstrap 提前到草稿期,
claim 只查就绪标志、发送热路径任何地方都不 await 就绪。仅本地普通草稿
(非 worktree / device-link / remote);预热句柄是「一个已就绪的会话」,不是可复用
进程(ADR 0001/0004 隔离约束不变;跨会话进程池因 CURSOR_CONFIG_DIR 进程启动即
固定 + ADR 0004 禁共享 cli-config 暂不做)。见 ADR 0005 / spec #74。
_Avoid_: 预热池(那是跨会话进程复用的另一立项,本词条不含)
