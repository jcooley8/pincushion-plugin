// mobile-wall-core.js — pure logic for `npx pincushion-mcp mobile-wall`.
// Turns simulator captures (screens/*.png + ax/*.json accessibility dumps)
// into a static, brandable "crit wall" page with semantic hotspot overlays,
// so Pincushion pins anchor to real element labels instead of raw pixels.
//
// No I/O in this module beyond what callers pass in — everything here is
// testable without a simulator. The shell (mobile-wall.mjs) owns capture
// (xcrun simctl / maestro / idb) and the filesystem.

// ─── small utilities ─────────────────────────────────────────────────────────

export const slug = (s) => String(s).toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

export const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// "01-first-launch" → { num: "01", title: "First launch" }
export function screenMeta(name, index = 0) {
  const m = /^(\d+)[-_]?(.*)$/.exec(name);
  const num = m ? m[1].padStart(2, '0') : String(index + 1).padStart(2, '0');
  const rest = (m ? m[2] : name).replace(/[-_]+/g, ' ').trim();
  const title = rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : name;
  return { num, title };
}

// Minimal PNG IHDR reader — width/height without any image dependency.
export function pngSize(buf) {
  if (!buf || buf.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// ─── AX dump parsing (maestro + idb backends) ────────────────────────────────
// Both parsers normalize to a flat node list: { label, x1, y1, x2, y2, w, h }.
// Bounds are POINTS (iOS logical coordinates) — hotspots are emitted as % of
// the derived screen size, so they map onto the PNG regardless of @2x/@3x.

export function parseBounds(b) {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(b || '');
  if (!m) return null;
  const [x1, y1, x2, y2] = m.slice(1).map(Number);
  return { x1, y1, x2, y2, w: x2 - x1, h: y2 - y1 };
}

// `maestro hierarchy` — nested { attributes: { accessibilityText, text,
// bounds: "[x1,y1][x2,y2]" }, children: [] }. Maestro sometimes wraps the
// JSON in log lines, so cut to the outermost braces before parsing.
export function parseMaestro(raw) {
  const s = String(raw);
  const start = s.indexOf('{'), end = s.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no JSON object found in maestro output');
  const tree = JSON.parse(s.slice(start, end + 1));
  const nodes = [];
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    const a = node.attributes || {};
    const b = parseBounds(a.bounds);
    if (b) nodes.push({ label: (a.accessibilityText || a.text || '').trim(), ...b });
    for (const c of node.children || []) walk(c);
  })(tree);
  return nodes;
}

// `idb ui describe-all --json` — flat array (or NDJSON lines) of elements with
// AXLabel + frame {x,y,width,height} (or an AXFrame "{{x, y}, {w, h}}" string).
export function parseIdb(raw) {
  const s = String(raw).trim();
  let els;
  try {
    const parsed = JSON.parse(s);
    els = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    els = s.split('\n').map((l) => l.trim()).filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { return []; }
    });
  }
  const nodes = [];
  for (const el of els) {
    if (!el || typeof el !== 'object') continue;
    let f = el.frame;
    if (!f && typeof el.AXFrame === 'string') {
      const m = /\{\{(-?[\d.]+),\s*(-?[\d.]+)\},\s*\{(-?[\d.]+),\s*(-?[\d.]+)\}\}/.exec(el.AXFrame);
      if (m) f = { x: +m[1], y: +m[2], width: +m[3], height: +m[4] };
    }
    if (!f || typeof f.x !== 'number') continue;
    const x1 = Math.round(f.x), y1 = Math.round(f.y);
    const w = Math.round(f.width), h = Math.round(f.height);
    const label = String(el.AXLabel || el.title || '').trim();
    nodes.push({ label, x1, y1, x2: x1 + w, y2: y1 + h, w, h });
  }
  return nodes;
}

// Screen point-size from the dump itself (no per-device table): prefer the
// largest node anchored at the origin (the app window / root view), fall back
// to the max extents across all nodes.
export function deriveScreenSize(nodes, override = null) {
  if (override && override.w > 0 && override.h > 0) return { w: override.w, h: override.h };
  let best = null;
  for (const n of nodes) {
    if (n.x1 <= 0 && n.y1 <= 0 && n.w > 0 && n.h > 0) {
      if (!best || n.w * n.h > best.w * best.h) best = n;
    }
  }
  if (best) return { w: best.x2, h: best.y2 };
  let w = 0, h = 0;
  for (const n of nodes) { w = Math.max(w, n.x2); h = Math.max(h, n.y2); }
  if (!w || !h) throw new Error('could not derive screen size from AX dump');
  return { w, h };
}

// ─── hotspot extraction ──────────────────────────────────────────────────────

const STATUS_BAR_PT = 44; // skip system status-bar elements
const STATUS_BAR_RE = /battery|wi-fi|cellular|ssid|^\d{1,2}:\d{2}/i;

// Prefer the leaf-most element per label: drop an entry when another entry
// with the same label sits fully inside it (parents duplicate child labels).
export function dedupeHotspots(items) {
  return items.filter((p) => !items.some((q) =>
    q !== p && q.label === p.label &&
    q.x1 >= p.x1 && q.y1 >= p.y1 && q.x2 <= p.x2 && q.y2 <= p.y2 &&
    (q.w * q.h) < (p.w * p.h)
  ));
}

// Labeled, on-screen, non-chrome elements → % of screen hotspots with stable
// slugged ids. Percentages survive responsive scaling of the exhibit image.
export function extractHotspots(nodes, screen, { statusBarPt = STATUS_BAR_PT } = {}) {
  const items = nodes.filter((n) =>
    n.label && n.w >= 8 && n.h >= 8 && n.w <= screen.w && n.h <= screen.h * 0.95 &&
    !(n.y2 <= statusBarPt || STATUS_BAR_RE.test(n.label)));
  const seen = new Set();
  return dedupeHotspots(items).map((p) => {
    let id = slug(p.label) || 'el';
    while (seen.has(id)) id += '-2';
    seen.add(id);
    return {
      id, label: p.label,
      left: +(p.x1 / screen.w * 100).toFixed(2), top: +(p.y1 / screen.h * 100).toFixed(2),
      width: +(p.w / screen.w * 100).toFixed(2), height: +(p.h / screen.h * 100).toFixed(2),
    };
  });
}

// ─── wall config (brandable, editable, rebuild-safe) ─────────────────────────
// wall.config.json lives in the capture dir; `build` writes a starter on first
// run and preserves user edits on rebuild (new screens are appended).

