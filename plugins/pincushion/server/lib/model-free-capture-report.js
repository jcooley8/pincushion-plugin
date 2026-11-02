// A local, explicit URL capture command. Cloud authority remains with the
// existing writer/read boundaries; a journal is never an authorization grant.
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, rename, rm, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const MAX_JOURNAL_BYTES = 64 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const DEVICES = ['desktop', 'mobile'];
const failure = (code) => Object.assign(new Error(code), { code });
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!plain(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined)
    .map((key) => [key, stable(value[key])]));
}

export function privateCaptureRequest(input) {
  const allowed = new Set(['operationId', 'projectId', 'url', 'title', 'requireAuth']);
  if (!plain(input) || Object.keys(input).some((key) => !allowed.has(key))
    || !UUID.test(input.operationId || '')
    || typeof input.projectId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.projectId)
    || typeof input.url !== 'string' || input.url.length > 2000
    || (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 160))
    || (input.requireAuth !== undefined && typeof input.requireAuth !== 'boolean')) {
    throw failure('invalid_capture_request');
  }
  let url;
  try { url = new URL(input.url); } catch { throw failure('invalid_capture_request'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw failure('invalid_capture_request');
  }
  return Object.freeze({
    operationId: input.operationId, projectId: input.projectId, url: input.url,
    title: input.title || 'Capture report', requireAuth: input.requireAuth === true,
  });
}

export function privateReportHash(reportUrl) {
  let url;
  try { url = new URL(reportUrl); } catch { throw failure('invalid_report_receipt'); }
  if (url.protocol !== 'https:' || !['pincushion.io', 'www.pincushion.io'].includes(url.hostname)
    || url.port || url.username || url.password || url.search || url.hash
    || !/^\/r\/[A-Za-z0-9_-]{8,512}$/.test(url.pathname)) throw failure('invalid_report_receipt');
  return sha256(url.pathname.slice(3));
}

async function flushDirectory(directory) {
  const file = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}

async function safeDirectory(directory, syncDirectory) {
  const absolute = resolve(directory);
  const parent = dirname(absolute);
  if (parent !== absolute) await safeDirectory(parent, syncDirectory);
  try { await mkdir(absolute, { mode: 0o700 }); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure('unsafe_capture_directory');
  // Flush existing entries too: a prior failed sync may have left this
  // directory visible but not durable. Never turn that retry into new effects
  // until every ancestor entry has been acknowledged by the filesystem.
  await syncDirectory(parent);
  return absolute;
}

async function readBoundedJson(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_JOURNAL_BYTES) throw failure('invalid_capture_journal');
    return JSON.parse(await file.readFile('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw failure('invalid_capture_journal');
  } finally { await file?.close(); }
}

async function durableJson(path, value, syncDirectory) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > MAX_JOURNAL_BYTES) throw failure('invalid_capture_journal');
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    file = null;
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await file?.close();
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

export function createFileCaptureJournal(root, { beforeDirectorySync } = {}) {
  const syncDirectory = async (directory) => {
    // Internal fault-injection seam; tool request fields cannot configure it.
    await beforeDirectorySync?.(directory);
    await flushDirectory(directory);
  };
  return {
    async withLease(operationId, work) {
      if (!UUID.test(operationId)) throw failure('invalid_capture_request');
      const directory = await safeDirectory(join(root, operationId), syncDirectory);
      const lockPath = join(directory, 'operation.lock');
      let lock;
      try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (error) {
        if (error.code === 'EEXIST') throw failure('capture_operation_busy');
        throw error;
      }
      const identity = await lock.stat();
      try {
        return await work({
          read: () => readBoundedJson(join(directory, 'receipt.json')),
          write: (record) => durableJson(join(directory, 'receipt.json'), record, syncDirectory),
          async captureDirectory() { return mkdtemp(join(directory, 'capture-')); },
          async removeCaptureDirectory(path) {
            if (dirname(path) !== directory || !/^capture-/.test(path.slice(directory.length + 1))) {
              throw failure('unsafe_capture_directory');
            }
            const info = await lstat(path);
            if (!info.isDirectory() || info.isSymbolicLink()) throw failure('unsafe_capture_directory');
            await rm(path, { recursive: true });
          },
        });
      } finally {
        await lock.close();
        const current = await lstat(lockPath).catch(() => null);
        if (current?.ino === identity.ino && current.dev === identity.dev && !current.isSymbolicLink()) await unlink(lockPath);
      }
    },
  };
}

