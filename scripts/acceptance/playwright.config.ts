import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

const reportDir = resolve(process.env.REPORT_DIR ?? "artifacts/acceptance");

export default defineConfig({
  testDir: ".",
  testMatch: "browser.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 360_000,
  globalTimeout: 900_000,
  expect: { timeout: 15_000 },
  outputDir: resolve(reportDir, "browser/test-output"),
  reporter: [
    ["list"],
    ["json", { outputFile: resolve(reportDir, "browser/playwright-results.json") }],
    ["html", { outputFolder: resolve(reportDir, "browser/html"), open: "never" }],
  ],
  use: {
    browserName: "chromium",
    headless: true,
    baseURL: process.env.WEB_URL ?? "http://web:3000",
    viewport: { width: 1440, height: 1000 },
    locale: "ru-RU",
    timezoneId: "Asia/Almaty",
    acceptDownloads: true,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    screenshot: "only-on-failure",
    // The serial scenario owns one shared context and records its complete trace.
    // Automatic per-test tracing also instruments browser.newContext() and would
    // double-start/stop that shared trace at test boundaries.
    trace: "off",
    serviceWorkers: "block",
  },
});
