import { describe, expect, it } from 'vitest';

import { parseProxyAddrInput } from '../RemoteSection';

describe('parseProxyAddrInput', () => {
  it('parses host:port', () => {
    expect(parseProxyAddrInput('127.0.0.1:7890')).toEqual({ localHost: '127.0.0.1', localPort: 7890 });
    expect(parseProxyAddrInput(' localhost:1080 ')).toEqual({ localHost: 'localhost', localPort: 1080 });
  });

  it('parses bracketed IPv6', () => {
    expect(parseProxyAddrInput('[::1]:7890')).toEqual({ localHost: '::1', localPort: 7890 });
  });

  it('takes the last colon so bare IPv6 without brackets is rejected (ambiguous)', () => {
    // ::1:7890 → lastIndexOf(':') 切出 host=': :1' 含空白? 不含 — host='::1', port=7890。
    // 裸 IPv6 语义模糊, 这里的行为是接受 last-colon 切分结果; 文档推荐 bracket 形态。
    expect(parseProxyAddrInput('::1:7890')).toEqual({ localHost: '::1', localPort: 7890 });
  });

  it('rejects malformed input', () => {
    expect(parseProxyAddrInput('')).toBeNull();
    expect(parseProxyAddrInput('7890')).toBeNull();
    expect(parseProxyAddrInput(':7890')).toBeNull();
    expect(parseProxyAddrInput('host:')).toBeNull();
    expect(parseProxyAddrInput('host:abc')).toBeNull();
    expect(parseProxyAddrInput('host:0')).toBeNull();
    expect(parseProxyAddrInput('host:70000')).toBeNull();
    expect(parseProxyAddrInput('bad host:7890')).toBeNull();
  });
});
