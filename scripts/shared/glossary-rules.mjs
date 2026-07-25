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
 * URL 片段。
 *
 * 关键是**不能**用 \S+ 收尾:中文正文常紧跟在 URL 后面且中间没有空格
 * (「请访问 https://x.test,返回对话列表」),\S+ 会把全角标点连同后面整句正文一起吞掉,
 * 于是 URL 之后的禁用词、大小写问题全部检测不到,门禁静默放行。
 * 按 CJK 句读与括号截断,只吃掉 URL 本身。
 */
const URL_TOKEN = /\b[a-z][\w-]*:\/\/[^\s，。；：！？、（）「」【】《》“”‘’…]+/gi;

/**
 * 文件名片段。
 *
 * 原先用扩展名白名单(json|ts|tsx|…),漏掉 `plugin.py`、`worker.go`、`Agent.java` 这类
 * ——它们会被当成正文里的产品术语,报「plugin 应为 Plugin」这种假阳性并阻断 CI。
 * 白名单永远补不全,改成通用形态。
 *
 * 两个约束防止误伤:
 *  - 扩展名必须是纯小写字母 → `1.5`、`v1.0`、`2.0 GB` 不会被当成文件名吃掉
 *    (那会让「1.5,上限」这类半角标点违规漏检);
 *  - 词干必须含至少一个字母 → 纯数字的 `12.34` 同理排除。
 */
const FILENAME_TOKEN = /\b[A-Za-z0-9_-]*[A-Za-z][A-Za-z0-9_-]*\.[a-z]{1,6}\b/g;

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
    .replace(URL_TOKEN, ' ')
    .replace(/\S+@\S+\.\S+/g, ' ')
    .replace(FILENAME_TOKEN, ' ');
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
 * 大小写形态检查:命中术语但拼写形态与标准不符时返回**第一个不符的**实际拼写,否则 null。
 *
 * 必须扫描全部匹配,不能只看第一个:一条文案里常先出现正确形态、后出现错误形态
 * (「创建 Worker 后,该 worker 会自动启动」)。用非全局 match 时,第一个匹配正确就直接
 * 返回 null,后面的错误形态永远查不出来——两位 reviewer 在 #389 都把这条标为 P1。
 */
export function findCaseMismatch(text, standard) {
  if (!/^[A-Za-z][A-Za-z0-9 ]*$/.test(standard)) return null;
  const escaped = standard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![${WORD_BOUNDARY}])${escaped}s?(?![${WORD_BOUNDARY}])`, 'gi');
  for (const m of text.matchAll(re)) {
    const hit = m[0].replace(/s$/, '');
    if (hit !== standard) return hit;
  }
  return null;
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

/**
 * 中文正文的「左边界」:汉字,以及各类右闭合符号。
 *
 * 只认汉字的话,`(直接替换,不留原文),或…` 这种会漏——半角逗号前面是右括号而非汉字。
 * 右括号 / 右引号 / 右书名号后面接的仍是中文正文,标点该跟中文规则走。
 */
const HALF_WIDTH_AFTER_HAN = /[一-鿿）)」』】》〉”’][,:;!?]/;
const ASCII_ELLIPSIS = /\.\.\./;

/**
 * 插值占位符在标点检查里的替身。
 *
 * stripNonProse 把 {{total}} 换成空格,于是「已缓存 {{total}},上限」在剥离后成了
 * 「已缓存  ,上限」——半角逗号前面是空格而非汉字,HALF_WIDTH_AFTER_HAN 匹配不上,
 * 违规被静默放过(实测 settings.about.storage.reportCache 就是这样漏掉的)。
 *
 * 对读者而言 {{total}} 渲染出来就是正文的一部分,它后面跟半角逗号同样是排版错误,
 * 所以标点检查要把插值当成汉字。用一个落在 一-鿿 区间内的字符做替身即可。
 *
 * URL / 邮箱 / 文件名**不能**这样替换:`config.json:` 里的冒号是路径分隔符不是标点,
 * 换成汉字替身会把它们全判成违规。那几类仍替换为空格。
 */
const PROSE_PLACEHOLDER = '中';

/** 半角标点 → 中文全角对应物。 */
export const FULL_WIDTH_PUNCT = Object.freeze({
  ',': '，',
  ':': '：',
  ';': '；',
  '!': '！',
  '?': '？',
});

/**
 * 标点检查专用的预处理:与 stripNonProse 剥离同样的片段,但把插值类占位符换成
 * 汉字替身而非空格,理由见 PROSE_PLACEHOLDER。
 *
 * 传入**原始文案**,不要传 stripNonProse 的结果——那样插值信息已经丢了。
 */
export function normalizeForPunctuation(text) {
  return text
    // 两个插值之间的标点是**格式分隔符**,不是正文标点:`{{minutes}}:{{seconds}}` 是时间、
    // `{{label}}: {{path}}` 是「标签: 路径」。它该用半角还是全角取决于运行期填进去的值,
    // 静态扫描判不了,所以整类排除——先把这类标点换成空格,再做插值替换。
    .replace(/\}\}\s*[,:;!?]\s*\{\{/g, '}} {{')
    .replace(/\{\{[^}]*\}\}/g, PROSE_PLACEHOLDER)
    .replace(/<\/?\d+>/g, PROSE_PLACEHOLDER)
    .replace(/\$t\([^)]*\)/g, PROSE_PLACEHOLDER)
    .replace(URL_TOKEN, ' ')
    .replace(/\S+@\S+\.\S+/g, ' ')
    .replace(FILENAME_TOKEN, ' ');
}

/** 汉字后紧跟半角标点时返回该标点,否则 null。 */
export function findHalfWidthPunct(text) {
  const m = text.match(HALF_WIDTH_AFTER_HAN);
  return m ? m[0].slice(-1) : null;
}

/** 是否含半角三点省略号。 */
export function hasAsciiEllipsis(text) {
  return ASCII_ELLIPSIS.test(text);
}
