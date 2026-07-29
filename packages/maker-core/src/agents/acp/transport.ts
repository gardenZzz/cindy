/**
 * Transport — ACP JSON-RPC NDJSON 字节流的双向 transport 抽象。
 *
 * 与 codex app-server 同构: transport 只管一行进一行出, 不解析 JSON、不识别 method。
 * 1 transport = 1 进程 = 1 AcpClient (ACP 无 thread 多路复用)。
 */

/** 一条 NDJSON 行 (不含尾部 `\n`)。callback 必须 sync return。 */
export type LineHandler = (line: string) => void;

/** Stderr / 协议外诊断行。 */
export type StderrHandler = (line: string) => void;

export interface TransportCloseInfo {
  reason: string;
}

export type CloseHandler = (info: TransportCloseInfo) => void;

/** 字节流双向 transport。一个 transport 实例只服务一个 client (1:1)。 */
export interface Transport {
  writeLine(line: string): Promise<void>;
  onLine(handler: LineHandler): () => void;
  onStderr?(handler: StderrHandler): () => void;
  onClose(handler: CloseHandler): () => void;
  close(reason?: string): Promise<void>;
}