// Spawn the helper shipped in both npm and MCPB. Its stdout is a private local
// capture receipt, never server stdout/stderr or an agent-visible raw log.
export async function runPageCapture(request, outputDirectory, { signal } = {}) {
  if (process.platform === 'win32') throw failure('capture_runtime_unavailable');
  if (signal?.aborted) throw failure('capture_cancelled');
  const helper = fileURLToPath(new URL('../scripts/capture-snapshot.mjs', import.meta.url));
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [helper, '--critique', request.url, outputDirectory, '--page-only',
      ...(request.requireAuth ? ['--require-auth'] : [])], {
      stdio: ['ignore', 'pipe', 'pipe'], detached: true,
      env: { ...process.env, PINCUSHION_CAPTURE_NO_INSTALL: '1' },
    });
    let bytes = 0;
    let aborted = false;
    const chunks = [];
    const stop = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* owned group exited */ } };
    const abort = () => { aborted = true; stop(); };
    const timer = setTimeout(abort, 180_000);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) abort();
      else chunks.push(chunk);
    });
    child.stderr.resume();
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); stop(); };
    child.once('error', () => { cleanup(); rejectRun(failure('capture_runtime_unavailable')); });
    child.once('close', (code) => {
      cleanup();
      if (aborted || signal?.aborted) return rejectRun(failure('capture_cancelled'));
      if (code !== 0) return rejectRun(failure('capture_incomplete'));
      try { resolveRun(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { rejectRun(failure('capture_incomplete')); }
    });
    if (signal?.aborted) abort();
  });
}

export async function mapPrivateCaptureOutput(output, request, outputDirectory) {
  if (output?.mode !== 'critique-v1' || output.status !== 'complete' || output.eligible !== true
    || output.rootUrl !== request.url || output.coverage?.truncated !== false || output.coverage?.authGap === true
    || output.coverage?.completeCapturePairs !== 1 || output.coverage?.capturedPages !== 1
    || output.coverage?.missingCapturePairs !== 0 || output.coverage?.requestedPins !== 0 || output.coverage?.resolvedPins !== 0
    || output.discovery?.strategy !== 'page-only' || !Array.isArray(output.pages) || output.pages.length !== 1
    || (request.requireAuth && output.auth?.mode !== 'authenticated')) throw failure('capture_incomplete');
  const page = output.pages[0];
  if (page.pageUrl !== request.url || page.finalUrl !== request.url || page.outcome !== 'accessible' || !plain(page.captures)
    || Object.keys(page.captures).length !== 2 || !DEVICES.every((device) => plain(page.captures[device]))) {
    throw failure('capture_incomplete');
  }
  const captures = [];
  for (const device of DEVICES) {
    const capture = page.captures[device];
    const width = capture.dimensions?.width;
    const height = capture.dimensions?.height;
    if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1
      || capture.captureContext?.deviceClass !== device || typeof capture.imagePath !== 'string'
      || !isAbsolute(capture.imagePath) || (capture.pinPositions?.length || 0) !== 0) throw failure('capture_incomplete');
    const subpath = relative(outputDirectory, capture.imagePath);
    if (!subpath || subpath.startsWith(`..${sep}`) || subpath === '..' || isAbsolute(subpath)
      || dirname(capture.imagePath) !== outputDirectory) throw failure('unsafe_capture_image');
    const file = await open(capture.imagePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let image;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size < 4 || info.size > MAX_IMAGE_BYTES) throw failure('unsafe_capture_image');
      image = await file.readFile();
    } finally { await file.close(); }
    // Holding these exact bytes closes file replacement between validation
    // and upload. The transcript receives neither paths nor base64.
    const jpeg = image[0] === 0xff && image[1] === 0xd8;
    const webp = image.toString('ascii', 0, 4) === 'RIFF' && image.toString('ascii', 8, 12) === 'WEBP';
    if (!jpeg && !webp) throw failure('unsafe_capture_image');
    captures.push({
      imageB64: image.toString('base64'), contentHash: sha256(image),
      contentType: jpeg ? 'image/jpeg' : 'image/webp', width, height, deviceClass: device,
      captureContext: capture.captureContext, pinPositions: [], hotspots: capture.hotspots || [],
    });
  }
  return [{ logicalScreenId: 'captured-page', pageUrl: request.url, title: request.title, order: 0, captures }];
}

