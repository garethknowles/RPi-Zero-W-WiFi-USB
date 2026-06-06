/**
 * Wipes the UI-test root before each Playwright run. Per-test isolation is
 * handled by beforeEach in the spec file.
 */
import { mkdir, rm } from "node:fs/promises";
import { UI_ROOT } from "../../playwright.ui.config";

export default async function globalSetup(): Promise<void> {
  await rm(UI_ROOT, { recursive: true, force: true });
  await mkdir(UI_ROOT, { recursive: true });
}