export function defaultConfig(appName = 'My app') {
  return {
    title: `${appName} — The Crit Wall`,
    kicker: `${appName} · design crit`,
    headline: 'Pin the native app, ship from source context.',
    lede: `Every screen of <b>${esc(appName)}</b>, mounted on one wall with accessibility anchors. Pins include screen + element labels so the implementing agent can resolve feedback in the app repo, not from pixels alone.`,
    accent: '#e5482e',
    theme: {},          // optional CSS-variable overrides: wall, wall2, chalk, chalkDim, hairline, placard
    footer: `Wall generated with <a href="https://www.pincushion.io" rel="noopener">Pincushion</a>. Screen + element + problem + fix beats "redesign everything."`,
    commands: [
      { label: 'Capture or refresh this wall', value: 'npx pincushion-mcp mobile-wall run' },
      { label: 'Open the agent packet', value: 'cat crit-wall/wall/agent-work-packet.md' },
      { label: 'Register the deployed wall', value: 'configure_project name="<app> crit wall" urls=["<deployed URL>"]' },
      { label: 'Create the public report', value: 'create_share_report' },
    ],
    agent: {
      targetRepo: 'mobile app repo',
      sourceRoots: ['.'],
      implementationNotes: [],
      acceptanceCriteria: [
        'Resolve approved pins in the native app repository, not by editing the wall artifact.',
        'Use screen.id, screen.screenId, route, sourceFiles, and hotspot labels to find native UI source.',
        'Refresh accessibility capture or add explicit source hints before treating screenshot-only pins as implementation-ready.',
      ],
    },
    sourceHints: {
      // Optional per-screen native hints:
      // { "01-home": { screenId, route, sourceFiles: ["App/HomeView.swift"], notes: [] } }
      screens: {},
      // Optional per-label source hints:
      // { "Get started": { sourceFiles: ["App/OnboardingView.swift"], notes: [] } }
      labels: {},
    },
    publish: {
      deployCommand: '',  // optional CI/static-host command run from wall/
      deployUrl: '',      // optional canonical URL to link on refreshed pins
      snapshotPath: '',   // optional JPEG/WebP full-page capture of the wall/report
    },
    projectId: '',      // set after configure_project — emits the pincushion-project meta tag
    pageUrl: '',        // the wall's deployed URL — with projectId, enables click-to-pin (no install)
    reportUrl: '',      // public crit report from create_share_report — linked in the how-to strip
    endpoint: 'https://dpsqzszdviltqvethxbr.supabase.co/functions/v1/widget-feedback',
    canvasScriptUrl: 'https://www.pincushion.io/widget/mobile-wall-canvas.js',
    ogImage: '',        // social preview image, relative to wall/ (e.g. "og.png")
    // Report-snapshot mapping (proven in the OpenClaw pilot): after
    // upload_page_snapshot, set the snapshot's pixel size + each exhibit
    // image's rect within it, and click-to-pin coordinates land exactly on
    // the annotated report. Without it, pins fall back to document-relative.
    // snapshot: { w: 1280, h: 7410, rects: { "01-first-launch": { x, y, w, h } } }
    snapshot: null,
    screens: {},        // per-screen { title, caption, flow, route, build, screen, links } — keyed by capture name
  };
}

function isAutomationFlowPath(value) {
  return /\.ya?ml$/i.test(String(value || '')) || /[\\/]/.test(String(value || ''));
}

export function mergeConfig(existing, appName, screenNames, plan = null) {
  const base = defaultConfig(appName);
  const cfg = { ...base, ...(existing || {}) };
  cfg.agent = { ...base.agent, ...(existing?.agent || {}) };
  cfg.agent.sourceRoots = existing?.agent?.sourceRoots || base.agent.sourceRoots;
  cfg.agent.implementationNotes = existing?.agent?.implementationNotes || base.agent.implementationNotes;
  cfg.agent.acceptanceCriteria = existing?.agent?.acceptanceCriteria || base.agent.acceptanceCriteria;
  cfg.sourceHints = { ...base.sourceHints, ...(existing?.sourceHints || {}) };
  cfg.sourceHints.screens = { ...base.sourceHints.screens, ...(existing?.sourceHints?.screens || {}) };
  cfg.sourceHints.labels = { ...base.sourceHints.labels, ...(existing?.sourceHints?.labels || {}) };
  cfg.publish = { ...base.publish, ...(existing?.publish || {}) };
  cfg.screens = { ...(existing?.screens || {}) };
  const planByName = screenPlanMap(plan);
  screenNames.forEach((name, i) => {
    const planScreen = planByName.get(name) || planByName.get(slug(name)) || {};
    if (!cfg.screens[name]) cfg.screens[name] = { title: screenMeta(name, i).title, caption: '', screen: planScreen.screen || name };
    const current = cfg.screens[name];
    if (!current.screen) current.screen = planScreen.screen || name;
    if (!current.flow && planScreen.flow && !isAutomationFlowPath(planScreen.flow)) current.flow = planScreen.flow;
    ['route', 'build'].forEach((key) => {
      if (!current[key] && planScreen[key]) current[key] = planScreen[key];
    });
    if (!Array.isArray(current.links) && Array.isArray(planScreen.links)) current.links = planScreen.links;
  });
  return cfg;
}

function screenReviewMeta(config, screenName) {
  const meta = config.screens?.[screenName] || {};
  return {
    flow: meta.flow || '',
    route: meta.route || '',
    build: meta.build || config.build || '',
    screen: meta.screen || screenName,
    links: arr(meta.links),
  };
}

// ─── wall page generation ────────────────────────────────────────────────────
// screens: [{ name, width, height, spots }] — width/height are PNG pixels
// (CLS-stable pinning surface), spots from extractHotspots (may be empty).

const THEME_KEYS = { wall: '--wall', wall2: '--wall-2', chalk: '--chalk', chalkDim: '--chalk-dim', hairline: '--hairline', placard: '--placard' };

export function buildWallHtml({ config, screens }) {
  const cfg = config;
  const themeVars = Object.entries(THEME_KEYS)
    .map(([k, v]) => cfg.theme?.[k] ? `${v}:${cfg.theme[k]};` : '')
    .join('');
  const exhibits = screens.map((s, i) => {
    const meta = cfg.screens?.[s.name] || {};
    const review = screenReviewMeta(cfg, s.name);
    const { num, title } = screenMeta(s.name, i);
    const dims = s.width && s.height ? ` width="${s.width}" height="${s.height}"` : '';
    const navTargets = review.links.length
      ? review.links
      : [screens[i - 1]?.name, screens[i + 1]?.name].filter(Boolean);
    const nav = navTargets.length
      ? `<nav class="screen-nav" aria-label="Screen links">${navTargets.map((target) => {
          const targetMeta = cfg.screens?.[target] || {};
          return `<a href="#screen-${slug(targetMeta.screen || target)}">${esc(targetMeta.title || screenMeta(target).title)}</a>`;
        }).join('')}</nav>`
      : '';
    const reviewBits = [
      review.flow && `Flow: ${review.flow}`,
      review.route && `Route: ${review.route}`,
      review.build && `Build: ${review.build}`,
      review.screen && `Screen: ${review.screen}`,
    ].filter(Boolean);
    const reviewMeta = reviewBits.length ? `<div class="screen-meta">${reviewBits.map((b) => `<span>${esc(b)}</span>`).join('')}</div>` : '';
    const spots = (s.spots || []).map((p) =>
      `      <div class="ax-spot" id="ax-${s.name}-${p.id}" data-ax="${esc(p.label)}" title="${esc(p.label)}" style="left:${p.left}%;top:${p.top}%;width:${p.width}%;height:${p.height}%"></div>`
    ).join('\n');
    const layer = spots ? `\n      <div class="ax-layer" aria-hidden="true">\n${spots}\n      </div>` : '';
    const count = (s.spots || []).length;
    const context = count
      ? `<p class="context">${count} semantic anchor${count === 1 ? '' : 's'} from the simulator accessibility tree.</p>`
      : '<p class="context warn">No accessibility anchors captured; pins on this screen will be screenshot-only.</p>';
    return `      <section class="exhibit" id="screen-${slug(review.screen || s.name)}">
        <figure${spots ? ' class="has-ax"' : ''}><img src="screens/${s.name}.png"${dims} alt="${esc(meta.title || title)}" loading="lazy">${layer}</figure>
        <figcaption class="placard"><span class="num">${esc(num)}</span><h3>${esc(meta.title || title)}</h3>${reviewMeta}<p>${esc(meta.caption || '')}</p>${context}${nav}</figcaption>
      </section>`;
  }).join('\n');

  const commands = Array.isArray(cfg.commands) ? cfg.commands.filter((c) => c?.value) : [];
  const commandBlock = commands.length ? `
    <div class="commands" aria-label="Agent handoff commands">
${commands.map((c) => `      <div class="command"><span>${esc(c.label || 'Command')}</span><code>${esc(c.value)}</code><button type="button" data-copy="${esc(c.value)}">Copy</button></div>`).join('\n')}
    </div>` : '';
  const reportLine = cfg.reportUrl
    ? `\n    <p class="ribbon">Every pin lands on the <a href="${esc(cfg.reportUrl)}" rel="noopener">live crit report</a> — read and reply there too, nothing to install.</p>`
    : '';
  const projectMeta = cfg.projectId ? `\n<meta name="pincushion-project" content="${esc(cfg.projectId)}">` : '';
  const ogImage = cfg.ogImage ? `\n<meta property="og:image" content="${esc(cfg.ogImage)}">` : '';
  const pinner = cfg.projectId && cfg.pageUrl ? buildPinnerScript(cfg) : '';
  const copyScript = commandBlock ? buildCopyScript() : '';
  const canvasScript = buildCanvasScript(cfg.canvasScriptUrl);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(cfg.title)}</title>
