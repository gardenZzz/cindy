import type { Editor } from '@tiptap/core';
import { Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import type { AgentInputReference } from '@cindy/maker-shared/agent-input-projection';

import type { MentionedResource } from '@/lib/fileTypes';
import { formatQuoteForSend } from '@/lib/chatQuotes';
import { formatMentionRef } from '@/lib/mentionRefFormat';
import {
  parseProjectDeepLinkHref,
  parseSessionDeepLinkHref,
  projectDisplayName,
} from '@/lib/deepLink';
import {
  COMPOSER_QUOTE_NODE_TYPE,
  composerQuoteAttrsToChatQuote,
  serializeComposerContentBlocksWithRanges,
  type ComposerQuoteAttrs,
  type ComposerSerializedBlock,
} from '@/lib/composerQuoteDocument';
import type { PastedTextRange, SlashCommandRange } from '@/lib/imageRef';

import type { MentionChipAttrs } from './MentionChipNode';
import type { PastedTextChipAttrs } from './PastedTextChipNode';
import { getDecoratedSlashCommandMatches, type SlashCommandMatch } from './SlashCommandDecoration';
import { serializeSessionChipText } from './sessionLinkPaste';
import { serializeProjectChipText } from './pastePipeline';

export interface SerializedComposerContent {
  text: string;
  mentions: MentionedResource[];
  hasQuotes: boolean;
  agentReferences: AgentInputReference[];
  pastedTextRanges: PastedTextRange[];
  slashCommandRanges: SlashCommandRange[];
}

type OrderedMarker = '.' | ')' | '、';

function orderedListMarker(node: ProseMirrorNode): OrderedMarker {
  return node.attrs.marker === ')' || node.attrs.marker === '、' ? node.attrs.marker : '.';
}

function orderedListSeparator(node: ProseMirrorNode, marker: OrderedMarker): string {
  if (marker === '、') return '';
  return typeof node.attrs.separator === 'string' && /^[ \t]+$/.test(node.attrs.separator)
    ? node.attrs.separator
    : ' ';
}

function bulletListMarker(node: ProseMirrorNode): string {
  const marker = node.attrs.marker;
  return marker === '+' || marker === '*' || marker === '•' ? marker : '-';
}

function bulletListSeparator(node: ProseMirrorNode): string {
  return typeof node.attrs.separator === 'string' && /^[ \t]+$/.test(node.attrs.separator)
    ? node.attrs.separator
    : ' ';
}

/**
 * Convert the composer's structured document into the Markdown wire format.
 *
 * List markers are editor structure rather than paragraph text, so their
 * serialized width is included when projecting inline reference ranges.
 */
function serializeComposerDocument(
  doc: ProseMirrorNode,
  decoratedSlashMatches: readonly SlashCommandMatch[],
): SerializedComposerContent {
  const blocks: ComposerSerializedBlock[] = [];
  const mentions: MentionedResource[] = [];
  const seenMentions = new Set<string>();
  let hasQuotes = false;

  const addMention = (attrs: MentionChipAttrs) => {
    // Slash commands and deep links are represented in the wire text but are
    // not filesystem resources.
    if (attrs.kind === 'slash' || attrs.kind === 'session' || attrs.kind === 'project') return;
    const key = `${attrs.kind}:${attrs.path}`;
    if (seenMentions.has(key)) return;
    seenMentions.add(key);
    mentions.push({ type: attrs.kind, name: attrs.label, path: attrs.path });
  };

  const serializeParagraph = (
    paragraph: ProseMirrorNode,
    paragraphPosition: number,
    prefix = '',
  ) => {
    let buffer = prefix;
    let bufferAgentReferences: AgentInputReference[] = [];
    let bufferPastedTextRanges: PastedTextRange[] = [];
    let bufferSlashCommandRanges: SlashCommandRange[] = [];
    let emittedInlineSegment = false;
    let continuationAfterQuote: string | null = null;

    const flushText = (force = false) => {
      if (!force && !buffer) return;
      blocks.push({
        kind: 'text',
        text: buffer,
        ...(bufferAgentReferences.length > 0 ? { agentReferences: bufferAgentReferences } : {}),
        ...(bufferPastedTextRanges.length > 0 ? { pastedTextRanges: bufferPastedTextRanges } : {}),
        ...(bufferSlashCommandRanges.length > 0
          ? { slashCommandRanges: bufferSlashCommandRanges }
          : {}),
      });
      buffer = '';
      bufferAgentReferences = [];
      bufferPastedTextRanges = [];
      bufferSlashCommandRanges = [];
      emittedInlineSegment = true;
    };

    const appendSlashCommandRanges = (
      matches: readonly SlashCommandMatch[],
      documentStart: number,
      textLength: number,
      bufferStart: number,
    ) => {
      for (const match of matches) {
        if (match.from < documentStart || match.to > documentStart + textLength) continue;
        bufferSlashCommandRanges.push({
          start: bufferStart + match.from - documentStart,
          end: bufferStart + match.to - documentStart,
        });
      }
    };

    paragraph.forEach((child, childOffset) => {
      if (child.type.name === COMPOSER_QUOTE_NODE_TYPE) {
        hasQuotes = true;
        const quoteText = formatQuoteForSend(
          composerQuoteAttrsToChatQuote(child.attrs as ComposerQuoteAttrs),
        );
        if (prefix) {
          // A quote chip inside a list item is part of that item. Keeping it
          // in the current text block preserves the list marker. Put the
          // encoded quote on its own continuation lines so history parsing
          // can still recognize the private marker and source metadata.
          const continuationPrefix = ' '.repeat(prefix.length);
          const quoteLines = quoteText.split('\n');
          buffer += `\n${quoteLines
            .map((line) => `${continuationPrefix}${line}`)
            .join('\n')}`;
          continuationAfterQuote = continuationPrefix;
        } else {
          flushText();
          blocks.push({ kind: 'quote', text: quoteText });
          emittedInlineSegment = true;
        }
        return;
      }

      if (continuationAfterQuote !== null) {
        buffer += `\n${continuationAfterQuote}`;
        continuationAfterQuote = null;
      }

      if (child.type.name === 'mentionChip') {
        const attrs = child.attrs as MentionChipAttrs;
        addMention(attrs);
        if (attrs.kind === 'slash') {
          buffer += `/${attrs.path} `;
          return;
        }
        if (attrs.kind === 'session') {
          const wire = serializeSessionChipText(attrs);
          const start = buffer.length;
          buffer += wire;
          const target = parseSessionDeepLinkHref(attrs.path);
          if (target?.messageClientId) {
            bufferAgentReferences.push({
              kind: 'message',
              start,
              end: buffer.length,
              href: attrs.path,
              sessionId: target.sessionId,
              messageClientId: target.messageClientId,
              ...(attrs.agentText ? { text: attrs.agentText } : {}),
              ...(attrs.agentTextTruncated ? { truncated: true } : {}),
            });
          } else if (target) {
            bufferAgentReferences.push({
              kind: 'session',
              start,
              end: buffer.length,
              href: attrs.path,
              sessionId: target.sessionId,
              ...(attrs.titled && attrs.label ? { title: attrs.label } : {}),
            });
          }
          return;
        }
        if (attrs.kind === 'project') {
          const wire = serializeProjectChipText(attrs);
          const start = buffer.length;
          buffer += wire;
          const target = parseProjectDeepLinkHref(attrs.path);
          if (target) {
            bufferAgentReferences.push({
              kind: 'project',
              start,
              end: buffer.length,
              href: attrs.path,
              name: attrs.label || projectDisplayName(target.workingDir),
              workingDir: target.workingDir,
            });
          }
          return;
        }
        if (attrs.kind === 'dir') {
          buffer += `@${formatMentionRef(`${attrs.path}/`)}`;
          return;
        }
        if (attrs.kind === 'agent') {
          const path = attrs.path;
          buffer += path.includes('/')
            ? `@${formatMentionRef(path)}`
            : `@${formatMentionRef(path.replace(/\.md$/, ''))}`;
          return;
        }
        buffer += `@${formatMentionRef(attrs.path)}`;
        return;
      }

      if (child.type.name === 'pastedTextChip') {
        const attrs = child.attrs as PastedTextChipAttrs;
        const start = buffer.length;
        buffer += attrs.text;
        bufferPastedTextRanges.push({ start, end: buffer.length, display: attrs.display });
        return;
      }

      if (child.type.name === 'hardBreak') {
        buffer += '\n';
        return;
      }

      if (child.isText) {
        const childText = child.text ?? '';
        const bufferStart = buffer.length;
        const documentStart = paragraphPosition + 1 + childOffset;
        buffer += childText;
        appendSlashCommandRanges(
          decoratedSlashMatches,
          documentStart,
          childText.length,
          bufferStart,
        );
      }
    });

    // Preserve truly empty paragraphs as line breaks, but do not synthesize an
    // empty text segment after a quote chip at the end of a paragraph.
    flushText(!emittedInlineSegment);
  };

  const serializeList = (listNode: ProseMirrorNode, listPosition: number, indent: string) => {
    const isOrdered = listNode.type.name === 'orderedList';
    const start =
      typeof listNode.attrs.start === 'number' &&
      Number.isInteger(listNode.attrs.start) &&
      listNode.attrs.start > 0
        ? listNode.attrs.start
        : 1;
    const marker = orderedListMarker(listNode);
    const separator = orderedListSeparator(listNode, marker);

    listNode.forEach((item, itemOffset, itemIndex) => {
      if (item.type.name !== 'listItem') return;
      const itemPosition = listPosition + 1 + itemOffset;
      const itemMarker = isOrdered
        ? `${start + itemIndex}${marker}${separator}`
        : `${bulletListMarker(listNode)}${bulletListSeparator(listNode)}`;
      const itemIndent = `${indent}${' '.repeat(itemMarker.length)}`;
      let firstParagraph = true;

      item.forEach((child, childOffset) => {
        const childPosition = itemPosition + 1 + childOffset;
        if (child.type.name === 'paragraph') {
          serializeParagraph(
            child,
            childPosition,
            firstParagraph ? `${indent}${itemMarker}` : itemIndent,
          );
          firstParagraph = false;
          return;
        }
        if (child.type.name === 'bulletList' || child.type.name === 'orderedList') {
          serializeList(child, childPosition, itemIndent);
        }
      });
    });
  };

  doc.forEach((node, nodeOffset) => {
    if (node.type.name === COMPOSER_QUOTE_NODE_TYPE) {
      hasQuotes = true;
      blocks.push({
        kind: 'quote',
        text: formatQuoteForSend(composerQuoteAttrsToChatQuote(node.attrs as ComposerQuoteAttrs)),
      });
      return;
    }
    if (node.type.name === 'paragraph') {
      serializeParagraph(node, nodeOffset);
      return;
    }
    if (node.type.name === 'bulletList' || node.type.name === 'orderedList') {
      serializeList(node, nodeOffset, '');
    }
  });

  return {
    ...serializeComposerContentBlocksWithRanges(blocks),
    mentions,
    hasQuotes,
  };
}

export function serializeEditorContent(editor: Editor): SerializedComposerContent {
  return serializeComposerDocument(editor.state.doc, getDecoratedSlashCommandMatches(editor));
}

/**
 * Serialize a selected editor fragment for plain-text clipboard consumers.
 * Replacing an empty document with the open slice lets ProseMirror rebuild
 * list context around selections that begin or end inside a list item.
 */
export function serializeEditorSlice(editor: Editor | null, slice: Slice): string {
  if (!editor) {
    return slice.content.textBetween(0, slice.content.size, '\n');
  }

  try {
    const emptyDoc = editor.state.schema.topNodeType.createAndFill();
    if (!emptyDoc) throw new Error('composer schema cannot create an empty document');
    const state = EditorState.create({ schema: editor.state.schema, doc: emptyDoc });
    const replaced = state.tr.replace(0, state.doc.content.size, slice).doc;
    return serializeComposerDocument(replaced, []).text;
  } catch {
    return slice.content.textBetween(0, slice.content.size, '\n');
  }
}
