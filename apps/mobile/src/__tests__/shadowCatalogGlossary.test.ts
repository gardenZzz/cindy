/**
 * 影子 catalog 的术语表门禁。
 *
 * mobile 有一批**不走 i18next** 的手写四语 catalog(loginMessages / newSessionMessages),
 * 原因是它们在 React 渲染树之外、更早期被同步调用。根脚本 check-i18n-glossary.mjs 只扫
 * locale JSON,扫不到这些 .ts —— 这是引入术语表时明确记录在案的盲区,本测试把它补上。
 *
 * 走 vitest 而不是扩展根脚本:vitest 本就能解析 TS 与路径别名,直接 import 拿到运行时对象,
 * 比在 node 脚本里正则抠 TS 源码可靠得多(嵌套结构下正则根本判不准 locale 归属)。
 * 规则函数复用 scripts/shared/glossary-rules.mjs,与根门禁同一套判定,不另写一份。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { authErrorMessages, loginMessages } from '@/auth/loginMessages';
import { newSessionMessages } from '@/session/newSessionMessages';
import {
  ELLIPSIS_LOCALES,
  HALFWIDTH_PUNCT_LOCALES,
  findCaseMismatch,
  findHalfWidthPunct,
  hasAsciiEllipsis,
  makeExemptChecker,
  occursIn,
  stripNonProse,
} from '../../../../scripts/shared/glossary-rules.mjs';

const REPO_ROOT = resolve(__dirname, '../../../..');

interface GlossaryTerm {
  id: string;
  status: 'decided' | 'proposed';
  en: string;
  translations: Record<string, string>;
  forbidden?: Record<string, (string | { text: string; whenEn: string })[]>;
  exempt?: string[];
  checkCase?: boolean;
}

const glossary = JSON.parse(
  readFileSync(resolve(REPO_ROOT, 'i18n/glossary.json'), 'utf8'),
) as { locales: string[]; sourceLocale: string; terms: GlossaryTerm[] };

/**
 * 把影子 catalog 摊平成 (source, locale, key, value)。
 * source 前缀与根脚本的 `mobile/<ns>:` 保持同一形态,便于 exempt 复用同一套写法。
 */
function collectEntries(): { locale: string; key: string; value: string }[] {
  const out: { locale: string; key: string; value: string }[] = [];

  // loginMessages: locale → key → string
  for (const [locale, table] of Object.entries(loginMessages)) {
    for (const [key, value] of Object.entries(table)) {
      out.push({ locale, key: `mobile/loginMessages:${key}`, value });
    }
  }

  // authErrorMessages: errorCode → locale → string(与上面维度相反)
  for (const [code, table] of Object.entries(authErrorMessages)) {
    for (const [locale, value] of Object.entries(table)) {
      out.push({ locale, key: `mobile/authErrorMessages:${code}`, value });
    }
  }

  // newSessionMessages: locale → key → string
  for (const [locale, table] of Object.entries(newSessionMessages)) {
    for (const [key, value] of Object.entries(table)) {
      out.push({ locale, key: `mobile/newSessionMessages:${key}`, value });
    }
  }

  return out;
}

const entries = collectEntries();

describe('影子 catalog 术语一致性', () => {
  it('catalog 非空且覆盖全部支持语言（防止 import 失效后测试静默通过）', () => {
    expect(entries.length).toBeGreaterThan(0);
    const seen = new Set(entries.map((e) => e.locale));
    for (const locale of glossary.locales) {
      expect(seen.has(locale), `影子 catalog 缺 ${locale}`).toBe(true);
    }
  });

  it('不使用术语表的禁用译法', () => {
    const violations: string[] = [];
    for (const term of glossary.terms) {
      if (term.status !== 'decided') continue;
      const isExempt = makeExemptChecker(term.exempt);
      for (const { locale, key, value } of entries) {
        if (isExempt(key)) continue;
        for (const entry of term.forbidden?.[locale] ?? []) {
          // 条件禁用（{ text, whenEn }）依赖英文源判断，而影子 catalog 的 en 表
          // 与 zh 表是同一份对象的不同 locale 分支，这里按 key 取同名英文条目。
          const bad = typeof entry === 'string' ? entry : entry.text;
          const whenEn = typeof entry === 'string' ? null : entry.whenEn;
          if (!occursIn(stripNonProse(value), bad)) continue;
          if (whenEn) {
            const source = entries.find((e) => e.key === key && e.locale === glossary.sourceLocale)?.value;
            const re = new RegExp(
              `(?<![A-Za-z0-9_-])${whenEn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?(?![A-Za-z0-9_-])`,
              'i',
            );
            if (!source || !re.test(source)) continue;
          }
          const expected = term.translations?.[locale] || term.en;
          violations.push(`${locale} ${key}: 「${bad}」应为「${expected}」— ${value.slice(0, 40)}`);
        }
      }
    }
    expect(violations, `影子 catalog 命中禁用译法:\n${violations.join('\n')}`).toEqual([]);
  });

  it('保留英文的术语大小写形态统一', () => {
    const violations: string[] = [];
    for (const term of glossary.terms) {
      if (term.status !== 'decided' || term.checkCase === false) continue;
      const isExempt = makeExemptChecker(term.exempt);
      for (const { locale, key, value } of entries) {
        if (isExempt(key)) continue;
        const standard = term.translations?.[locale];
        if (!standard || standard !== term.en) continue;
        const hit = findCaseMismatch(stripNonProse(value), standard);
        if (hit) violations.push(`${locale} ${key}: 「${hit}」应为「${standard}」`);
      }
    }
    expect(violations, `影子 catalog 大小写不统一:\n${violations.join('\n')}`).toEqual([]);
  });

  it('标点风格符合各语言规则', () => {
    const violations: string[] = [];
    for (const { locale, key, value } of entries) {
      const prose = stripNonProse(value);
      if (HALFWIDTH_PUNCT_LOCALES.has(locale)) {
        const mark = findHalfWidthPunct(prose);
        if (mark) violations.push(`${locale} ${key}: 中文后半角「${mark}」— ${value.slice(0, 40)}`);
      }
      if (ELLIPSIS_LOCALES.has(locale) && hasAsciiEllipsis(prose)) {
        violations.push(`${locale} ${key}: 省略号应为「…」— ${value.slice(0, 40)}`);
      }
    }
    expect(violations, `影子 catalog 标点不规范:\n${violations.join('\n')}`).toEqual([]);
  });
});
