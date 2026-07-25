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

/** CJK 全角句读与括号。出现即说明 URL / 邮箱已经结束、后面是正文。 */
const CJK_PUNCT = '，。；：！？、（）「」【】《》“”‘’…';
/** 汉字 + 假名 + 谚文。用于「半角分隔符后面是不是中文正文」的判定。 */
const CJK_CHAR = '\\u4e00-\\u9fff\\u3040-\\u30ff\\uac00-\\ud7af';

/**
 * URL / 邮箱这类「不参与术语匹配的 token」的收尾规则。
 *
 * **不能**用 \S+ 收尾:中文正文常紧跟在它们后面且中间没有空格,\S+ 会把标点连同后面
 * 整句正文一起吞掉,于是之后的禁用词、大小写、标点问题全部检测不到,门禁静默放行。
 *
 * 两级截断:
 *  - 全角句读:一律截断——URL 里不会出现全角标点;
 *  - 半角 , ; : ! ?:**仅当其后(允许一个空格)是 CJK 字符时**截断。允许空格是因为中英混排
 *    常写成 `https://x.test, 返回…`;只认紧邻的话逗号会被当成 URL 的一部分吃掉,
 *    后面的标点违规随之漏检。不能无条件截,否则会切坏合法的
 *    query string(`?a=1&ids=1,2`)与端口号(`:8080`);而 `https://x.test,返回…`
 *    这种半角逗号后直接接中文的写法,逗号显然是正文标点而非 URL 的一部分。
 */
const TOKEN_TAIL = `(?:(?![${CJK_PUNCT}])(?![,;:!?](?=\\s*[${CJK_CHAR}]))\\S)+`;

const URL_TOKEN = new RegExp(`\\b[a-z][\\w-]*://${TOKEN_TAIL}`, 'gi');

/**
 * 邮箱片段。
 *
 * 收尾用 TOKEN_TAIL,理由同 URL——原先的 `\S+@\S+\.\S+` 连全角标点都不截,
 * 「联系 a@x.com，返回worker操作」会被整段剥成「联系 」。
 *
 * local part(@ 前面那段)必须限定在邮箱合法字符里,**不能**用「除空白与全角标点之外的
 * 一切」:那样会把紧贴在地址前面的中文正文一起吃掉——`返回worker联系a@x.com` 整条被剥成
 * 一个空格,里面小写的 worker 违规随之消失。中文文案里地址常与正文无空格相接。
 */
const EMAIL_TOKEN = new RegExp(`[A-Za-z0-9._%+-]+@${TOKEN_TAIL}`, 'g');

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
    .replace(EMAIL_TOKEN, ' ')
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
 * 术语在文案里出现的次数。
 *
 * fingerprint 需要它:光靠「locale + key + 规则 + 词」无法区分同一个 key 里命中 1 次还是
 * 3 次。某个 key 的一处「会话」被冻进 baseline 后,再往同一条文案里加一处「会话」会产出
 * 完全相同的 fingerprint,新违规就被 baseline 掩盖、CI 照过——这违反 baseline「只减不增」
 * 的契约。把次数编进 fingerprint,增加一处就是一条新指纹。
 */
export function countOccurrences(text, term, { caseInsensitive = false } = {}) {
  if (/^[\x20-\x7e]+$/.test(term)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 默认**大小写敏感**,与 occursIn 同口径。禁用译法的判定必须如此:术语表里
    // project 只禁大写 Project、plugin 则把两种大小写各列一条,说明设计意图就是
    // 逐形态声明。若在这里用 /i,「只禁 Project」会被悄悄扩成连小写 project 也禁。
    // 大小写检查(term-case)反过来需要数出所有形态,那里显式传 caseInsensitive。
    const re = new RegExp(
      `(?<![${WORD_BOUNDARY}])${escaped}s?(?![${WORD_BOUNDARY}])`,
      caseInsensitive ? 'gi' : 'g',
    );
    return [...text.matchAll(re)].length;
  }
  // CJK 词用不重叠的子串计数
  let n = 0;
  let from = 0;
  for (;;) {
    const i = text.indexOf(term, from);
    if (i < 0) return n;
    n += 1;
    from = i + term.length;
  }
}

