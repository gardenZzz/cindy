#!/usr/bin/env node
// extract.mjs — 注销提示气泡(修复后)QA demo 真值提取器。机械提取,不手抄:
//  - desktop:LoginPage.tsx 气泡 class 串/结构事实/渲染位置(根层浮层、LoginStage 之外)、
//    colors.ts registerColor 值(login-deletion-bubble-bg 的 var 链解析:chat-input-bg/surface
//    /chat-input-border/login-control-text/login-secondary-text)、4×common.json 注销四语。
//  - mobile:loginSkinLayout.ts LOGIN_DELETION_BUBBLE 常量 + resolveDeletionBubbleFrame 结构
//    事实(esbuild 编译后 import 作 adaptive oracle)、tokens.ts loginPalettes 双色板
//    (deletionBubbleBg/Border/controlText/secondaryText)、login.tsx 气泡样式块+渲染结构、
//    loginMessages.ts 注销四语。
//  - adaptive.samples:产品纯函数 resolveLoginSurface + resolveDeletionBubbleFrame 对
//    spec.adaptive.sampleSizes 预计算期望几何(oracle = 产品公式本身,验收侧不重写)。
// stdout 输出 truth JSON。

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const demoDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(demoDir, '..', '..', '..');
const R = (p) => resolve(repoRoot, p);
const rel = (p) => `../../../${p}`;

const hashes = new Map();
function fileHash(absPath) {
  if (!hashes.has(absPath)) {
    hashes.set(absPath, createHash('sha256').update(readFileSync(absPath)).digest('hex'));
  }
  return hashes.get(absPath);
}
function leaf(value, srcRelRepo, locator) {
  return {
    value,
    provenance: { source: rel(srcRelRepo), locator, hash: `sha256:${fileHash(R(srcRelRepo))}` },
  };
}
function readSrc(p) {
  return readFileSync(R(p), 'utf8');
}
function leafFields(obj, srcRelRepo, prefix, locators = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = leaf(v, srcRelRepo, locators[k] ?? `${prefix}.${k}`);
  return out;
}
function extractConstObject(src, name) {
  const start = src.indexOf(`export const ${name}`);
  if (start === -1) throw new Error(`未找到 export const ${name}`);
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(braceStart, i + 1);
    }
  }
  throw new Error(`${name} 对象体未闭合`);
}
function numField(objSrc, key) {
  const m = new RegExp(`\\b${key}:\\s*(-?[\\d.]+)`).exec(objSrc);
  if (!m) throw new Error(`字段 ${key} 未命中`);
  return Number(m[1]);
}
function extractRegisterColor(src, name) {
  const re = new RegExp(`registerColor\\('${name}',\\s*\\{\\s*light:\\s*'([^']+)',\\s*dark:\\s*'([^']+)'`, 's');
  const m = re.exec(src);
  if (!m) throw new Error(`registerColor('${name}') 未命中`);
  return { light: m[1], dark: m[2] };
}

/* ══ desktop ══ */
const P = {
  loginPage: 'apps/desktop/src/renderer/components/login/LoginPage.tsx',
  colors: 'apps/desktop/src/renderer/themes/colors.ts',
  commonJson: (loc) => `apps/desktop/src/renderer/i18n/locales/${loc}/common.json`,
};
const loginPageSrc = readSrc(P.loginPage);
const colorsSrc = readSrc(P.colors);

