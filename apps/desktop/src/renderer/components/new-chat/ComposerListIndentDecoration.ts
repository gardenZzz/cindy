/**
 * Tiptap 扩展 —— composer 列表行缩进(纯视觉,对齐 Claude 原生 App 的
 * "进入列表模式"反馈)。
 *
 * 行为:当某一"行"(段落内以 hardBreak 划分)以列表 / 待办 / 引用前缀开头
 * (`1. ` / `- ` / `- [ ] ` / `> ` 等,与列表接续共用 matchListPrefix 判定),
 * 给整条列表行包一层 inline decoration span,并把前缀的估算宽度写入 CSS
 * 变量。CSS 将这条列表行作为独立的换行容器:首行用负 text-indent 把标记
 * 悬挂在左侧,自动换行后的续行则从正文起点开始。用户打完 `1. `(空格落下)
 * 那一刻缩进立即出现,即"已进入列表状态"的视觉信号;空项退出(前缀被删)
 * 时缩进同步消失。
 *
 * 与 CjkPunctDecoration 相同的设计约束:
 * - decoration 只是渲染层,doc JSON / 草稿存储 / 发送内容里没有任何痕迹;
 * - doc 没变直接复用 DecorationSet,变了全量重扫(chat input 文本量小,
 *   全量成本可忽略,不值得做增量映射);
 * - 只在 doc 发生变化时重算,view.update 不参与 decoration 计算;
 * - 这是纯文本编辑器的视觉缩进,不改变 doc JSON / 发送文本。
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { matchListPrefix } from '@/lib/composerListContinuation';

const PLUGIN_KEY = new PluginKey<DecorationSet>('composerListIndentDecoration');

/** 行内一个非文本 inline 节点(mention chip 等)的占位符,与 applyListContinuation 一致。 */
const ATOM_PLACEHOLDER = '\uFFFC';
const CJK_PUNCTUATION_RE = /[\u3000-\u303f\uff00-\uffef]/;

/**
 * 将列表前缀换算成当前字体下的近似宽度。
 *
 * ChatInput 已启用 tabular-nums,所以数字直接用 1ch;句点、空格、方括号等
 * 窄字符按 0.4ch 估算;中文顿号按全角 1em。这里只生成数字和 CSS 单位,
 * 不会透传用户文本。含 Tab 的行由调用方跳过,因为比例字体下无法用 ch
 * 准确复现浏览器的 tab advance。
 */
export function listPrefixIndentStyle(prefix: string): string {
  let ch = 0;
  let em = 0;
  for (const char of prefix) {
    if (char >= '0' && char <= '9') {
      ch += 1;
    } else if (char === '、' || char === '\u3000') {
      em += 1;
    } else {
      ch += 0.4;
    }
  }
  const chValue = Number(ch.toFixed(2));
  const emValue = Number(em.toFixed(2));
  const positive =
    emValue > 0 ? `calc(${chValue}ch + ${emValue}em)` : `${chValue}ch`;
  const negative =
    emValue > 0 ? `calc(-${chValue}ch - ${emValue}em)` : `-${chValue}ch`;
  return [
    `--composer-list-hang:${positive}`,
    `--composer-list-hang-negative:${negative}`,
  ]
    .map((declaration) => `${declaration};`)
    .join('');
}

/**
 * 扫描 doc,给所有"列表行"的整行内容生成 inline decoration。
 * 返回的 from/to 是 doc-level position。导出以便单测直接断言范围。
 */
