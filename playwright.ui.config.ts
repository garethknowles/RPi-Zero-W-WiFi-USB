/**
 * UI tests: no USB-replug machinery, just exercises the SPA against a live
 * server backed by a tmp directory.
 */
import { defineConfig } from "@playwright/test";

const PORT = 31999;
const ROOT = "/tmp/ankermgr-ui-root";

export default defineConfig({
  testDir: "./tests/ui",
  fullyParallel: false, // single shared server + filesystem
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `bun run ankermanager.ts`,
    url: `http://127.0.0.1:${PORT}/api/status`,
    timeout: 15_000,
    reuseExistingServer: false,
    env: {
      FM_ROOT: ROOT,
      FM_PORT: String(PORT),
      FM_HOST: "127.0.0.1",
      FM_DRIVER: "", // disable USB replug — UI tests don't care about it
      FM_STATE_FILE: "/tmp/ankermgr-ui-sync.json",
    },
  },
  globalSetup: "./tests/ui/global-setup.ts",
});

export const UI_ROOT = ROOT;
export const UI_PORT = PORT;
