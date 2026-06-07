#!/usr/bin/env bun
/**
 * ankermanager — AnkerMake M5 WiFi file manager for a Raspberry Pi Zero 2 W.
 *
 * One process does two jobs:
 *   1. Serves a small web UI + JSON API to manage the files on the virtual USB
 *      drive (list / upload incl. whole folders / mkdir / delete / download).
 *   2. Presents the USB mass-storage gadget to the printer at startup (loads
 *      g_mass_storage pointed at the FAT32 image). The AnkerMake M5 re-reads its
 *      directory listing whenever you open its USB menu, so file changes show up
 *      on their own — there is no replug/"sync" step, and nothing here ever
 *      disconnects the drive (which would abort an in-progress print).
 *
 * This app is the *only* writer to the drive (there is no Samba share).
 *
 * It only ever touches FM_ROOT (the loop-mounted FAT32 image, /mnt/usb_share).
 * All configuration comes from environment variables (see CONFIG below), which
 * on the Pi are provided by /etc/ankermanager.env via the systemd unit.
 */

import { mkdir, readdir, rm, stat, statfs } from "node:fs/promises";
import { execFile } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { basename, dirname, resolve, sep } from "node:path";

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
  // USB gadget settings. Empty driver disables the gadget (useful for local dev).
  driver: process.env.FM_DRIVER ?? "g_mass_storage",
  usbImage: process.env.FM_USB_IMAGE ?? "/piusb.bin",
  maxUploadBytes: Number(
    process.env.FM_MAX_UPLOAD_BYTES ?? 4 * 1024 * 1024 * 1024,
  ),
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
  const base = basename(name)
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .trim();
  if (!base || base === "." || base === "..")
    throw new HttpError(400, "invalid name");
  return base;
}

// Resolve a client-supplied *relative* path (e.g. "folder/sub/cube.gcode" from a
// dropped directory) into a full path under `dir`. Every segment is sanitised
// with safeName, which also rejects "." / ".." so the path can't escape. Returns
// both the absolute target and the cleaned relative path for echoing back.
function safeRelTarget(dir: string, rel: string): { target: string; clean: string } {
  const segs = rel
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s.length > 0)
    .map(safeName);
  if (segs.length === 0) throw new HttpError(400, "empty path");
  const target = resolve(dir, ...segs);
  safePath(target.slice(CONFIG.root.length)); // re-validate under root
  return { target, clean: segs.join("/") };
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// System metadata junk — files that desktop OSes scatter onto removable
// volumes (macOS Finder/Spotlight, Windows). We never show or count them, and
// we delete them from the image so the printer's own file list stays clean.
// ---------------------------------------------------------------------------
const JUNK_RE =
  /^(\.DS_Store|\._.*|\.Spotlight-V100|\.fseventsd|\.Trashes|\.TemporaryItems|\.DocumentRevisions-V100|\.apdisk|\.metadata_never_index|\.VolumeIcon\.icns|System Volume Information)$/;
const isJunk = (name: string): boolean => JUNK_RE.test(name);

