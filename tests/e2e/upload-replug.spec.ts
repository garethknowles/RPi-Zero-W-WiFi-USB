/**
 * End-to-end: a user drives the SPA in a browser. Uploads (including dropped
 * folders) save immediately, the printer picks them up on its own, and nothing
 * ever replugs the USB gadget — we assert the mock modprobe bin on PATH is only
 * touched by the one-time startup load.
 *
 * Tests run serially because they share the single webServer + mock log.
 */
import { expect, test } from "@playwright/test";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { E2E_MOCK_LOG, E2E_ROOT } from "../../playwright.e2e.config";

test.describe.configure({ mode: "serial" });

async function modprobeCalls(): Promise<string[]> {
  if (!existsSync(E2E_MOCK_LOG)) return [];
  const txt = await readFile(E2E_MOCK_LOG, "utf8");
  return txt.split("\n").filter((l) => l.length > 0);
}

// The gadget is loaded once at server startup (async, may land just after the
// server starts answering). Wait for it before any test so the per-test log
// clear can't race with it — after this, nothing ever calls modprobe again.
test.beforeAll(async () => {
  const deadline = Date.now() + 5_000;
  while ((await modprobeCalls()).length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
});

test.beforeEach(async () => {
  for (const entry of await readdir(E2E_ROOT)) {
    await rm(`${E2E_ROOT}/${entry}`, { recursive: true, force: true });
  }
  await writeFile(E2E_MOCK_LOG, ""); // startup load already settled (beforeAll)
});

test("uploading a file shows it immediately and never replugs the gadget", async ({ page }) => {
  await page.goto("/");
  await page.locator('input#file').setInputFiles({
    name: "first.gcode",
    mimeType: "text/plain",
    buffer: Buffer.from("G1 X0\n"),
  });
  await expect(page.locator("td", { hasText: "first.gcode" })).toBeVisible();

  // Give any (incorrect) replug a chance to fire, then assert none did.
  await page.waitForTimeout(500);
  expect(await modprobeCalls()).toEqual([]);
});

test("uploading multiple files at once lists them all", async ({ page }) => {
  await page.goto("/");
  await page.locator('input#file').setInputFiles([
    { name: "a.gcode", mimeType: "text/plain", buffer: Buffer.from("a") },
    { name: "b.gcode", mimeType: "text/plain", buffer: Buffer.from("bb") },
  ]);
  await expect(page.locator("td", { hasText: "a.gcode" })).toBeVisible();
  await expect(page.locator("td", { hasText: "b.gcode" })).toBeVisible();
});

test("dropping a folder uploads its contents and preserves structure", async ({ page }) => {
  await page.goto("/");

  // Drive the REAL drop handler: dispatch a 'drop' event whose dataTransfer
  // exposes a webkitGetAsEntry() directory tree. (A synthetic DragEvent won't
  // carry a dataTransfer, so we attach our own to a plain Event — this still
  // exercises the page's actual drop listener, walk, and sequential upload.)
  await page.evaluate(() => {
    const fileEntry = (name: string, content: string) => ({
      isFile: true,
      isDirectory: false,
      name,
      file: (cb: (f: File) => void) => cb(new File([content], name, { type: "text/plain" })),
    });
    const dirEntry = (name: string, children: any[]) => ({
      isFile: false,
      isDirectory: true,
      name,
      createReader: () => {
        let done = false;
        // Flip `done` before invoking cb: walkEntries recurses synchronously
        // here (a real DirectoryReader is async), so the flag must be set first.
        return {
          readEntries: (cb: (e: any[]) => void) => {
            const batch = done ? [] : children;
            done = true;
            cb(batch);
          },
        };
      },
    });
    const root = dirEntry("models", [
      fileEntry("cube.gcode", "G1 X0\n"),
      dirEntry("sub", [fileEntry("nested.gcode", "G1 Y0\n")]),
    ]);
    const dt = { items: [{ kind: "file", webkitGetAsEntry: () => root }], files: [] };
    const ev = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", { value: dt });
    document.getElementById("drop")!.dispatchEvent(ev);
  });

  // The dropped folder appears at the top level...
  await expect(page.locator(".name.dir", { hasText: "models" })).toBeVisible();
  // ...and never triggered a replug.
  await page.waitForTimeout(300);
  expect(await modprobeCalls()).toEqual([]);

  // Drill all the way in to confirm the nested structure was preserved.
  await page.locator(".name.dir", { hasText: "models" }).click();
  await expect(page.locator("td", { hasText: "cube.gcode" })).toBeVisible();
  await page.locator(".name.dir", { hasText: "sub" }).click();
  await expect(page.locator("td", { hasText: "nested.gcode" })).toBeVisible();
});

test("deleting a file removes it without replugging", async ({ page }) => {
  await page.goto("/");
  await page.locator('input#file').setInputFiles({
    name: "doomed.gcode",
    mimeType: "text/plain",
    buffer: Buffer.from("x"),
  });
  await expect(page.locator("td", { hasText: "doomed.gcode" })).toBeVisible();

  page.once("dialog", (d) => d.accept());
  await page.locator(".del").first().click();
  await expect(page.locator("td", { hasText: "doomed.gcode" })).toHaveCount(0);

  await page.waitForTimeout(300);
  expect(await modprobeCalls()).toEqual([]);
});
