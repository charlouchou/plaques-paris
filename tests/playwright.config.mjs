import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PORT ?? 8091);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.mjs/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    locale: "fr-FR",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    // Viewport iPhone 13 (390x664, DPR 3, isMobile, hasTouch)
    { name: "iphone-13", use: { ...devices["iPhone 13"] } },
  ],
  // Sert web/ en statique (pas de build) pendant les tests.
  webServer: {
    command: `python3 -m http.server ${PORT} --bind localhost --directory ${process.env.WEB_DIR ?? "../web"}`,
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
