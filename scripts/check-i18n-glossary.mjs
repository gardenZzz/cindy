#!/usr/bin/env node
/**
 * i18n 术语表(glossary)一致性门禁。
 *
 * 与 check-i18n.mjs 的分工:后者只管 **key 结构**(缺 key / 孤儿 key / 类型冲突),
 * 保证「四语言 key 齐整」;本脚本管 **译文语义**,保证「同一个概念在所有地方译法一致」。
 * 两者互补,谁也替代不了谁。
 *
 * 校验对象:i18n/glossary.json 里登记的术语,对照 desktop + mobile 全部 locale JSON。
 *
 * 三类规则:
 *  1. forbidden —— 术语在某语言下的禁用译法(如 Agent 在 zh-CN 禁「代理」)。
 *  2. case-form —— 保留英文的术语必须统一大小写形态(如 Worker 不写 worker)。
 *  3. punctuation —— 两条规则适用范围不同:半角标点(汉字后禁 , : ; ! ?)只对 zh-CN
 *     生效——日文 UI 惯例本就用半角冒号,实测 ja 半角 124:78 才是主流;省略号(… 而非
 *     三个半角点)覆盖 zh-CN / ja / ko 三语,三者现状都以 … 为主流。
 *
 * 分级:
 *  - status=decided 的术语违规 → **阻断**(exit 1)。
 *  - status=proposed 的术语违规 → 只告警。proposed 用于承载「已知不一致但尚未拍板」的
 *    术语,让清单可见、可讨论,而不是靠脚本单方面替产品做裁决。
 *  - 标点规则视同 decided。
 *
 * 存量:i18n/glossary-baseline.json 冻结首次引入时的既有违规,只告警不阻断。baseline
 * **只减不增**——已修复却仍留在 baseline 的条目会报错,强制随手清理。新增违规一律阻断。
 * 这个模式沿用仓库既有先例(i18nCompleteness.test.ts 的 KNOWN_MISSING、
 * hardcoded-color-exemptions.json),不另造轮子。
 *
 * 用法:
 *   node scripts/check-i18n-glossary.mjs                 # 校验(root: pnpm check:i18n-glossary)
 *   node scripts/check-i18n-glossary.mjs --update-baseline  # 剪枝 baseline(只删不增)
 *   node scripts/check-i18n-glossary.mjs --report        # 打印完整违规明细(不阻断)
 *
 * 已知覆盖缺口(有意为之,记录在案):mobile 存在 i18next 之外的手写四语 catalog
 * (src/auth/loginMessages.ts 等 .ts 文件),本脚本只扫 locale JSON,不解析这些 TS。
 * 它们由各自的编译期 Record 类型 + parity 单测保证结构,但术语一致性目前是盲区。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderGlossaryDoc } from './shared/glossary-doc.mjs';
import { validateAgainstSchema } from './shared/json-schema-lite.mjs';
import {
  ELLIPSIS_LOCALES,
  FULL_WIDTH_PUNCT,
  HALFWIDTH_PUNCT_LOCALES,
  WORD_BOUNDARY,
  findCaseMismatch,
  findHalfWidthPunct,
  hasAsciiEllipsis,
  normalizeForPunctuation,
  makeExemptChecker,
  occursIn,
  stripNonProse,
} from './shared/glossary-rules.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GLOSSARY_PATH = path.join(repoRoot, 'i18n', 'glossary.json');
const SCHEMA_PATH = path.join(repoRoot, 'i18n', 'glossary.schema.json');
const BASELINE_PATH = path.join(repoRoot, 'i18n', 'glossary-baseline.json');
const DOC_PATH = path.join(repoRoot, 'i18n', 'GLOSSARY.md');
const DESKTOP_LOCALES = path.join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales');
const MOBILE_LOCALES = path.join(repoRoot, 'apps', 'mobile', 'src', 'i18n', 'locales');

const SUPPORTED_SCHEMA_VERSION = 1;

const args = new Set(process.argv.slice(2));
const UPDATE_BASELINE = args.has('--update-baseline');
const REPORT_ONLY = args.has('--report');

function fail(message) {
  console.error(`[check-i18n-glossary] ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 加载
// ---------------------------------------------------------------------------

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`读取 / 解析失败: ${path.relative(repoRoot, file)}\n  ${err.message}`);
  }
}

const glossary = readJson(GLOSSARY_PATH);
if (glossary.version !== SUPPORTED_SCHEMA_VERSION) {
  fail(
    `glossary.json version=${glossary.version},本脚本只支持 ${SUPPORTED_SCHEMA_VERSION}。` +
      `升级 schema 时必须同步更新本脚本,不要让版本静默漂移。`,
  );
}

// 先按 schema 全量校验再扫语料。glossary.schema.json 长期只服务编辑器补全,从没有
// 任何代码真正执行过它——那意味着把 forbidden 拼成 forbiden 时,该条术语的规则会
// 整条消失而 CI 全绿。术语表是唯一事实源,它自身的正确性必须先于它校验别人。
const schemaErrors = validateAgainstSchema(glossary, readJson(SCHEMA_PATH));
if (schemaErrors.length > 0) {
  fail(
    `i18n/glossary.json 不符合 i18n/glossary.schema.json:\n` +
      schemaErrors.map((e) => `  - ${e}`).join('\n'),
  );
}

// 以语言为键的映射,其键名必须落在 glossary.locales 里。
//
// schema 管不了这条:locales 是数据(glossary.json 自己声明的),而 JSON Schema 里的
// additionalProperties 只能约束「值」的形状,不能拿另一个字段的内容去约束键名。
// 于是 forbidden.zh_CN(下划线,正确写法是 zh-CN)这类拼写照样通过校验,而扫描时只按
// glossary.locales 迭代,那条规则就被静默忽略了——写了规则、看着有校验、实际没生效。
const LOCALE_KEYED_FIELDS = ['translations', 'forbidden', 'alsoAllowed', 'minorityByDesign'];
const declaredLocales = new Set(glossary.locales);
const localeKeyErrors = [];
for (const term of glossary.terms) {
  for (const field of LOCALE_KEYED_FIELDS) {
    for (const locale of Object.keys(term[field] ?? {})) {
      if (!declaredLocales.has(locale)) {
        localeKeyErrors.push(
          `术语 ${term.id} 的 ${field}.${locale}:"${locale}" 不在 locales [${glossary.locales.join(', ')}] 里`,
        );
      }
    }
  }
}
if (localeKeyErrors.length > 0) {
  fail(`术语表里有无法生效的语言键(拼错的语言键会让整条规则静默失效):\n${localeKeyErrors.map((e) => `  - ${e}`).join('\n')}`);
}

/** 递归展平嵌套 JSON 为 Map<'a.b.c', string>。 */
function flatten(obj, prefix, out) {
  for (const [key, value] of Object.entries(obj)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value, keyPath, out);
    } else if (typeof value === 'string') {
      out.set(keyPath, value);
    }
  }
  return out;
}

