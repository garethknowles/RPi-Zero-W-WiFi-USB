#!/usr/bin/env bun
/**
 * ankermanager — AnkerMake M5 WiFi file manager for a Raspberry Pi Zero 2 W.
 *
 * One process does two jobs:
 *   1. Serves a small web UI + JSON API to manage the files on the virtual USB
 *      drive (list / upload / mkdir / delete / download).
 *   2. Acts as the USB "replug" watchdog: whenever files change — either through
 *      this app or through the Samba share — it unloads and reloads the USB
 *      mass-storage gadget so the printer re-reads the file list.
 *
 * It only ever touches FM_ROOT (the loop-mounted FAT32 image, /mnt/usb_share).
 * All configuration comes from environment variables (see CONFIG below), which
 * on the Pi are provided by /etc/ankermanager.env via the systemd unit.
 */

import { mkdir, readdir, rm, stat, statfs } from "node:fs/promises";
import { watch } from "node:fs";
import { execFile } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { basename, resolve, sep } from "node:path";

const run = promisify(execFile);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const CONFIG = {
  root: resolve(process.env.FM_ROOT ?? "/mnt/usb_share"),
  port: Number(process.env.FM_PORT ?? 8080),
  host: process.env.FM_HOST ?? "0.0.0.0",
  user: process.env.FM_USER ?? "",
  pass: process.env.FM_PASS ?? "",
  // USB gadget settings. Empty driver disables replug (useful for local dev).
  driver: process.env.FM_DRIVER ?? "g_mass_storage",
  usbImage: process.env.FM_USB_IMAGE ?? "/piusb.bin",
  debounceMs: Number(process.env.FM_DEBOUNCE_MS ?? 5000),
  // Backstop poll that catches changes fs.watch might miss (e.g. some Samba
  // writes). 0 disables it. fs.watch is the primary mechanism.
  pollMs: Number(process.env.FM_POLL_MS ?? 10000),
  maxUploadBytes: Number(process.env.FM_MAX_UPLOAD_BYTES ?? 4 * 1024 * 1024 * 1024),
};

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------------------
// Path safety — every request path is resolved under CONFIG.root and rejected
// if it escapes it. Filenames are reduced to a safe basename.
// ---------------------------------------------------------------------------
function safePath(rel: string | null | undefined): string {
  const cleaned = (rel ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  const full = resolve(CONFIG.root, cleaned);
  if (full !== CONFIG.root && !full.startsWith(CONFIG.root + sep)) {
    throw new HttpError(400, "path escapes root");
  }
  return full;
}

// FAT32-illegal characters and path separators are stripped from names.
function safeName(name: string): string {
  const base = basename(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim();
  if (!base || base === "." || base === "..") throw new HttpError(400, "invalid name");
  return base;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// USB replug — debounced + single-flight so rapid changes coalesce into one
// unload/reload cycle and cycles never overlap.
// ---------------------------------------------------------------------------
const replugState = { inProgress: false, pending: false, lastAt: 0, lastReason: "" };
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleReplug(reason: string) {
  if (!CONFIG.driver) return; // disabled (dev mode)
  replugState.lastReason = reason;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void doReplug(reason);
  }, CONFIG.debounceMs);
}

async function doReplug(reason: string) {
  if (replugState.inProgress) {
    replugState.pending = true;
    return;
  }
  replugState.inProgress = true;
  try {
    log(`replug: reason=${reason} driver=${CONFIG.driver}`);
    await modprobe(["-r", CONFIG.driver]).catch(() => {}); // ok if not loaded
    await run("sync", []).catch(() => {});
    await modprobe([
      CONFIG.driver,
      `file=${CONFIG.usbImage}`,
      "stall=0",
      "removable=1",
    ]);
    replugState.lastAt = Date.now();
  } catch (err) {
    log("replug failed:", (err as Error).message);
  } finally {
    replugState.inProgress = false;
    if (replugState.pending) {
      replugState.pending = false;
      void doReplug("pending");
    }
  }
}

function modprobe(args: string[]) {
  // The systemd service runs as root, so modprobe needs no sudo. Fall back to
  // sudo when running unprivileged (e.g. manual testing on the Pi).
  if (process.getuid?.() === 0) return run("modprobe", args);
  return run("sudo", ["modprobe", ...args]);
}

// ---------------------------------------------------------------------------
// Filesystem watcher — catches changes made outside the web app (Samba). The
// app's own mutations call scheduleReplug() directly for instant feedback.
// ---------------------------------------------------------------------------
function startWatcher() {
  if (!CONFIG.driver) return;
  try {
    watch(CONFIG.root, { recursive: true }, () => scheduleReplug("fs-watch"));
    log(`watching ${CONFIG.root} (recursive)`);
  } catch (err) {
    log("recursive fs.watch unavailable, relying on poll:", (err as Error).message);
  }
  if (CONFIG.pollMs > 0) {
    let last = "";
    setInterval(async () => {
      try {
        const sig = await treeSignature(CONFIG.root);
        if (last && sig !== last) scheduleReplug("poll");
        last = sig;
      } catch {
        /* ignore transient scan errors */
      }
    }, CONFIG.pollMs);
  }
}

// Cheap change signature: sorted "relpath:size:mtime" of every file.
async function treeSignature(dir: string, prefix = ""): Promise<string> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push("d:" + rel);
      out.push(await treeSignature(resolve(dir, entry.name), rel));
    } else {
      const s = await stat(resolve(dir, entry.name));
      out.push(`f:${rel}:${s.size}:${Math.round(s.mtimeMs)}`);
    }
  }
  return out.sort().join("|");
}