/** 半角标点在文案里出现的次数(同 countOccurrences,供标点规则的 fingerprint 用)。 */
export function countHalfWidthPunct(text) {
  return [...text.matchAll(new RegExp(HALF_WIDTH_AFTER_HAN.source, 'g'))].length;
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
 *    **en 同样适用**——不是靠现状数据,而是 DESIGN.md §11 Voice & Content 明文规定
 *    英文也用省略号字符「…」而非三个半角点。原先漏掉 en,等于让门禁替既有违规背书。
 */
export const HALFWIDTH_PUNCT_LOCALES = new Set(['zh-CN']);
export const ELLIPSIS_LOCALES = new Set(['en', 'zh-CN', 'ja', 'ko']);

/**
 * 中文正文里的半角标点。两种形态:
 *
 *  1. 汉字 / 右闭合符号 + 半角标点。只认汉字的话 `(直接替换,不留原文),或…` 会漏——
 *     逗号前面是右括号。右括号 / 右引号 / 右书名号后面接的仍是中文正文。
 *  2. 拉丁字母或数字 + 半角标点 + **后面是 CJK**。`Keychain,重启` 这类漏了整整一类:
 *     中文句子里夹的英文产品名、技术词后面同样该用全角。这一支必须要求右边是 CJK,
 *     否则 `a=1,b=2`、`GPT-4,Claude` 这种纯 ASCII 片段会被误判。
 *
 *     CJK 前允许空白(`\s*`):中英混排常在半角标点后留一个空格,`Keychain, 重启` 与
 *     `Keychain,重启` 是同一个问题,只认紧邻会漏掉前者。空白不影响排除纯 ASCII 的目的
 *     ——`a=1, b=2` 后面仍不是 CJK。
 */
const HALF_WIDTH_AFTER_HAN = new RegExp(
  `[一-鿿）)」』】》〉”’][,:;!?]|[A-Za-z0-9][,:;!?](?=\\s*[${CJK_CHAR}])`,
);
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
    // URL / 邮箱在标点检查里也要留下正文边界。
    //
    // TOKEN_TAIL 已经正确地把 `https://x.test,返回` 的逗号留在了外面,但若把 token 换成
    // 空格,就变成「 ,返回」——逗号前面是空格,findHalfWidthPunct 认不出左边界,违规照样
    // 漏掉。对读者来说 URL 渲染出来就是正文的一部分,和插值一样该用汉字替身。
    //
    // 注意只有**紧跟「半角标点 + CJK」**的 token 才替换成汉字替身:其余情形仍替换为空格,
    // 否则 `config.json:` 这类路径分隔符会被当成正文标点误报(FILENAME_TOKEN 同理,
    // 它永远替空格)。
    //
    // lookahead 里必须带 CJK,不能只写 [,;:!?]:token 匹配是贪婪的,只要 lookahead 能满足
    // 就会回溯出更短的匹配——`https://a.test/x?ids=1,2` 会被切在 query string 内部的逗号处,
    // 于是那个逗号被误判成正文标点。带上 CJK 后与 TOKEN_TAIL 自身的截断条件一致,不会回溯。
    .replace(new RegExp(`${URL_TOKEN.source}(?=[,;:!?]\\s*[${CJK_CHAR}])`, 'gi'), PROSE_PLACEHOLDER)
    .replace(new RegExp(`${EMAIL_TOKEN.source}(?=[,;:!?]\\s*[${CJK_CHAR}])`, 'g'), PROSE_PLACEHOLDER)
    .replace(URL_TOKEN, ' ')
    .replace(EMAIL_TOKEN, ' ')
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
