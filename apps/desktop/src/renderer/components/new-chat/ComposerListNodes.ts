/**
 * Structured list nodes for the chat composer.
 *
 * The composer stores list structure in its ProseMirror document and only
 * turns it back into Markdown at send time. This keeps wrapping, nested
 * items, and inline atoms in one layout tree instead of estimating marker
 * widths with decorations.
 */
import { InputRule, Node, mergeAttributes, wrappingInputRule, type NodeConfig } from '@tiptap/core';
import { Fragment, type Node as PMNode, type NodeType } from '@tiptap/pm/model';
import { liftListItem, splitListItem } from '@tiptap/pm/schema-list';
import { Selection, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

const BULLET_MARKER_RE = /^([-+*•])([ \t]+)$/;
const ORDERED_MARKER_RE = /^(\d{1,6})([.)])\s$/;
const CJK_ORDERED_MARKER_RE = /^(\d{1,6})(、)$/;

type BulletMarker = '-' | '+' | '*' | '•';
type OrderedMarker = '.' | ')' | '、';

interface OrderedListAttrs {
  start: number;
  marker: OrderedMarker;
}

interface SelectedTaskPrefix {
  from: number;
  to: number;
  bodyIsEmpty: boolean;
  caretAtOrAfterPrefix: boolean;
  caretAtParagraphEnd: boolean;
}

interface PlainListParagraphMarker {
  kind: 'bullet' | 'ordered';
  prefixLength: number;
  attrs: Record<string, unknown>;
}

function plainListParagraphMarker(text: string): PlainListParagraphMarker | null {
  const bullet = text.match(/^([-+*•])([ \t]+)/);
  if (bullet) {
    return {
      kind: 'bullet',
      prefixLength: bullet[0].length,
      attrs: { marker: bullet[1], separator: bullet[2] },
    };
  }
  const ordered = text.match(/^(\d{1,6})([.)])([ \t]+)/);
  if (ordered) {
    return {
      kind: 'ordered',
      prefixLength: ordered[0].length,
      attrs: { start: Number(ordered[1]), marker: ordered[2] },
    };
  }
  const cjkOrdered = text.match(/^(\d{1,6})(、)([ \t]*)/);
  if (cjkOrdered) {
    return {
      kind: 'ordered',
      prefixLength: cjkOrdered[0].length,
      attrs: { start: Number(cjkOrdered[1]), marker: '、' },
    };
  }
  return null;
}

function hardBreakListInputRule(
  find: RegExp,
  type: NodeType,
  getAttributes: (match: RegExpMatchArray) => object = () => ({}),
): InputRule {
  return new InputRule({
    find: (text) => {
      const lineStart = text.lastIndexOf('\n');
      if (lineStart < 0) return null;
      const line = text.slice(lineStart + 1);
      const match = line.match(find);
      if (!match) return null;
      return {
        text: line,
        index: lineStart + 1,
        data: { attributes: getAttributes(match) },
      };
    },
    handler: ({ state, range, match }) => {
      const $markerStart = state.doc.resolve(range.from);
      if ($markerStart.depth !== 1 || $markerStart.parent.type.name !== 'paragraph') return null;

      const paragraph = $markerStart.parent;
      const paragraphStart = $markerStart.start();
      const markerOffset = range.from - paragraphStart;
      const hardBreak = paragraph.nodeAt(markerOffset - 1);
      if (hardBreak?.type.name !== 'hardBreak') return null;

      const before = paragraph.content.cut(0, markerOffset - hardBreak.nodeSize);
      const after = paragraph.content.cut(range.to - paragraphStart);
      const paragraphType = state.schema.nodes.paragraph;
      const itemType = state.schema.nodes.listItem;
      if (!paragraphType || !itemType) return null;

      const leadingParagraph = paragraph.type.create(paragraph.attrs, before, paragraph.marks);
      const listParagraph = paragraphType.create(null, after);
      const list = type.create(
        (match.data?.attributes as Record<string, unknown> | undefined) ?? {},
        itemType.create(null, listParagraph),
      );
      const paragraphPosition = $markerStart.before(1);
      const replacement = Fragment.fromArray([leadingParagraph, list]);
      const tr = state.tr.replaceWith(
        paragraphPosition,
        paragraphPosition + paragraph.nodeSize,
        replacement,
      );
      const listPosition = paragraphPosition + leadingParagraph.nodeSize;
      tr.setSelection(TextSelection.create(tr.doc, listPosition + 3));
    },
  });
}

