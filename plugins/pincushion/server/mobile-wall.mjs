// mobile-wall.mjs — `npx pincushion-mcp mobile-wall`, the mobile crit-wall
// generator. Captures screenshots + accessibility hierarchies from a booted
// iOS simulator (maestro or idb backend), then emits a static, brandable
// crit-wall page with semantic hotspot overlays so Pincushion pins anchor to
// real element labels instead of raw pixels.
//
// Two capture modes:
//   capture <name>  — manual: the user navigates the simulator between calls
//   run             — headless: wall.plan.json declares the app + per-screen
//                     maestro navigation; boots/installs/launches, drives
//                     every screen, captures, and builds — no human attached.
//   publish         — post-merge: refresh captures/wall, optionally deploy,
//                     upload the public-report snapshot, and link resolved pins.
//
// All pure logic lives in lib/mobile-wall-core.js; this shell owns process
// execution (xcrun/maestro/idb) and the filesystem. `exec` and `sleep` are
// injectable so both modes are testable without a simulator.
import { execFileSync } from 'node:child_process';
import {
  mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, copyFileSync,
} from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  parseMaestro, parseIdb, deriveScreenSize, extractHotspots, pngSize,
  mergeConfig, buildWallHtml, buildHelp, buildNextSteps, slug,
  starterPlan, validatePlan, buildMaestroFlow, buildAgentContext,
  buildAgentWorkPacket, buildAgentWorkPacketMarkdown,
  buildSnapshotPinPositions, buildPublishManifest, buildPublishMarkdown,
} from './lib/mobile-wall-core.js';

const DEFAULT_OUT = 'crit-wall';
const DEFAULT_FUNCTION_BASE = 'https://dpsqzszdviltqvethxbr.supabase.co/functions/v1';

function automationFlowPath(screen) {
  const explicit = screen?.maestroFlow;
  if (explicit) return explicit;
  const legacy = screen?.flow;
  return /\.ya?ml$/i.test(String(legacy || '')) || /[\\/]/.test(String(legacy || '')) ? legacy : '';
}