<meta name="description" content="${esc(cfg.headline)} ${esc(cfg.kicker)}">
<meta property="og:title" content="${esc(cfg.title)}">
<meta property="og:description" content="${esc(cfg.headline)} ${esc(cfg.kicker)}">
<meta property="og:type" content="website">${ogImage}${projectMeta}
<style>
  :root{
    --wall:#12140f;--wall-2:#171a13;--chalk:#e9e4d6;--chalk-dim:#a9a496;
    --red:${esc(cfg.accent)};--hairline:#2c2f26;--placard:#1c1f17;${themeVars}
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html{scroll-behavior:smooth}
  body{
    background:
      radial-gradient(1200px 600px at 70% -10%, color-mix(in srgb, var(--red) 8%, transparent), transparent 60%),
      repeating-linear-gradient(0deg, transparent 0 47px, rgba(233,228,214,.025) 47px 48px),
      repeating-linear-gradient(90deg, transparent 0 47px, rgba(233,228,214,.02) 47px 48px),
      var(--wall);
    color:var(--chalk);
    font:400 16px/1.6 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    -webkit-font-smoothing:antialiased;
  }
  .frame{max-width:1180px;margin:0 auto;padding:0 24px}
  header{padding:72px 0 40px;border-bottom:1px solid var(--hairline)}
  .kicker{color:var(--red);font-weight:600;font-size:13px;letter-spacing:.22em;text-transform:uppercase}
  h1{font-family:Georgia, "Times New Roman", serif;font-weight:900;font-size:clamp(44px,8vw,96px);line-height:.98;letter-spacing:-.02em;margin:14px 0 6px}
  .lede{max-width:64ch;color:var(--chalk-dim);margin-top:18px;font-size:15px}
  .lede b{color:var(--chalk);font-weight:600}
  .howto{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--hairline);border:1px solid var(--hairline);margin:40px 0 0}
  @media (max-width:700px){.howto{grid-template-columns:1fr}}
  .howto .step{background:var(--wall-2);padding:18px 20px}
  .howto .n{color:var(--red);font-weight:600;font-size:12px;letter-spacing:.18em}
  .howto p{font-size:13.5px;color:var(--chalk-dim);margin-top:6px}
  .ribbon{margin-top:14px;font-size:12.5px;color:var(--chalk-dim)}
  .ribbon a,footer a{color:var(--chalk);text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--red)}
  .commands{margin-top:18px;border:1px solid var(--hairline);background:var(--wall-2)}
  .command{display:grid;grid-template-columns:180px 1fr auto;gap:12px;align-items:center;padding:10px 12px;border-top:1px solid var(--hairline)}
  .command:first-child{border-top:0}
  .command span{font-size:11px;color:var(--chalk-dim);text-transform:uppercase;letter-spacing:.08em}
  .command code{display:block;min-width:0;overflow:auto;white-space:nowrap;font:400 12px/1.4 inherit;color:var(--chalk);background:var(--wall);border:1px solid var(--hairline);border-radius:6px;padding:7px 9px}
  .command button{background:transparent;color:var(--chalk);border:1px solid var(--hairline);border-radius:6px;padding:7px 10px;font:600 12px/1 inherit;cursor:pointer}
  .command button:hover{border-color:var(--red)}
  @media (max-width:760px){.command{grid-template-columns:1fr}.command code{white-space:normal;overflow-wrap:anywhere}}
  main{padding:34px 0 40px}
  .canvas-shell{padding:0 16px}
  .canvas-toolbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:flex-end;gap:6px;margin:0 auto 12px;max-width:1180px;padding:8px;background:color-mix(in srgb, var(--wall) 88%, transparent);backdrop-filter:blur(10px);border:1px solid var(--hairline);border-radius:10px}
  .zoom-btn,.zoom-readout{height:30px;min-width:32px;border:1px solid var(--hairline);border-radius:7px;background:var(--wall-2);color:var(--chalk);font:600 12px/1 inherit;display:inline-flex;align-items:center;justify-content:center}
  .zoom-btn{cursor:pointer}
  .zoom-btn:hover{border-color:var(--red)}
  .zoom-readout{min-width:54px;color:var(--chalk-dim)}
  .wall-canvas{height:min(78vh,920px);min-height:520px;overflow:auto;overscroll-behavior:contain;border:1px solid var(--hairline);border-radius:14px;background:rgba(0,0,0,.16);box-shadow:inset 0 0 0 1px rgba(255,255,255,.018)}
  .wall-canvas.is-space-pan{cursor:grab}
  .wall-canvas.is-panning{cursor:grabbing;user-select:none}
  .canvas-stage{position:relative;min-width:100%;min-height:100%;padding:28px}
  .canvas-content{width:min(1180px,calc(100vw - 88px));transform-origin:0 0}
  .exhibits{display:grid;grid-template-columns:repeat(2, 1fr);gap:56px 40px}
  @media (max-width:860px){.canvas-shell{padding:0 12px}.wall-canvas{height:74vh;min-height:430px}.canvas-stage{padding:18px}.canvas-content{width:calc(100vw - 60px)}.exhibits{grid-template-columns:1fr}}
  .exhibit{border:1px solid var(--hairline);background:var(--wall-2);padding:22px 22px 0}
  .exhibit figure{margin:0;position:relative}
  .exhibit img{
    display:block;width:100%;height:auto;border:1px solid var(--hairline);border-radius:28px;
    box-shadow:0 24px 60px -28px rgba(0,0,0,.85);background:#000;cursor:crosshair;
  }
  .placard{display:grid;grid-template-columns:auto 1fr;gap:0 16px;align-items:baseline;padding:18px 2px 20px}
  .placard .num{font-family:Georgia, serif;font-weight:900;font-size:34px;color:var(--red);line-height:1}
  .placard h3{font:600 15px/1.3 inherit;letter-spacing:.04em;text-transform:uppercase}
  .screen-meta{grid-column:2;display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}
  .screen-meta span{border:1px solid var(--hairline);border-radius:999px;padding:2px 7px;color:var(--chalk-dim);font-size:10.5px;line-height:1.5}
  .placard p{grid-column:2;font-size:13px;color:var(--chalk-dim);margin-top:4px}
  .placard .context{font-size:11.5px;color:color-mix(in srgb, var(--chalk) 74%, var(--chalk-dim));margin-top:8px}
  .placard .warn{color:#ffb28f}
  .screen-nav{grid-column:2;display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
  .screen-nav a{border:1px solid var(--hairline);border-radius:6px;color:var(--chalk);font-size:11.5px;line-height:1.2;padding:6px 8px;text-decoration:none}
  .screen-nav a:hover{border-color:var(--red);color:#fff}
  footer{border-top:1px solid var(--hairline);padding:36px 0 64px;font-size:13px;color:var(--chalk-dim)}
  /* semantic hotspots: pins anchor to real accessibility elements */
  figure.has-ax{position:relative}
  .ax-layer{position:absolute;inset:0;pointer-events:none}
  .ax-spot{position:absolute;pointer-events:auto;border-radius:6px}
  .ax-spot:hover{outline:1.5px dashed color-mix(in srgb, var(--red) 75%, transparent);outline-offset:1px;cursor:crosshair}
${pinner ? PINNER_CSS : ''}</style>
</head>
<body>
<header>
  <div class="frame">
    <div class="kicker">${esc(cfg.kicker)}</div>
    <h1>${esc(cfg.headline)}</h1>
    <p class="lede">${cfg.lede}</p>
    <div class="howto" id="how-to-pin">
      <div class="step"><div class="n">01 / CLICK</div><p>Click the exact spot on any screen below.${cfg.projectId && cfg.pageUrl ? ' No install, no account — just your name + email.' : ''}</p></div>
      <div class="step"><div class="n">02 / PIN</div><p>Say what's wrong and the concrete fix. Hotspots add the accessibility label automatically.</p></div>
      <div class="step"><div class="n">03 / SHIP</div><p>Approved pins become MCP work packets with screen, selector, and thread context for a PR.</p></div>
    </div>${commandBlock}${reportLine}
  </div>
</header>
<main>
  <div class="canvas-shell">
    <div class="canvas-toolbar" aria-label="Wall canvas zoom controls">
      <button type="button" class="zoom-btn" data-zoom="out" title="Zoom out (Cmd -)">−</button>
      <span class="zoom-readout" data-zoom-readout>100%</span>
      <button type="button" class="zoom-btn" data-zoom="in" title="Zoom in (Cmd +)">+</button>
      <button type="button" class="zoom-btn" data-zoom="reset" title="Reset zoom (Cmd 0)">Reset</button>
    </div>
    <div class="wall-canvas" data-wall-canvas>
      <div class="canvas-stage" data-canvas-stage>
        <div class="canvas-content" data-canvas-content>
          <div class="exhibits">
${exhibits}
          </div>
        </div>
      </div>
    </div>
  </div>
</main>
<footer>
  <div class="frame"><p>${cfg.footer}</p></div>
</footer>
${copyScript}${canvasScript}${pinner}</body>
</html>
`;
}

export function buildAgentContext({ config, screens, plan = null, planPath = '', outDir = 'crit-wall' }) {
  const packet = buildAgentWorkPacket({ config, screens, plan, planPath, outDir });
  return {
    version: 1,
    kind: 'pincushion-mobile-wall-context',
    title: config.title,
    appName: config.appName || '',
    pageUrl: config.pageUrl || '',
    reportUrl: config.reportUrl || '',
    projectId: config.projectId || '',
    capture: packet.capture,
    quality: packet.quality,
    handoff: [
      'Use screen.id and hotspot.selector to connect a pin to native UI source.',
      'Pins created through the wall prefix comments with [Screen: ...] and [Element: ...].',
      'If a screen has no hotspots, refresh the accessibility capture before treating the pin as implementation-ready.',
    ],
    screens: screens.map((s, i) => {
      const meta = config.screens?.[s.name] || {};
      const review = screenReviewMeta(config, s.name);
      return {
        id: s.name,
        selector: `#screen-${slug(review.screen || s.name)} img`,
        title: meta.title || screenMeta(s.name, i).title,
        caption: meta.caption || '',
        flow: review.flow,
        route: review.route || packet.screens[i]?.route || '',
        build: review.build,
        screen: review.screen,
        links: review.links,
        image: `screens/${s.name}.png`,
        width: s.width || null,
        height: s.height || null,
        screenshotOnly: !(s.spots || []).length,
        screenId: packet.screens[i]?.screenId || '',
        sourceFiles: packet.screens[i]?.sourceFiles || [],
        hotspots: (s.spots || []).map((p) => ({
          id: p.id,
          label: p.label,
          selector: `#ax-${s.name}-${p.id}`,
          boundsPercent: { left: p.left, top: p.top, width: p.width, height: p.height },
          nativeSearch: searchCommandsForLabel(p.label, p.id, config),
        })),
      };
    }),
  };
}

