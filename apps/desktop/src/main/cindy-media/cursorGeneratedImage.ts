/**
 * cursorGeneratedImage.ts — Cursor ACP 生图入仓的主机侧校验。
 * ---------------------------------------------------------------------------
 * #50 / 媒体规则：禁止任意本机路径 fs.readFile；入仓前 realpath + 受控根目录、
 * 常规文件、字节上限、魔数 MIME。base64 / data URL 先限长再解码。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sniffMediaMime } from './sniffMediaMime.js';

/** Cursor 单张生成图硬上限（读盘 / 解码后）。 */
export const MAX_CURSOR_GENERATED_IMAGE_BYTES = 15 * 1024 * 1024;

/**
 * base64 / data URL 字符串长度上限（约对应 15MiB 解码后体积，含 data: 头冗余）。
 * 在 Buffer.from 之前拦截，避免超大字符串撑爆 main 堆。
 */
export const MAX_CURSOR_IMAGE_DATA_CHARS = 22 * 1024 * 1024;

const IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

function foldPath(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/** child 是否位于 parent 目录树内（双方已是绝对路径）。 */
export function isPathInsideDir(parent: string, child: string): boolean {
  const relative = path.relative(foldPath(parent), foldPath(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * 解析并核验 Cursor 生图本机路径：realpath、regular file、字节上限、落在允许根内。
 * 成功返回可读绝对路径；失败抛可读 Error（供合成 isError tool_result）。
 */
export async function resolveCursorGeneratedImagePath(
  sourcePath: string,
  allowedRoots: readonly string[],
  opts?: { maxBytes?: number },
): Promise<string> {
  const maxBytes = opts?.maxBytes ?? MAX_CURSOR_GENERATED_IMAGE_BYTES;
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) {
    throw new Error('cursor generated image: empty path');
  }
  if (!path.isAbsolute(sourcePath)) {
    throw new Error('cursor generated image: path must be absolute');
  }

  const roots: string[] = [];
  for (const root of allowedRoots) {
    if (typeof root !== 'string' || !root.trim() || !path.isAbsolute(root)) continue;
    try {
      const resolvedRoot = await fs.realpath(root);
      const st = await fs.stat(resolvedRoot);
      if (st.isDirectory()) roots.push(resolvedRoot);
    } catch {
      // 可选根缺失不授权。
    }
  }
  if (roots.length === 0) {
    throw new Error('cursor generated image: no allowed roots available');
  }

  let resolved: string;
  let stat;
  try {
    resolved = await fs.realpath(sourcePath);
    stat = await fs.stat(resolved);
  } catch {
    throw new Error('cursor generated image: file not found');
  }
  if (!stat.isFile()) {
    throw new Error('cursor generated image: path is not a regular file');
  }
  if (stat.size > maxBytes) {
    throw new Error(`cursor generated image: exceeds ${maxBytes} bytes`);
  }
  if (!roots.some((root) => isPathInsideDir(root, resolved))) {
    throw new Error('cursor generated image: path outside allowed directories');
  }
  return resolved;
}

/** 会话常用允许根：workdir + 系统临时目录（Cursor 常见落盘处）。 */
export function defaultCursorGeneratedImageRoots(
  workingDir: string | null | undefined,
): string[] {
  const roots: string[] = [];
  if (typeof workingDir === 'string' && workingDir.trim() && path.isAbsolute(workingDir)) {
    roots.push(workingDir);
  }
  roots.push(os.tmpdir());
  return roots;
}

/**
 * 读盘 + 魔数 MIME；仅接受图片类型。返回 buffer 与 sniff 出的 mime。
 */
export async function readCursorGeneratedImageFile(
  resolvedPath: string,
  opts?: { maxBytes?: number },
): Promise<{ buffer: Buffer; mimeType: string }> {
  const maxBytes = opts?.maxBytes ?? MAX_CURSOR_GENERATED_IMAGE_BYTES;
  const buffer = await fs.readFile(resolvedPath);
  if (buffer.byteLength === 0) {
    throw new Error('cursor generated image: empty file');
  }
  if (buffer.byteLength > maxBytes) {
    throw new Error(`cursor generated image: exceeds ${maxBytes} bytes`);
  }
  const mimeType = sniffMediaMime(buffer);
  if (!mimeType || !IMAGE_MIME.has(mimeType)) {
    throw new Error('cursor generated image: unsupported or non-image content');
  }
  return { buffer, mimeType };
}

/**
 * 解析 Cursor imageData / data URL：限长 → 解码 → 魔数 MIME。
 * 不信任声明的 mime；sniff 失败即拒。
 */
export function decodeCursorGeneratedImageData(
  imageData: string,
  opts?: { maxChars?: number; maxBytes?: number },
): { buffer: Buffer; mimeType: string } {
  const maxChars = opts?.maxChars ?? MAX_CURSOR_IMAGE_DATA_CHARS;
  const maxBytes = opts?.maxBytes ?? MAX_CURSOR_GENERATED_IMAGE_BYTES;
  if (typeof imageData !== 'string' || !imageData.trim()) {
    throw new Error('cursor generated image: empty imageData');
  }
  if (imageData.length > maxChars) {
    throw new Error(`cursor generated image: imageData exceeds ${maxChars} chars`);
  }

  let buffer: Buffer;
  const dataUrl = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(imageData);
  if (dataUrl) {
    buffer = Buffer.from(dataUrl[2], 'base64');
  } else if (/^data:/i.test(imageData)) {
    throw new Error('cursor generated image: invalid data URL');
  } else {
    buffer = Buffer.from(imageData, 'base64');
  }

  if (buffer.byteLength === 0) {
    throw new Error('cursor generated image: empty buffer after decode');
  }
  if (buffer.byteLength > maxBytes) {
    throw new Error(`cursor generated image: exceeds ${maxBytes} bytes`);
  }
  const mimeType = sniffMediaMime(buffer);
  if (!mimeType || !IMAGE_MIME.has(mimeType)) {
    throw new Error('cursor generated image: unsupported or non-image content');
  }
  return { buffer, mimeType };
}

/**
 * 物化 Cursor 生成图来源（path 或 data/base64 url）为入仓字节。
 * `url` 已是 cindy-media / xdt-image 时原样透传（无读盘）。
 */
export async function materializeCursorGeneratedImageSource(
  data: { url?: string; path?: string },
  deps: {
    allowedRoots: readonly string[];
    ingestBuffer: (params: {
      buffer: Uint8Array;
      mimeType: string;
    }) => Promise<{ url: string; filename: string }>;
  },
): Promise<{ url: string; filename: string } | null> {
  if (data.url?.startsWith('xdt-image://') || data.url?.startsWith('cindy-media://')) {
    const base = data.url.split(/[\\/]/).pop() || 'generated-image.png';
    return { url: data.url, filename: base };
  }
  if (data.path) {
    const resolved = await resolveCursorGeneratedImagePath(data.path, deps.allowedRoots);
    const { buffer, mimeType } = await readCursorGeneratedImageFile(resolved);
    return deps.ingestBuffer({ buffer, mimeType });
  }
  if (data.url?.startsWith('data:')) {
    const { buffer, mimeType } = decodeCursorGeneratedImageData(data.url);
    return deps.ingestBuffer({ buffer, mimeType });
  }
  return null;
}