export function parseArgs(argv) {
  const args = { _: [] };
  const valueFlags = new Set([
    'out', 'backend', 'udid', 'name', 'plan',
    'project-id', 'page-url', 'report-url',
    'snapshot', 'snapshot-width', 'snapshot-height', 'content-type',
    'deploy-command', 'deploy-url', 'verify',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && valueFlags.has(a.slice(2))) {
      args[a.slice(2)] = argv[++i] || '';
    } else if (a.startsWith('--')) {
      args[a.slice(2)] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function defaultExec(cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

function hasBin(exec, bin) {
  try { exec('which', [bin]); return true; } catch { return false; }
}

// maestro preferred (matches the proven capture flow); idb fallback.
export function detectBackend(exec) {
  if (hasBin(exec, 'maestro')) return 'maestro';
  if (hasBin(exec, 'idb')) return 'idb';
  return null;
}

function isSignedIn() {
  if (process.env.PINCUSHION_LICENSE_KEY) return true;
  try { return !!readFileSync(join(homedir(), '.pincushion', 'license-key'), 'utf8').trim(); } catch { return false; }
}

// Same resolution order as the MCP server: env > project .feedback key >
// user-level key — so a CI job can use either the env var or a checked-out
// project key without special-casing.
function licenseKey(cwd = process.cwd()) {
  if (process.env.PINCUSHION_LICENSE_KEY) return process.env.PINCUSHION_LICENSE_KEY.trim();
  for (const p of [join(cwd, '.feedback', '.license-key'), join(homedir(), '.pincushion', 'license-key')]) {
    try {
      const key = readFileSync(p, 'utf8').trim();
      if (key) return key;
    } catch { /* next */ }
  }
  return '';
}

const firstLine = (e) => String(e.message || e).split('\n')[0];
const execErrText = (e) => [e?.stderr, e?.stdout, e?.message].filter(Boolean).join('\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

function functionBase(config) {
  // PINCUSHION_SYNC_URL is how every other surface (server.js, setup.mjs)
  // points at a local emulator/staging — honor it here too so publish never
  // silently writes to prod from a dev environment.
  const override = String(process.env.PINCUSHION_SYNC_URL || '');
  if (override.includes('/functions/v1/')) return override.replace(/\/functions\/v1\/.*$/, '/functions/v1');
  const endpoint = String(config.endpoint || '');
  if (endpoint.includes('/functions/v1/')) return endpoint.replace(/\/functions\/v1\/.*$/, '/functions/v1');
  return DEFAULT_FUNCTION_BASE;
}

function contentTypeFor(path, override = '') {
  if (override) return override;
  const p = String(path || '').toLowerCase();
  if (p.endsWith('.webp')) return 'image/webp';
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg';
  if (p.endsWith('.png')) return 'image/png';
  return 'image/jpeg';
}

function publicUrlFrom(text) {
  const m = /(https?:\/\/[^\s"'<>]+)/.exec(String(text || ''));
  return m ? m[1].replace(/[),.;]+$/, '') : '';
}

async function fetchCloudAnnotations(ctx, { baseUrl, key, projectId, pageUrl }) {
  const url = new URL(`${baseUrl}/sync-annotations`);
  if (projectId) url.searchParams.set('project_id', projectId);
  if (pageUrl) url.searchParams.set('pageUrl', pageUrl);
  const res = await ctx.fetch(url, { headers: { Accept: 'application/json', 'x-license-key': key } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `sync-annotations HTTP ${res.status}`);
  return data.annotations || [];
}

function buildSnapshotHotspots({ config, hotspots = {}, target = {} } = {}) {
  const snap = config?.snapshot;
  if (!snap?.rects || !Number(snap.w) || !Number(snap.h)) return [];
  const sx = Number(target.width || snap.w) / Number(snap.w);
  const sy = Number(target.height || snap.h) / Number(snap.h);
  const out = [];
  for (const [name, rect] of Object.entries(snap.rects || {})) {
    if (!rect || !Number.isFinite(Number(rect.x)) || !Number.isFinite(Number(rect.y)) || !Number.isFinite(Number(rect.w)) || !Number.isFinite(Number(rect.h))) continue;
    const meta = config.screens?.[name] || {};
    const screenId = slug(meta.screen || name);
    const scaledRect = {
      x: Math.round(Number(rect.x) * sx),
      y: Math.round(Number(rect.y) * sy),
      w: Math.round(Number(rect.w) * sx),
      h: Math.round(Number(rect.h) * sy),
    };
    out.push({ selector: `#screen-${screenId} img`, ...scaledRect });
    for (const spot of hotspots[name] || []) {
      const x = Number(rect.x) + (Number(spot.left) / 100) * Number(rect.w);
      const y = Number(rect.y) + (Number(spot.top) / 100) * Number(rect.h);
      const w = (Number(spot.width) / 100) * Number(rect.w);
      const h = (Number(spot.height) / 100) * Number(rect.h);
      if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
      out.push({
        selector: `#ax-${name}-${spot.id}`,
        x: Math.round(x * sx),
        y: Math.round(y * sy),
        w: Math.round(w * sx),
        h: Math.round(h * sy),
      });
    }
  }
  return out;
}

async function uploadSnapshot(ctx, { baseUrl, key, projectId, pageUrl, snapshotPath, contentType, width, height, pinPositions, hotspots, captureContext }) {
  const imageB64 = readFileSync(snapshotPath).toString('base64');
  const res = await ctx.fetch(`${baseUrl}/upload-screenshot`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-license-key': key },
    body: JSON.stringify({
      kind: 'page',
      project_id: projectId,
      page_url: pageUrl,
      content_type: contentType,
      image_b64: imageB64,
      width,
      height,
      pin_positions: pinPositions.map((p) => ({ annotation_id: p.annotationId, x: p.x, y: p.y })),
      hotspots,
      capture_context: captureContext,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new Error(data.message || data.error || `upload-screenshot HTTP ${res.status}`);
  return { success: true, url: data.url, width: data.width, height: data.height, pinsPlaced: data.pin_count };
}

function doneStatus(status) {
  return status === 'implemented' || status === 'resolved';
}

async function pushAnnotationUpdate(ctx, { baseUrl, key, annotation, patch }) {
  const body = {
    ...annotation,
    id: annotation.id,
    pageUrl: annotation.pageUrl || annotation.page_url,
    pageTitle: annotation.pageTitle || annotation.page_title,
    projectId: annotation.projectId || annotation.project_id,
    thread: annotation.thread || [],
    ...patch,
  };
  const res = await ctx.fetch(`${baseUrl}/sync-annotations`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-license-key': key },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new Error(data.message || data.error || `sync-annotations HTTP ${res.status}`);
  return data;
}

// ─── maestro JVM resolution ──────────────────────────────────────────────────
// maestro needs a JVM, and the headless shells `run` targets (CI, cron, agent
// sessions) often lack the profile exports that provide one. Probe the
// standard macOS locations once per invocation and inject JAVA_HOME so a
// keg-only Homebrew JDK is enough. Cached on ctx (not module state) so tests
// stay isolated.
function javaHomeFor(ctx) {
  if (ctx.javaHome !== undefined) return ctx.javaHome;
  ctx.javaHome = null;
  if (process.env.JAVA_HOME) return (ctx.javaHome = process.env.JAVA_HOME);
  // stdio: silence the probe's own "Unable to locate a Java Runtime" stderr —
  // a miss here is expected and handled by the Homebrew fallback below.
  try { ctx.javaHome = String(ctx.exec('/usr/libexec/java_home', [], { stdio: ['ignore', 'pipe', 'ignore'] })).trim() || null; } catch { /* probe brew */ }
  if (!ctx.javaHome) {
    for (const root of ['/opt/homebrew/opt', '/usr/local/opt']) {
      let cands = [];
      try { cands = readdirSync(root).filter((d) => /^openjdk(@\d+)?$/.test(d)).sort().reverse(); } catch { continue; }
      for (const c of cands) {
        const home = join(root, c, 'libexec', 'openjdk.jdk', 'Contents', 'Home');
        if (existsSync(home)) { ctx.javaHome = home; break; }
      }
      if (ctx.javaHome) break;
    }
  }
  return ctx.javaHome;
}

function runMaestro(ctx, args) {
  const jh = javaHomeFor(ctx);
  const opts = jh && !process.env.JAVA_HOME ? { env: { ...process.env, JAVA_HOME: jh } } : {};
  return ctx.exec('maestro', args, opts);
}

const JAVA_HINT = 'maestro needs a JVM and none was found — `brew install openjdk` (or set JAVA_HOME), or use `--backend idb` for capture.\n';
const javaHint = (e, output) => { if (/Java Runtime/i.test(execErrText(e))) output.write(JAVA_HINT); };

// ─── shared capture (screenshot + AX dump for one screen) ───────────────────

function captureScreen(ctx, { out, name, device, backend, udid }) {
  const { exec, output } = ctx;
  mkdirSync(join(out, 'screens'), { recursive: true });
  mkdirSync(join(out, 'ax'), { recursive: true });

  const shotPath = join(out, 'screens', `${name}.png`);
  try {
    exec('xcrun', ['simctl', 'io', device, 'screenshot', shotPath]);
  } catch (e) {
    output.write(`Screenshot failed: ${firstLine(e)}\nIs the simulator booted? (xcrun simctl list devices)\n`);
    return { ok: false };
  }

  let raw;
  try {
    raw = backend === 'maestro'
      ? runMaestro(ctx, ['hierarchy'])
      : exec('idb', ['ui', 'describe-all', ...(udid ? ['--udid', udid] : []), '--json']);
  } catch (e) {
    output.write(`AX hierarchy failed (${backend}): ${firstLine(e)}\n`);
    javaHint(e, output);
    output.write('The screenshot was saved — you can retry the hierarchy, or build without hotspots for this screen.\n');
    return { ok: false };
  }
  // Validate before persisting so a half-broken dump fails loudly at capture
  // time (when a retry is possible) instead of silently at build time.
  let count = 0;
  try {
    const nodes = backend === 'maestro' ? parseMaestro(raw) : parseIdb(raw);
    const screen = deriveScreenSize(nodes);
    count = extractHotspots(nodes, screen).length;
  } catch (e) {
    output.write(`Could not parse the ${backend} dump: ${firstLine(e)}\n`);
    return { ok: false };
  }
  writeFileSync(join(out, 'ax', `${name}.json`), String(raw));
  return { ok: true, count };
}

// ─── capture (manual mode) ───────────────────────────────────────────────────

async function runCapture(args, ctx) {
  const { output, exec, cwd } = ctx;
  const name = slug(args._[1] || '');
  if (!name) {
    output.write('Usage: npx pincushion-mcp mobile-wall capture <screen-name> [--out dir] [--backend maestro|idb] [--udid <udid>]\n');
    return 1;
  }
  const out = resolve(cwd, args.out || DEFAULT_OUT);
  const backend = args.backend || detectBackend(exec);
  if (!backend) {
    output.write('No AX backend found. Install one of:\n' +
      '  maestro — curl -Ls https://get.maestro.mobile.dev | bash\n' +
      '  idb     — brew install idb-companion && pip3 install fb-idb\n');
    return 1;
  }
  if (backend !== 'maestro' && backend !== 'idb') {
    output.write(`Unknown backend "${backend}" — use maestro or idb. (Android/adb is not supported yet.)\n`);
    return 1;
  }
  const r = captureScreen(ctx, { out, name, device: args.udid || 'booted', backend, udid: args.udid });
  if (!r.ok) return 1;
  output.write(`Captured ${name}: screens/${name}.png + ax/${name}.json (${r.count} hotspots) → ${out}\n`);
  output.write(`Next screen: navigate the simulator, then \`mobile-wall capture <name>\` again — or \`mobile-wall build\`.\n`);
  return 0;
}

// ─── run (headless mode) ─────────────────────────────────────────────────────

function isBooted(exec) {
  try { return /\(Booted\)/.test(exec('xcrun', ['simctl', 'list', 'devices', 'booted'])); }
  catch { return false; }
}

async function runRun(args, ctx) {
  const { output, exec, cwd, sleep } = ctx;
  const out = resolve(cwd, args.out || DEFAULT_OUT);
  const planPath = resolve(cwd, args.plan || join(out, 'wall.plan.json'));

  if (!existsSync(planPath)) {
    mkdirSync(out, { recursive: true });
    writeFileSync(planPath, JSON.stringify(starterPlan(basename(cwd)), null, 2) + '\n');
    output.write(`No capture plan found — scaffolded ${planPath}\n` +
      'Fill in app.bundleId (+ optional appPath / boot) and the screens list,\n' +
      'then re-run `mobile-wall run`. See `mobile-wall help` for the format.\n');
    return 1;
  }
  let plan;
  try { plan = JSON.parse(readFileSync(planPath, 'utf8')); }
  catch (e) { output.write(`Could not parse ${planPath}: ${firstLine(e)}\n`); return 1; }
  const errors = validatePlan(plan);
  if (errors.length) {
    output.write(`Invalid plan ${planPath}:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
    return 1;
  }

  const drivesApp = plan.screens.some((s) => (s.steps && s.steps.length) || automationFlowPath(s));
  if (drivesApp && !hasBin(exec, 'maestro')) {
    output.write('`mobile-wall run` drives navigation with maestro, which is not on your PATH.\n' +
      '  Install: curl -Ls https://get.maestro.mobile.dev | bash\n');
    return 1;
  }
  const backend = args.backend || detectBackend(exec);
  if (!backend) {
    output.write('No AX backend found (maestro or idb) — see `mobile-wall help`.\n');
    return 1;
  }

  const device = args.udid || plan.app?.device || 'booted';
  const settleMs = Number.isFinite(plan.settleMs) ? plan.settleMs : 800;

  // 1. Simulator: cold-boot headlessly when nothing is running (no
  //    Simulator.app needed — simctl runs the device fine without a window).
  if (!isBooted(exec)) {
    const target = device !== 'booted' ? device : plan.app?.boot;
    if (!target) {
      output.write('No simulator is booted, and the plan names no app.boot device to start.\n' +
        'Set app.boot (e.g. "iPhone 17 Pro" or a UDID from `xcrun simctl list devices`).\n');
      return 1;
    }
    output.write(`Booting ${target} (headless)…\n`);
    try {
      exec('xcrun', ['simctl', 'boot', target]);
    } catch (e) {
      output.write(`Boot failed: ${firstLine(e)}\n`);
      return 1;
    }
    try { exec('xcrun', ['simctl', 'bootstatus', target]); } catch { /* older Xcode: continue */ }
  }

  // 2. App: optional install, then a clean launch (terminate first so every
  //    run starts from the same state — repeatable captures).
  if (plan.app?.appPath) {
    output.write(`Installing ${plan.app.appPath}…\n`);
    try { exec('xcrun', ['simctl', 'install', device, resolve(dirname(planPath), plan.app.appPath)]); }
    catch (e) { output.write(`Install failed: ${firstLine(e)}\n`); return 1; }
  }
  if (plan.app?.bundleId) {
    try { exec('xcrun', ['simctl', 'terminate', device, plan.app.bundleId]); } catch { /* not running */ }
    try { exec('xcrun', ['simctl', 'launch', device, plan.app.bundleId]); }
    catch (e) { output.write(`Launch failed (${plan.app.bundleId}): ${firstLine(e)}\n`); return 1; }
    await sleep(settleMs);
  }

  // 3. Screens: navigate (generated or hand-authored maestro flow), settle,
  //    capture. Generated flows persist under <out>/flows/ so a failing step
  //    can be replayed with `maestro test` directly.
  const maestroDevice = device !== 'booted' ? ['--device', device] : [];
  let spotTotal = 0;
  for (const s of plan.screens) {
    const name = slug(s.name);
    const flowPath = automationFlowPath(s);
    try {
      if (flowPath) {
        runMaestro(ctx, [...maestroDevice, 'test', resolve(dirname(planPath), flowPath)]);
      } else if (s.steps && s.steps.length) {
        const flowsDir = join(out, 'flows');
        mkdirSync(flowsDir, { recursive: true });
        const flowPath = join(flowsDir, `${name}.yaml`);
        writeFileSync(flowPath, buildMaestroFlow(plan.app.bundleId, s.steps));
        runMaestro(ctx, [...maestroDevice, 'test', flowPath]);
      }
    } catch (e) {
      output.write(`Navigation failed at screen "${name}": ${firstLine(e)}\n`);
      javaHint(e, output);
      output.write(`Replay it directly: maestro test ${flowPath ? resolve(dirname(planPath), flowPath) : join(out, 'flows', `${name}.yaml`)}\n`);
      return 1;
    }
    if (settleMs) await sleep(settleMs);
    const r = captureScreen(ctx, { out, name, device, backend, udid: device !== 'booted' ? device : undefined });
    if (!r.ok) return 1;
    spotTotal += r.count;
    output.write(`Captured ${name} (${r.count} hotspots)\n`);
  }
  output.write(`${plan.screens.length} screens captured, ${spotTotal} hotspots — building the wall…\n`);

  // 4. Build — same path as `mobile-wall build`.
  return runBuild(args, ctx);
}

// ─── build ───────────────────────────────────────────────────────────────────

async function runBuild(args, { output, cwd }) {
  const out = resolve(cwd, args.out || DEFAULT_OUT);
  const screensDir = join(out, 'screens');
  const axDir = join(out, 'ax');
  if (!existsSync(screensDir)) {
    output.write(`No captures found in ${out}/screens — run \`mobile-wall capture <name>\` first.\n`);
    return 1;
  }
  const names = readdirSync(screensDir).filter((f) => f.endsWith('.png'))
    .map((f) => f.replace(/\.png$/, '')).sort();
  if (!names.length) {
    output.write(`No screenshots in ${screensDir} — run \`mobile-wall capture <name>\` first.\n`);
    return 1;
  }

  const planPath = resolve(cwd, args.plan || join(out, 'wall.plan.json'));
  let plan = null;
  if (existsSync(planPath)) {
    try {
      const candidate = JSON.parse(readFileSync(planPath, 'utf8'));
      const errors = validatePlan(candidate);
      if (errors.length) {
        output.write(`Ignoring invalid ${planPath} for agent handoff:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
      } else {
        plan = candidate;
      }
    } catch (e) {
      output.write(`Ignoring unreadable ${planPath} for agent handoff: ${firstLine(e)}\n`);
    }
  }

  // wall.config.json: starter written on first build, user edits preserved.
  const configPath = join(out, 'wall.config.json');
  let existing = null;
  if (existsSync(configPath)) {
    try { existing = JSON.parse(readFileSync(configPath, 'utf8')); }
    catch (e) { output.write(`Ignoring unreadable ${configPath}: ${firstLine(e)}\n`); }
  }
  const appName = args.name || existing?.appName || basename(cwd);
  const config = mergeConfig(existing, appName, names, plan);
  config.appName = appName;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

  const screens = [];
  const manifest = {};
  let spotCount = 0;
  for (const name of names) {
    const png = readFileSync(join(screensDir, `${name}.png`));
    const dims = pngSize(png) || {};
    let spots = [];
    const axPath = join(axDir, `${name}.json`);
    if (existsSync(axPath)) {
      try {
        const raw = readFileSync(axPath, 'utf8');
        // Auto-detect the dump flavor: idb emits an array (or NDJSON), maestro
        // a nested attributes/children object.
        const trimmed = raw.trim();
        const nodes = trimmed.startsWith('[') || /"AXLabel"|"AXFrame"/.test(trimmed.slice(0, 2000))
          ? parseIdb(raw) : parseMaestro(raw);
        spots = extractHotspots(nodes, deriveScreenSize(nodes));
      } catch (e) {
        output.write(`Skipping hotspots for ${name}: ${firstLine(e)}\n`);
      }
    }
    manifest[name] = spots;
    spotCount += spots.length;
    screens.push({ name, width: dims.width, height: dims.height, spots });
  }

  const wallDir = join(out, 'wall');
  mkdirSync(join(wallDir, 'screens'), { recursive: true });
  for (const name of names) copyFileSync(join(screensDir, `${name}.png`), join(wallDir, 'screens', `${name}.png`));
  // The packet is a handoff artifact that travels to other machines (app-repo
  // PRs, CI) — record project-relative paths, never this machine's absolute
  // ones, so the reproduce commands work wherever the packet lands.
  const outRel = args.out || DEFAULT_OUT;
  const planRel = plan ? (args.plan || join(outRel, 'wall.plan.json')) : '';
  const packet = buildAgentWorkPacket({ config, screens, plan, planPath: planRel, outDir: outRel });
  writeFileSync(join(wallDir, 'index.html'), buildWallHtml({ config, screens }));
  writeFileSync(join(wallDir, 'hotspots.json'), JSON.stringify(manifest, null, 1));
  writeFileSync(join(wallDir, 'agent-context.json'), JSON.stringify(buildAgentContext({ config, screens, plan, planPath: planRel, outDir: outRel }), null, 2) + '\n');
  writeFileSync(join(wallDir, 'agent-work-packet.json'), JSON.stringify(packet, null, 2) + '\n');
  writeFileSync(join(wallDir, 'agent-work-packet.md'), buildAgentWorkPacketMarkdown(packet));

  output.write(buildNextSteps({
    outDir: out,
    screenCount: names.length,
    spotCount,
    configured: isSignedIn(),
    screenshotOnlyCount: packet.quality.screenshotOnlyScreens.length,
    headless: packet.capture.headless,
  }));
  return 0;
}

// ─── publish ────────────────────────────────────────────────────────────────

async function runPublish(args, ctx) {
  const { output, cwd, exec } = ctx;
  const verify = args.verify || '';
  if (verify && !['pending', 'verified', 'regressed', 'inconclusive'].includes(verify)) {
    output.write('--verify must be one of: pending, verified, regressed, inconclusive\n');
    return 1;
  }
  const out = resolve(cwd, args.out || DEFAULT_OUT);
  const wallDir = join(out, 'wall');
  const buildArgs = { ...args, _: [args['no-run'] ? 'build' : 'run'] };
  const buildCode = args['no-run'] ? await runBuild(buildArgs, ctx) : await runRun(buildArgs, ctx);
  if (buildCode !== 0) return buildCode;

  const configPath = join(out, 'wall.config.json');
  const hotspotsPath = join(wallDir, 'hotspots.json');
  if (!existsSync(configPath) || !existsSync(hotspotsPath)) {
    output.write(`Publish needs ${configPath} and ${hotspotsPath}; run mobile-wall build first.\n`);
    return 1;
  }
  let config, hotspots;
  try {
    config = readJson(configPath);
    hotspots = readJson(hotspotsPath);
  } catch (e) {
    output.write(`Could not read wall config/hotspots: ${firstLine(e)}\n`);
    return 1;
  }
  if (args['project-id']) config.projectId = args['project-id'];
  if (args['page-url']) config.pageUrl = args['page-url'];
  if (args['report-url']) config.reportUrl = args['report-url'];

  const deployCommand = args['deploy-command'] || config.publish?.deployCommand || '';
  let deployUrl = args['deploy-url'] || config.publish?.deployUrl || config.pageUrl || '';
  if (deployCommand) {
    output.write(`Running deploy command from ${wallDir}: ${deployCommand}\n`);
    if (!args['dry-run']) {
      try {
        const stdout = exec('/bin/sh', ['-lc', deployCommand], { cwd: wallDir });
        deployUrl = args['deploy-url'] || publicUrlFrom(stdout) || deployUrl;
        if (stdout) output.write(String(stdout).trimEnd() + '\n');
      } catch (e) {
        output.write(`Deploy command failed: ${firstLine(e)}\n`);
        return 1;
      }
    }
  }

  const projectId = config.projectId || '';
  const pageUrl = config.pageUrl || '';
  const key = licenseKey(cwd);
  const baseUrl = functionBase(config);
  const cloud = !args['no-cloud'] && !!projectId && !!pageUrl && !!key;
  let annotations = [];
  let cloudError = '';
  if (cloud) {
    try {
      annotations = await fetchCloudAnnotations(ctx, { baseUrl, key, projectId, pageUrl });
      output.write(`Fetched ${annotations.length} cloud pin${annotations.length === 1 ? '' : 's'} for ${pageUrl}\n`);
    } catch (e) {
      cloudError = firstLine(e);
      output.write(`Could not fetch cloud pins: ${cloudError}\n`);
    }
  } else {
    const missing = [
      !projectId && 'projectId',
      !pageUrl && 'pageUrl',
      !key && 'PINCUSHION_LICENSE_KEY',
    ].filter(Boolean).join(', ');
    output.write(args['no-cloud'] ? 'Cloud sync skipped by --no-cloud.\n' : `Cloud sync skipped; missing ${missing}.\n`);
  }

  const snapshotPath = args.snapshot || config.publish?.snapshotPath || '';
  // The edge function requires integer dimensions and rejects PNG page
  // snapshots (full-page PNG blows the size cap) — fail those client-side
  // instead of shipping megabytes of base64 to a guaranteed 400.
  const target = {
    width: Math.round(Number(args['snapshot-width'] || config.snapshot?.w || 0)) || 0,
    height: Math.round(Number(args['snapshot-height'] || config.snapshot?.h || 0)) || 0,
  };
  const snapshotType = snapshotPath ? contentTypeFor(snapshotPath, args['content-type']) : '';
  const pinPositions = buildSnapshotPinPositions({
    annotations,
    hotspots,
    snapshot: config.snapshot,
    target,
  });
  const snapshotHotspots = buildSnapshotHotspots({ config, hotspots, target });
  let upload = null;
  if (snapshotPath) {
    if (snapshotType === 'image/png') {
      upload = { skipped: 'page snapshots must be JPEG or WebP (the server rejects full-page PNG); re-export the capture as .jpg or .webp' };
    } else if (!existsSync(resolve(cwd, snapshotPath))) {
      upload = { error: `snapshot file not found: ${resolve(cwd, snapshotPath)}` };
      output.write(`Snapshot upload failed: ${upload.error}\n`);
    } else if (!target.width || !target.height) {
      upload = { skipped: 'snapshot width/height missing; set snapshot.w/h in wall.config.json or pass --snapshot-width/--snapshot-height' };
    } else if (!config.snapshot?.rects) {
      upload = { skipped: 'wall.config.json has no snapshot.rects mapping for this wall layout' };
    } else if (!cloud || cloudError) {
      upload = { skipped: cloudError || 'cloud unavailable' };
    } else if (args['dry-run'] || args['no-upload']) {
      upload = { skipped: args['dry-run'] ? 'dry run' : '--no-upload' };
    } else {
      try {
        upload = await uploadSnapshot(ctx, {
          baseUrl,
          key,
          projectId,
          pageUrl,
          snapshotPath: resolve(cwd, snapshotPath),
          contentType: snapshotType,
          width: target.width,
          height: target.height,
          pinPositions,
          hotspots: snapshotHotspots,
          captureContext: { deviceClass: 'mobile', cssWidth: target.width, cssHeight: target.height, orientation: target.width > target.height ? 'landscape' : 'portrait', platform: 'iOS simulator', browser: 'native-app' },
        });
        output.write(`Uploaded page snapshot with ${upload.pinsPlaced} positioned pin${upload.pinsPlaced === 1 ? '' : 's'}.\n`);
      } catch (e) {
        upload = { error: firstLine(e) };
        output.write(`Snapshot upload failed: ${upload.error}\n`);
      }
    }
  } else {
    upload = { skipped: 'no snapshot image; pass --snapshot <jpg|webp> to refresh the public report image' };
  }

  const updates = [];
  const now = new Date().toISOString();
  const shouldResolve = !!args['resolve-implemented'];
  // --verify records a verification verdict only; deploy-URL linking is its
  // own explicit opt-in (--link-deploy, or implied by --resolve-implemented)
  // so a verify-only publish never stamps pins with the wall URL as a deploy.
  const shouldLink = !!args['link-deploy'] || !!args['resolve-implemented'];
  const cloudActionsRequested = shouldResolve || shouldLink || !!verify;
  if (cloudActionsRequested && !args['dry-run'] && (!cloud || cloudError)) {
    output.write(`Requested pin updates (${[shouldResolve && '--resolve-implemented', args['link-deploy'] && '--link-deploy', verify && '--verify'].filter(Boolean).join(', ')}) but cloud sync is unavailable — failing so CI notices.\n`);
  }
  if (cloud && !cloudError && !args['dry-run'] && cloudActionsRequested) {
    for (const ann of annotations) {
      const status = ann.status || 'open';
      const action = ann.action || '';
      const isImplemented = status === 'implemented' || action === 'implemented';
      if (!isImplemented && !doneStatus(status)) continue;
      const patch = {};
      if (shouldResolve && isImplemented) {
        patch.status = 'resolved';
        patch.resolvedAt = ann.resolvedAt || ann.resolved_at || now;
        patch.thread = [...(ann.thread || []), {
          id: `msg_mobile_publish_${Date.now().toString(36)}_${String(ann.id).slice(-6)}`,
          author: 'Pincushion',
          body: `Mobile wall refreshed after publish${deployUrl ? `: ${deployUrl}` : '.'}`,
          type: 'status-note',
          timestamp: now,
        }];
      }
      if (deployUrl && shouldLink) {
        patch.deployUrl = deployUrl;
        patch.deployedAt = now;
      }
      if (verify) {
        patch.verificationStatus = verify;
        patch.verificationNotes = `mobile-wall publish refreshed the public critique surface${snapshotPath ? ' and uploaded a new snapshot' : ''}.`;
        patch.verifiedAt = now;
      }
      if (!Object.keys(patch).length) continue;
      try {
        await pushAnnotationUpdate(ctx, { baseUrl, key, annotation: ann, patch });
        updates.push({ annotationId: ann.id, status: patch.status || status, deployUrl: patch.deployUrl || '', verificationStatus: patch.verificationStatus || '' });
      } catch (e) {
        updates.push({ annotationId: ann.id, error: firstLine(e) });
      }
    }
  }

  const manifest = buildPublishManifest({
    config,
    annotations,
    pinPositions,
    upload,
    deployUrl,
    snapshotPath,
    dryRun: !!args['dry-run'],
    cloud,
    updates,
  });
  writeFileSync(join(wallDir, 'publish-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(wallDir, 'publish-report.md'), buildPublishMarkdown(manifest));
  output.write(`Publish report: ${join(wallDir, 'publish-report.md')}\n`);
  if (args['dry-run']) output.write('Dry run complete; no snapshot or pin status writes were sent.\n');
  // Honest exit code for CI: a failed upload, any failed pin update, or
  // requested-but-impossible cloud actions all mean the publish did not do
  // what was asked — never report success for a partial run.
  const failedUpdates = updates.filter((u) => u.error);
  if (failedUpdates.length) output.write(`${failedUpdates.length} pin update(s) failed — see publish-manifest.json.\n`);
  const cloudActionFailure = cloudActionsRequested && !args['dry-run'] && (!cloud || !!cloudError);
  return (upload?.error || failedUpdates.length || cloudActionFailure) ? 1 : 0;
}

// ─── entry ───────────────────────────────────────────────────────────────────

export async function runMobileWall(argv = [], opts = {}) {
  const ctx = {
    output: opts.output || process.stdout,
    exec: opts.exec || defaultExec,
    fetch: opts.fetch || ((...a) => globalThis.fetch(...a)),
    cwd: opts.cwd || process.cwd(),
    sleep: opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
  };
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (cmd === 'run') return runRun(args, ctx);
  if (cmd === 'capture') return runCapture(args, ctx);
  if (cmd === 'build') return runBuild(args, ctx);
  if (cmd === 'publish') return runPublish(args, ctx);
  ctx.output.write(buildHelp());
  return cmd && cmd !== 'help' ? 1 : 0;
}
