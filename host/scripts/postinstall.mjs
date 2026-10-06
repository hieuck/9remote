#!/usr/bin/env node

/**
 * postinstall for the published host package.
 *
 * Runs the bundled installer. A failure here must NOT fail the install — the package is still
 * usable (the installer only fetches cloudflared and writes config), and npm treats a non-zero
 * postinstall as a hard install failure, which rolled back an otherwise good `npm install`.
 *
 * The previous form was `node dist/install.cjs || true`, but `||` is POSIX shell syntax and
 * cmd.exe has no such operator — npm ran the string through cmd, which failed on the token, so
 * the install aborted before it ever started. Doing the exit-code check in Node is portable.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const installer = path.join(__dirname, "..", "dist", "install.cjs");

if (!fs.existsSync(installer)) {
  // Source checkout or a partial build: nothing to install.
  process.exit(0);
}

const result = spawnSync(process.execPath, [installer], { stdio: "inherit" });
if (result.error) {
  console.warn(`[postinstall] installer could not start: ${result.error.message} (continuing)`);
} else if (result.status !== 0) {
  console.warn(`[postinstall] installer exited ${result.status} (continuing)`);
}

process.exit(0);