// 结构事实:气泡 class 串(浮层定位/尺寸/颜色 token 消费)
const bubbleClassM = /className="(absolute left-1\/2 top-\[72px\] z-30 w-\[min\(670px,calc\(100vw-48px\)\)\] -translate-x-1\/2 break-words rounded-\[22px\] border border-\[var\(--chat-input-border\)\] bg-\[var\(--login-deletion-bubble-bg\)\] p-5 text-center)"/.exec(loginPageSrc);
if (!bubbleClassM) throw new Error('desktop 气泡 section className 未命中(源码已变?)');
const bubbleTitleClassM = /<h2 className="(text-\[20px\] font-normal leading-\[23px\] text-\[var\(--login-control-text\)\])"/.exec(loginPageSrc);
const bubbleCopyClassM = /<p className="(mt-\[5px\] text-\[20px\] font-normal leading-\[23px\] text-\[var\(--login-secondary-text\)\])"/.exec(loginPageSrc);
if (!bubbleTitleClassM || !bubbleCopyClassM) throw new Error('desktop 气泡标题/正文 className 未命中');
// 渲染位置结构事实:气泡在 </LoginStage> 之后(根层,不在 stage 文档流)
const renderPosM = /<\/LoginStage>\s*\{\/\* 注销状态提示气泡[\s\S]{0,400}?<AccountDeletionStatusPanel/.exec(loginPageSrc);
if (!renderPosM) throw new Error('desktop 气泡根层渲染位置(</LoginStage> 之后)未命中');
// completed 才传 onDismiss(结构事实,沿用旧逻辑未改动)
const dismissGateM = /accountDeletionStatus\.status === 'completed'\s*\?\s*\(\) =>/.exec(loginPageSrc);
if (!dismissGateM) throw new Error('desktop dismiss 仅 completed 结构未命中');
// 「我知道了」热区扩张 class(mt-11 -mb-11 py-11 视觉间距 22/20)
const dismissClassM = /'(mt-\[11px\] -mb-\[11px\] border-0 bg-transparent px-3 py-\[11px\])',/.exec(loginPageSrc);
if (!dismissClassM) throw new Error('desktop dismiss 热区扩张 className 未命中');

// 颜色 token:login-deletion-bubble-bg 的 var 链解析到实值
const bubbleBgRefs = extractRegisterColor(colorsSrc, 'login-deletion-bubble-bg');
if (bubbleBgRefs.light !== 'var(--chat-input-bg)' || bubbleBgRefs.dark !== 'var(--surface)')
  throw new Error('login-deletion-bubble-bg 的 var 链前提变化(应为 chat-input-bg/surface)');
const chatInputBg = extractRegisterColor(colorsSrc, 'chat-input-bg');
const surface = extractRegisterColor(colorsSrc, 'surface');
const chatInputBorder = extractRegisterColor(colorsSrc, 'chat-input-border');
const controlText = extractRegisterColor(colorsSrc, 'login-control-text');
const secondaryText = extractRegisterColor(colorsSrc, 'login-secondary-text');
// var 链递归解析(如 chat-input-bg.light='var(--surface-elevated)' → surface-elevated.light)
function resolveVarChain(value) {
  const m = /^var\(--([\w-]+)\)$/.exec(value);
  if (!m) return { value, chain: [value] };
  const hop = extractRegisterColor(colorsSrc, m[1]);
  // 只取与调用侧同模式的那一跳由调用方挑;这里返回两模式供挑
  return { value, chain: [value, `var(--${m[1]})`], ref: hop };
}
const deskBubbleBgLight = resolveVarChain(chatInputBg.light);
const deskBubbleBgLightFinal = deskBubbleBgLight.ref ? deskBubbleBgLight.ref.light : deskBubbleBgLight.value;
const deskBgLightLocator = deskBubbleBgLight.ref
  ? `login-deletion-bubble-bg.light=var(--chat-input-bg) → chat-input-bg.light=${chatInputBg.light} → ${deskBubbleBgLight.chain[1]} → ${deskBubbleBgLightFinal}`
  : "login-deletion-bubble-bg.light=var(--chat-input-bg) → registerColor('chat-input-bg').light";
const deskBorderLight = resolveVarChain(chatInputBorder.light);
const deskBorderDark = resolveVarChain(chatInputBorder.dark);
const deskBorderLightFinal = deskBorderLight.ref ? deskBorderLight.ref.light : deskBorderLight.value;
const deskBorderDarkFinal = deskBorderDark.ref ? deskBorderDark.ref.dark : deskBorderDark.value;
const deskBorderLocator = (hop, final) =>
  hop.ref
    ? `chat-input-border=${hop.value} → ${hop.chain[1]} → ${final}`
    : "chat-input-border(直接消费 var(--chat-input-border))";

const DESK_COPY_LOCALES = ['zh-CN', 'en', 'ja', 'ko'];
const deskCopy = {};
for (const loc of DESK_COPY_LOCALES) {
  const j = JSON.parse(readSrc(P.commonJson(loc)));
  const st = j.accountDeletion?.status;
  if (!st) throw new Error(`${loc} common.json 缺 accountDeletion.status`);
  deskCopy[loc] = {
    pendingTitle: st.pendingTitle,
    pendingCopy: st.pendingCopy,
    processingTitle: st.processingTitle,
    processingCopy: st.processingCopy,
    completedTitle: st.completedTitle,
    completedCopy: st.completedCopy,
    dismissButton: st.dismissButton,
  };
}

/* ══ mobile ══ */
const M = {
  skinLayout: 'apps/mobile/src/auth/loginSkinLayout.ts',
  tokens: 'apps/mobile/src/theme/tokens.ts',
  loginTsx: 'apps/mobile/app/(auth)/login.tsx',
  loginMessages: 'apps/mobile/src/auth/loginMessages.ts',
};
const mSkinSrc = readSrc(M.skinLayout);
const mTokensSrc = readSrc(M.tokens);
const mLoginSrc = readSrc(M.loginTsx);
const mMsgsSrc = readSrc(M.loginMessages);

const mBubbleObj = extractConstObject(mSkinSrc, 'LOGIN_DELETION_BUBBLE');
const copyLineHeight = Number(/LOGIN_COPY_LINE_HEIGHT\s*=\s*(\d+)/.exec(mSkinSrc)[1]);
// surface 断点与 pad stage 规格(气泡定位移植所需;resolveDeletionBubbleFrame 消费)
const padLandscapeMinW = Number(/PAD_LANDSCAPE_MIN_WIDTH\s*=\s*(\d+)/.exec(mSkinSrc)[1]);
const padLandscapeMinH = Number(/PAD_LANDSCAPE_MIN_HEIGHT\s*=\s*(\d+)/.exec(mSkinSrc)[1]);
const padPortraitMinW = Number(/PAD_PORTRAIT_MIN_WIDTH\s*=\s*(\d+)/.exec(mSkinSrc)[1]);
const padLandscapeMinScale = Number(/PAD_LANDSCAPE_MIN_SCALE\s*=\s*([\d.]+)/.exec(mSkinSrc)[1]);
const mPadPortraitStage = extractConstObject(mSkinSrc, 'LOGIN_PAD_PORTRAIT_STAGE');
const mPadLandscapeStage = extractConstObject(mSkinSrc, 'LOGIN_PAD_LANDSCAPE_STAGE');
const mStageWidth = Number(/LOGIN_STAGE_WIDTH\s*=\s*(\d+)/.exec(mSkinSrc)[1]);

// mobile 结构事实:气泡 position absolute + frame 行内注入;样式块无阴影/固定高
const mBubbleStyleBlock = /deletionBubble: \{([\s\S]*?)\}/.exec(mLoginSrc);
if (!mBubbleStyleBlock || !/position: 'absolute'/.test(mBubbleStyleBlock[1]))
  throw new Error('mobile deletionBubble 样式块 position:absolute 未命中');
if (/shadow|elevation|height:/.test(mBubbleStyleBlock[1]))
  throw new Error('mobile deletionBubble 出现了 shadow/elevation/固定高——规格前提变化,需复核');
const mFrameInjectM = /\{ left: frame\.left, top: frame\.top, width: frame\.width \}/.exec(mLoginSrc);
if (!mFrameInjectM) throw new Error('mobile 气泡 frame 行内注入(left/top/width)未命中');
const mResolveCallM = /resolveDeletionBubbleFrame\(stage, insets\.top\)/.exec(mLoginSrc);
if (!mResolveCallM) throw new Error('mobile resolveDeletionBubbleFrame(stage, insets.top) 调用未命中');
const mHitSlopM = /hitSlop=\{LOGIN_DELETION_BUBBLE\.linkHitSlop\}/.exec(mLoginSrc);
if (!mHitSlopM) throw new Error('mobile dismiss hitSlop 未命中');
// 入场门(PR #464 review):Animated.View opacity=panelEntrance.opacity + pointerEvents 仅 done
const mEntranceGateM = /<Animated.View\s+pointerEvents=\{handoffPhase === 'done' \? 'auto' : 'none'\}\s+style=\{\[StyleSheet\.absoluteFill, \{ opacity: panelEntrance\.opacity \}\]\}/.exec(mLoginSrc);
if (!mEntranceGateM) throw new Error('mobile 气泡入场门(Animated.View opacity/pointerEvents gate)未命中');

// loginPalettes 双色板
const mPalettesObj = extractConstObject(mTokensSrc, 'loginPalettes');
function paletteVal(mode, key) {
  const modeBlock = new RegExp(`${mode}: \\{([\\s\\S]*?)\\n  \\}`).exec(mPalettesObj);
  if (!modeBlock) throw new Error(`loginPalettes.${mode} 块未命中`);
  const m = new RegExp(`\\b${key}:\\s*'([^']+)'`).exec(modeBlock[1]);
  if (!m) throw new Error(`loginPalettes.${mode}.${key} 未命中`);
  return m[1];
}

// loginMessages 四语(顺序 zh-CN/en/ja/ko)
const MSG_LOCALES = ['zh-CN', 'en', 'ja', 'ko'];
function msgValues(key) {
  const re = new RegExp(`\\b${key}:\\s*'((?:[^'\\\\]|\\\\.)*)'`, 'g');
  const hits = [...mMsgsSrc.matchAll(re)].map((m) => m[1]);
  if (hits.length !== 4) throw new Error(`loginMessages 键 ${key} 命中 ${hits.length} 次(预期 4)`);
  return hits;
}
const mCopy = {};
for (const [i, loc] of MSG_LOCALES.entries()) {
  mCopy[loc] = {
    pendingTitle: msgValues('accountDeletionPendingTitle')[i],
    pendingCopy: msgValues('accountDeletionPendingCopy')[i],
    processingTitle: msgValues('accountDeletionProcessingTitle')[i],
    processingCopy: msgValues('accountDeletionProcessingCopy')[i],
    completedTitle: msgValues('accountDeletionCompletedTitle')[i],
    completedCopy: msgValues('accountDeletionCompletedCopy')[i],
    dismissButton: msgValues('accountDeletionDismiss')[i],
  };
}

/* ══ oracle:esbuild 编译 loginSkinLayout.ts → resolveLoginSurface + resolveDeletionBubbleFrame ══ */
const require2 = createRequire(join(repoRoot, 'package.json'));
const esbuild = require2('esbuild');
const tmp = mkdtempSync(join(tmpdir(), 'deletion-bubble-extract-'));
let layoutMod;
try {
  const code = esbuild.transformSync(mSkinSrc, { loader: 'ts', format: 'esm' }).code;
  writeFileSync(join(tmp, 'loginSkinLayout.mjs'), code);
  layoutMod = await import(pathToFileURL(join(tmp, 'loginSkinLayout.mjs')).href);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
const { resolveLoginSurface, resolveDeletionBubbleFrame } = layoutMod;

// demo 的 safeTop 仿真常量(demo chrome;phone top = insets.top,产品运行时注入)
const DEMO_SAFE_TOP = 59;
// spec.adaptive.sampleSizes 的期望几何预计算(oracle = 产品纯函数)
const SAMPLE_SIZES = [
  [390, 844], [375, 812], [374, 812], [335, 700], [320, 680],
  [700, 1000], [699, 1000], [744, 1133],
  [1000, 690], [999, 690], [1000, 689], [1180, 820], [1440, 900],
];
const samples = SAMPLE_SIZES.map(([w, h]) => {
  const surface = resolveLoginSurface(w, h);
  const frame = resolveDeletionBubbleFrame(surface, DEMO_SAFE_TOP);
  return {
    w,
    h,
    probes: {
      bubble: { x: frame.left, y: frame.top, w: frame.width },
      surfaceMode: surface.mode,
    },
  };
});

/* ══ truth 组装 ══ */
const truth = {
  structure: {
    desktop: {
      renderPosition: leaf('LoginPage 根层(</LoginStage> 之后),不在 stage 文档流;absolute z-30 浮层', P.loginPage, 'LoginPage.tsx </LoginStage> 之后的 AccountDeletionStatusPanel 渲染点'),
      dismissGate: leaf("仅 completed 态传入 onDismiss(「我知道了」);pending/processing 无按钮", P.loginPage, "LoginPage.tsx accountDeletionStatus.status === 'completed' ? onDismiss : undefined"),
      bubbleClass: leaf(bubbleClassM[1], P.loginPage, 'AccountDeletionStatusPanel section className 全串'),
      dismissHitArea: leaf('mt-[11px]+py-[11px](视觉 22)+-mb-[11px](视觉底 20);热区 11+23+11=45≥44', P.loginPage, `dismiss className="${dismissClassM[1]}"`),
    },
    mobile: {
      renderPosition: leaf('position:absolute,left/top/width 由 resolveDeletionBubbleFrame(stage, insets.top) 行内注入;不参与布局流', M.loginTsx, 'login.tsx:1140-1197 deletionBubbleFrame + AccountDeletionStatusPanel frame prop'),
      styleFacts: leaf('不透明底+1px 描边;无 shadow/elevation/固定高(样式块守护断言)', M.loginTsx, 'login.tsx:1439-1449 makeStyles.deletionBubble'),
      dismissHitSlop: leaf('hitSlop {top:12,bottom:12,left:20,right:20} → 热区 47≥44', M.loginTsx, 'login.tsx hitSlop={LOGIN_DELETION_BUBBLE.linkHitSlop}'),
      dismissGate: leaf('仅 completed 态渲染 dismiss Pressable(onDismiss 仅 completed 传入)', M.loginTsx, 'login.tsx:1315-1327 {onDismiss ? <Pressable/> : null}'),
      entranceGate: leaf("Animated.View 包装:opacity=panelEntrance.opacity(与登录组同一 Animated 值);pointerEvents 仅 handoffPhase==='done' 放行——入场完成前不可见不可点(PR #464 review)", M.loginTsx, 'login.tsx 气泡渲染点 Animated.View pointerEvents/style'),
    },
  },
  desktop: {
    geometry: leafFields(
      { top: 72, width: 670, widthClamp: 'min(670px, calc(100vw - 48px))', radius: 22, padding: 20, borderWidth: 1, fontSize: 20, lineHeight: 23, fontWeight: 400, titleBodyGap: 5, bodyLinkGap: 22, linkBottomGap: 20, linkHitHeight: 45, zIndex: 30 },
      P.loginPage,
      'AccountDeletionStatusPanel(tailwind 类)',
      {
        top: 'top-[72px]', width: 'w-[min(670px,…)] 的 670', widthClamp: 'w-[min(670px,calc(100vw-48px))]',
        radius: 'rounded-[22px]', padding: 'p-5=20', borderWidth: 'border=1',
        fontSize: 'text-[20px]', lineHeight: 'leading-[23px]', fontWeight: 'font-normal=400',
        titleBodyGap: '正文 mt-[5px]', bodyLinkGap: 'mt-[11px]+py-[11px] 视觉 22',
        linkBottomGap: '-mb-[11px]+p-5 视觉 20(拍板固定底距)', linkHitHeight: 'py 11×2+23=45',
        zIndex: 'z-30',
      },
    ),
    colors: {
      bubbleBg: {
        light: leaf(deskBubbleBgLightFinal, P.colors, deskBgLightLocator),
        dark: leaf(surface.dark, P.colors, "login-deletion-bubble-bg.dark=var(--surface) → registerColor('surface').dark"),
      },
      bubbleBorder: {
        light: leaf(deskBorderLightFinal, P.colors, deskBorderLocator(deskBorderLight, deskBorderLightFinal)),
        dark: leaf(deskBorderDarkFinal, P.colors, deskBorderLocator(deskBorderDark, deskBorderDarkFinal)),
      },
      titleText: {
        light: leaf(controlText.light, P.colors, "registerColor('login-control-text').light"),
        dark: leaf(controlText.dark, P.colors, "registerColor('login-control-text').dark"),
      },
      copyText: {
        light: leaf(secondaryText.light, P.colors, "registerColor('login-secondary-text').light"),
        dark: leaf(secondaryText.dark, P.colors, "registerColor('login-secondary-text').dark"),
      },
      bgBase: {
        light: leaf(extractRegisterColor(colorsSrc, 'login-bg-base').light, P.colors, "registerColor('login-bg-base').light"),
        dark: leaf(extractRegisterColor(colorsSrc, 'login-bg-base').dark, P.colors, "registerColor('login-bg-base').dark"),
      },
    },
    copy: Object.fromEntries(
      DESK_COPY_LOCALES.map((loc) => [
        loc,
        leafFields(deskCopy[loc], P.commonJson(loc), `accountDeletion.status(${loc})`),
      ]),
    ),
  },
  mobile: {
    geometry: leafFields(
      {
        radius: numField(mBubbleObj, 'radius'),
        padding: numField(mBubbleObj, 'padding'),
        borderWidth: numField(mBubbleObj, 'borderWidth'),
        fontSize: numField(mBubbleObj, 'font'),
        lineHeight: copyLineHeight,
        titleBodyGap: numField(mBubbleObj, 'titleBodyGap'),
        bodyLinkGap: numField(mBubbleObj, 'bodyLinkGap'),
        hitSlopTop: 12,
        hitSlopBottom: 12,
        hitSlopX: 20,
        sideMargin: numField(mBubbleObj, 'sideMargin'),
        phoneMaxWidth: 335,
        padWidth: 556,
        padTop: 72,
        padLandscapeCenterRatio: 0.75,
      },
      M.skinLayout,
      'LOGIN_DELETION_BUBBLE',
      {
        lineHeight: 'LOGIN_DELETION_BUBBLE.lineHeight=LOGIN_COPY_LINE_HEIGHT',
        hitSlopTop: 'LOGIN_DELETION_BUBBLE.linkHitSlop.top',
        hitSlopBottom: 'LOGIN_DELETION_BUBBLE.linkHitSlop.bottom',
        hitSlopX: 'LOGIN_DELETION_BUBBLE.linkHitSlop.left/right',
        phoneMaxWidth: 'LOGIN_DELETION_BUBBLE.phone.maxWidth',
        padWidth: 'LOGIN_DELETION_BUBBLE.pad.width',
        padTop: 'LOGIN_DELETION_BUBBLE.pad.top',
        padLandscapeCenterRatio: 'LOGIN_DELETION_BUBBLE.pad.landscapeCenterRatio',
      },
    ),
    colors: (() => {
      const out = {};
      for (const key of ['deletionBubbleBg', 'deletionBubbleBorder', 'controlText', 'secondaryText', 'bgBase']) {
        out[key] = {
          light: leaf(paletteVal('light', key), M.tokens, `loginPalettes.light.${key}`),
          dark: leaf(paletteVal('dark', key), M.tokens, `loginPalettes.dark.${key}`),
        };
      }
      return out;
    })(),
    surface: leafFields(
      {
        padLandscapeMinWidth: padLandscapeMinW,
        padLandscapeMinHeight: padLandscapeMinH,
        padPortraitMinWidth: padPortraitMinW,
        padLandscapeMinScale: padLandscapeMinScale,
        padPortraitStageWidth: numField(mPadPortraitStage, 'width'),
        padPortraitStageHeight: numField(mPadPortraitStage, 'height'),
        padLandscapeStageWidth: numField(mPadLandscapeStage, 'width'),
        padLandscapeStageHeight: numField(mPadLandscapeStage, 'height'),
        stageWidth: mStageWidth,
      },
      M.skinLayout,
      'surface 断点/stage 规格',
      {
        padLandscapeMinWidth: 'PAD_LANDSCAPE_MIN_WIDTH',
        padLandscapeMinHeight: 'PAD_LANDSCAPE_MIN_HEIGHT',
        padPortraitMinWidth: 'PAD_PORTRAIT_MIN_WIDTH',
        padLandscapeMinScale: 'PAD_LANDSCAPE_MIN_SCALE',
        padPortraitStageWidth: 'LOGIN_PAD_PORTRAIT_STAGE.width',
        padPortraitStageHeight: 'LOGIN_PAD_PORTRAIT_STAGE.height',
        padLandscapeStageWidth: 'LOGIN_PAD_LANDSCAPE_STAGE.width',
        padLandscapeStageHeight: 'LOGIN_PAD_LANDSCAPE_STAGE.height',
        stageWidth: 'LOGIN_STAGE_WIDTH',
      },
    ),
    copy: Object.fromEntries(
      MSG_LOCALES.map((loc) => [loc, leafFields(mCopy[loc], M.loginMessages, `accountDeletion*(${loc})`)]),
    ),
  },
  adaptive: {
    safeTop: leaf(DEMO_SAFE_TOP, M.loginTsx, 'demo chrome:safe-area 顶仿真常量(产品运行时 = insets.top)'),
    oracle: leaf('resolveLoginSurface + resolveDeletionBubbleFrame(esbuild 编译 loginSkinLayout.ts 后 import,产品纯函数)', M.skinLayout, 'loginSkinLayout.ts:302 resolveLoginSurface / :486 resolveDeletionBubbleFrame'),
    samples: leaf(samples, M.skinLayout, '产品纯函数对 spec.adaptive.sampleSizes 预计算(oracle 输出,非手算)'),
  },
};

process.stdout.write(JSON.stringify(truth, null, 1) + '\n');