// ---------------------------------------------------------------------------
// Auth — optional HTTP Basic. Enabled only when FM_USER is set.
// ---------------------------------------------------------------------------
function constantEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function checkAuth(req: Request): boolean {
  if (!CONFIG.user) return true; // auth disabled
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Basic ")) return false;
  let decoded = "";
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  const i = decoded.indexOf(":");
  if (i < 0) return false;
  const u = decoded.slice(0, i);
  const p = decoded.slice(i + 1);
  return constantEquals(u, CONFIG.user) && constantEquals(p, CONFIG.pass);
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------
async function apiList(url: URL): Promise<Response> {
  const dir = safePath(url.searchParams.get("path"));
  const entries = await readdir(dir, { withFileTypes: true });
  const items = await Promise.all(
    entries.map(async (e) => {
      const s = await stat(resolve(dir, e.name)).catch(() => null);
      return {
        name: e.name,
        dir: e.isDirectory(),
        size: s?.size ?? 0,
        mtime: s ? Math.round(s.mtimeMs) : 0,
      };
    }),
  );
  // Folders first, then alphabetical.
  items.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return json({ items });
}

async function apiUpload(url: URL, req: Request): Promise<Response> {
  const dir = safePath(url.searchParams.get("path"));
  await stat(dir); // 404s via catch in handler if missing
  const form = await req.formData();
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) throw new HttpError(400, "no files");
  const saved: string[] = [];
  for (const file of files) {
    if (file.size > CONFIG.maxUploadBytes) throw new HttpError(413, `${file.name} too large`);
    const target = resolve(dir, safeName(file.name));
    safePath(target.slice(CONFIG.root.length)); // re-validate
    await Bun.write(target, file);
    saved.push(safeName(file.name));
  }
  await run("sync", []).catch(() => {});
  scheduleReplug("upload");
  return json({ saved });
}

async function apiMkdir(req: Request): Promise<Response> {
  const body = (await req.json()) as { path?: string; name?: string };
  const parent = safePath(body.path);
  const target = resolve(parent, safeName(body.name ?? ""));
  await mkdir(target, { recursive: false });
  scheduleReplug("mkdir");
  return json({ ok: true });
}

async function apiDelete(req: Request): Promise<Response> {
  const body = (await req.json()) as { path?: string };
  const target = safePath(body.path);
  if (target === CONFIG.root) throw new HttpError(400, "cannot delete root");
  await rm(target, { recursive: true, force: true });
  await run("sync", []).catch(() => {});
  scheduleReplug("delete");
  return json({ ok: true });
}

async function apiDownload(url: URL): Promise<Response> {
  const target = safePath(url.searchParams.get("path"));
  const s = await stat(target);
  if (s.isDirectory()) throw new HttpError(400, "is a directory");
  return new Response(Bun.file(target), {
    headers: {
      "content-disposition": `attachment; filename="${basename(target).replace(/"/g, "")}"`,
    },
  });
}

async function apiStatus(): Promise<Response> {
  let free = 0;
  let total = 0;
  try {
    const fs = await statfs(CONFIG.root);
    free = fs.bavail * fs.bsize;
    total = fs.blocks * fs.bsize;
  } catch {
    /* statfs unavailable */
  }
  let files = 0;
  try {
    files = await countFiles(CONFIG.root);
  } catch {
    /* ignore */
  }
  return json({
    free,
    total,
    files,
    driver: CONFIG.driver,
    syncing: replugState.inProgress || debounceTimer !== null,
    lastReplugAt: replugState.lastAt,
  });
}

