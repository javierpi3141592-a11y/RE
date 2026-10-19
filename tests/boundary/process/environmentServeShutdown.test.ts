import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";

import { writeEnvironmentServeFiles } from "../../fixtures/environmentServe.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { rawHttpRequest } from "../../support/http/rawRequest.js";
import { startListeningProcess } from "../../support/mcp/streamableHttpProcess.js";
import { processTest } from "../../support/process/processFixture.js";

const SHUTDOWN_TIMEOUT_MS = 90_000;

describe("rea environment-serve shutdown", () => {
  // On Windows, Node's child.kill() terminates the child outright for SIGTERM and SIGINT alike,
  // so no signal handler runs and there is no graceful shutdown to observe.
  processTest.skipIf(process.platform === "win32")(
    "closes the listener on SIGTERM, prints one stopped document and exits 143",
    async ({ processes }) => {
      const root = await createTestTempDirectory("rea-environment-serve-stop-");
      const files = await writeEnvironmentServeFiles(root);
      const started = await startListeningProcess(processes, [
        "environment-serve",
        files.manifestPath,
        "--evidence",
        files.capturePath,
        "--port",
        "0",
        "--json",
      ]);
      let stdout = "";
      started.child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      const card = await rawHttpRequest(
        new URL("/.well-known/agent-env.json", started.url.origin),
      );
      expect(card.status).toBe(200);
      started.child.kill("SIGTERM");
      const [code, signalCode] = await once(started.child, "close");
      expect(code).toBe(143);
      expect(signalCode).toBeNull();
      expect(JSON.parse(stdout)).toMatchObject({
        status: "stopped",
        url: started.url.href,
        environment: "grafana-example",
      });
      await expect(rawHttpRequest(started.url)).rejects.toMatchObject({
        code: "ECONNREFUSED",
      });
    },
    SHUTDOWN_TIMEOUT_MS,
  );
});

describe.skipIf(process.platform === "win32")(
  "environment startup cancellation",
  () => {
    processTest(
      "cancels a paused Evidence read without announcing a listener",
      async ({ processes }) => {
        const root = await createTestTempDirectory(
          "rea-environment-start-cancel-",
        );
        const files = await writeEnvironmentServeFiles(root);
        const preload = join(root, "pause-read.mjs");
        const marker = "REA_EVIDENCE_READ_STARTED";
        await writeFile(
          preload,
          `
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const open = fs.open;
let gated = false;
fs.open = async (path, ...args) => {
  const handle = await open(path, ...args);
  if (path === ${JSON.stringify(files.manifestPath)}) {
    const read = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      if (!gated) {
        gated = true;
        const interrupted = new Promise(resolve => process.once("SIGTERM", resolve));
        const keepAlive = setInterval(() => undefined, 1000);
        process.stderr.write(${JSON.stringify(marker + "\n")});
        try { await interrupted; } finally { clearInterval(keepAlive); }
      }
      return read(...readArgs);
    };
  }
  return handle;
};
syncBuiltinESMExports();
`,
        );
        const child = processes.spawn(
          process.execPath,
          [
            "--import",
            preload,
            "scripts/rea.mjs",
            "environment-serve",
            files.manifestPath,
            "--evidence",
            files.capturePath,
            "--port",
            "0",
            "--json",
          ],
          {
            env: {
              PATH: process.env.PATH ?? "",
              NODE_OPTIONS: "--max-old-space-size=768",
              REA_LOG_LEVEL: "info",
            },
          },
        );
        const closed = once(child, "close");
        child.stdin.end();
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error(`No Evidence read marker: ${stderr}`)),
            30_000,
          );
          child.stderr.on("data", (chunk: Buffer) => {
            stderr = (stderr + chunk.toString("utf8")).slice(-64 * 1024);
            if (stderr.includes(marker)) {
              clearTimeout(timeout);
              resolve();
            }
          });
          child.once("exit", () => {
            clearTimeout(timeout);
            reject(new Error(`Exited before Evidence read: ${stderr}`));
          });
        });
        child.kill("SIGTERM");
        const [code, signal] = await closed;
        expect(code).toBe(143);
        expect(signal).toBeNull();
        expect(JSON.parse(stdout)).toMatchObject({
          code: "cancelled",
          details: { operation: "environment-serve" },
        });
        expect(stderr).not.toContain("MCP transport listening");
      },
      SHUTDOWN_TIMEOUT_MS,
    );
  },
);