const listItemConfig: NodeConfig = {
  name: 'listItem',
  group: 'block',
  content: 'paragraph block*',
  defining: true,
  parseHTML() {
    return [{ tag: 'li' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['li', mergeAttributes(HTMLAttributes), 0];
  },
};

export const ComposerListItem = Node.create(listItemConfig);

export const ComposerBulletList = Node.create({
  name: 'bulletList',
  group: 'block',
  content: 'listItem+',
  defining: true,
  addAttributes() {
    return {
      marker: {
        default: '-',
        parseHTML: (element) => {
          const value = element.getAttribute('data-marker');
          return value === '+' || value === '*' || value === '•' ? value : '-';
        },
        renderHTML: (attributes) =>
          attributes.marker === '-' ? {} : { 'data-marker': attributes.marker },
      },
      separator: {
        default: ' ',
        parseHTML: (element) => element.getAttribute('data-separator') || ' ',
        renderHTML: (attributes) =>
          attributes.separator === ' ' ? {} : { 'data-separator': attributes.separator },
      },
    };
  },
  parseHTML() {
    return [{ tag: 'ul' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['ul', mergeAttributes(HTMLAttributes), 0];
  },
  addInputRules() {
    return [
      wrappingInputRule({
        find: BULLET_MARKER_RE,
        type: this.type,
        getAttributes: (match) => ({
          marker: match[1] as BulletMarker,
          separator: match[2],
        }),
      }),
      hardBreakListInputRule(BULLET_MARKER_RE, this.type, (match) => ({
        marker: match[1] as BulletMarker,
        separator: match[2],
      })),
    ];
  },
});

function orderedAttrs(match: RegExpMatchArray): OrderedListAttrs {
  const marker = (match[2] ?? '、') as OrderedMarker;
  return {
    start: Number(match[1] ?? 1),
    marker,
  };
}

export const ComposerOrderedList = Node.create({
  name: 'orderedList',
  group: 'block',
  content: 'listItem+',
  defining: true,
  addAttributes() {
    return {
      start: {
        default: 1,
        parseHTML: (element) => {
          const value = Number(element.getAttribute('start'));
          return Number.isInteger(value) && value > 0 ? value : 1;
        },
        renderHTML: (attributes) => (attributes.start === 1 ? {} : { start: attributes.start }),
      },
      marker: {
        default: '.',
        parseHTML: (element) => {
          const value = element.getAttribute('data-marker');
          return value === ')' || value === '、' ? value : '.';
        },
        renderHTML: (attributes) =>
          attributes.marker === '.' ? {} : { 'data-marker': attributes.marker },
      },
    };
  },
  parseHTML() {
    return [{ tag: 'ol' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const start = Number(node.attrs.start);
    const lastItem = start + Math.max(node.childCount - 1, 0);
    const markerDigits =
      Number.isInteger(start) && start > 0 && Number.isInteger(lastItem)
        ? String(lastItem).length
        : 1;
    return [
      'ol',
      mergeAttributes(HTMLAttributes, { 'data-marker-digits': String(markerDigits) }),
      0,
    ];
  },
  addInputRules() {
    return [
      wrappingInputRule({
        find: ORDERED_MARKER_RE,
        type: this.type,
        getAttributes: orderedAttrs,
      }),
      wrappingInputRule({
        find: CJK_ORDERED_MARKER_RE,
        type: this.type,
        getAttributes: orderedAttrs,
      }),
      hardBreakListInputRule(ORDERED_MARKER_RE, this.type, orderedAttrs),
      hardBreakListInputRule(CJK_ORDERED_MARKER_RE, this.type, orderedAttrs),
    ];
  },
});

function selectedListItemDepth(view: EditorView): number | null {
  const { $from } = view.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === 'listItem') return depth;
  }
  return null;
}

function selectedListItemIsEmpty(view: EditorView, depth: number): boolean {
  const item = view.state.selection.$from.node(depth);
  return (
    item.childCount === 1 &&
    item.firstChild?.type.name === 'paragraph' &&
    item.firstChild.content.size === 0
  );
}

function selectedListItemIsOnlyTaskParagraph(view: EditorView, depth: number): boolean {
  const item = view.state.selection.$from.node(depth);
  return item.childCount === 1 && item.firstChild === view.state.selection.$from.parent;
}

function selectedTaskPrefix(view: EditorView): SelectedTaskPrefix | null {
  const { $from } = view.state.selection;
  const paragraph = $from.parent;
  if (paragraph.type.name !== 'paragraph') return null;
  const text = paragraph.textBetween(0, paragraph.content.size, '\uFFFC', '\uFFFC');
  const match = text.match(/^\[[ xX]\](?:[ \t]+|$)/);
  if (!match) return null;
  return {
    from: $from.start(),
    to: $from.start() + match[0].length,
    bodyIsEmpty: text.slice(match[0].length).trim().length === 0,
    caretAtOrAfterPrefix: $from.parentOffset >= match[0].length,
    caretAtParagraphEnd: $from.parentOffset === paragraph.content.size,
  };
}

function clearTaskPrefixAndLift(
  view: EditorView,
  itemDepth: number,
  taskPrefix: SelectedTaskPrefix,
): boolean {
  if (
    !taskPrefix.bodyIsEmpty ||
    !taskPrefix.caretAtParagraphEnd ||
    !selectedListItemIsOnlyTaskParagraph(view, itemDepth)
  ) {
    return false;
  }
  view.dispatch(view.state.tr.delete(taskPrefix.from, taskPrefix.to));
  const itemType = view.state.schema.nodes.listItem;
  if (itemType) liftListItem(itemType)(view.state, view.dispatch);
  return true;
}

function backspaceAfterStructuredList(view: EditorView): boolean {
  const { state } = view;
  const { $from } = state.selection;
  if (
    !state.selection.empty ||
    $from.depth !== 1 ||
    $from.parent.type.name !== 'paragraph' ||
    $from.parent.content.size !== 0 ||
    $from.parentOffset !== 0
  ) {
    return false;
  }
  const paragraphPosition = $from.before(1);
  const previous = state.doc.resolve(paragraphPosition).nodeBefore;
  if (previous?.type.name !== 'bulletList' && previous?.type.name !== 'orderedList') return false;

  const tr = state.tr.delete(paragraphPosition, paragraphPosition + $from.parent.nodeSize);
  tr.setSelection(Selection.near(tr.doc.resolve(paragraphPosition), -1));
  view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Continue a structured list on the composer's explicit newline shortcuts.
 * An empty item exits the list; a non-empty item becomes two sibling items.
 * Markdown task prefixes remain editable text, with new items reset to
 * unchecked state.
 */
export function handleStructuredListBreak(view: EditorView): boolean {
  const { state } = view;
  const itemType = state.schema.nodes.listItem;
  const itemDepth = selectedListItemDepth(view);
  if (!itemType || !state.selection.empty || itemDepth === null) return false;
  const taskPrefix = selectedTaskPrefix(view);
  if (
    taskPrefix?.bodyIsEmpty &&
    taskPrefix.caretAtOrAfterPrefix &&
    taskPrefix.caretAtParagraphEnd
  ) {
    if (!selectedListItemIsOnlyTaskParagraph(view, itemDepth)) return false;
    return clearTaskPrefixAndLift(view, itemDepth, taskPrefix);
  }
  if (selectedListItemIsEmpty(view, itemDepth)) {
    return liftListItem(itemType)(state, view.dispatch);
  }
  const split = splitListItem(itemType)(state, view.dispatch);
  if (split && taskPrefix?.caretAtOrAfterPrefix) {
    view.dispatch(view.state.tr.insertText('[ ] ').scrollIntoView());
  }
  return split;
}

/** Exit an empty structured item with one Backspace, matching plain-list input. */
export function handleStructuredListBackspace(view: EditorView): boolean {
  const { state } = view;
  if (backspaceAfterStructuredList(view)) return true;
  const itemType = state.schema.nodes.listItem;
  const { $from } = state.selection;
  const itemDepth = selectedListItemDepth(view);
  const taskPrefix = selectedTaskPrefix(view);
  if (
    !itemType ||
    !state.selection.empty ||
    itemDepth === null ||
    (taskPrefix
      ? !taskPrefix.bodyIsEmpty ||
        !taskPrefix.caretAtOrAfterPrefix ||
        !taskPrefix.caretAtParagraphEnd ||
        !selectedListItemIsOnlyTaskParagraph(view, itemDepth)
      : $from.parentOffset !== 0 || !selectedListItemIsEmpty(view, itemDepth))
  ) {
    return false;
  }
  if (taskPrefix) return clearTaskPrefixAndLift(view, itemDepth, taskPrefix);
  return liftListItem(itemType)(state, view.dispatch);
}

/**
 * Upgrade a plain list row appended by paste, IME, dictation, or another
 * direct transaction that does not run input rules.
 *
 * The command is intentionally scoped to the final top-level paragraph and
 * an end-of-document caret. Restored documents and multi-row text are
 * normalized before insertion; this closes the remaining live-editing gap
 * without rescanning or rebuilding the full document after every keystroke.
 */
function getTrailingPlainListParagraph(view: EditorView): {
  paragraph: PMNode;
  marker: PlainListParagraphMarker;
  paragraphPosition: number;
} | null {
  const { state } = view;
  const { $from } = state.selection;
  if (
    !state.selection.empty ||
    $from.depth !== 1 ||
    $from.parent.type.name !== 'paragraph' ||
    $from.parentOffset !== $from.parent.content.size ||
    $from.after(1) !== state.doc.content.size
  ) {
    return null;
  }

  const paragraph = $from.parent;
  const text = paragraph.textBetween(0, paragraph.content.size, '\uFFFC', '\uFFFC');
  const marker = plainListParagraphMarker(text);
  const first = paragraph.firstChild;
  if (!marker || first?.type.name !== 'text' || (first.text?.length ?? 0) < marker.prefixLength) {
    return null;
  }
  return { paragraph, marker, paragraphPosition: $from.before(1) };
}

export function hasTrailingPlainListParagraph(view: EditorView): boolean {
  return getTrailingPlainListParagraph(view) !== null;
}

export function promoteTrailingPlainListParagraph(view: EditorView): boolean {
  const trailing = getTrailingPlainListParagraph(view);
  if (!trailing) return false;
  const { state } = view;
  const { paragraph, marker, paragraphPosition } = trailing;

  const paragraphType = state.schema.nodes.paragraph;
  const itemType = state.schema.nodes.listItem;
  const listType =
    marker.kind === 'ordered' ? state.schema.nodes.orderedList : state.schema.nodes.bulletList;
  if (!paragraphType || !itemType || !listType) return false;

  const body = paragraph.content.cut(marker.prefixLength);
  const list = listType.create(
    marker.attrs,
    itemType.create(null, paragraphType.create(paragraph.attrs, body)),
  );
  const tr = state.tr.replaceWith(paragraphPosition, paragraphPosition + paragraph.nodeSize, list);
  tr.setSelection(TextSelection.atEnd(tr.doc));
  view.dispatch(tr.scrollIntoView());
  return true;
}
