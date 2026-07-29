---
status: accepted
---

# Agent 图片传输的端到端契约

Cindy 把用户附的本地图片送进 Agent 会话时,跨了三层:composer 给出的路径/声明 →
共享 image resizer → 各 Agent 的 prompt block 构造。这条链在 Cursor 接入(#3)期间
连续三轮 review 各出一次缺陷,每次形态不同、都不是同一个补丁能覆盖的:

1. capability 声明 `image.supported = true`,实际把图片降级成 `[image: /path]`
   文本占位——模型只看到路径字符串,看不到图像。
2. 改成真发 ACP `ImageContentBlock` 后,在 Electron Main 的 send 热路径上
   `readFileSync` 整图再 base64——大图/慢盘会冻住窗口与全部 IPC。
3. 改异步并接入 resizer 后,resizer 把 >500KB 的 PNG/JPEG 转成 WebP,而声明的
   mimeType 仍取自原 block——字节与声明格式不一致,上游可能拒收或无法解码。

三次都由 review 发现而非测试拦截,根因是这条链只有零散实现约定、没有写下来的契约。
本 ADR 把契约固化,新增或改动任何 Agent 的图片路径都要对齐。

## 契约

**C1 · 声明必须匹配字节。** prompt block 上报的 `mimeType` 必须描述**实际发出的
字节**,不是用户原始文件。resizer 可能改格式(当前实现统一转 WebP),因此凡是
resizer 返回了**替代路径**,MIME 一律从该路径推导;只有它原样返回传入路径
(低于阈值 / sharp 不可用 / 转换失败降级 / 非普通文件)才可沿用上游声明的 MIME。

**C2 · 读取必须异步。** 图片读取与编码发生在 Electron Main 进程,必须走
`fs.promises`,禁止 `readFileSync`。同一 turn 多图并发缩放,并发上限由 resizer
内部 semaphore 控制。

**C3 · capability 不得撒谎。** 声明 `image.supported = true` 就必须真发结构化
image block。做不到就把 capability 置 false 让 UI 降级,不得静默替换成文本占位
——UI 依据 capability 决定是否允许用户附图。

**C4 · 超限在编码前拦截。** 单图上限按 **resize 之后**的字节数判定,且必须在
base64 之前检查(base64 会再放大 4/3),超限给可读错误而非静默截断或发出坏图。

**C5 · 远程图不落这条链。** `http://` / `https://` 开头的路径按 URI 直传上游,
不下载、不缩放、不改 MIME。

## 测试要求

C1 的回归测试必须用**真正触发转换**的 fixture(大于 resizer 的 `skipUnderBytes`
阈值),并同时断言 outbound block 的**字节魔数**与 `mimeType` 两者一致。

这一条是从教训里来的:三轮的图片测试都用 8/64-byte 的 PNG,全都低于阈值、
根本走不到转换分支,所以断言形状全绿而缺陷照在。只断言 block 形状不算覆盖。
另需一条低于阈值时沿用原 MIME 的对照用例,防止改过头。

## Consequences

- 新接入的 Agent 若上游协议没有结构化 image 通道,按 C3 直接把 capability 置
  false,不做「转成文本描述」这类兼容——那是 1 的原始形态。
- resizer 未来若改成按源格式选择输出容器(而非统一 WebP),C1 的实现无需改动:
  判据是「是否返回了替代路径」,不是「是不是 WebP」。
- C2 对 mobile 侧不直接适用(不在 Electron Main),但异步读取仍是默认要求。
