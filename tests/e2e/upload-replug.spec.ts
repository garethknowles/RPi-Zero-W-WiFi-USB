/**
 * End-to-end: a user drives the SPA in a browser; we verify that the right
 * modprobe commands fire as a result (via the mock bin on PATH).
 *
 * Tests run serially because they share the single webServer + mock log.
 */
import { expect, test } from "@playwright/test";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { E2E_MOCK_LOG, E2E_ROOT, E2E_USB_IMAGE } from "../../playwright.e2e.config";

test.describe.configure({ mode: "serial" });

async function modprobeCalls(): Promise<string[]> {
  if (!existsSync(E2E_MOCK_LOG)) return [];
  const txt = await readFile(E2E_MOCK_LOG, "utf8");
  return txt.split("\n").filter((l) => l.length > 0);
}

async function clearModprobeLog(): Promise<void> {
  await writeFile(E2E_MOCK_LOG, "");
}

async function waitForNewCall(before: number, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await modprobeCalls()).length > before) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`No new modprobe call within ${timeoutMs}ms`);
}

test.beforeEach(async () => {
  for (const entry of await readdir(E2E_ROOT)) {
    await rm(`${E2E_ROOT}/${entry}`, { recursive: true, force: true });
  }
  await clearModprobeLog();
});

test("uploading a file in the browser triggers a modprobe replug cycle", async ({ page }) => {
  await page.goto("/");

  const before = (await modprobeCalls()).length;
  await page.locator('input[type="file"]').setInputFiles({
    name: "first.gcode",
    mimeType: "text/plain",
    buffer: Buffer.from("G1 X0\n"),
  });
  await expect(page.locator("td", { hasText: "first.gcode" })).toBeVisible();

  await waitForNewCall(before);
  await page.waitForTimeout(250); // let both unload + load lines land
  const calls = await modprobeCalls();

  expect(calls).toContain("-r g_mass_storage");
  const load = calls.find((l) => l.startsWith("g_mass_storage "));
  expect(load).toBeDefined();
  expect(load).toContain(`file=${E2E_USB_IMAGE}`);
  expect(load).toContain("stall=0");
  expect(load).toContain("removable=1");
});

test("deleting a file in the browser triggers a modprobe replug cycle", async ({ page }) => {
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles({
    name: "doomed.gcode",
    mimeType: "text/plain",
    buffer: Buffer.from("x"),
  });
  await expect(page.locator("td", { hasText: "doomed.gcode" })).toBeVisible();
  await page.waitForTimeout(400); // let the upload's replug settle
  await clearModprobeLog();

  page.once("dialog", (d) => d.accept());
  await page.locator(".del").first().click();
  await expect(page.locator("td", { hasText: "doomed.gcode" })).toHaveCount(0);

  await waitForNewCall(0);
  await page.waitForTimeout(250);
  const calls = await modprobeCalls();
  expect(calls.some((l) => l.startsWith("g_mass_storage "))).toBe(true);
});

test("creating a folder triggers a modprobe replug cycle", async ({ page }) => {
  await page.goto("/");
  await clearModprobeLog();

  page.once("dialog", (d) => d.accept("models"));
  await page.getByRole("button", { name: /New folder/i }).click();
  await expect(page.locator("td", { hasText: "models" })).toBeVisible();

  await waitForNewCall(0);
  await page.waitForTimeout(250);
  const calls = await modprobeCalls();
  expect(calls.some((l) => l.startsWith("g_mass_storage "))).toBe(true);
});

test("the status bar reflects the sync state during a replug", async ({ page }) => {
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles({
    name: "sync-check.gcode",
    mimeType: "text/plain",
    buffer: Buffer.from("x"),
  });
  // The "syncing to printer…" indicator appears in the same status bar refresh
  // that follows the upload.
  await expect(page.locator("#status")).toContainText(/sync/i);
});
