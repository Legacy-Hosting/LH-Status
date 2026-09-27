#!/usr/bin/env bash
set -Eeuo pipefail

base=/opt/legacy-hosting/status
test -L "$base/current"
test -f "$base/current-release"
test -f /var/www/legacy-hosting-status/index.html
test -f /var/lib/legacy-hosting-status/status-snapshot.json
curl --fail --silent --show-error http://127.0.0.1:8082/health | \
  grep -q '"status":"ok"'
curl --fail --silent --show-error http://127.0.0.1:8082/api/v1/status | \
  grep -q '"components"'
curl --fail --silent --show-error http://127.0.0.1:8082/api/v1/status | \
  grep -q '"events"'
curl --fail --silent --show-error http://127.0.0.1:8082/feed.atom | \
  grep -q '<feed xmlns="http://www.w3.org/2005/Atom">'
pm2 describe lh-status >/dev/null
current_release=$(readlink -f "$base/current")
if [[ $current_release != "$base/releases/"* ]]; then
  echo "Status current symlink points outside the release directory" >&2
  exit 1
fi
CURRENT_RELEASE="$current_release" node <<'NODE'
const { execFileSync } = require("node:child_process");
const currentRelease = process.env.CURRENT_RELEASE;
const processInfo = JSON.parse(execFileSync("pm2", ["jlist"], { encoding: "utf8" }))
  .find((item) => item.name === "lh-status");
if (!processInfo?.pm2_env?.pm_exec_path?.startsWith(`${currentRelease}/`)) {
  throw new Error(`lh-status is not running from ${currentRelease}`);
}
NODE
nginx -t
echo "LH-Status release verification passed for $(cat "$base/current-release")."
