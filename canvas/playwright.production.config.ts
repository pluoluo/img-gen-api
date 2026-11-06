import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const canvasTestData = mkdtempSync(join(tmpdir(), "image-api-canvas-tests-"));
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./production-tests",
  outputDir: "./production-test-results",
  use: {
    baseURL: "http://127.0.0.1:8080",
    headless: true,
    viewport: { width: 1440, height: 960 },
  },
  webServer: {
    command:
      "cd .. && PYTHONPATH=. venv/bin/python -m uvicorn image_api.main:app --host 127.0.0.1 --port 8080",
    url: "http://127.0.0.1:8080/health",
    reuseExistingServer: false,
    env: { CANVAS_DATA_DIR: canvasTestData },
  },
  reporter: "list",
});