const arr = (v) => {
  if (Array.isArray(v)) return v.filter((x) => x !== null && x !== undefined && x !== '').map(String);
  return v ? [String(v)] : [];
};

const uniq = (items) => [...new Set(items.filter(Boolean))];

// POSIX single-quote quoting: inert for $, backticks, and backslashes. The
// quoted text includes accessibility labels straight from the app under
// critique — double-quote quoting would let a label like `$(...)` execute if
// an agent pastes the suggested command into a shell.
const commandQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function sourceRoots(config) {
  const roots = arr(config.agent?.sourceRoots);
  return roots.length ? roots : ['.'];
}

function sourceHint(raw) {
  if (!raw) return {};
  if (typeof raw === 'string' || Array.isArray(raw)) return { sourceFiles: arr(raw) };
  if (typeof raw === 'object') return raw;
  return {};
}

function screenPlanMap(plan) {
  const map = new Map();
  for (const s of plan?.screens || []) {
    const id = slug(s?.name || '');
    if (id) map.set(id, s);
  }
  return map;
}

// -F: labels/titles are literal strings, not regexes — "Message C3-PO..."
// must not wildcard on the dots, and a label containing "(" must not be a
// regex syntax error.
function searchCommandsForLabel(label, id, config) {
  const roots = sourceRoots(config).map(commandQuote).join(' ');
  const hints = sourceHint(config.sourceHints?.labels?.[label]);
  const searches = [
    `rg -nF ${commandQuote(label)} ${roots}`,
    `rg -nF ${commandQuote(id)} ${roots}`,
    `rg -nF ${commandQuote(`accessibilityLabel("${label}")`)} ${roots}`,
    `rg -nF ${commandQuote(`accessibilityIdentifier("${id}")`)} ${roots}`,
  ];
  return uniq([...arr(hints.search), ...searches]);
}

function screenSearchCommands({ screenName, screenId, route, title, config }) {
  const roots = sourceRoots(config).map(commandQuote).join(' ');
  return uniq([
    screenId && `rg -nF ${commandQuote(screenId)} ${roots}`,
    route && `rg -nF ${commandQuote(route)} ${roots}`,
    title && `rg -nF ${commandQuote(title)} ${roots}`,
    `rg -nF ${commandQuote(screenName)} ${roots}`,
  ]);
}

function normalizeScreenSource({ config, planScreen, screenName, title }) {
  const fromConfig = sourceHint(config.sourceHints?.screens?.[screenName]);
  const fromPlan = sourceHint(planScreen?.sourceHint);
  const screenId = planScreen?.screenId || fromConfig.screenId || fromPlan.screenId || '';
  const route = planScreen?.route || fromConfig.route || fromPlan.route || '';
  const sourceFiles = uniq([
    ...arr(planScreen?.sourceFiles),
    ...arr(fromPlan.sourceFiles || fromPlan.files),
    ...arr(fromConfig.sourceFiles || fromConfig.files),
  ]);
  const notes = uniq([
    ...arr(planScreen?.notes),
    ...arr(fromPlan.notes),
    ...arr(fromConfig.notes),
  ]);
  const searches = uniq([
    ...arr(fromPlan.search),
    ...arr(fromConfig.search),
    ...screenSearchCommands({ screenName, screenId, route, title, config }),
  ]);
  return { screenId, route, sourceFiles, notes, search: searches };
}

function buildWallCommand(command, { outDir = 'crit-wall', planPath = '' } = {}) {
  const parts = ['npx pincushion-mcp mobile-wall', command];
  if (outDir && outDir !== 'crit-wall') parts.push('--out', commandQuote(outDir));
  if (command === 'run' && planPath) parts.push('--plan', commandQuote(planPath));
  return parts.join(' ');
}