function validateUpload(receipt, capture, request) {
  if (!receipt || receipt.error || receipt.private !== true || !UUID.test(receipt.versionId || '')
    || receipt.pageUrl !== request.url || receipt.width !== capture.width || receipt.height !== capture.height
    || receipt.contentHash !== capture.contentHash || (receipt.pinsPlaced || 0) !== 0) throw failure('invalid_upload_receipt');
  return {
    versionId: receipt.versionId, deviceClass: capture.deviceClass, pageUrl: request.url,
    width: receipt.width, height: receipt.height, contentHash: receipt.contentHash,
  };
}

function captureManifestMatches(manifest, request, uploads) {
  if (!plain(manifest) || manifest.version !== 1 || manifest.generationKey !== `capture-${request.operationId}`
    || manifest.requested?.purpose !== 'capture' || manifest.requested?.accessMode !== 'project_members'
    || manifest.population?.complete !== true || manifest.population?.pinCount !== 0 || manifest.critique !== null
    || !Array.isArray(manifest.screens) || manifest.screens.length !== 1) return false;
  const screen = manifest.screens[0];
  if (screen.url !== request.url || screen.logicalScreenId !== 'captured-page'
    || !Array.isArray(screen.captures) || screen.captures.length !== 2 || uploads.length !== 2) return false;
  return DEVICES.every((device) => {
    const actual = screen.captures.filter((capture) => capture.deviceClass === device);
    const expected = uploads.filter((upload) => upload.deviceClass === device);
    return actual.length === 1 && expected.length === 1 && actual[0].status === 'complete'
      && actual[0].versionId === expected[0].versionId && actual[0].width === expected[0].width
      && actual[0].height === expected[0].height && actual[0].pinCount === 0
      && Array.isArray(actual[0].pinIds) && actual[0].pinIds.length === 0;
  });
}

function privateReportFrames(report, request, uploads) {
  const generation = report?.generation;
  if (report?.project?.id !== request.projectId || report.share?.access_mode !== 'project_members' || report.restricted === true
    || generation?.requested?.purpose !== 'capture' || generation.critique
    || generation.population?.complete !== true || generation.population?.pinCount !== 0
    || !Array.isArray(generation.screens) || generation.screens.length !== 1
    || generation.screens[0].url !== request.url || generation.screens[0].logicalScreenId !== 'captured-page'
    || !Array.isArray(generation.screens[0].captures) || generation.screens[0].captures.length !== 2
    || !Array.isArray(report.workspaceCaptures) || report.workspaceCaptures.length !== 2) return null;
  const frames = [];
  for (const upload of uploads) {
    const projected = generation.screens[0].captures.filter((frame) => frame.deviceClass === upload.deviceClass);
    const matching = report.workspaceCaptures.filter((frame) => frame.deviceClass === upload.deviceClass);
    const frame = matching[0];
    if (projected.length !== 1 || projected[0].width !== upload.width || projected[0].height !== upload.height
      || projected[0].pinCount !== 0 || matching.length !== 1 || frame.id !== 'captured-page'
      || frame.sourcePageUrl !== request.url || frame.width !== upload.width || frame.height !== upload.height
      || frame.captureContext?.deviceClass !== upload.deviceClass || typeof frame.imageUrl !== 'string'
      || !plain(frame.pinPositions) || Object.keys(frame.pinPositions).length !== 0) return null;
    frames.push({ frame, upload });
  }
  return frames;
}