export function buildListIndentDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((block, blockPos) => {
    if (!block.isTextblock) return true; // 继续下钻找 textblock
    const contentBase = blockPos + 1; // +1 跨过 textblock 的开标记

    // 段落内按 hardBreak 切行;occupied 与 doc position 一一对应
    // (text 每字符 1、atom 节点占位符 1)。
    let lineText = '';
    let lineStartOffset = 0;
    let lineEndOffset = 0;
    let lineHasInlineAtom = false;
    const lines: Array<{
      text: string;
      start: number;
      end: number;
      hasInlineAtom: boolean;
    }> = [];
    const flushLine = () => {
      lines.push({
        text: lineText,
        start: lineStartOffset,
        end: lineEndOffset,
        hasInlineAtom: lineHasInlineAtom,
      });
    };
    block.nodesBetween(0, block.content.size, (node, pos) => {
      if (node.type.name === 'hardBreak') {
        // `pos` is the end of the current line in the textblock content.
        lineEndOffset = pos;
        flushLine();
        lineText = '';
        lineStartOffset = pos + node.nodeSize;
        lineEndOffset = lineStartOffset;
        lineHasInlineAtom = false;
      } else if (node.isText) {
        lineText += node.text ?? '';
        lineEndOffset = pos + node.nodeSize;
      } else {
        lineText += ATOM_PLACEHOLDER;
        lineEndOffset = pos + node.nodeSize;
        lineHasInlineAtom = true;
      }
      return false;
    });
    lineEndOffset = block.content.size;
    flushLine(); // 段落最后一行

    const addLineDecoration = (line: (typeof lines)[number]) => {
      const match = matchListPrefix(line.text);
      // Inline decorations apply their attributes to every covered inline node.
      // A mixed text/atom line would split the full-width wrapper around the atom
      // and turn chips into blocks, so leave those lines untouched.
      // Tab-indented and CJK-punctuated lines are also skipped in the inline
      // fallback: their rendered width cannot be represented safely by a split
      // inline wrapper.
      if (
        !match ||
        line.hasInlineAtom ||
        line.text.slice(0, match.prefixLength).includes('\t') ||
        CJK_PUNCTUATION_RE.test(line.text)
      ) {
        return;
      }
      const from = contentBase + line.start;
      const to = contentBase + line.end;
      const prefix = line.text.slice(0, match.prefixLength);
      decorations.push(
        Decoration.inline(from, to, {
          class: 'composer-list-line-indent',
          style: listPrefixIndentStyle(prefix),
        }),
      );
    };

    if (lines.length === 1) {
      const [line] = lines;
      const match = line && matchListPrefix(line.text);
      const prefix = match ? line.text.slice(0, match.prefixLength) : '';
      // A node decoration stays on the paragraph even when CjkPunctDecoration
      // adds nested inline spans, so punctuation cannot split the list wrapper.
      if (
        line &&
        match &&
        !line.hasInlineAtom &&
        !prefix.includes('\t')
      ) {
        decorations.push(
          Decoration.node(blockPos, blockPos + block.nodeSize, {
            class: 'composer-list-block-indent',
            style: listPrefixIndentStyle(prefix),
          }),
        );
      }
    } else {
      lines.forEach(addLineDecoration);
    }

    return false; // textblock 内部已手动扫过,不再下钻
  });

  return DecorationSet.create(doc, decorations);
}

export const ComposerListIndentDecoration = Extension.create({
  name: 'composerListIndentDecoration',

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: PLUGIN_KEY,
        state: {
          init(_config, state: EditorState) {
            return buildListIndentDecorations(state.doc);
          },
          apply(tr: Transaction, old: DecorationSet) {
            if (!tr.docChanged) return old;
            return buildListIndentDecorations(tr.doc);
          },
        },
        props: {
          decorations(state) {
            return this.getState(state) ?? DecorationSet.empty;
          },
        },
        // 注:曾有一个 view().update 里 `if (view.composing) return` 的"IME 保护",
        // 但重算发生在上面的 state.apply(只看 tr.docChanged),view.update 在视图更新
        // 之后才跑、DecorationSet 早已算好,该钩子等价 no-op(greptile P2)——已删除。
        // 真要在 IME 期跳过重算,应在 apply 里按 composition 事务标记判断,而非此处。
      }),
    ];
  },
});
