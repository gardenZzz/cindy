#!/usr/bin/env node
// interaction-gate.mjs — 自定义交互门(门 A-F 之外的交互断言):
//  1. dismiss:completed 态点「我知道了」气泡从 DOM 消失(四端)
//  2. 浮层覆盖:elementFromPoint(气泡中心)命中气泡(四端×双模式)
//  3. 不推挤:面板示意 rect 在气泡消失前后逐 px 不变
//  4. 间距:正文↔我知道了 = 22、我知道了↔气泡底 = 20(completed + 长文案压力态,底距恒定)
//  5. 桌面 clamp:宽度 @800=670 / @717=669 / @600=552,top 恒 72
//  6. 压力态:气泡撑高 > completed、间距仍 22/20、copy 居中(text-align)
//  7. 热区:dismiss 命中区 ≥44×44(desk py 扩张 45)
// 用法:node interaction-gate.mjs(在 demo 目录)。exit 2 = FAIL。

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const demoDir = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(join(demoDir, 'noop.js'));
let chromium;
for (const load of [
  () => require_('playwright'),
  () => require_(join(demoDir, '..', '..', '..', 'node_modules', 'playwright')),
  () => require_('/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas/node_modules/playwright'),
]) {
  try { ({ chromium } = load()); break; } catch {}
}
if (!chromium) { console.error('playwright 未解析到'); process.exit(2); }