/**
 * 加载一个 locale 的全部文案。
 * key 前缀区分来源,便于 exempt 精确定位:desktop:a.b / mobile/session:x.y
 */
function loadLocale(locale) {
  const out = new Map();

  const desktopFile = path.join(DESKTOP_LOCALES, locale, 'common.json');
  if (fs.existsSync(desktopFile)) {
    for (const [k, v] of flatten(readJson(desktopFile), '', new Map())) {
      out.set(`desktop:${k}`, v);
    }
  }

  const mobileDir = path.join(MOBILE_LOCALES, locale);
  if (fs.existsSync(mobileDir)) {
    for (const file of fs.readdirSync(mobileDir).sort()) {
      if (!file.endsWith('.json')) continue;
      const ns = file.slice(0, -'.json'.length);
      for (const [k, v] of flatten(readJson(path.join(mobileDir, file)), '', new Map())) {
        out.set(`mobile/${ns}:${k}`, v);
      }
    }
  }

  return out;
}

const locales = glossary.locales;
const corpus = new Map(locales.map((l) => [l, loadLocale(l)]));
for (const [locale, entries] of corpus) {
  if (entries.size === 0) fail(`locale "${locale}" 未加载到任何文案,请检查 locales 目录布局`);
}

// ---------------------------------------------------------------------------
// 规则
// ---------------------------------------------------------------------------

/** 一条违规。fingerprint 用于 baseline 比对,必须稳定。 */
function makeViolation({ locale, key, rule, detail, severity, hint }) {
  return {
    locale,
    key,
    rule,
    detail,
    severity,
    hint,
    fingerprint: `${locale}\t${key}\t${rule}\t${detail}`,
  };
}

const violations = [];

