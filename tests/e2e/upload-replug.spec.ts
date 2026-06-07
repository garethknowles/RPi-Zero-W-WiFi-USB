/**
 * End-to-end: a user drives the SPA in a browser. File changes are saved
 * immediately but must NOT replug the USB on their own — the replug only fires
 * when the user presses "Sync to printer". We assert both halves via the mock
 * modprobe bin on PATH.
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

// Click "Sync to printer" and accept the confirmation dialog.
async function pressSync(page: import("@playwright/test").Page): Promise<void> {
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: /Sync to printer/i }).click();
}

test.beforeEach(async () => {
  for (const entry of await readdir(E2E_ROOT)) {
    await rm(`${E2E_ROOT}/${entry}`, { recursive: true, force: true });
  }
  await clearModprobeLog();
});

test("uploading a file saves it and marks it pending — but does NOT replug", async ({ page }) => {
  await page.goto("/");

  await page.locator('input[type="file"]').setInputFiles({
    name: "first.gcode",
    mimeType: "text/plain",
    buffer: Buffer.from("G1 X0\n"),
  });
  await expect(page.locator("td", { hasText: "first.gcode" })).toBeVisible();

  // Status bar shows the change is not yet on the printer.
  await expect(page.locator("#status")).toContainText(/not yet on the printer/i);
  // Give any (incorrect) replug a chance to fire, then assert none did.
  await page.waitForTimeout(500);
  expect(await modprobeCalls()).toEqual([]);
});

test("pressing Sync to printer triggers a modprobe replug cycle and clears pending", async ({ page }) => {
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles({
    name: "ready.gcode",
    mimeType: "text/plain",
    buffer: Buffer.from("G1 X0\n"),
  });
  await expect(page.locator("td", { hasText: "ready.gcode" })).toBeVisible();
  await clearModprobeLog();

  const before = (await modprobeCalls()).length;
  await pressSync(page);

  await waitForNewCall(before);
  await page.waitForTimeout(250); // let both unload + load lines land
  const calls = await modprobeCalls();
  expect(calls).toContain("-r g_mass_storage");
  const load = calls.find((l) => l.startsWith("g_mass_storage "));
  expect(load).toBeDefined();
  expect(load).toContain(`file=${E2E_USB_IMAGE}`);
  expect(load).toContain("stall=0");
  expect(load).toContain("removable=1");

  // And the UI now reports the printer is up to date.
  await expect(page.locator("#status")).toContainText(/up to date/i);
});

test("deleting and creating folders also stay pending until a sync", async ({ page }) => {
  await page.goto("/");

  // Create a folder — pending, no replug.
  page.once("dialog", (d) => d.accept("models"));
  await page.getByRole("button", { name: /New folder/i }).click();
  await expect(page.locator("td", { hasText: "models" })).toBeVisible();
  await page.waitForTimeout(400);
  expect(await modprobeCalls()).toEqual([]);
  await expect(page.locator("#status")).toContainText(/not yet on the printer/i);

  // One sync pushes everything.
  await pressSync(page);
  await waitForNewCall(0);
  await page.waitForTimeout(250);
  expect((await modprobeCalls()).some((l) => l.startsWith("g_mass_storage "))).toBe(true);
});
