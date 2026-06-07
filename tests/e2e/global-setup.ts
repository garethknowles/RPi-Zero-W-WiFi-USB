/**
 * Lays down a clean root + a fresh mock-bin directory with modprobe + sudo
 * shell stubs that record their argv to MOCK_LOG. Runs once before the
 * webServer is started.
 */
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import {
  E2E_MOCK_BIN,
  E2E_MOCK_LOG,
  E2E_ROOT,
  E2E_STATE_FILE,
} from "../../playwright.e2e.config";

export default async function globalSetup(): Promise<void> {
  await rm(E2E_ROOT, { recursive: true, force: true });
  await mkdir(E2E_ROOT, { recursive: true });
  // Start each run with no persisted pending-sync state.
  await rm(E2E_STATE_FILE, { force: true });

  await rm(E2E_MOCK_BIN, { recursive: true, force: true });
  await mkdir(E2E_MOCK_BIN, { recursive: true });
  await writeFile(E2E_MOCK_LOG, "");

  // modprobe stub: records its argv to the log.
  await writeFile(
    `${E2E_MOCK_BIN}/modprobe`,
    `#!/bin/sh\necho "$*" >> "${E2E_MOCK_LOG}"\n`,
  );
  // sudo stub: drops the sudo prefix and execs the rest. With our PATH this
  // routes "sudo modprobe …" back through the modprobe stub.
  await writeFile(
    `${E2E_MOCK_BIN}/sudo`,
    `#!/bin/sh\nexec "$@"\n`,
  );
  await chmod(`${E2E_MOCK_BIN}/modprobe`, 0o755);
  await chmod(`${E2E_MOCK_BIN}/sudo`, 0o755);
}
