/**
 * Shared test harness: spawns ankermanager.ts with a sandboxed root, intercepts
 * its modprobe/sudo calls via a tmp PATH-prepended mock, and exposes helpers to
 * wait for / inspect the captured invocations.
 *
 * Each call to startServer() gets its own tmpdir, mock log, and port — tests
 * don't share state.
 */

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface TestServer {
  url: string;
  root: string;
  mockLog: string;
  stop: () => Promise<void>;
  /** Snapshot current modprobe invocations (one per line, in order). */
  readModprobeCalls: () => Promise<string[]>;
  /** Replace the log with empty contents. */
  clearModprobeCalls: () => Promise<void>;
  /** Block until at least one new modprobe line appears, or throw on timeout. */
  awaitModprobeCall: (timeoutMs?: number) => Promise<string>;
}

async function makeMockBin(dir: string, logPath: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  // Mock modprobe: record argv to the log, exit 0.
  await writeFile(join(dir, "modprobe"), `#!/bin/sh\necho "$*" >> "${logPath}"\n`);
  // Mock sudo: drop the leading "sudo" and exec the rest. With our PATH it will
  // route "sudo modprobe …" back through our mock modprobe.
  await writeFile(join(dir, "sudo"), `#!/bin/sh\nexec "$@"\n`);
  await chmod(join(dir, "modprobe"), 0o755);
  await chmod(join(dir, "sudo"), 0o755);
}

// Port allocator — bun:test runs files serially, so a simple counter is enough.
let nextPort = 30100 + Math.floor(Math.random() * 1000);

export interface StartOptions {
  user?: string;
  pass?: string;
  driver?: string;
  debounceMs?: number;
  usbImage?: string;
  extraEnv?: Record<string, string>;
}

export async function startServer(opts: StartOptions = {}): Promise<TestServer> {
  const root = await mkdtemp(join(tmpdir(), "ankermgr-root-"));
  const mockDir = await mkdtemp(join(tmpdir(), "ankermgr-mock-"));
  const mockLog = join(mockDir, "modprobe.log");
  await makeMockBin(mockDir, mockLog);

  const port = nextPort++;
  const repoRoot = resolve(import.meta.dir, "..", "..");

  const proc = Bun.spawn({
    cmd: [process.execPath, "run", join(repoRoot, "ankermanager.ts")],
    cwd: repoRoot,
    env: {
      PATH: `${mockDir}:${process.env.PATH ?? ""}`,
      HOME: process.env.HOME ?? "",
      FM_ROOT: root,
      FM_PORT: String(port),
      FM_HOST: "127.0.0.1",
      FM_DRIVER: opts.driver ?? "g_mass_storage",
      FM_USB_IMAGE: opts.usbImage ?? "/tmp/test-piusb.bin",
      FM_DEBOUNCE_MS: String(opts.debounceMs ?? 50),
      FM_POLL_MS: "0",
      FM_USER: opts.user ?? "",
      FM_PASS: opts.pass ?? "",
      ...opts.extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const url = `http://127.0.0.1:${port}`;
  try {
    await waitUntilUp(url);
  } catch (err) {
    proc.kill();
    throw err;
  }

  return {
    url,
    root,
    mockLog,
    stop: async () => {
      proc.kill();
      await proc.exited;
      await rm(root, { recursive: true, force: true });
      await rm(mockDir, { recursive: true, force: true });
    },
    readModprobeCalls: async () => readLines(mockLog),
    clearModprobeCalls: async () => {
      if (existsSync(mockLog)) await writeFile(mockLog, "");
    },
    awaitModprobeCall: async (timeoutMs = 3000) => {
      const before = (await readLines(mockLog)).length;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const lines = await readLines(mockLog);
        if (lines.length > before) return lines[lines.length - 1]!;
        await sleep(25);
      }
      throw new Error(`Timed out waiting for modprobe call after ${timeoutMs}ms`);
    },
  };
}

async function readLines(path: string): Promise<string[]> {
  if (!existsSync(path)) return [];
  const txt = await readFile(path, "utf8");
  return txt.split("\n").filter((l) => l.length > 0);
}

async function waitUntilUp(url: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url + "/api/status");
      // 200 (no auth) or 401 (auth required) both prove the server is bound.
      if (r.status === 200 || r.status === 401) return;
    } catch {
      // not bound yet
    }
    await sleep(50);
  }
  throw new Error(`server at ${url} did not start in time`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function basicAuth(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}