// --- 规则 1 & 2:术语 forbidden / 大小写形态 ---
for (const term of glossary.terms) {
  const isExempt = makeExemptChecker(term.exempt);
  // 严格校验 status:拼错(如 "decied")时若静默按 proposed 处理,该术语的全部违规会
  // 降级成告警、CI 照常通过——门禁被无声关掉比报错危险得多。
  if (term.status !== 'decided' && term.status !== 'proposed') {
    fail(`术语 ${term.id} 的 status "${term.status}" 非法,只能是 decided 或 proposed`);
  }
  const severity = term.status === 'decided' ? 'error' : 'warn';

  for (const locale of locales) {
    const entries = corpus.get(locale);

    // 规则 1:禁用译法。
    // 条目为字符串时无条件禁用;为 { text, whenEn } 时只在该 key 的**英文源**匹配
    // whenEn 才禁——因为同一个中文词往往是另一个英文词的正确译法(Directory 该译
    // 「目录」,但无条件禁「文件夹」会误伤 Folder;Running 禁「进行中」会误伤
    // In Progress)。没有这个条件,这类术语根本没法进表。
    for (const entry of term.forbidden?.[locale] ?? []) {
      const bad = typeof entry === 'string' ? entry : entry.text;
      const whenEn = typeof entry === 'string' ? null : entry.whenEn;
      // 词边界必须复用 WORD_BOUNDARY:whenEn 的匹配口径要和 occursIn / findCaseMismatch
      // 完全一致,否则边界规则演进时(例如再往里加一类字符)两处会悄悄漂移,
      // 出现「术语命中了但条件禁用没生效」这种最难查的不一致。
      const sourceRe = whenEn
        ? new RegExp(
            `(?<![${WORD_BOUNDARY}])${whenEn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?(?![${WORD_BOUNDARY}])`,
            'i',
          )
        : null;

      for (const [key, value] of entries) {
        if (isExempt(key)) continue;
        if (!occursIn(stripNonProse(value), bad)) continue;
        if (sourceRe) {
          // 英文源同样要先剥离非文案片段:whenEn 若只出现在 URL / 文件名 / $t() 里
          // (例如英文源含 agent-config.json),会被误判为「英文命中」,把禁用规则
          // 套到一个其实没提到该概念的 key 上。
          const source = corpus.get(glossary.sourceLocale)?.get(key);
          if (!source || !sourceRe.test(stripNonProse(source))) continue;
        }
        const expected = term.translations?.[locale] ?? term.en;
        violations.push(
          makeViolation({
            locale,
            key,
            rule: 'forbidden-term',
            detail: `${term.id}:${bad}`,
            severity,
            hint:
              `「${bad}」是 ${term.en} 的禁用译法,应为「${expected}」` +
              (whenEn ? `(仅当英文源含 ${whenEn} 时)` : ''),
          }),
        );
      }
    }

    // 规则 2:保留英文的术语必须统一大小写形态。
    // 两个前提缺一不可:
    //  - translations 值与 en 相同(译成中文/日文/韩文的术语没有大小写问题);
    //  - checkCase 未显式关闭。Issue / Session 这类词同时是常用英语单词,英文句子里
    //    的 "fix the issue" 是正常用法,强行要求大写会在 prompt 模板里制造大批假阳性。
    //
    // **源语言(en)刻意不做大小写检查**:glossary 把英文存在 term.en 而非
    // translations.en,所以下面的 standard 取值天然为 undefined、直接跳过。这不是疏漏
    // ——英文原文里 agent / worker 作普通名词小写本就是正确英语("ask the agent to
    // explain"、"after agent edits"),实测开启会产生 84 处假阳性。中英混排的约束只在
    // 译文侧成立:中文句子里出现的 Agent 一定指产品概念,英文句子里则不一定。
    if (term.checkCase === false) continue;
    const standard = term.translations?.[locale];
    if (!standard || standard !== term.en) continue;
    for (const [key, value] of entries) {
      if (isExempt(key)) continue;
      const hit = findCaseMismatch(stripNonProse(value), standard);
      if (!hit) continue;
      violations.push(
        makeViolation({
          locale,
          key,
          rule: 'term-case',
          detail: `${term.id}:${hit}`,
          severity,
          hint: `「${hit}」大小写不统一,应为「${standard}」`,
        }),
      );
    }
  }
}

