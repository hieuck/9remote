// Freshness check for the daemon runtime cache.
//
// The cache under ~/.9remote/daemon/vNN/ is keyed by DAEMON_VERSION alone, so an upgrade
// that shipped a new ptyDaemon.js without bumping that number left the previous copy in place
// and the host kept spawning the stale daemon — a shipped fix silently never reached anyone
// who already had the directory. Asking "does the file exist?" cannot catch that; asking
// "is it byte-identical to what I would write now?" can.
//
// The cache exists to keep node_modules unlocked on Windows during an upgrade, not to pin a
// version, so re-copying on a content change costs one file copy and is always safe.
import fs from "node:fs";
import crypto from "node:crypto";

// Content identity. Size+mtime would be cheaper but wrong: a freshly copied file has a new
// mtime with identical bytes, so every host start would re-copy the bundle for nothing.
export function fileFingerprint(file) {
  try {
    return crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

// True only when dest exists AND matches source. Anything unreadable, missing or mismatched
// is false so the caller re-copies — a false "stale" costs one copy, a false "current" ships
// old code forever.
export function daemonCacheIsCurrent(srcFile, destFile) {
  if (!srcFile || !destFile || typeof srcFile !== "string" || typeof destFile !== "string") return false;
  if (!fs.existsSync(destFile)) return false;
  const src = fileFingerprint(srcFile);
  if (src === null) return false;
  const dest = fileFingerprint(destFile);
  if (dest === null) return false;
  if (src === dest) return true;
  // Same size but different mtime (rebuilt in place) — still stale.
  return false;
}