// Recursively remove junk files/folders under `dir`; returns how many top-level
// junk entries were removed. Tolerant of transient read errors.
async function cleanJunk(dir: string): Promise<number> {
  let removed = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = resolve(dir, e.name);
    if (isJunk(e.name)) {
      await rm(full, { recursive: true, force: true }).catch(() => {});
      removed++;
    } else if (e.isDirectory()) {
      removed += await cleanJunk(full);
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// USB gadget — loaded once at startup to present the drive to the printer.
// ---------------------------------------------------------------------------
function modprobe(args: string[]) {
  // The systemd service runs as root, so modprobe needs no sudo. Fall back to
  // sudo when running unprivileged (e.g. manual testing on the Pi).
  if (process.getuid?.() === 0) return run("modprobe", args);
  return run("sudo", ["modprobe", ...args]);
}

// Present the drive to the printer. Idempotent: a modprobe of an already-loaded
// module is a no-op, so re-running this never disconnects a live mount (and so
// never interrupts a print).
function loadGadget() {
  return modprobe([
    CONFIG.driver,
    `file=${CONFIG.usbImage}`,
    "stall=0",
    "removable=1",
  ]);
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
  const entries = (await readdir(dir, { withFileTypes: true })).filter(
    (e) => !isJunk(e.name),
  );
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
  items.sort((a, b) =>
    a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1,
  );
  return json({ items });
}

async function apiUpload(url: URL, req: Request): Promise<Response> {
  const dir = safePath(url.searchParams.get("path"));
  await stat(dir); // 404s via catch in handler if missing
  const form = await req.formData();
  const files = form
    .getAll("files")
    .filter((f): f is File => f instanceof File);
  if (files.length === 0) throw new HttpError(400, "no files");
  // Optional parallel "paths" field carries each file's relative path so dropped
  // folders keep their structure. Absent (or blank) → save flat by basename.
  const paths = form.getAll("paths").map((p) => (typeof p === "string" ? p : ""));
  const saved: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    if (file.size > CONFIG.maxUploadBytes)
      throw new HttpError(413, `${file.name} too large`);
    let target: string;
    let clean: string;
    if (paths[i]) {
      ({ target, clean } = safeRelTarget(dir, paths[i]!));
      await mkdir(dirname(target), { recursive: true });
    } else {
      clean = safeName(file.name);
      target = resolve(dir, clean);
      safePath(target.slice(CONFIG.root.length)); // re-validate
    }
    await Bun.write(target, file);
    saved.push(clean);
  }
  await run("sync", []).catch(() => {}); // flush writes through to the image
  return json({ saved });
}

async function apiMkdir(req: Request): Promise<Response> {
  const body = (await req.json()) as { path?: string; name?: string };
  const parent = safePath(body.path);
  const target = resolve(parent, safeName(body.name ?? ""));
  await mkdir(target, { recursive: false });
  return json({ ok: true });
}

async function apiDelete(req: Request): Promise<Response> {
  const body = (await req.json()) as { path?: string };
  const target = safePath(body.path);
  if (target === CONFIG.root) throw new HttpError(400, "cannot delete root");
  await rm(target, { recursive: true, force: true });
  await run("sync", []).catch(() => {});
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
  return json({ free, total, files, driver: CONFIG.driver });
}

async function countFiles(dir: string): Promise<number> {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (isJunk(e.name)) continue;
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
        return new Response(INDEX_HTML, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (url.pathname === "/api/list" && req.method === "GET")
        return await apiList(url);
      if (url.pathname === "/api/upload" && req.method === "POST")
        return await apiUpload(url, req);
      if (url.pathname === "/api/mkdir" && req.method === "POST")
        return await apiMkdir(req);
      if (url.pathname === "/api/delete" && req.method === "POST")
        return await apiDelete(req);
      if (url.pathname === "/api/download" && req.method === "GET")
        return await apiDownload(url);
      if (url.pathname === "/api/status" && req.method === "GET")
        return await apiStatus();
      return new Response("Not found", { status: 404 });
    } catch (err) {
      if (err instanceof HttpError)
        return json({ error: err.message }, err.status);
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return json({ error: "not found" }, 404);
      if (e.code === "EEXIST") return json({ error: "already exists" }, 409);
      log("request error:", e.code ?? "", e.message);
      // This is a LAN-only tool, so surface the real reason — "internal error"
      // is useless for debugging. Friendly text for the FAT32 mishaps we expect.
      const friendly: Record<string, string> = {
        EROFS: "the drive is mounted read-only (remount it read-write)",
        EACCES: "permission denied",
        EPERM: "operation not permitted",
        EBUSY: "the file is in use (is the printer reading it?)",
        ENOSPC: "the drive is full",
        EIO: "disk I/O error (the FAT32 image may be corrupt — run fsck)",
      };
      const reason = (e.code && friendly[e.code]) ?? e.message ?? "internal error";
      return json({ error: e.code ? `${reason} (${e.code})` : reason }, 500);
    }
  },
});

log(
  `ankermanager listening on http://${CONFIG.host}:${server.port}  root=${CONFIG.root}`,
);
if (!CONFIG.user) log("WARNING: FM_USER unset — web UI has no authentication");

void startup();