// --- 规则 3:标点风格 ---
// 各 locale 的适用范围与数据依据见 shared/glossary-rules.mjs 的常量注释。
for (const locale of locales) {
  const checkHalfWidth = HALFWIDTH_PUNCT_LOCALES.has(locale);
  const checkEllipsis = ELLIPSIS_LOCALES.has(locale);
  if (!checkHalfWidth && !checkEllipsis) continue;

  for (const [key, value] of corpus.get(locale)) {
    // 标点检查走 normalizeForPunctuation 而非 stripNonProse:后者把 {{插值}} 换成空格,
    // 「{{total}},上限」剥离后逗号前是空格,违规会被静默放过。
    const prose = normalizeForPunctuation(value);

    const mark = checkHalfWidth ? findHalfWidthPunct(prose) : null;
    if (mark) {
      violations.push(
        makeViolation({
          locale,
          key,
          rule: 'punct-halfwidth',
          detail: mark,
          severity: 'error',
          hint: `中文字符后应使用全角「${FULL_WIDTH_PUNCT[mark] ?? mark}」,当前是半角「${mark}」`,
        }),
      );
    }

    if (checkEllipsis && hasAsciiEllipsis(prose)) {
      violations.push(
        makeViolation({
          locale,
          key,
          rule: 'punct-ellipsis',
          detail: '...',
          severity: 'error',
          hint: '省略号应使用「…」而非三个半角点',
        }),
      );
    }
  }
}

violations.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));

// ---------------------------------------------------------------------------
// baseline
// ---------------------------------------------------------------------------

// baseline **只收 error 级**。proposed 术语的告警刻意不冻结:它们本来就不阻断,
// 冻进 baseline 只会让「还有多少术语没裁决」这个数字消失,失去提醒作用。
const blockingAll = violations.filter((v) => v.severity === 'error');

if (UPDATE_BASELINE) {
  // --update-baseline **只能删,不能加**。
  //
  // 原先它把当前全部违规覆盖写进 baseline,于是「引入违规 + 顺手重跑一次本命令」就能
  // 让新违规被登记为已知存量,CI 照常通过——门禁等于自带一个绕过开关。baseline 的
  // 约定本来就是「只减不增」,这里必须让工具本身遵守,而不是指望使用者自觉。
  //
  // 真要新冻结一批存量(例如新增一条规则),得手动编辑 JSON——那样新增条目会明明白白
  // 出现在 diff 里被 review 看到。
  const existing = fs.existsSync(BASELINE_PATH) ? new Set(readJson(BASELINE_PATH).entries ?? []) : new Set();
  const additions = blockingAll.filter((v) => !existing.has(v.fingerprint));
  if (additions.length > 0) {
    fail(
      `--update-baseline 只能删除已修好的条目,不能登记新违规(当前有 ${additions.length} 条不在 baseline 里):\n` +
        additions
          .slice(0, 10)
          .map((v) => `  - ${v.fingerprint.split('\t').slice(0, 3).join(' / ')}`)
          .join('\n') +
        (additions.length > 10 ? `\n  ...另有 ${additions.length - 10} 条` : '') +
        '\n请修掉这些违规;确需冻结时手动编辑 i18n/glossary-baseline.json,让新增条目出现在 diff 里。',
    );
  }
  const kept = blockingAll.map((v) => v.fingerprint).sort();
  const payload = {
    _comment:
      '存量违规冻结清单(仅 status=decided 的术语与标点规则)。只减不增:修好一条就从这里' +
      '删一条,新增违规一律阻断 CI。剪枝: node scripts/check-i18n-glossary.mjs --update-baseline' +
      '(该命令拒绝登记新违规,新增条目必须手动编辑本文件)',
    _generatedFrom: `glossary.json version ${glossary.version}`,
    entries: kept,
  };
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(
    `[check-i18n-glossary] baseline 已剪枝: ${existing.size} → ${kept.length} 条 → ${path.relative(repoRoot, BASELINE_PATH)}`,
  );
  process.exit(0);
}

const baseline = fs.existsSync(BASELINE_PATH) ? readJson(BASELINE_PATH) : { entries: [] };
const baselineSet = new Set(baseline.entries ?? []);

const current = new Set(violations.map((v) => v.fingerprint));
const stale = [...baselineSet].filter((fp) => !current.has(fp)).sort();
const fresh = violations.filter((v) => !baselineSet.has(v.fingerprint));

const blocking = fresh.filter((v) => v.severity === 'error');
const warnings = fresh.filter((v) => v.severity === 'warn');
const known = violations.filter((v) => baselineSet.has(v.fingerprint));

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

