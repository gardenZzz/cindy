/**
 * 「本机装没装 cursor-agent」的单一真相 —— 渲染进程侧的缓存探测。
 *
 * 为什么要有这一层:探测本身很便宜(main 侧几次 fs 检查),但它是**异步**的,而它的结果
 * 决定 UI 上一个二选一的分支。此前四个消费点各自 `useState(false)` + 自己发一次 IPC,
 * 于是每个点都有一段「已经渲染成『没装』、探测还没回来」的窗口 —— 新建页那处的后果最重:
 * 它会在窗口期把停在 cursor 的草稿翻成 cc 且不翻回去,用户上次选的 vendor 与其 model /
 * effort / 权限档记忆一起作废。
 *
 * 所以这里把探测收成一个模块级缓存 + 单飞行(single-flight):启动时预热一次,之后所有
 * 消费点读到的都是已解析值,`null`(未知)窗口只在冷启动最初几毫秒存在。
 *
 * 缓存失效由**已知事件**驱动,不做轮询:设置页装完 cursor-agent 直接写入 true,
 * 设置页「重新检查」手动触发强制重探（spec #38）。其他所有消费点（包含发送门禁）均严格从缓存读取。
 */

/** null = 尚未探测出结果(冷启动窗口 / 刚被 invalidate)。 */
let cached: boolean | null = null;
let inflight: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

async function probe(): Promise<boolean> {
  // preload 未装配(单测 / 分离窗口早期帧)时按未装处理,不抛。
  const call = window.electronAPI?.maker?.agent?.getCursorBinaryStatus;
  if (!call) return false;
  try {
    return (await call()).installed;
  } catch {
    // 探测失败一律 fail-closed:未装时不露出 Cursor 入口,选了也只会在 spawn 阶段失败。
    return false;
  }
}

/** 同步读缓存。`null` = 还不知道 —— 调用方**不得**把它当成「没装」。 */
export function peekCursorAvailability(): boolean | null {
  return cached;
}

/**
 * 读「装没装」。已有缓存直接返回;并发调用共享同一次探测。
 * @param opts.refresh true = 丢掉缓存强制重探(设置页「重新检查」、门禁的否定结果复核)。
 */
export function getCursorAvailability(opts: { refresh?: boolean } = {}): Promise<boolean> {
  if (opts.refresh) {
    cached = null;
    inflight = null;
  } else {
    if (cached !== null) return Promise.resolve(cached);
    if (inflight) return inflight;
  }
  const pending = probe().then((installed) => {
    // 竞态:refresh 期间又被 setCursorAvailability 写过 → 以后写的为准,不回滚。
    if (inflight === pending) {
      cached = installed;
      inflight = null;
      emit();
    }
    return installed;
  });
  inflight = pending;
  return pending;
}

/** 已知结果直写(装完 cursor-agent 后设置页调用),省掉一次重探并立刻通知订阅方。 */
export function setCursorAvailability(installed: boolean): void {
  inflight = null;
  if (cached === installed) return;
  cached = installed;
  emit();
}

export function subscribeCursorAvailability(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 单测用:清掉模块级状态。 */
export const __testing = {
  reset(): void {
    cached = null;
    inflight = null;
    listeners.clear();
  },
};
