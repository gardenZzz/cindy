/**
 * cursorGeneratedImage.test.ts — Cursor 生图主机校验单测。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_CURSOR_GENERATED_IMAGE_BYTES,
  MAX_CURSOR_IMAGE_DATA_CHARS,
  decodeCursorGeneratedImageData,
  defaultCursorGeneratedImageRoots,
  isPathInsideDir,
  materializeCursorGeneratedImageSource,
  readCursorGeneratedImageFile,
  resolveCursorGeneratedImagePath,
} from '../cursorGeneratedImage.js';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);

let tmpRoot = '';
let workDir = '';
let outsideDir = '';

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-gen-img-'));
  workDir = path.join(tmpRoot, 'workdir');
  outsideDir = path.join(tmpRoot, 'private');
  fs.mkdirSync(workDir);
  fs.mkdirSync(outsideDir);
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('isPathInsideDir', () => {
  it('accepts nested paths and rejects siblings', () => {
    expect(isPathInsideDir('/a/b', '/a/b/c.png')).toBe(true);
    expect(isPathInsideDir('/a/b', '/a/other/c.png')).toBe(false);
  });
});

describe('resolveCursorGeneratedImagePath', () => {
  it('allows regular files under workdir', async () => {
    const file = path.join(workDir, 'ok.png');
    fs.writeFileSync(file, PNG_BYTES);
    // Windows 上 os.tmpdir() 可能是短路径(RUNNER~1),realpath 返回长路径(runneradmin);
    // 两侧都 realpath 一次再比,避免 8.3 vs 长路径假失败。
    const expected = fs.realpathSync(file);
    await expect(resolveCursorGeneratedImagePath(file, [workDir])).resolves.toBe(expected);
  });

  it('rejects paths outside allowed roots', async () => {
    const file = path.join(outsideDir, 'secret.png');
    fs.writeFileSync(file, PNG_BYTES);
    await expect(resolveCursorGeneratedImagePath(file, [workDir])).rejects.toThrow(
      /outside allowed/,
    );
  });

  it('rejects oversized files before full ingest', async () => {
    const file = path.join(workDir, 'huge.png');
    fs.writeFileSync(file, Buffer.alloc(100));
    await expect(
      resolveCursorGeneratedImagePath(file, [workDir], { maxBytes: 10 }),
    ).rejects.toThrow(/exceeds/);
  });

  it('rejects relative paths', async () => {
    await expect(resolveCursorGeneratedImagePath('rel.png', [workDir])).rejects.toThrow(
      /absolute/,
    );
  });
});

describe('readCursorGeneratedImageFile / decodeCursorGeneratedImageData', () => {
  it('sniffs png magic and rejects non-image bytes', async () => {
    const file = path.join(workDir, 'magic.png');
    fs.writeFileSync(file, PNG_BYTES);
    await expect(readCursorGeneratedImageFile(file)).resolves.toMatchObject({
      mimeType: 'image/png',
    });

    const junk = path.join(workDir, 'junk.bin');
    fs.writeFileSync(junk, Buffer.from('not-an-image'));
    await expect(readCursorGeneratedImageFile(junk)).rejects.toThrow(/unsupported/);
  });

  it('rejects overlong imageData before decode', () => {
    const huge = 'A'.repeat(MAX_CURSOR_IMAGE_DATA_CHARS + 1);
    expect(() => decodeCursorGeneratedImageData(huge)).toThrow(/exceeds/);
  });

  it('decodes data URL png', () => {
    const url = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
    expect(decodeCursorGeneratedImageData(url).mimeType).toBe('image/png');
  });
});

describe('materializeCursorGeneratedImageSource', () => {
  it('ingests allowed path via inject buffer', async () => {
    const file = path.join(workDir, 'm.png');
    fs.writeFileSync(file, PNG_BYTES);
    const result = await materializeCursorGeneratedImageSource(
      { path: file },
      {
        allowedRoots: defaultCursorGeneratedImageRoots(workDir),
        ingestBuffer: async () => ({
          url: 'cindy-media://blobs/test.png',
          filename: `test.png`,
        }),
      },
    );
    expect(result).toEqual({ url: 'cindy-media://blobs/test.png', filename: 'test.png' });
  });

  it('does not read outside paths', async () => {
    const file = path.join(outsideDir, 'nope.png');
    fs.writeFileSync(file, PNG_BYTES);
    let ingested = false;
    await expect(
      materializeCursorGeneratedImageSource(
        { path: file },
        {
          allowedRoots: [workDir],
          ingestBuffer: async () => {
            ingested = true;
            return { url: 'x', filename: 'x' };
          },
        },
      ),
    ).rejects.toThrow(/outside allowed/);
    expect(ingested).toBe(false);
  });
});

describe('limits', () => {
  it('exports positive caps', () => {
    expect(MAX_CURSOR_GENERATED_IMAGE_BYTES).toBeGreaterThan(1024 * 1024);
    expect(MAX_CURSOR_IMAGE_DATA_CHARS).toBeGreaterThan(MAX_CURSOR_GENERATED_IMAGE_BYTES);
  });
});
