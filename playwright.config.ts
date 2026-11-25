import { rmSync } from "node:fs";
import { defineConfig } from "@playwright/test";

/**
 * The end-to-end tests of Factory: they use only the REST API of a live instance (AGENTS.md,
 * Testing). Without `FACTORY_E2E_URL`, Playwright starts a new instance with empty data. With it,
 * the tests run against that instance.
 */

const PORT = 4411;
const DATA_DIR = "e2e/.data";
const external = process.env.FACTORY_E2E_URL;
const baseURL = external ?? `http://localhost:${PORT}`;

// Only the first process of a run removes the data of the run before it: the workers load this file too.
if (external === undefined && process.env.TEST_WORKER_INDEX === undefined) {
  rmSync(DATA_DIR, { force: true, recursive: true });
}

export default defineConfig({
  // One instance with one board and one runner: the tests of a file depend on each other's state.
  fullyParallel: false,
  reporter: [["list"]],
  testDir: "e2e",
  // An agent's run takes a sandbox and some model calls.
  timeout: 300_000,
  use: { baseURL },
  ...(external === undefined
    ? {
        webServer: {
          command: "bun src/main.ts",
          env: {
            FACTORY_DATA_DIR: DATA_DIR,
            FACTORY_URL: baseURL,
            PORT: String(PORT),
          },
          reuseExistingServer: false,
          timeout: 60_000,
          url: `${baseURL}/api/session`,
        },
      }
    : {}),
  workers: 1,
});
