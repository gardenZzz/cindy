// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Editor, Node as TiptapNode } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import HardBreak from '@tiptap/extension-hard-break';
import {
  buildListIndentDecorations,
  ComposerListIndentDecoration,
  listPrefixIndentStyle,
} from '@/components/new-chat/ComposerListIndentDecoration';
import { CjkPunctDecoration } from '@/components/new-chat/CjkPunctDecoration';

/**
 * composer 列表行缩进 decoration:
 * - buildListIndentDecorations 的范围计算(hardBreak 分行、多行、整行缩进);
 * - 真实编辑器集成:decoration 渲染进 DOM,打完前缀立即出现、删掉即消失;
 * - ChatInput 注册 + globals.css 样式存在的接线契约。
 */

let editor: Editor | null = null;

const TestAtom = TiptapNode.create({
  name: 'testAtom',
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,

  parseHTML() {
    return [{ tag: 'span[data-test-atom]' }];
  },

  renderHTML() {
    return ['span', { 'data-test-atom': '' }, 'chip'];
  },
});

function makeEditor(lines: string[]): Editor {
  const content: Array<Record<string, unknown>> = [];
  lines.forEach((line, i) => {
    if (i > 0) content.push({ type: 'hardBreak' });
    if (line.length > 0) content.push({ type: 'text', text: line });
  });
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [Document, Paragraph, Text, HardBreak, TestAtom, ComposerListIndentDecoration],
    content: { type: 'doc', content: [{ type: 'paragraph', content }] },
  });
  return editor;
}

function indentSpans(ed: Editor): string[] {
  return Array.from(ed.view.dom.querySelectorAll('span.composer-list-line-indent')).map(
    (el) => el.textContent ?? '',
  );
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe('buildListIndentDecorations', () => {
  it('builds paired hanging-indent variables without embedding user text', () => {
    const latinStyle = listPrefixIndentStyle('2. ');
    expect(latinStyle).toContain('--composer-list-hang:1.8ch;');
    expect(latinStyle).toContain('--composer-list-hang-negative:-1.8ch;');
    expect(latinStyle).not.toContain('2. ');

    const cjkStyle = listPrefixIndentStyle('10、');
    expect(cjkStyle).toContain('--composer-list-hang:calc(2ch + 1em);');
    expect(cjkStyle).toContain('--composer-list-hang-negative:calc(-2ch - 1em);');
    expect(cjkStyle).not.toContain('10、');
  });

  it('skips tab-indented lines instead of guessing a proportional-font tab width', () => {
    const ed = makeEditor(['\t1. item']);
    expect(buildListIndentDecorations(ed.state.doc).find()).toHaveLength(0);
  });

  it('decorates the full content of a single-line item', () => {
    const ed = makeEditor(['1. test']);
    const found = buildListIndentDecorations(ed.state.doc).find();
    expect(found).toHaveLength(1);
    expect(found[0].from).toBe(0);
    expect(found[0].to).toBe(9);
  });

  it('decorates each list line independently across hardBreaks', () => {
    const ed = makeEditor(['intro', '- item', '2. x']);
    const found = buildListIndentDecorations(ed.state.doc).find();
    expect(found).toHaveLength(2);
    // "intro"(5) + br(1) → "- item" 行起点 offset 6,contentBase 1
    expect(found[0].from).toBe(7);
    expect(found[0].to).toBe(13); // 整行 "- item"
    expect(found[1].from).toBe(14);
    expect(found[1].to).toBe(18); // 整行 "2. x"
  });

  it('decorates a prefix-only line (即时反馈:刚打完 `1. ` 就缩进)', () => {
    const ed = makeEditor(['1. ']);
    expect(buildListIndentDecorations(ed.state.doc).find()).toHaveLength(1);
  });

  it('does not decorate plain text lines', () => {
    const ed = makeEditor(['hello world', '3.14159']);
    expect(buildListIndentDecorations(ed.state.doc).find()).toHaveLength(0);
  });

  it('leaves lines containing inline atoms untouched so chips keep their inline geometry', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [Document, Paragraph, Text, HardBreak, TestAtom, ComposerListIndentDecoration],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '- before ' },
              { type: 'testAtom' },
              { type: 'text', text: ' after' },
            ],
          },
        ],
      },
    });
    expect(buildListIndentDecorations(editor.state.doc).find()).toHaveLength(0);
    expect(
      editor.view.dom
        .querySelector('[data-test-atom]')
        ?.classList.contains('composer-list-line-indent'),
    ).toBe(false);
  });
});

describe('ComposerListIndentDecoration in a real editor', () => {
  it('renders the indent span into the DOM for list lines', () => {
    const ed = makeEditor(['1. hello']);
    expect(ed.view.dom.querySelector('p.composer-list-block-indent')?.textContent).toBe(
      '1. hello',
    );
    expect(
      ed.view.dom
        .querySelector<HTMLElement>('p.composer-list-block-indent')
        ?.style.getPropertyValue('--composer-list-hang'),
    ).toBe('1.8ch');
  });

  it('keeps CJK punctuation inside a paragraph-level list wrapper', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        Paragraph,
        Text,
        HardBreak,
        CjkPunctDecoration,
        ComposerListIndentDecoration,
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '1. 中文，内容。继续' }],
          },
        ],
      },
    });
    expect(editor.view.dom.querySelectorAll('p.composer-list-block-indent')).toHaveLength(1);
    expect(editor.view.dom.querySelectorAll('span.composer-list-line-indent')).toHaveLength(0);
    expect(editor.view.dom.querySelectorAll('span[style*="font-family"]')).not.toHaveLength(0);
  });

  it('appears the moment the prefix becomes complete, and disappears when broken', () => {
    const ed = makeEditor(['1.']);
    expect(indentSpans(ed)).toHaveLength(0);
    // 打出空格,前缀完整 → 缩进立即出现
    ed.commands.insertContentAt(ed.state.doc.content.size - 1, ' ');
    expect(ed.view.dom.querySelector('.composer-list-block-indent')?.textContent).toBe('1. ');
    // 删掉空格 → 缩进消失
    ed.commands.deleteRange({
      from: ed.state.doc.content.size - 2,
      to: ed.state.doc.content.size - 1,
    });
    expect(ed.view.dom.querySelector('.composer-list-block-indent')).toBeNull();
  });
});

describe('wiring contract', () => {
  it('ChatInput registers ComposerListIndentDecoration', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'components', 'new-chat', 'ChatInput.tsx'),
      'utf8',
    );
    expect(src).toContain("import { ComposerListIndentDecoration } from './ComposerListIndentDecoration';");
    expect(src).toMatch(/CjkPunctDecoration,\s*\n\s*ComposerListIndentDecoration,/);
  });

  it('globals.css defines the indent class', () => {
    const css = readFileSync(resolve(__dirname, '..', 'styles', 'globals.css'), 'utf8');
    expect(css).toContain('.ProseMirror .composer-list-block-indent');
    expect(css).toContain('.ProseMirror span.composer-list-line-indent');
    expect(css).toContain('display: inline-block;');
    expect(css).toContain('width: 100%;');
    expect(css).toContain('padding-left: calc(1em + var(--composer-list-hang, 1.25em));');
    expect(css).toContain('text-indent: var(--composer-list-hang-negative, -1.25em);');
    expect(css).toContain('overflow-wrap: anywhere;');
    expect(css).not.toContain('word-break: break-all;');
  });
});
