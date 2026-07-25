/**
 * 术语表 guard 规则函数的单测。
 *
 * 这里每一条断言都对应一个真实踩过的坑或一条有数据依据的裁决,不是为覆盖率凑数:
 * 误报会让门禁被绕过或被关掉,漏报会让门禁形同虚设,两边都要钉住。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ELLIPSIS_LOCALES,
  HALFWIDTH_PUNCT_LOCALES,
  findCaseMismatch,
  findHalfWidthPunct,
  hasAsciiEllipsis,
  makeExemptChecker,
  occursIn,
  stripNonProse,
} from '../shared/glossary-rules.mjs';
import { renderGlossaryDoc } from '../shared/glossary-doc.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

// ---------------------------------------------------------------------------
// occursIn:词边界
// ---------------------------------------------------------------------------

test('occursIn: 连字符复合词不算命中(ssh-agent ≠ 产品 Agent)', () => {
  // 这是引入 guard 时最大的一批假阳性来源:SSH 密钥代理与产品 Agent 同形但无关。
  assert.equal(occursIn('密钥已加载到 ssh-agent', 'agent'), false);
  assert.equal(occursIn('检查 user-agent 头', 'agent'), false);
  assert.equal(occursIn('字段 agent_id 缺失', 'agent'), false);
  // 独立成词时必须命中,否则门禁形同虚设。
  assert.equal(occursIn('展开 agent 设置', 'agent'), true);
});

test('occursIn: 允许复数但不误伤更长的标识符', () => {
  assert.equal(occursIn('更多 Plugin 操作', 'Plugin'), true);
  assert.equal(occursIn('已安装 Plugins', 'Plugin'), true);
  assert.equal(occursIn('PluginRegistry 初始化', 'Plugin'), false);
});

test('occursIn: 中文术语按子串匹配(无词边界概念)', () => {
  assert.equal(occursIn('这是代理设置', '代理'), true);
  assert.equal(occursIn('这是插件设置', '代理'), false);
});

test('occursIn: 大小写敏感 —— forbidden 区分 Plugin 与 plugin', () => {
  assert.equal(occursIn('更多 plugin 操作', 'Plugin'), false);
});

// ---------------------------------------------------------------------------
// stripNonProse:剥离非文案片段
// ---------------------------------------------------------------------------

test('stripNonProse: 剥离 i18next 插值,避免变量名与术语同形误报', () => {
  // {{project}} 是变量名,不是展示给用户的「Project」字样。
  assert.equal(occursIn(stripNonProse('在 {{project}} 中新建'), 'project'), false);
  assert.equal(occursIn(stripNonProse('该 Project 下的会话'), 'Project'), true);
});

test('stripNonProse: 剥离 URL、邮箱与文件名', () => {
  assert.equal(occursIn(stripNonProse('打开 https://x.com/agent/list'), 'agent'), false);
  assert.equal(occursIn(stripNonProse('读取 project.json 失败'), 'project'), false);
  assert.equal(occursIn(stripNonProse('联系 agent@example.com'), 'agent'), false);
});

test('stripNonProse: 剥离 Trans 占位与 $t 引用', () => {
  assert.equal(stripNonProse('前<0>中</0>后').includes('<0>'), false);
  assert.equal(stripNonProse('$t(common.agent) 之后').includes('$t('), false);
});

// ---------------------------------------------------------------------------
// findCaseMismatch:大小写形态
// ---------------------------------------------------------------------------

test('findCaseMismatch: 命中错误形态时返回实际拼写,正确时返回 null', () => {
  assert.equal(findCaseMismatch('归档 worker', 'Worker'), 'worker');
  assert.equal(findCaseMismatch('归档 Worker', 'Worker'), null);
  assert.equal(findCaseMismatch('归档 WORKER', 'Worker'), 'WORKER');
});

test('findCaseMismatch: 复数形态归一后再比对,不误报 Workers', () => {
  assert.equal(findCaseMismatch('所有 Workers 已停止', 'Worker'), null);
  assert.equal(findCaseMismatch('所有 workers 已停止', 'Worker'), 'worker');
});

test('findCaseMismatch: 连字符复合词同样豁免', () => {
  assert.equal(findCaseMismatch('service-worker 已注册', 'Worker'), null);
});

// ---------------------------------------------------------------------------
// makeExemptChecker:豁免
// ---------------------------------------------------------------------------

test('makeExemptChecker: 完整路径精确匹配', () => {
  const isExempt = makeExemptChecker(['desktop:settings.a.b']);
  assert.equal(isExempt('desktop:settings.a.b'), true);
  assert.equal(isExempt('desktop:settings.a.c'), false);
});

test('makeExemptChecker: 以点结尾的子树前缀豁免整段', () => {
  const isExempt = makeExemptChecker(['desktop:settings.remote.']);
  assert.equal(isExempt('desktop:settings.remote.keys.inAgent'), true);
  assert.equal(isExempt('desktop:settings.remoteControl.hook'), false, '前缀必须含点,不能误伤 remoteControl');
});

test('makeExemptChecker: 不支持按末段 key 名匹配', () => {
  // 按末段匹配会让任意同名嵌套 key 被静默放过,是 brand guard 明确记录过的教训。
  const isExempt = makeExemptChecker(['title']);
  assert.equal(isExempt('desktop:settings.a.title'), false);
});

test('makeExemptChecker: 空/缺省列表不豁免任何 key', () => {
  assert.equal(makeExemptChecker(undefined)('desktop:any.key'), false);
  assert.equal(makeExemptChecker([])('desktop:any.key'), false);
});

// ---------------------------------------------------------------------------
// 标点规则
// ---------------------------------------------------------------------------

test('findHalfWidthPunct: 只在汉字后触发', () => {
  assert.equal(findHalfWidthPunct('保存失败:原因'), ':');
  assert.equal(findHalfWidthPunct('授权失败,请重试'), ',');
  assert.equal(findHalfWidthPunct('保存失败：原因'), null);
  // 英文/数字后的半角标点是正常排版,不能报。
  assert.equal(findHalfWidthPunct('Error: not found'), null);
  assert.equal(findHalfWidthPunct('共 1,000 项'), null);
});

test('标点规则的 locale 适用范围有数据依据', () => {
  // ja 实测半角冒号 124:78 才是主流(日文 UI 惯例),套用中文全角规则会制造大批假阳性。
  assert.equal(HALFWIDTH_PUNCT_LOCALES.has('zh-CN'), true);
  assert.equal(HALFWIDTH_PUNCT_LOCALES.has('ja'), false);
  assert.equal(HALFWIDTH_PUNCT_LOCALES.has('ko'), false);
  // 省略号三语一致以「…」为主流。
  for (const locale of ['zh-CN', 'ja', 'ko']) {
    assert.equal(ELLIPSIS_LOCALES.has(locale), true, `${locale} 应纳入省略号规则`);
  }
});

test('hasAsciiEllipsis: 识别三点省略号', () => {
  assert.equal(hasAsciiEllipsis('加载中...'), true);
  assert.equal(hasAsciiEllipsis('加载中…'), false);
});

// ---------------------------------------------------------------------------
// 术语表数据自身的完整性
// ---------------------------------------------------------------------------

const glossary = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', 'glossary.json'), 'utf8'));

test('glossary.json: id 唯一且格式合法', () => {
  const ids = glossary.terms.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, '术语 id 必须唯一——baseline 用它做锚点');
  for (const id of ids) {
    assert.match(id, /^[a-z0-9-]+$/, `id "${id}" 必须是 kebab-case`);
  }
});

test('glossary.json: 每条术语都有裁决理由', () => {
  for (const term of glossary.terms) {
    assert.ok(term.note?.trim(), `术语 ${term.id} 缺 note——没有理由的裁决会被后人反复推翻`);
  }
});

test('glossary.json: decided 术语必须给出所有非源语言的译法', () => {
  const targets = glossary.locales.filter((l) => l !== glossary.sourceLocale);
  for (const term of glossary.terms.filter((t) => t.status === 'decided')) {
    for (const locale of targets) {
      assert.ok(
        term.translations?.[locale]?.trim(),
        `已裁决术语 ${term.id} 缺 ${locale} 译法;拿不准应留在 status=proposed`,
      );
    }
  }
});

test('glossary.json: forbidden 不能与自己的标准译法冲突', () => {
  for (const term of glossary.terms) {
    for (const [locale, words] of Object.entries(term.forbidden ?? {})) {
      const standard = term.translations?.[locale];
      if (!standard) continue;
      assert.ok(
        !words.includes(standard),
        `术语 ${term.id} 在 ${locale} 把标准译法「${standard}」同时列为禁用,规则自相矛盾`,
      );
    }
  }
});

test('glossary.json: 同一 locale 下 forbidden 词不跨术语重复', () => {
  // 重复会让同一处违规被两个术语各报一次,baseline 也会存两条指纹。
  // 一个词只归属一个术语,其余条目在 note 里交叉引用(如「代理」统一登记在 proxy 下)。
  const owner = new Map();
  for (const term of glossary.terms) {
    for (const [locale, words] of Object.entries(term.forbidden ?? {})) {
      for (const word of words) {
        const slot = `${locale}\t${word}`;
        const prev = owner.get(slot);
        assert.equal(
          prev,
          undefined,
          `${locale} 的禁用词「${word}」同时登记在 ${prev} 与 ${term.id} 下,会造成重复报告`,
        );
        owner.set(slot, term.id);
      }
    }
  }
});

test('glossary.json: exempt 路径带来源前缀,不是裸 key', () => {
  for (const term of glossary.terms) {
    for (const item of term.exempt ?? []) {
      assert.match(
        item,
        /^(desktop|mobile\/[a-zA-Z]+):.+$/,
        `术语 ${term.id} 的豁免 "${item}" 缺来源前缀(desktop: / mobile/<ns>:)`,
      );
    }
  }
});

test('glossary.json: locales 与 desktop SUPPORTED_LOCALES 一致', () => {
  const localeTs = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/shared/locale.ts'), 'utf8');
  const match = localeTs.match(/SUPPORTED_LOCALES\s*=\s*\[([^\]]*)\]/);
  assert.ok(match, '无法从 locale.ts 解析 SUPPORTED_LOCALES');
  const supported = [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual(
    [...glossary.locales].sort(),
    [...supported].sort(),
    '术语表覆盖的语言必须与 SUPPORTED_LOCALES 一致,新增语言时两处一起改',
  );
});

// ---------------------------------------------------------------------------
// 文档同步
// ---------------------------------------------------------------------------

test('GLOSSARY.md 与 glossary.json 同步', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'i18n', 'GLOSSARY.md'), 'utf8');
  assert.equal(
    doc,
    renderGlossaryDoc(glossary),
    'i18n/GLOSSARY.md 已过期,运行 pnpm i18n:glossary-doc 重新生成',
  );
});

// ---------------------------------------------------------------------------
// baseline 完整性
// ---------------------------------------------------------------------------

test('glossary-baseline.json: 条目格式合法且无重复', () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', 'glossary-baseline.json'), 'utf8'));
  const entries = baseline.entries ?? [];
  assert.equal(new Set(entries).size, entries.length, 'baseline 不应有重复条目');
  for (const entry of entries) {
    const parts = entry.split('\t');
    assert.equal(parts.length, 4, `baseline 条目 "${entry}" 应为 locale\\tkey\\trule\\tdetail 四段`);
    assert.ok(glossary.locales.includes(parts[0]), `baseline 条目语言 "${parts[0]}" 不在术语表 locales 内`);
  }
});
