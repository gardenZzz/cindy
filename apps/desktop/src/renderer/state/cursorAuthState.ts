/** Cursor 登录态的进程内快照；发送热路径只读，不主动 spawn `cursor-agent status`。 */
let authenticated: boolean | null = null;

/** null = 本进程尚未从设置页或 ACP 预热得到权威结果。 */
export function peekCursorAuthState(): boolean | null {
  return authenticated;
}

export function setCursorAuthState(value: boolean): void {
  authenticated = value;
}