async function countFiles(dir: string): Promise<number> {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += await countFiles(resolve(dir, e.name));
    else n++;
  }
  return n;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = Bun.serve({
  port: CONFIG.port,
  hostname: CONFIG.host,
  maxRequestBodySize: CONFIG.maxUploadBytes + 16 * 1024 * 1024,
  async fetch(req) {
    const url = new URL(req.url);

    if (!checkAuth(req)) {
      return new Response("Authentication required", {
        status: 401,
        headers: { "www-authenticate": 'Basic realm="AnkerMake File Manager"' },
      });
    }

    try {
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(INDEX_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (url.pathname === "/api/list" && req.method === "GET") return await apiList(url);
      if (url.pathname === "/api/upload" && req.method === "POST") return await apiUpload(url, req);
      if (url.pathname === "/api/mkdir" && req.method === "POST") return await apiMkdir(req);
      if (url.pathname === "/api/delete" && req.method === "POST") return await apiDelete(req);
      if (url.pathname === "/api/download" && req.method === "GET") return await apiDownload(url);
      if (url.pathname === "/api/status" && req.method === "GET") return await apiStatus();
      return new Response("Not found", { status: 404 });
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return json({ error: "not found" }, 404);
      if (e.code === "EEXIST") return json({ error: "already exists" }, 409);
      log("request error:", e.message);
      return json({ error: "internal error" }, 500);
    }
  },
});

log(`ankermanager listening on http://${CONFIG.host}:${server.port}  root=${CONFIG.root}`);
if (!CONFIG.user) log("WARNING: FM_USER unset — web UI has no authentication");

// Initial replug on startup so the drive is presented to the printer, then watch.
scheduleReplug("startup");
startWatcher();

// ---------------------------------------------------------------------------
// Frontend — single inline page, vanilla JS, no build step.
// ---------------------------------------------------------------------------
const INDEX_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AnkerMake File Manager</title>
<style>
  :root { color-scheme: light dark; --accent:#2d7ff9; --border:#8883; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; margin: 0; padding: 1rem; max-width: 900px; margin-inline: auto; }
  h1 { font-size: 1.2rem; display:flex; align-items:center; gap:.5rem; }
  .bar { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; margin:.5rem 0; }
  .crumbs { font-size:.95rem; }
  .crumbs a { color: var(--accent); text-decoration:none; cursor:pointer; }
  button { font: inherit; padding:.4rem .7rem; border:1px solid var(--border); border-radius:6px; background:transparent; cursor:pointer; }
  button.primary { background: var(--accent); color:#fff; border-color: var(--accent); }
  #drop { border:2px dashed var(--border); border-radius:10px; padding:1.2rem; text-align:center; color:#888; margin:.5rem 0; transition:.15s; }
  #drop.hover { border-color: var(--accent); color: var(--accent); background:#2d7ff90d; }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:.45rem .4rem; border-bottom:1px solid var(--border); font-size:.95rem; }
  td.size, th.size { text-align:right; white-space:nowrap; }
  td.act { text-align:right; white-space:nowrap; }
  .name { cursor:default; }
  .name.dir { cursor:pointer; color: var(--accent); font-weight:600; }
  .muted { color:#888; font-size:.85rem; }
  .icon { width:1.1em; display:inline-block; }
  #status { font-size:.8rem; color:#888; margin-top:.6rem; display:flex; gap:1rem; flex-wrap:wrap; }
  #sync { color: var(--accent); }
  progress { width:100%; height:.5rem; }
  a.dl { color: var(--accent); text-decoration:none; }
  .danger { color:#d33; }
</style>
</head>
<body>
  <h1>🖨️ AnkerMake File Manager</h1>
  <div class="bar">
    <div class="crumbs" id="crumbs"></div>
    <span style="flex:1"></span>
    <button id="mkdirBtn">📁 New folder</button>
    <button class="primary" id="pickBtn">⬆️ Upload</button>
    <input type="file" id="file" multiple hidden>
  </div>
  <div id="drop">Drag &amp; drop files here to upload</div>
  <progress id="prog" value="0" max="100" hidden></progress>
  <table>
    <thead><tr><th>Name</th><th class="size">Size</th><th>Modified</th><th></th></tr></thead>
    <tbody id="list"></tbody>
  </table>
  <p class="muted">Tip: the AnkerMake M5 may only show files in the <b>root</b> of the drive — keep printable <code>.gcode</code>/<code>.acode</code> files there. Avoid changing files during an active print.</p>
  <div id="status"></div>

<script>
let cwd = "";
const $ = (id) => document.getElementById(id);
const fmtSize = (n) => { const u=["B","KB","MB","GB"]; let i=0; while(n>=1024&&i<u.length-1){n/=1024;i++;} return n.toFixed(i?1:0)+" "+u[i]; };
const fmtDate = (ms) => ms ? new Date(ms).toLocaleString() : "";

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) { let m="error"; try{ m=(await r.json()).error||m; }catch{} throw new Error(m); }
  return r.headers.get("content-type")?.includes("json") ? r.json() : r;
}

function renderCrumbs() {
  const parts = cwd ? cwd.split("/") : [];
  let acc = "";
  const links = ['<a data-p="">🏠 root</a>'];
  for (const p of parts) { acc = acc ? acc+"/"+p : p; links.push(' / <a data-p="'+acc+'">'+p+'</a>'); }
  $("crumbs").innerHTML = links.join("");
  $("crumbs").querySelectorAll("a").forEach(a => a.onclick = () => { cwd = a.dataset.p; refresh(); });
}

async function refresh() {
  renderCrumbs();
  const { items } = await api("/api/list?path=" + encodeURIComponent(cwd));
  const rows = items.map(it => {
    const full = (cwd ? cwd + "/" : "") + it.name;
    const nameCell = it.dir
      ? '<span class="name dir" data-p="'+full+'">📁 '+it.name+'</span>'
      : '<span class="name">📄 '+it.name+'</span>';
    const dl = it.dir ? "" : '<a class="dl" href="/api/download?path='+encodeURIComponent(full)+'">⬇️</a> ';
    return '<tr><td>'+nameCell+'</td><td class="size">'+(it.dir?"":fmtSize(it.size))+
      '</td><td class="muted">'+fmtDate(it.mtime)+'</td><td class="act">'+dl+
      '<button class="del" data-p="'+full+'" data-d="'+it.dir+'">🗑️</button></td></tr>';
  });
  $("list").innerHTML = rows.join("") || '<tr><td colspan="4" class="muted">Empty folder</td></tr>';
  $("list").querySelectorAll(".name.dir").forEach(el => el.onclick = () => { cwd = el.dataset.p; refresh(); });
  $("list").querySelectorAll(".del").forEach(b => b.onclick = () => del(b.dataset.p, b.dataset.d === "true"));
  status();
}

async function status() {
  try {
    const s = await api("/api/status");
    $("status").innerHTML =
      '<span>📦 ' + fmtSize(s.free) + ' free of ' + fmtSize(s.total) + '</span>' +
      '<span>🗂️ ' + s.files + ' files</span>' +
      (s.syncing ? '<span id="sync">🔄 syncing to printer…</span>' : '<span>✅ in sync</span>');
    if (s.syncing) setTimeout(status, 1500);
  } catch {}
}

async function del(path, isDir) {
  if (!confirm("Delete " + (isDir ? "folder (and contents)" : "file") + ":\\n" + path + " ?")) return;
  try { await api("/api/delete", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ path }) }); refresh(); }
  catch (e) { alert("Delete failed: " + e.message); }
}

$("mkdirBtn").onclick = async () => {
  const name = prompt("New folder name:");
  if (!name) return;
  try { await api("/api/mkdir", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ path: cwd, name }) }); refresh(); }
  catch (e) { alert("Create folder failed: " + e.message); }
};

$("pickBtn").onclick = () => $("file").click();
$("file").onchange = () => { if ($("file").files.length) upload($("file").files); $("file").value = ""; };

function upload(files) {
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/upload?path=" + encodeURIComponent(cwd));
  $("prog").hidden = false; $("prog").value = 0;
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) $("prog").value = (e.loaded / e.total) * 100; };
  xhr.onload = () => { $("prog").hidden = true; if (xhr.status >= 200 && xhr.status < 300) refresh();
    else { let m="upload failed"; try{ m=JSON.parse(xhr.responseText).error||m; }catch{} alert(m); } };
  xhr.onerror = () => { $("prog").hidden = true; alert("upload failed"); };
  xhr.send(fd);
}

const drop = $("drop");
["dragenter","dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("hover"); }));
["dragleave","drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("hover"); }));
drop.addEventListener("drop", e => { if (e.dataTransfer.files.length) upload(e.dataTransfer.files); });

refresh();
</script>
</body>
</html>`;