function print(list, label, log) {
  if (list.length === 0) return;
  log(`\n[check-i18n-glossary] ${label} ${list.length} 处:`);
  for (const v of list.slice(0, REPORT_ONLY ? Infinity : 40)) {
    log(`  ${v.locale}  ${v.key}`);
    log(`      ${v.hint}`);
  }
  if (!REPORT_ONLY && list.length > 40) {
    log(`  ...(其余 ${list.length - 40} 处省略,完整明细: node scripts/check-i18n-glossary.mjs --report)`);
  }
}

print(blocking, '❌ 新增术语/标点违规', console.error);

// 待裁决术语按术语折叠:逐条列出会淹没真正需要处理的新增违规,而这里的重点是
// 「还有哪些术语没拍板、各自波及多大」,不是每一条的位置。
if (warnings.length > 0) {
  const byTerm = new Map();
  for (const v of warnings) {
    const termId = v.detail.split(':')[0];
    byTerm.set(termId, (byTerm.get(termId) ?? 0) + 1);
  }
  console.warn(`\n[check-i18n-glossary] ⚠️ 待裁决术语命中 ${warnings.length} 处(status=proposed,不阻断):`);
  for (const [termId, count] of [...byTerm].sort((a, b) => b[1] - a[1])) {
    const term = glossary.terms.find((t) => t.id === termId);
    console.warn(`  ${String(count).padStart(4)} 处  ${termId}（${term?.en ?? '?'}）`);
  }
  console.warn(
    '  裁决后把 i18n/glossary.json 里对应条目的 status 改为 decided,' +
      '并重新生成 baseline 冻结存量。明细: node scripts/check-i18n-glossary.mjs --report',
  );
}

if (REPORT_ONLY) {
  print(warnings, 'ℹ️ 待裁决术语明细', console.log);
  print(known, 'ℹ️ baseline 内已知存量', console.log);
}

if (stale.length > 0) {
  console.error(`\n[check-i18n-glossary] ❌ baseline 有 ${stale.length} 条已失效条目(问题已修复,但仍挂在账上):`);
  for (const fp of stale.slice(0, 40)) {
    const [locale, key, rule, detail] = fp.split('\t');
    console.error(`  ${locale}  ${key}  (${rule}: ${detail})`);
  }
  if (stale.length > 40) console.error(`  ...(其余 ${stale.length - 40} 条省略)`);
  console.error(
    '\nbaseline 只减不增。请删除上述条目,或跑剪枝命令自动摘掉已修好的:\n' +
      '  node scripts/check-i18n-glossary.mjs --update-baseline',
  );
}

// GLOSSARY.md 是给人和 AI 查阅的入口,过期比不存在更糟——大家会照着过期的表写文案。
// 用与生成器完全相同的渲染函数比对,不做「差不多就行」的模糊校验。
const docStale = fs.existsSync(DOC_PATH)
  ? fs.readFileSync(DOC_PATH, 'utf8') !== renderGlossaryDoc(glossary)
  : true;
if (docStale) {
  console.error(
    '\n[check-i18n-glossary] ❌ i18n/GLOSSARY.md 与 i18n/glossary.json 不同步(或缺失)。\n' +
      '  运行 pnpm i18n:glossary-doc 重新生成。',
  );
}

if (REPORT_ONLY) {
  console.log(
    `\n[check-i18n-glossary] 报告模式:新增 ${blocking.length} / 待裁决 ${warnings.length} / ` +
      `baseline 存量 ${known.length} / baseline 失效 ${stale.length} / 文档${docStale ? '过期' : '同步'}`,
  );
  process.exit(0);
}

if (blocking.length > 0 || stale.length > 0 || docStale) {
  console.error(
    `\n[check-i18n-glossary] 失败:新增违规 ${blocking.length} / baseline 失效 ${stale.length}` +
      `${docStale ? ' / 文档过期' : ''}。术语裁决见 i18n/glossary.json,人读版 i18n/GLOSSARY.md。`,
  );
  process.exit(1);
}

const decided = glossary.terms.filter((t) => t.status === 'decided').length;
const proposed = glossary.terms.length - decided;
console.log(
  `[check-i18n-glossary] ✅ 术语表 ${decided} 条已裁决 / ${proposed} 条待讨论,` +
    `${locales.join(' / ')} 无新增违规` +
    (known.length > 0 ? `(baseline 存量 ${known.length} 处待清理)` : '') +
    (warnings.length > 0 ? `(待裁决术语告警 ${warnings.length} 处)` : ''),
);
