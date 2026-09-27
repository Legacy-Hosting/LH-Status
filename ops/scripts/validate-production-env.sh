#!/usr/bin/env bash
set -Eeuo pipefail

environment_file=${1:-/etc/legacy-hosting/status.env}
if [[ ! -f $environment_file ]]; then
  echo "Missing protected Status environment: $environment_file" >&2
  exit 1
fi
permissions=$(stat -c '%a' "$environment_file")
if (( 10#$permissions > 600 )); then
  echo "$environment_file must have mode 0600 or stricter" >&2
  exit 1
fi
set -a
. "$environment_file"
set +a
required=(NODE_ENV HOST PORT STATUS_COMPONENTS STATUS_DATA_FILE)
for name in "${required[@]}"; do
  if [[ -z ${!name:-} ]]; then
    echo "Missing Status setting: $name" >&2
    exit 1
  fi
done
if [[ $NODE_ENV != production || $HOST != 127.0.0.1 || $PORT != 8082 ]]; then
  echo "Status must run in production mode on 127.0.0.1:8082" >&2
  exit 1
fi
if [[ $STATUS_DATA_FILE != /var/lib/legacy-hosting-status/* ]]; then
  echo "STATUS_DATA_FILE must stay below /var/lib/legacy-hosting-status" >&2
  exit 1
fi
node -e 'const targets=JSON.parse(process.env.STATUS_COMPONENTS); if(!Array.isArray(targets)||targets.length<1||targets.some((item)=>!String(item.url||"").startsWith("https://"))) process.exit(1)'
echo "Status production environment validation passed without printing secrets."
