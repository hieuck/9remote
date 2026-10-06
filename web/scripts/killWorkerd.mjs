#!/usr/bin/env node

/**
 * Kill leftover wrangler `workerd` processes before starting the dev server.
 *
 * Replaces `pkill -f 'workerd.*9remote' 2>/dev/null; true`, which is POSIX-only: on Windows npm
 * runs scripts through cmd.exe, where `pkill` does not exist, so `predev` exited non-zero and
 * `npm run dev` aborted before Next ever started. This does the same job on every platform and,
 * like the original, never fails the caller — a leftover process is a nuisance, not an error.
 */

import { spawnSync } from "node:child_process";

const PATTERN = /workerd.*9remote/i;

function listWorkerd() {
  if (process.platform === "win32") {
    const r = spawnSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8" });
    if (r.status !== 0 || !r.stdout) return [];
    return r.stdout
      .split(/\r?\n/)
      .filter((l) => /workerd\.exe/i.test(l))
      .map((l) => {
        const m = l.match(/"([^"]+)",\s*"(\d+)"/);
        return m ? { name: m[1], pid: Number(m[2]) } : null;
      })
      .filter(Boolean);
  }
  const r = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .split(/\r?\n/)
    .filter((l) => PATTERN.test(l))
    .map((l) => {
      const m = l.trim().match(/^(\d+)/);
      return m ? { name: "workerd", pid: Number(m[1]) } : null;
    })
    .filter(Boolean);
}

const procs = listWorkerd();
if (!procs.length) {
  console.log("[predev] no leftover workerd process");
  process.exit(0);
}

for (const p of procs) {
  if (p.pid === process.pid) continue;
  const r = process.platform === "win32"
    ? spawnSync("taskkill", ["/pid", String(p.pid), "/T", "/F"], { encoding: "utf8" })
    : spawnSync("kill", ["-TERM", String(p.pid)], { encoding: "utf8" });
  console.log(`[predev] killed ${p.name} pid=${p.pid}${r.status === 0 ? "" : " (already gone)"}`);
}

process.exit(0);