const PLATS = ['desk', 'phone', 'pad-landscape', 'pad-portrait'];
const results = [];
let failures = 0;
const check = (id, ok, detail) => {
  results.push({ id, pass: ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? '  ' + detail : ''}`);
};

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 960 } })).newPage();
const base = pathToFileURL(join(demoDir, 'index.html')).href;

async function gotoCase(plat, mode = 'light', lang = 'zh-CN', state = 'deletion-completed') {
  await page.goto(base);
  await page.waitForFunction(() => window.__qa && window.__qa.current() != null, null, { timeout: 8000 });
  await page.evaluate(() => localStorage.clear());
  for (const [k, v] of [['plat', plat], ['mode', mode], ['lang', lang]]) {
    const el = await page.$(`[data-qa-pref="${k}:${v}"]`);
    if (el) await el.click();
  }
  await page.click(`[data-qa-state-btn="${state}"]`);
  await page.waitForFunction((id) => window.__qa.current() === id, state, { timeout: 5000 });
}

// 1+2+3:dismiss / 浮层覆盖 / 不推挤(四端)
for (const plat of PLATS) {
  await gotoCase(plat);
  const m = await page.evaluate(() => {
    const frame = document.getElementById('frame');
    const bubble = frame.querySelector('.db-bubble');
    const br = bubble.getBoundingClientRect();
    const hit = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
    const panel = frame.querySelector('.prop-panel');
    const pr = panel ? panel.getBoundingClientRect() : null;
    return {
      hitIsBubble: hit === bubble || bubble.contains(hit),
      panelRect: pr ? { x: pr.x, y: pr.y, w: pr.width, h: pr.height } : null,
    };
  });
  check(`overlay:${plat}`, m.hitIsBubble, 'elementFromPoint(气泡中心)命中气泡');
  await page.click('.db-dismiss');
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => {
    const frame = document.getElementById('frame');
    const gone = !frame.querySelector('.db-bubble');
    const panel = frame.querySelector('.prop-panel');
    const pr = panel ? panel.getBoundingClientRect() : null;
    return { gone, panelRect: pr ? { x: pr.x, y: pr.y, w: pr.width, h: pr.height } : null };
  });
  check(`dismiss:${plat}`, after.gone, '点击「我知道了」气泡消失');
  const sameRect = JSON.stringify(m.panelRect) === JSON.stringify(after.panelRect);
  check(`no-push:${plat}`, sameRect, '气泡消失后面板示意 rect 逐 px 不变(不占布局流)');
}

// 4+6+7:间距 / 压力态 / 热区(desk + phone,completed + stress)
for (const plat of ['desk', 'phone']) {
  for (const state of ['deletion-completed', 'deletion-stress']) {
    await gotoCase(plat, 'light', 'zh-CN', state);
    const g = await page.evaluate(() => {
      const bubble = document.querySelector('.db-bubble');
      const br = bubble.getBoundingClientRect();
      const copyR = bubble.querySelector('.db-copy').getBoundingClientRect();
      const dismiss = bubble.querySelector('.db-dismiss');
      const dr = (dismiss.querySelector('.db-dismiss-text') ?? dismiss).getBoundingClientRect();
      const btnR = dismiss.getBoundingClientRect();
      const align = getComputedStyle(bubble.querySelector('.db-copy')).textAlign;
      return {
        bubbleH: br.height,
        gapLink: dr.top - copyR.bottom,
        gapBottom: br.bottom - 1 - dr.bottom,
        hitW: btnR.width,
        hitH: btnR.height,
        align,
      };
    });
    const tag = `${plat}:${state.replace('deletion-', '')}`;
    check(`gap-link:${tag}`, Math.abs(g.gapLink - 22) <= 1, `正文↔我知道了=${g.gapLink.toFixed(1)}(期望 22)`);
    check(`gap-bottom:${tag}`, Math.abs(g.gapBottom - 20) <= 1, `我知道了↔气泡底=${g.gapBottom.toFixed(1)}(拍板恒定 20)`);
    check(`copy-center:${tag}`, g.align === 'center', `text-align=${g.align}`);
    check(`hit-area:${tag}`, g.hitW >= 44 && g.hitH >= 44, `命中区 ${g.hitW.toFixed(0)}×${g.hitH.toFixed(0)}(≥44)`);
    if (state === 'deletion-stress') {
      await gotoCase(plat, 'light', 'zh-CN', 'deletion-completed');
      const h0 = await page.evaluate(() => document.querySelector('.db-bubble').getBoundingClientRect().height);
      check(`stress-grows:${plat}`, g.bubbleH > h0 + 40, `压力态撑高 ${g.bubbleH.toFixed(0)} > completed ${h0.toFixed(0)}`);
    }
  }
}

// 5:桌面 clamp(宽度 800→670 / 717→669 / 600→552;top 恒 72)
await gotoCase('desk');
for (const [w, want] of [[800, 670], [717, 669], [600, 552]]) {
  const m = await page.evaluate(({ w }) => {
    window.__qa.resize(w, 600);
    const b = document.querySelector('.db-bubble').getBoundingClientRect();
    const f = document.getElementById('frame').getBoundingClientRect();
    return { w: b.width, top: b.top - f.top, left: b.left - f.left };
  }, { w });
  check(`desk-clamp:${w}`, Math.abs(m.w - want) <= 1, `宽=${m.w.toFixed(1)}(期望 ${want}=min(670,${w}-48))`);
  check(`desk-top:${w}`, Math.abs(m.top - 72) <= 1, `top=${m.top.toFixed(1)}(恒定 72)`);
  check(`desk-center:${w}`, Math.abs(m.left - (w - m.w) / 2) <= 1, `left=${m.left.toFixed(1)}(水平居中)`);
}

// phone 窄屏 clamp(min(335, 屏宽−40)):390→335 / 374→334 / 335→295
await gotoCase('phone');
for (const [w, want] of [[390, 335], [374, 334], [335, 295]]) {
  const m = await page.evaluate(({ w }) => {
    window.__qa.resize(w, 700);
    const b = document.querySelector('.db-bubble').getBoundingClientRect();
    const f = document.getElementById('frame').getBoundingClientRect();
    return { w: b.width, left: b.left - f.left };
  }, { w });
  check(`phone-clamp:${w}`, Math.abs(m.w - want) <= 1, `宽=${m.w.toFixed(1)}(期望 ${want}=min(335,${w}-40))`);
  check(`phone-center:${w}`, Math.abs(m.left - (w - m.w) / 2) <= 1, `left=${m.left.toFixed(1)}(水平居中)`);
}

await browser.close();

const evidenceDir = join(demoDir, 'evidence');
if (!existsSync(evidenceDir)) mkdirSync(evidenceDir, { recursive: true });
const out = { gate: 'interaction', pass: failures === 0, total: results.length, passed: results.filter((r) => r.pass).length, failures, generatedAt: new Date().toISOString(), results };
writeFileSync(join(evidenceDir, 'interaction-gate.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`\n交互门: ${out.passed}/${out.total} pass,evidence → evidence/interaction-gate.json`);
process.exit(failures === 0 ? 0 : 2);