export function buildAgentWorkPacket({ config, screens, plan = null, planPath = '', outDir = 'crit-wall' }) {
  const byPlanName = screenPlanMap(plan);
  const screenPackets = screens.map((s, i) => {
    const meta = config.screens?.[s.name] || {};
    const review = screenReviewMeta(config, s.name);
    const title = meta.title || screenMeta(s.name, i).title;
    const planScreen = byPlanName.get(s.name) || byPlanName.get(slug(s.name)) || null;
    const source = normalizeScreenSource({ config, planScreen, screenName: s.name, title });
    const hotspots = (s.spots || []).map((p) => {
      const labelHint = sourceHint(config.sourceHints?.labels?.[p.label]);
      return {
        id: p.id,
        label: p.label,
        selector: `#ax-${s.name}-${p.id}`,
        boundsPercent: { left: p.left, top: p.top, width: p.width, height: p.height },
        sourceFiles: arr(labelHint.sourceFiles || labelHint.files),
        notes: arr(labelHint.notes),
        nativeSearch: searchCommandsForLabel(p.label, p.id, config),
      };
    });
    return {
      id: s.name,
      selector: `#screen-${slug(review.screen || s.name)} img`,
      title,
      caption: meta.caption || '',
      flow: review.flow,
      route: review.route || source.route,
      build: review.build,
      screen: review.screen,
      links: review.links,
      screenId: source.screenId,
      image: `screens/${s.name}.png`,
      width: s.width || null,
      height: s.height || null,
      screenshotOnly: !hotspots.length,
      sourceFiles: source.sourceFiles,
      notes: source.notes,
      nativeSearch: source.search,
      plan: planScreen ? {
        steps: planScreen.steps || [],
        flow: review.flow || (!isAutomationFlowPath(planScreen.flow) ? planScreen.flow || '' : ''),
        maestroFlow: planScreen.maestroFlow || (isAutomationFlowPath(planScreen.flow) ? planScreen.flow : ''),
      } : null,
      hotspots,
    };
  });
  const screenshotOnlyScreens = screenPackets.filter((s) => s.screenshotOnly).map((s) => s.id);
  const hotspotCount = screenPackets.reduce((sum, s) => sum + s.hotspots.length, 0);
  return {
    version: 1,
    kind: 'pincushion-mobile-critique-work-packet',
    title: config.title,
    app: {
      name: config.appName || '',
      platform: 'ios',
      targetRepo: config.agent?.targetRepo || 'mobile app repo',
      bundleId: plan?.app?.bundleId || '',
      appPath: plan?.app?.appPath || '',
      device: plan?.app?.device || '',
      boot: plan?.app?.boot || '',
    },
    capture: {
      mode: plan ? 'headless-plan' : 'manual-capture',
      headless: !!plan,
      planPath: planPath || '',
      runCommand: buildWallCommand('run', { outDir, planPath }),
      buildCommand: buildWallCommand('build', { outDir }),
      preserve: uniq([
        planPath || `${outDir}/wall.plan.json`,
        `${outDir}/screens`,
        `${outDir}/ax`,
        `${outDir}/wall.config.json`,
      ]),
      settleMs: Number.isFinite(plan?.settleMs) ? plan.settleMs : null,
    },
    pincushion: {
      projectId: config.projectId || '',
      pageUrl: config.pageUrl || '',
      reportUrl: config.reportUrl || '',
      pinContextPrefix: '[Screen: <screen>] [Element: <accessibility label>]',
      snapshotMapping: config.snapshot ? {
        width: config.snapshot.w || null,
        height: config.snapshot.h || null,
        mappedScreens: Object.keys(config.snapshot.rects || {}).sort(),
      } : null,
      setupCommands: [
        'configure_project name="<app> crit wall" urls=["<deployed URL>"]',
        'upload_page_snapshot',
        'create_share_report',
        'implement_approved_pins',
      ],
    },
    quality: {
      screenCount: screenPackets.length,
      hotspotCount,
      anchoredScreenCount: screenPackets.length - screenshotOnlyScreens.length,
      screenshotOnlyScreens,
      warnings: [
        ...(!plan ? ['No wall.plan.json was available; capture may not be reproducible headlessly.'] : []),
        ...(screenshotOnlyScreens.length ? [`${screenshotOnlyScreens.length} screen(s) have no accessibility hotspots.`] : []),
      ],
    },
    implementationRules: arr(config.agent?.acceptanceCriteria),
    implementationNotes: arr(config.agent?.implementationNotes),
    screens: screenPackets,
  };
}

export function buildAgentWorkPacketMarkdown(packet) {
  const lines = [
    `# ${packet.title || 'Mobile Critique'} Work Packet`,
    '',
    `Target repo: ${packet.app.targetRepo}`,
    `Capture mode: ${packet.capture.mode}${packet.capture.headless ? ' (headless)' : ''}`,
    `Screens: ${packet.quality.screenCount} (${packet.quality.anchoredScreenCount} accessibility-anchored, ${packet.quality.screenshotOnlyScreens.length} screenshot-only)`,
    '',
    '## Reproduce',
    '',
    `- Capture/build: \`${packet.capture.runCommand}\``,
    `- Rebuild only: \`${packet.capture.buildCommand}\``,
    ...arr(packet.capture.planPath).map((p) => `- Preserve plan: \`${p}\``),
    '',
    '## Pincushion Handoff',
    '',
    `- Project: ${packet.pincushion.projectId || '(not configured)'}`,
    `- Wall URL: ${packet.pincushion.pageUrl || '(not deployed)'}`,
    `- Report URL: ${packet.pincushion.reportUrl || '(not minted)'}`,
    `- Pin prefix: \`${packet.pincushion.pinContextPrefix}\``,
    '',
    '## Implementation Rules',
    '',
    ...packet.implementationRules.map((rule) => `- ${rule}`),
    '',
    '## Screens',
    '',
  ];
  for (const screen of packet.screens) {
    lines.push(`### ${screen.id} — ${screen.title}`, '');
    lines.push(`- Selector: \`${screen.selector}\``);
    if (screen.flow) lines.push(`- Flow: \`${screen.flow}\``);
    if (screen.build) lines.push(`- Build: \`${screen.build}\``);
    if (screen.screen) lines.push(`- Screen: \`${screen.screen}\``);
    if (screen.screenId) lines.push(`- Screen ID: \`${screen.screenId}\``);
    if (screen.route) lines.push(`- Route: \`${screen.route}\``);
    if (screen.links.length) lines.push(`- Links: ${screen.links.map((id) => `\`${id}\``).join(', ')}`);
    if (screen.sourceFiles.length) lines.push(`- Source files: ${screen.sourceFiles.map((f) => `\`${f}\``).join(', ')}`);
    lines.push(`- Context quality: ${screen.screenshotOnly ? 'screenshot-only; refresh AX or add source hints before implementation' : `${screen.hotspots.length} accessibility hotspot(s)`}`);
    if (screen.nativeSearch.length) {
      lines.push('- Useful searches:');
      screen.nativeSearch.slice(0, 4).forEach((cmd) => lines.push(`  - \`${cmd}\``));
    }
    if (screen.hotspots.length) {
      lines.push('- Hotspots:');
      screen.hotspots.forEach((h) => lines.push(`  - \`${h.selector}\` — ${h.label}`));
    }
    lines.push('');
  }
  if (packet.quality.warnings.length) {
    lines.push('## Warnings', '');
    packet.quality.warnings.forEach((w) => lines.push(`- ${w}`));
    lines.push('');
  }
  return lines.join('\n');
}

export function parsePinContext(annotation) {
  const thread = Array.isArray(annotation?.thread) ? annotation.thread : [];
  const text = thread.map((m) => m?.plainText || m?.body || '').find((body) => /\[Screen:/.test(String(body))) || '';
  const screen = /\[Screen:\s*([^\]]+)\]/.exec(text);
  const element = /\[Element:\s*([^\]]+)\]/.exec(text);
  return {
    screen: screen ? slug(screen[1]) : '',
    element: element ? element[1].trim() : '',
  };
}

function snapshotScale(snapshot, target) {
  const baseW = Number(snapshot?.w), baseH = Number(snapshot?.h);
  const targetW = Number(target?.width || baseW), targetH = Number(target?.height || baseH);
  return {
    width: targetW,
    height: targetH,
    sx: baseW > 0 && targetW > 0 ? targetW / baseW : 1,
    sy: baseH > 0 && targetH > 0 ? targetH / baseH : 1,
  };
}

function centerOfHotspot(rect, spot) {
  const x = rect.x + ((Number(spot.left) + Number(spot.width) / 2) / 100) * rect.w;
  const y = rect.y + ((Number(spot.top) + Number(spot.height) / 2) / 100) * rect.h;
  return { x, y, reason: 'screen-hotspot' };
}

function centerOfRect(rect) {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, reason: 'screen-center' };
}

// Match a wall element id fragment against a capture name: exact slug match,
// or the name with its numeric order prefix dropped ("01-first-launch" also
// answers to "first-launch" — pilot walls used the short form in section ids).
function screenNameMatches(name, fragment) {
  const s = slug(name);
  return s === fragment || s.replace(/^\d+-/, '') === fragment;
}