// On startup, clean any stray system junk and present the drive to the printer.
// loadGadget() is idempotent (modprobe of an already-loaded module is a no-op),
// so an app restart never disconnects a live mount.
async function startup(): Promise<void> {
  if (!CONFIG.driver) {
    log("FM_DRIVER empty — USB gadget disabled (dev mode)");
    return;
  }
  const removed = await cleanJunk(CONFIG.root).catch(() => 0);
  if (removed) log(`removed ${removed} system metadata file(s) from the drive`);
  log("presenting the drive to the printer");
  await loadGadget().catch((e) =>
    log("gadget load failed:", (e as Error).message),
  );
}

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
    <button id="folderBtn">📂 Upload folder</button>
    <button class="primary" id="pickBtn">⬆️ Upload</button>
    <input type="file" id="file" multiple hidden>
    <input type="file" id="folder" webkitdirectory multiple hidden>
  </div>
  <div id="drop">Drag &amp; drop files <b>or whole folders</b> here to upload</div>
  <progress id="prog" value="0" max="100" hidden></progress>
  <table>
    <thead><tr><th>Name</th><th class="size">Size</th><th>Modified</th><th></th></tr></thead>
    <tbody id="list"></tbody>
  </table>
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
      '<span>🗂️ ' + s.files + ' files</span>';
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
$("file").onchange = () => { uploadItems(toItems($("file").files)); $("file").value = ""; };
$("folderBtn").onclick = () => $("folder").click();
$("folder").onchange = () => { uploadItems(folderItems($("folder").files)); $("folder").value = ""; };

// An "item" is { file, path } where path is relative to the current folder
// (just the filename for flat picks, "sub/dir/file" for folders).
const toItems = (fileList) => Array.from(fileList).map(f => ({ file: f, path: f.name }));
// <input webkitdirectory> exposes the relative path on each File.
const folderItems = (fileList) => Array.from(fileList).map(f => ({ file: f, path: f.webkitRelativePath || f.name }));

// Walk dropped entries (files and directories), preserving relative paths.
async function walkEntries(entries) {
  const out = [];
  const readAll = (reader) => new Promise((res, rej) => {
    const acc = [];
    const step = () => reader.readEntries(batch => batch.length ? (acc.push(...batch), step()) : res(acc), rej);
    step();
  });
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path: prefix + entry.name });
    } else if (entry.isDirectory) {
      for (const child of await readAll(entry.createReader())) await walk(child, prefix + entry.name + "/");
    }
  };
  for (const e of entries) await walk(e, "");
  return out;
}

// Upload one file per request, sequentially. The Pi never has to buffer a whole
// folder in memory, and a single file that can't be read/sent is reported by
// name instead of aborting the entire batch. Each request carries the file's
// relative path so folders are rebuilt server-side.
async function uploadItems(items) {
  if (!items.length) return;
  const prog = $("prog");
  prog.hidden = false; prog.max = items.length; prog.value = 0;
  const failed = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    try {
      const fd = new FormData();
      fd.append("files", it.file);
      fd.append("paths", it.path);
      const r = await fetch("/api/upload?path=" + encodeURIComponent(cwd), { method: "POST", body: fd });
      if (!r.ok) { let m = "HTTP " + r.status; try { m = (await r.json()).error || m; } catch {} throw new Error(m); }
    } catch (err) {
      failed.push(it.path + " — " + (err && err.message ? err.message : err));
    }
    prog.value = i + 1;
  }
  prog.hidden = true;
  await refresh();
  if (failed.length) alert(failed.length + " file(s) failed to upload:\\n\\n" + failed.join("\\n"));
}

const drop = $("drop");
["dragenter","dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("hover"); }));
["dragleave","drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("hover"); }));
drop.addEventListener("drop", async e => {
  const dt = e.dataTransfer;
  try {
    // Snapshot directory entries synchronously — they're only valid during the event.
    const entries = [];
    if (dt && dt.items && dt.items.length && dt.items[0].webkitGetAsEntry) {
      for (const item of dt.items) { const en = item.webkitGetAsEntry(); if (en) entries.push(en); }
    }
    const items = entries.length ? await walkEntries(entries) : toItems((dt && dt.files) || []);
    await uploadItems(items);
  } catch (err) {
    $("prog").hidden = true;
    alert("Upload failed: " + (err && err.message ? err.message : err));
  }
});

refresh();
</script>
</body>
</html>`;