export function createPrivateCaptureReportRunner({ journal, authorize, capture = runPageCapture, generate, readManifest, readPrivateReport, readCaptureImage }) {
  return async function capturePrivateReport(input, { signal } = {}) {
    let request;
    try { request = privateCaptureRequest(input); }
    catch { return { success: false, error: 'invalid_capture_request' }; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 240_000);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const pending = (error = 'capture_readback_pending') => ({ success: false, status: 'pending', operationId: request.operationId, error });
    try {
      if (controller.signal.aborted) throw failure('capture_cancelled');
      const authority = await authorize(request, { signal: controller.signal });
      if (authority?.allowed !== true || !HASH.test(authority.seal || '')) throw failure('capture_access_denied');
      const digest = sha256(JSON.stringify(stable(request)));
      const current = async () => {
        if (controller.signal.aborted) throw failure('capture_cancelled');
        const fresh = await authorize(request, { signal: controller.signal });
        if (controller.signal.aborted || fresh?.allowed !== true || fresh.seal !== authority.seal) throw failure('capture_access_denied');
      };
      return await journal.withLease(request.operationId, async (store) => {
        let record = await store.read();
        const isNew = record === null;
        if (!isNew && (!plain(record) || record.version !== 1 || record.operationId !== request.operationId
          || record.requestDigest !== digest || record.scopeSeal !== authority.seal || !Array.isArray(record.uploads)
          || record.uploads.length > 2)) throw failure('capture_scope_changed');
        if (isNew) {
          record = { version: 1, operationId: request.operationId, requestDigest: digest, scopeSeal: authority.seal, phase: 'capturing', uploads: [] };
          // Persist intent before any browser or cloud effect. Any subsequent
          // call to this operation is read-only, even after an uncertain ACK.
          await store.write(record);
          let directory;
          try {
            await current();
            directory = await store.captureDirectory();
            const output = await capture(request, directory, { signal: controller.signal });
            await current();
            const screens = await mapPrivateCaptureOutput(output, request, directory);
            record.phase = 'generating';
            await store.write(record);
            await generate({
              projectId: request.projectId, title: request.title, purpose: 'capture', accessMode: 'project_members',
              critiqueRunId: request.operationId, generationKey: `capture-${request.operationId}`,
              screens, coverage: { complete: true, discoveredRoutes: 1, capturedRoutes: 1, gaps: [] },
            }, {
              signal: controller.signal, beforeEffect: current,
              async onUpload(upload, supplied) {
                await current();
                const expected = screens[0].captures[record.uploads.length];
                if (!expected || supplied !== expected) throw failure('invalid_upload_receipt');
                const fact = validateUpload(upload, expected, request);
                if (record.uploads.some((prior) => prior.versionId === fact.versionId)) throw failure('invalid_upload_receipt');
                record.uploads.push(fact);
                await store.write(record);
              },
              async onPrepared({ reportUrl, manifest }) {
                await current();
                if (!captureManifestMatches(manifest, request, record.uploads)) throw failure('invalid_report_receipt');
                record.reportHash = privateReportHash(reportUrl);
                record.manifestHash = sha256(JSON.stringify(stable(manifest)));
                record.phase = 'prepared';
                await store.write(record);
              },
            });
          } catch {
            // Effects may already have committed. Recovery below can only
            // accept recorded exact facts, never repeat a mutation.
          } finally {
            if (directory) await store.removeCaptureDirectory(directory);
          }
        }
        await current();
        if (!HASH.test(record.reportHash || '') || !HASH.test(record.manifestHash || '') || record.uploads.length !== 2) return pending();
        const data = await readManifest(request, { signal: controller.signal });
        await current();
        if (data?.success !== true || privateReportHash(data.reportUrl) !== record.reportHash
          || !captureManifestMatches(data.manifest, request, record.uploads)
          || sha256(JSON.stringify(stable(data.manifest))) !== record.manifestHash) return pending();
        const report = await readPrivateReport(request, record.reportHash, { signal: controller.signal });
        await current();
        const frames = privateReportFrames(report, request, record.uploads);
        if (!frames || typeof readCaptureImage !== 'function') return pending();
        for (const { frame, upload } of frames) {
          await current();
          const image = await readCaptureImage(frame, { signal: controller.signal });
          await current();
          if (!Buffer.isBuffer(image) || image.length < 4 || image.length > MAX_IMAGE_BYTES || sha256(image) !== upload.contentHash) return pending();
        }
        record.phase = 'complete';
        await store.write(record);
        await current();
        const appPath = `/app/project/${encodeURIComponent(request.projectId)}/review/${record.reportHash}`;
        return {
          success: true, status: 'capture_only', operationId: request.operationId, projectId: request.projectId,
          reviewId: record.reportHash, appPath, appUrl: `https://www.pincushion.io${appPath}`, deviceVariants: DEVICES,
          pinCount: 0,
        };
      });
    } catch (error) {
      const publicCodes = new Set(['capture_scope_changed', 'capture_access_denied', 'capture_cancelled', 'capture_operation_busy']);
      return pending(publicCodes.has(error.code) ? error.code : 'capture_readback_pending');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };
}