// Resolve a pin's element.selector against the wall's own DOM conventions.
// MCP-seeded pins (create_critique_pin etc.) carry a selector but no click
// coordinates and no [Screen:] thread prefix — without this they'd silently
// lose their markers on every publish re-upload.
//   #ax-<screen>-<spotId>   → hotspot center
//   #screen-<slug> img      → screen center
function positionFromSelector(selector, { rects, hotspots }) {
  const sel = String(selector || '').trim();
  const names = Object.keys(rects);
  const ax = /^#ax-(.+)$/.exec(sel);
  if (ax) {
    // Longest capture name first: with screens `01-home` and `01-home-v2`,
    // selector `#ax-01-home-v2-save` must resolve against `01-home-v2`, not
    // its dash-prefix sibling. And when a candidate's hotspot lookup misses,
    // keep trying shorter candidates instead of settling for the wrong
    // screen's center — only fall back once every candidate's spot missed.
    const candidates = names
      .filter((name) => ax[1].startsWith(`${name}-`))
      .sort((a, b) => b.length - a.length);
    for (const name of candidates) {
      const spotId = ax[1].slice(name.length + 1);
      const spot = (hotspots?.[name] || []).find((s) => s.id === spotId);
      if (spot) return { screen: name, ...centerOfHotspot(rects[name], spot), reason: 'selector-hotspot' };
    }
    if (candidates.length) {
      const name = candidates[0]; // longest match = most specific screen
      return { screen: name, ...centerOfRect(rects[name]), reason: 'selector-screen' };
    }
    return null;
  }
  const scr = /^#screen-([\w-]+)/.exec(sel);
  if (scr) {
    const name = names.find((n) => screenNameMatches(n, scr[1]));
    if (name) return { screen: name, ...centerOfRect(rects[name]), reason: 'selector-screen' };
  }
  return null;
}

export function buildSnapshotPinPositions({ annotations = [], hotspots = {}, snapshot = null, target = null } = {}) {
  if (!snapshot || !snapshot.rects || !Number(snapshot.w) || !Number(snapshot.h)) return [];
  const scale = snapshotScale(snapshot, target);
  const positions = [];
  for (const ann of annotations || []) {
    if (!ann?.id) continue;
    const ctx = parsePinContext(ann);
    const rect = ctx.screen ? snapshot.rects[ctx.screen] : null;
    let pos = null;
    if (rect) {
      const spots = hotspots?.[ctx.screen] || [];
      const spot = ctx.element
        ? spots.find((s) => String(s.label || '').trim() === ctx.element)
        : null;
      pos = spot ? centerOfHotspot(rect, spot) : centerOfRect(rect);
    } else {
      const relX = Number(ann.pin?.relX ?? ann.pin?.x);
      const relY = Number(ann.pin?.relY ?? ann.pin?.y);
      if (Number.isFinite(relX) && Number.isFinite(relY)) {
        pos = { x: relX * snapshot.w, y: relY * snapshot.h, reason: 'stored-relative-pin' };
      } else {
        const bySelector = positionFromSelector(ann.element?.selector, { rects: snapshot.rects, hotspots });
        if (bySelector) { pos = bySelector; ctx.screen = bySelector.screen; }
      }
    }
    if (!pos) continue;
    positions.push({
      annotationId: ann.id,
      x: Math.round(pos.x * scale.sx),
      y: Math.round(pos.y * scale.sy),
      screen: ctx.screen || null,
      element: ctx.element || null,
      reason: pos.reason,
    });
  }
  return positions;
}

export function buildPublishManifest({
  config,
  annotations = [],
  pinPositions = [],
  upload = null,
  deployUrl = '',
  snapshotPath = '',
  dryRun = false,
  cloud = true,
  updates = [],
} = {}) {
  const statuses = {};
  for (const ann of annotations || []) statuses[ann.status || 'open'] = (statuses[ann.status || 'open'] || 0) + 1;
  return {
    version: 1,
    kind: 'pincushion-mobile-wall-publish',
    dryRun,
    cloud,
    projectId: config.projectId || '',
    pageUrl: config.pageUrl || '',
    reportUrl: config.reportUrl || '',
    deployUrl: deployUrl || config.publish?.deployUrl || '',
    snapshotPath,
    annotations: {
      count: annotations.length,
      byStatus: statuses,
    },
    pinPositions: pinPositions.map((p) => ({ annotationId: p.annotationId, x: p.x, y: p.y, screen: p.screen, element: p.element, reason: p.reason })),
    upload,
    updates,
    next: [
      'Keep wall.plan.json committed or attached to the mobile app PR for repeatable post-merge refreshes.',
      'After the app PR merges, run mobile-wall publish from CI or an agent with PINCUSHION_LICENSE_KEY set.',
      'If the layout changes, recapture the wall snapshot and upload it so the same /r report shows fresh markers.',
    ],
  };
}

export function buildPublishMarkdown(manifest) {
  const lines = [
    '# Mobile Wall Publish',
    '',
    `Project: ${manifest.projectId || '(missing)'}`,
    `Wall URL: ${manifest.pageUrl || '(missing)'}`,
    `Report URL: ${manifest.reportUrl || '(missing)'}`,
    `Deploy URL: ${manifest.deployUrl || '(not linked)'}`,
    `Mode: ${manifest.dryRun ? 'dry run' : 'publish'}${manifest.cloud ? '' : ' (cloud skipped)'}`,
    '',
    '## Result',
    '',
    `- Pins fetched: ${manifest.annotations.count}`,
    `- Marker positions: ${manifest.pinPositions.length}`,
    `- Snapshot upload: ${manifest.upload?.success ? `uploaded ${manifest.upload.url}` : (manifest.upload?.skipped || 'not run')}`,
    `- Pin updates: ${manifest.updates.length}`,
    '',
  ];
  if (manifest.pinPositions.length) {
    lines.push('## Marker Positions', '');
    manifest.pinPositions.forEach((p) => lines.push(`- ${p.annotationId}: ${p.x},${p.y}${p.screen ? ` (${p.screen}${p.element ? ` / ${p.element}` : ''})` : ''}`));
    lines.push('');
  }
  lines.push('## Next', '');
  manifest.next.forEach((item) => lines.push(`- ${item}`));
  lines.push('');
  return lines.join('\n');
}

function buildCopyScript() {
  return `<script>
(function () {
  "use strict";
  document.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-copy]");
    if (!btn) return;
    var text = btn.getAttribute("data-copy") || "";
    if (!text) return;
    navigator.clipboard.writeText(text).then(function () {
      var old = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(function () { btn.textContent = old; }, 1200);
    }).catch(function () {
      btn.textContent = "Select text";
    });
  });
})();
</script>
`;
}

function buildCanvasScript(src) {
  return `<script src="${esc(src || 'https://www.pincushion.io/widget/mobile-wall-canvas.js')}" defer></script>`;
}

