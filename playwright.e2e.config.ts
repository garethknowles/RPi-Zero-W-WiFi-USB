/**
 * End-to-end tests: drives the SPA in a browser AND asserts that the resulting
 * USB-replug commands fire. modprobe + sudo are replaced with shell scripts on
 * PATH that log invocations to a file the tests then inspect.
 */
import { defineConfig } from "@playwright/test";

const PORT = 31998;
const ROOT = "/tmp/ankermgr-e2e-root";
const MOCK_BIN = "/tmp/ankermgr-e2e-bin";
const MOCK_LOG = "/tmp/ankermgr-e2e-modprobe.log";
const USB_IMAGE = "/tmp/ankermgr-e2e-piusb.bin";
const STATE_FILE = "/tmp/ankermgr-e2e-sync.json";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  webServer: {
    // Mock bin must come first on PATH so modprobe + sudo resolve to our stubs.
    command: `bun run ankermanager.ts`,
    url: `http://127.0.0.1:${PORT}/api/status`,
    timeout: 15_000,
    reuseExistingServer: false,
    env: {
      PATH: `${MOCK_BIN}:${process.env.PATH ?? ""}`,
      FM_ROOT: ROOT,
      FM_PORT: String(PORT),
      FM_HOST: "127.0.0.1",
      FM_DRIVER: "g_mass_storage",
      FM_USB_IMAGE: USB_IMAGE,
      FM_STATE_FILE: STATE_FILE,
    },
  },
  globalSetup: "./tests/e2e/global-setup.ts",
});

export const E2E_ROOT = ROOT;
export const E2E_PORT = PORT;
export const E2E_MOCK_BIN = MOCK_BIN;
export const E2E_MOCK_LOG = MOCK_LOG;
export const E2E_USB_IMAGE = USB_IMAGE;
export const E2E_STATE_FILE = STATE_FILE;
