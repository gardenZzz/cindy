/**
 * 术语表 guard 的纯规则函数。
 *
 * 抽成独立模块是为了可测:这里每一条边界都是踩过的坑(见各函数注释),回归代价很高,
 * 必须有单测钉住。check-i18n-glossary.mjs 只做编排与 IO。
 */

/**
 * ASCII 术语的词边界字符集。
 *
 * 连字符 / 下划线**必须**算作边界:否则 `ssh-agent`(SSH 密钥代理,与产品的 Agent 是
 * 两个概念)会被判成「agent 大小写不统一」。引入本脚本时这一条制造了 60 处假阳性中的
 * 大半,`user-agent`、`sub-agent`、`agent_id` 同理。
 */
export const WORD_BOUNDARY = 'A-Za-z0-9_-';

/**
 * 剥离不该参与术语匹配的片段,避免误报:
 *  - {{var}} / {{var, format}}  i18next 插值(变量名常与术语同形,如 {{project}})
 *  - <0>…</0>                   Trans 组件占位
 *  - $t(...)                    i18next 嵌套引用
 *  - URL、邮箱、带扩展名的文件名(project.json)
 */
export function stripNonProse(text) {
  return text
    .replace(/\{\{[^}]*\}\}/g, ' ')
    .replace(/<\/?\d+>/g, ' ')
    .replace(/\$t\([^)]*\)/g, ' ')
    .replace(/\b[a-z][\w-]*:\/\/\S+/gi, ' ')
    .replace(/\S+@\S+\.\S+/g, ' ')
    .replace(/\b[\w-]+\.(json|ts|tsx|js|mjs|md|yml|yaml|sql|lock|toml)\b/gi, ' ');
}

/**
 * 术语命中判定。
 * 纯 ASCII 词(Agent / Plugin)按词边界匹配,允许紧跟复数 s;
 * 含 CJK 的词(代理 / 插件)没有词边界概念,用子串。
 */
export function occursIn(text, term) {
  if (/^[\x20-\x7e]+$/.test(term)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![${WORD_BOUNDARY}])${escaped}s?(?![${WORD_BOUNDARY}])`).test(text);
  }
  return text.includes(term);
}

/**
 * 大小写形态检查:命中术语但拼写形态与标准不符时返回实际拼写,否则返回 null。
 * 只对「保留英文原词」的术语有意义(译成中文/日文的术语无大小写问题)。
 */
export function findCaseMismatch(text, standard) {
  if (!/^[A-Za-z][A-Za-z0-9 ]*$/.test(standard)) return null;
  const escaped = standard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![${WORD_BOUNDARY}])${escaped}s?(?![${WORD_BOUNDARY}])`, 'i');
  const m = text.match(re);
  if (!m) return null;
  const hit = m[0].replace(/s$/, '');
  return hit === standard ? null : hit;
}

/**
 * 构造某术语的豁免判定。
 * 支持完整路径精确匹配,以及以 `.` 结尾的子树前缀(用于整段同形异义,例如
 * SSH agent 与产品 Agent,`desktop:settings.remote.` 整段豁免)。
 * 刻意**不支持**按末段 key 名匹配——那会让任意同名嵌套 key 被静默放过。
 */
export function makeExemptChecker(list) {
  const exact = new Set();
  const prefixes = [];
  for (const item of list ?? []) {
    if (item.endsWith('.')) prefixes.push(item);
    else exact.add(item);
  }
  return (key) => exact.has(key) || prefixes.some((p) => key.startsWith(p));
}

// ---------------------------------------------------------------------------
// 标点规则
// ---------------------------------------------------------------------------

/**
 * 规则边界由现状数据定,不靠直觉(比例为引入本脚本时实测的 desktop locale):
 *  - 全角逗号 / 冒号:zh-CN 全角是主流(逗号 566:218、冒号 153:61)→ 规则成立。
 *    **ja 不适用**——日文 UI 惯例本就用半角冒号,实测半角 124:78 反而是主流,
 *    套用中文规则会制造 124 处假阳性。ko 同理不适用。
 *  - 省略号:zh-CN 140:44、ja 138:46、ko 138:46,三语一致以「…」为主流 → 全部适用。
 */
export const HALFWIDTH_PUNCT_LOCALES = new Set(['zh-CN']);
export const ELLIPSIS_LOCALES = new Set(['zh-CN', 'ja', 'ko']);

const HALF_WIDTH_AFTER_HAN = /[一-鿿][,:]/;
const ASCII_ELLIPSIS = /\.\.\./;

/** 汉字后紧跟半角逗号/冒号时返回该标点,否则 null。 */
export function findHalfWidthPunct(text) {
  const m = text.match(HALF_WIDTH_AFTER_HAN);
  return m ? m[0].slice(-1) : null;
}

/** 是否含半角三点省略号。 */
export function hasAsciiEllipsis(text) {
  return ASCII_ELLIPSIS.test(text);
}