// Zero-friction pinning (optional): enabled when the wall is registered
// (projectId) and deployed (pageUrl). Posts to the public widget-feedback
// path with document-relative pin coordinates; hotspot labels prefix the
// comment so the pin names the real element.
const PINNER_CSS = `  .pc-pop{position:absolute;z-index:50;width:min(300px,84%);background:var(--placard);border:1px solid var(--hairline);border-radius:10px;box-shadow:0 18px 50px rgba(0,0,0,.6);padding:14px;transform:translate(-50%,10px)}
  .pc-pop .pc-dot{position:absolute;top:-24px;left:50%;margin-left:-9px;width:18px;height:18px;border-radius:50%;background:var(--red);border:2px solid #fff}
  .pc-pop label{display:block;font:600 10.5px/1 inherit;letter-spacing:.12em;text-transform:uppercase;color:var(--chalk-dim);margin:8px 0 4px}
  .pc-pop input,.pc-pop textarea{width:100%;background:var(--wall);border:1px solid var(--hairline);border-radius:6px;color:var(--chalk);font:400 13px/1.45 inherit;padding:7px 9px;outline:none}
  .pc-pop input:focus,.pc-pop textarea:focus{border-color:var(--red)}
  .pc-pop textarea{min-height:64px;resize:vertical}
  .pc-pop .pc-context{border:1px solid var(--hairline);border-radius:6px;background:var(--wall);color:var(--chalk-dim);font-size:11.5px;line-height:1.45;padding:7px 9px;margin:0 0 8px;overflow-wrap:anywhere}
  .pc-pop .pc-row{display:flex;gap:8px;margin-top:10px;align-items:center}
  .pc-pop button{background:var(--red);color:#fff;border:0;border-radius:6px;padding:8px 14px;font:600 12.5px/1 inherit;cursor:pointer}
  .pc-pop button[disabled]{opacity:.55;cursor:wait}
  .pc-pop .pc-cancel{background:transparent;color:var(--chalk-dim);border:1px solid var(--hairline)}
  .pc-pop .pc-err{color:#ff8b76;font-size:12px;margin-top:8px}
  .pc-pop .pc-ok{color:#8fd6a2;font-size:13px;line-height:1.5}
`;

function buildPinnerScript(cfg) {
  const snap = cfg.snapshot && cfg.snapshot.w > 0 && cfg.snapshot.h > 0 ? cfg.snapshot : null;
  const meta = {};
  for (const name of Object.keys(cfg.screens || {})) {
    const m = screenReviewMeta(cfg, name);
    meta[name] = { flow: m.flow, route: m.route, build: m.build, screen: m.screen };
  }
  return `<script>
(function () {
  "use strict";
  var ENDPOINT = ${JSON.stringify(cfg.endpoint)};
  var PROJECT = ${JSON.stringify(cfg.projectId)};
  var PAGE = ${JSON.stringify(cfg.pageUrl)};
  var REPORT = ${JSON.stringify(cfg.reportUrl || '')};
  // Report-snapshot mapping: click fraction within an exhibit image → pixel
  // position in the uploaded page snapshot → relX/relY, so the pin marker
  // lands exactly on the annotated report (OpenClaw-pilot approach). Screens
  // without a rect fall back to document-relative coordinates.
  var SNAP = ${JSON.stringify(snap ? { w: snap.w, h: snap.h } : null)};
  var RECTS = ${JSON.stringify(snap ? snap.rects || {} : {})};
  var META = ${JSON.stringify(meta)};
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; }
  function contextBits(name, axLabel) {
    var m = META[name] || {};
    var bits = [];
    if (m.flow) bits.push("Flow: " + m.flow);
    if (m.route) bits.push("Route: " + m.route);
    if (m.build) bits.push("Build: " + m.build);
    bits.push("Screen: " + (m.screen || name));
    bits.push(axLabel ? ("Element: " + axLabel) : "no AX element at this point");
    return bits;
  }
  function commentPrefix(name, axLabel) {
    var m = META[name] || {};
    var screen = m.screen || name;
    var parts = [];
    if (m.flow) parts.push("[Flow: " + m.flow + "]");
    if (m.route) parts.push("[Route: " + m.route + "]");
    if (m.build) parts.push("[Build: " + m.build + "]");
    parts.push("[Screen: " + screen + "]");
    if (axLabel) parts.push("[Element: " + axLabel + "]");
    return parts.join(" ") + " ";
  }
  function closePop() { var p = document.querySelector(".pc-pop"); if (p) p.remove(); }
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closePop(); });
  document.querySelectorAll(".exhibit figure").forEach(function (fig) {
    var img = fig.querySelector("img");
    if (!img) return;
    fig.addEventListener("click", function (ev) {
      if (ev.target.closest(".pc-pop")) return;
      closePop();
      var r = img.getBoundingClientRect();
      var fx = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      var fy = Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height));
      var name = (img.getAttribute("src") || "").split("/").pop().replace(".png", "");
      var rect = SNAP && RECTS[name];
      var relX, relY;
      if (rect) {
        relX = (rect.x + fx * rect.w) / SNAP.w;
        relY = (rect.y + fy * rect.h) / SNAP.h;
      } else {
        var doc = document.documentElement;
        relX = (window.scrollX + ev.clientX) / doc.scrollWidth;
        relY = (window.scrollY + ev.clientY) / doc.scrollHeight;
      }
      var axLabel = ev.target.classList && ev.target.classList.contains("ax-spot") ? ev.target.getAttribute("data-ax") : null;
      var pop = el("div", "pc-pop");
      pop.style.left = (fx * 100).toFixed(2) + "%";
      pop.style.top = (fy * 100).toFixed(2) + "%";
      pop.appendChild(el("div", "pc-dot"));
      var lab1 = el("label", null, "What's wrong here — and your fix");
      var ta = el("textarea"); ta.placeholder = axLabel ? ("Re: \\u201c" + axLabel + "\\u201d — the problem + your fix…") : "The problem + your fix…";
      var ctx = el("div", "pc-context", contextBits(name, axLabel).join(" · "));
      var lab2 = el("label", null, "Name"); var inName = el("input");
      var lab3 = el("label", null, "Email (not shown publicly)"); var inMail = el("input"); inMail.type = "email";
      var row = el("div", "pc-row");
      var send = el("button", null, "Pin it"); var cancel = el("button", "pc-cancel", "Cancel");
      row.appendChild(send); row.appendChild(cancel);
      var msg = el("div");
      [lab1, ctx, ta, lab2, inName, lab3, inMail, row, msg].forEach(function (n) { pop.appendChild(n); });
      fig.appendChild(pop);
      ta.focus();
      cancel.addEventListener("click", function (e) { e.stopPropagation(); closePop(); });
      send.addEventListener("click", function (e) {
        e.stopPropagation();
        msg.className = ""; msg.textContent = "";
        var comment = ta.value.trim(), nm = inName.value.trim(), em = inMail.value.trim();
        if (comment.length < 2) { msg.className = "pc-err"; msg.textContent = "Say what's wrong first."; return; }
        if (!nm) { msg.className = "pc-err"; msg.textContent = "Name, please — it goes on your pin."; return; }
        if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(em)) { msg.className = "pc-err"; msg.textContent = "A real email, please (never shown publicly)."; return; }
        comment = commentPrefix(name, axLabel) + comment;
        send.disabled = true; send.textContent = "Pinning…";
        fetch(ENDPOINT, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: PROJECT, pageUrl: PAGE, pageTitle: document.title, name: nm, email: em, comment: comment, pin: { relX: relX, relY: relY } })
        }).then(function (res) { return res.json().then(function (b) { return { ok: res.ok, b: b }; }); })
          .then(function (r) {
            if (r.ok && r.b && r.b.success) {
              pop.querySelectorAll("label, textarea, input, .pc-row").forEach(function (n) { n.remove(); });
              var ok = el("div", "pc-ok");
              ok.textContent = "Pinned. ";
              if (REPORT) { var a = el("a", null, "See it on the crit report"); a.href = REPORT; a.rel = "noopener"; ok.appendChild(a); }
              pop.appendChild(ok);
            } else {
              send.disabled = false; send.textContent = "Pin it";
              msg.className = "pc-err";
              msg.textContent = (r.b && (r.b.message || r.b.error)) || "Something went wrong — try again.";
            }
          })
          .catch(function () { send.disabled = false; send.textContent = "Pin it"; msg.className = "pc-err"; msg.textContent = "Network hiccup — try again."; });
      });
    });
  });
})();
</script>
`;
}

// ─── headless capture plan (`mobile-wall run`) ───────────────────────────────
// wall.plan.json describes the whole session declaratively so the entire
// capture → build pipeline runs unattended (local or CI): which app to
// launch, and for each screen, how to navigate to it. Navigation steps are
// maestro commands written as JSON (YAML is a superset of JSON, so each step
// serializes verbatim into a generated flow file) — or a `maestroFlow` path to
// a hand-authored maestro flow for anything the JSON shorthand can't express.
// `flow` is review metadata (for example, "Onboarding") and is carried into
// the public crit report grouping.

