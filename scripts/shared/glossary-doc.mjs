/**
 * 从 i18n/glossary.json 渲染人读版 GLOSSARY.md。
 *
 * 抽成共享模块的原因:generate-glossary-doc.mjs 用它生成,check-i18n-glossary.mjs
 * 用同一份逻辑校验「文档是否与术语表同步」。两边共用一个渲染函数,才不会出现
 * 「校验说同步了、实际生成出来不一样」的假绿。
 */

/** 术语表在人读文档里的展示顺序:已裁决在前(按 id),待讨论在后(按 id)。 */
function sortTerms(terms) {
  return [...terms].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'decided' ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

/** 单元格转义:markdown 表格里的 | 会破坏列结构。 */
function cell(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** 译法展示:空字符串表示「保留英文原词」,直接显示 en 并标注。 */
function renderTranslation(term, locale) {
  const value = term.translations?.[locale];
  if (!value) return '—';
  if (value === term.en) return `\`${value}\`（保留英文）`;
  return value;
}

export function renderGlossaryDoc(glossary) {
  const terms = sortTerms(glossary.terms);
  const decided = terms.filter((t) => t.status === 'decided');
  const proposed = terms.filter((t) => t.status === 'proposed');
  const locales = glossary.locales.filter((l) => l !== glossary.sourceLocale);

  const lines = [];

  lines.push('<!-- 本文件由 scripts/generate-glossary-doc.mjs 自动生成，请勿手改。 -->');
  lines.push('<!-- 修改术语请编辑 i18n/glossary.json，然后运行 pnpm i18n:glossary-doc。 -->');
  lines.push('');
  lines.push('# Cindy 术语表');
  lines.push('');
  lines.push(
    '产品术语的唯一事实源。**新增或修改任何 UI 文案前先查这里**——同一个概念在不同界面译法不一致，' +
      '是用户能直接看见的质量问题。',
  );
  lines.push('');
  lines.push('- 数据正本：`i18n/glossary.json`（本文件由它生成）');
  lines.push('- 自动门禁：`pnpm check:i18n-glossary`（随 CI 阻断）');
  lines.push('- 存量豁免：`i18n/glossary-baseline.json`（只减不增）');
  lines.push('');

  lines.push('## 已裁决术语');
  lines.push('');
  if (decided.length === 0) {
    lines.push('（暂无）');
  } else {
    lines.push('这些术语的译法已定，**违反会阻断 CI**。');
    lines.push('');
    lines.push(`| 英文 | ${locales.join(' | ')} | 禁用译法 |`);
    lines.push(`| --- | ${locales.map(() => '---').join(' | ')} | --- |`);
    for (const term of decided) {
      const cells = locales.map((l) => cell(renderTranslation(term, l)));
      const forbidden = Object.entries(term.forbidden ?? {})
        .flatMap(([loc, words]) => words.map((w) => `${loc}: ${w}`))
        .join('；');
      lines.push(`| **${cell(term.en)}** | ${cells.join(' | ')} | ${cell(forbidden) || '—'} |`);
    }
    lines.push('');
    const withVariants = decided.filter((t) =>
      Object.values(t.alsoAllowed ?? {}).some((list) => list.length > 0),
    );
    if (withVariants.length > 0) {
      lines.push('### 分场合译法');
      lines.push('');
      lines.push('同一个词在不同语境下有不同说法。下面这些是**允许的**，按场合选，不会被门禁拦截。');
      lines.push('');
      lines.push('| 英文 | 语言 | 译法 | 什么场合 |');
      lines.push('| --- | --- | --- | --- |');
      for (const term of withVariants) {
        for (const [locale, list] of Object.entries(term.alsoAllowed ?? {})) {
          const primary = term.translations?.[locale];
          if (primary) {
            lines.push(`| **${cell(term.en)}** | ${locale} | ${cell(primary)} | 默认 |`);
          }
          for (const variant of list) {
            lines.push(`| ${cell(term.en)} | ${locale} | ${cell(variant.text)} | ${cell(variant.when)} |`);
          }
        }
      }
      lines.push('');
    }

    lines.push('### 裁决理由');
    lines.push('');
    for (const term of decided) {
      lines.push(`- **${term.en}** — ${term.note}`);
      if (term.exempt?.length) {
        lines.push(`  - 豁免范围：${term.exempt.map((e) => `\`${e}\``).join('、')}`);
      }
    }
  }
  lines.push('');

  lines.push('## 待讨论术语');
  lines.push('');
  if (proposed.length === 0) {
    lines.push('（暂无——所有已登记术语都已裁决）');
  } else {
    lines.push(
      '这些术语现状不一致但**尚未拍板**，guard 只告警不阻断。' +
        '裁决后把 `i18n/glossary.json` 里对应条目的 `status` 改为 `decided`、补上 `translations`，' +
        '再跑 `--update-baseline` 冻结存量。',
    );
    lines.push('');
    for (const term of proposed) {
      lines.push(`### ${term.en}`);
      lines.push('');
      lines.push(term.note);
      const forbidden = Object.entries(term.forbidden ?? {})
        .flatMap(([loc, words]) => words.map((w) => `\`${w}\`（${loc}）`))
        .join('、');
      if (forbidden) {
        lines.push('');
        lines.push(`已确定禁用：${forbidden}`);
      }
      lines.push('');
    }
  }

  lines.push('## 怎么加一条术语');
  lines.push('');
  lines.push('1. 在 `i18n/glossary.json` 的 `terms` 里加条目，`note` 必填——写清楚**为什么**这么定，');
  lines.push('   否则后人会反复推翻它。');
  lines.push('2. 拿不准时先设 `status: "proposed"`，让 guard 把现状规模统计出来再讨论。');
  lines.push('3. 跑 `pnpm i18n:glossary-doc` 重新生成本文件。');
  lines.push('4. 跑 `pnpm check:i18n-glossary` 看新规则命中多少存量；确认无误报后再');
  lines.push('   `node scripts/check-i18n-glossary.mjs --update-baseline` 冻结。');
  lines.push('');
  lines.push('**误报排查**：guard 已剥离 `{{插值}}`、URL、文件名，并把连字符视作词边界');
  lines.push('（`ssh-agent` 不会被判成产品 `Agent`）。仍需放行时用 `exempt`：完整路径精确匹配，');
  lines.push('或以 `.` 结尾的子树前缀。同形异义（SSH agent vs 产品 Agent）走 `exempt` 并在 `note` 里写明。');
  lines.push('');

  return `${lines.join('\n')}\n`;
}
