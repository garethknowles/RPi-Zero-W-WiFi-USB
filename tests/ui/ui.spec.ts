import { expect, test } from "@playwright/test";
import { mkdir, readdir, rm } from "node:fs/promises";
import { UI_ROOT } from "../../playwright.ui.config";

// Each test starts with an empty root.
test.beforeEach(async () => {
  for (const entry of await readdir(UI_ROOT)) {
    await rm(`${UI_ROOT}/${entry}`, { recursive: true, force: true });
  }
});

test("homepage loads with the expected heading and empty state", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /AnkerMake File Manager/i })).toBeVisible();
  await expect(page.locator("text=Empty folder")).toBeVisible();
});

test("creates a new folder via the New folder button", async ({ page }) => {
  page.once("dialog", (d) => d.accept("models"));
  await page.goto("/");
  await page.getByRole("button", { name: /New folder/i }).click();
  await expect(page.locator("td", { hasText: "models" })).toBeVisible();
});

test("uploads a file via the hidden file picker and shows it in the list", async ({ page }) => {
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles({
    name: "cube.gcode",
    mimeType: "text/plain",
    buffer: Buffer.from("G1 X0 Y0\n"),
  });
  await expect(page.locator("td", { hasText: "cube.gcode" })).toBeVisible({ timeout: 5_000 });
  await expect(page.locator("td.size", { hasText: /\d+\s*B/ })).toBeVisible();
});

test("navigates into a sub-folder via the breadcrumb", async ({ page }) => {
  await mkdir(`${UI_ROOT}/parts`, { recursive: true });
  await page.goto("/");
  await page.locator(".name.dir", { hasText: "parts" }).click();
  await expect(page.locator("#crumbs")).toContainText("parts");
  await expect(page.locator("text=Empty folder")).toBeVisible();
});

test("deletes a file after confirm", async ({ page }) => {
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles({
    name: "doomed.gcode",
    mimeType: "text/plain",
    buffer: Buffer.from("x"),
  });
  await expect(page.locator("td", { hasText: "doomed.gcode" })).toBeVisible();

  page.once("dialog", (d) => d.accept());
  await page.locator(".del").first().click();
  await expect(page.locator("td", { hasText: "doomed.gcode" })).toHaveCount(0);
});

test("status bar shows free space and file count", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status")).toContainText(/free of/i);
  await expect(page.locator("#status")).toContainText(/0 files/);
});

test("API rejects path traversal", async ({ request }) => {
  const r = await request.get("/api/list?path=" + encodeURIComponent("../../etc"));
  expect(r.status()).toBe(400);
});