export function starterPlan(appName = 'My app') {
  return {
    app: {
      bundleId: 'com.example.myapp',   // required to launch + drive the app
      appPath: '',                     // optional: .app bundle to install first
      device: 'booted',                // simulator UDID, or "booted"
      boot: '',                        // optional: device name/UDID to boot when nothing is booted (headless — no Simulator.app needed)
    },
    settleMs: 800,                     // wait after navigation before capturing
    screens: [
      { name: '01-first-launch', screenId: 'launch', flow: 'Onboarding', screen: 'first-launch' }, // no steps: capture the launch state
      { name: '02-example', flow: 'Onboarding', route: 'OnboardingView', build: 'local', links: ['01-first-launch'], sourceFiles: ['App/OnboardingView.swift'], steps: [{ tapOn: 'Get started' }] },
      // { name: "03-custom", maestroFlow: "flows/my-flow.yaml" },
    ],
    _comment: `${appName} capture plan — see \`npx pincushion-mcp mobile-wall help\``,
  };
}

export function validatePlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object') return ['plan is not a JSON object'];
  const screens = plan.screens;
  if (!Array.isArray(screens) || !screens.length) {
    errors.push('plan.screens must be a non-empty array');
    return errors;
  }
  const seen = new Set();
  let needsBundleId = false;
  screens.forEach((s, i) => {
    const name = slug(s?.name || '');
    if (!name) errors.push(`screens[${i}]: missing name`);
    else if (seen.has(name)) errors.push(`screens[${i}]: duplicate name "${name}"`);
    seen.add(name);
    const automationFlow = s?.maestroFlow || (isAutomationFlowPath(s?.flow) ? s.flow : '');
    if (s?.steps && !Array.isArray(s.steps)) errors.push(`screens[${i}]: steps must be an array of maestro commands`);
    if (s?.steps && automationFlow) errors.push(`screens[${i}]: use steps OR maestroFlow, not both`);
    if (s?.maestroFlow && typeof s.maestroFlow !== 'string') errors.push(`screens[${i}]: maestroFlow must be a string path`);
    if (s?.links && !Array.isArray(s.links)) errors.push(`screens[${i}]: links must be an array of screen ids`);
    if (s?.steps?.length) needsBundleId = true;
  });
  if (needsBundleId && !plan.app?.bundleId) {
    errors.push('app.bundleId is required when any screen has steps (it becomes the generated flow\'s appId)');
  }
  return errors;
}

// Maestro flow file from JSON steps. Steps pass through verbatim: strings
// become bare commands ("back"), objects serialize as JSON — valid YAML.
export function buildMaestroFlow(bundleId, steps) {
  const lines = steps.map((s) => `- ${typeof s === 'string' ? s : JSON.stringify(s)}`);
  return `appId: ${bundleId}\n---\n${lines.join('\n')}\n`;
}

// ─── CLI text ────────────────────────────────────────────────────────────────

export function buildHelp() {
  return `pincushion mobile-wall — turn a booted iOS-simulator app into a pinnable crit wall

Usage:
  npx pincushion-mcp mobile-wall run                     headless: plan → captures → wall
  npx pincushion-mcp mobile-wall capture <screen-name>   capture one screen (manual navigation)
  npx pincushion-mcp mobile-wall build                   generate the wall page from captures
  npx pincushion-mcp mobile-wall publish                 refresh wall + public report handoff
  npx pincushion-mcp mobile-wall help

Options:
  --out <dir>        capture directory (default: ./crit-wall)
  --plan <file>      run: capture plan (default: <out>/wall.plan.json)
  --backend <b>      maestro | idb for the AX hierarchy (default: auto-detect)
  --udid <udid>      simulator UDID (default: booted)
  --name <app name>  build: app name used in the default copy
Publish options:
  --no-run           skip simulator capture; rebuild from existing captures
  --snapshot <file>  JPEG/WebP full-page wall/report snapshot to upload
  --snapshot-width/--snapshot-height <px>  snapshot pixel size (or snapshot.w/h in config)
  --deploy-command <cmd>  run static-host deploy command from wall/
  --deploy-url <url>      canonical deployed URL (else parsed from deploy output)
  --resolve-implemented   mark implemented pins resolved (also links deploy URL)
  --link-deploy           stamp implemented/resolved pins with the deploy URL
  --verify <status>       record verification: pending|verified|regressed|inconclusive
  --project-id / --page-url / --report-url   override wall.config.json values
  --dry-run          compute + report everything, send nothing
  --no-cloud / --no-upload   skip pin fetch+updates / skip the snapshot upload

Headless workflow (run):
  1. mobile-wall run          — first run scaffolds <out>/wall.plan.json
  2. Fill in app.bundleId (+ optional appPath to install, boot to cold-boot a
     simulator headlessly) and the screens list. Each screen is captured after
     its maestro navigation steps run — steps are maestro commands as JSON
     (e.g. {"tapOn": "Get started"}), or "maestroFlow": a hand-written
     maestro flow. Use flow/route/build/screen/links as review metadata.
  3. mobile-wall run          — boots/installs/launches, drives each screen,
     captures, and builds <out>/wall/index.html. No human at the simulator.

Manual workflow (capture): navigate the simulator yourself, then
\`mobile-wall capture <name>\` per screen, and \`mobile-wall build\`.

Brand it: edit <out>/wall.config.json (titles, captions, colors) and rebuild.
Agent handoff: wall.config.json supports agent.targetRepo/sourceRoots plus
sourceHints.screens and sourceHints.labels; builds write agent-work-packet.md
with screen IDs, routes, source hints, AX labels, and screenshot-only warnings.

Publish workflow: after the mobile app PR merges, run \`mobile-wall publish\`
from CI or an agent with PINCUSHION_LICENSE_KEY. It reruns the headless plan,
optionally deploys wall/, recomputes public-report marker positions from the
fresh snapshot mapping, uploads the latest snapshot, and can link/resolve pins
without requiring a reviewer-installed browser extension.

Requires: Xcode command line tools (xcrun simctl); maestro for run/navigation
(idb works for capture-only AX). Android (adb/uiautomator) not supported yet.
`;
}

export function buildNextSteps({ outDir, screenCount, spotCount, configured, screenshotOnlyCount = 0, headless = false }) {
  const wall = `${outDir}/wall`;
  return `
Wall generated: ${wall}/index.html  (${screenCount} screen${screenCount === 1 ? '' : 's'}, ${spotCount} semantic hotspot${spotCount === 1 ? '' : 's'})
Agent handoff: ${wall}/agent-context.json maps screens + AX hotspots to selectors.
Work packet: ${wall}/agent-work-packet.md is the agent-readable mobile implementation brief.

Next steps:
  1. Preview locally:  npx serve ${wall}
  2. Brand it: edit ${outDir}/wall.config.json (title, copy, accent, captions), then rebuild.
  3. Deploy the wall to any static host (e.g. \`cd ${wall} && vercel deploy --prod\`).
  4. Register it as a Pincushion project — in your agent:
       configure_project name="<your app> crit wall" urls=["<deployed URL>"]
     then put the returned projectId + deployed URL into wall.config.json
     (projectId / pageUrl) and rebuild — that turns on zero-install click-to-pin.
  5. Mint a public crit link — in your agent: create_share_report
     (add it to wall.config.json as reportUrl so the wall links to it).

Pins dropped on a hotspot carry the real element label (data-ax), so your
agent can grep the app source for the element instead of guessing from pixels.
${headless ? 'Headless proof: this build was backed by wall.plan.json; preserve it for future agents.\n' : 'Reproducibility gap: add or preserve wall.plan.json so future agents can recapture headlessly.\n'}${screenshotOnlyCount ? `Screenshot-only warning: ${screenshotOnlyCount} screen${screenshotOnlyCount === 1 ? '' : 's'} had no AX hotspots; refresh AX or add source hints before resolving those pins.\n` : ''}
${configured ? '' : 'Not signed in? Run `npx pincushion-mcp login` once to enable cloud sync + share reports.\n'}`;
}
