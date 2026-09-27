#!/usr/bin/env bash
set -Eeuo pipefail

environment_file=${1:-/etc/legacy-hosting/status.env}
if [[ ! -f $environment_file ]]; then
  echo "Missing protected Status environment: $environment_file" >&2
  exit 1
fi
permissions=$(stat -c '%a' "$environment_file")
if (( (8#$permissions & 077) != 0 )); then
  echo "$environment_file must have mode 0600 or stricter" >&2
  exit 1
fi
set -a
. "$environment_file"
set +a
required=(NODE_ENV HOST PORT STATUS_PUBLIC_ORIGIN STATUS_COMPONENTS STATUS_DATA_FILE STATUS_EVENTS_FILE STATUS_PUSH_STATE_FILE STATUS_PUSH_VAPID_SUBJECT STATUS_PUSH_VAPID_PUBLIC_KEY STATUS_PUSH_VAPID_PRIVATE_KEY STATUS_PUSH_ALLOWED_HOSTS)
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
if [[ $STATUS_PUBLIC_ORIGIN != https://status.legacyhosting.xyz ]]; then
  echo "STATUS_PUBLIC_ORIGIN must be https://status.legacyhosting.xyz" >&2
  exit 1
fi
if [[ $STATUS_DATA_FILE != /var/lib/legacy-hosting-status/* ]]; then
  echo "STATUS_DATA_FILE must stay below /var/lib/legacy-hosting-status" >&2
  exit 1
fi
if [[ $STATUS_EVENTS_FILE != /var/lib/legacy-hosting-status/* ]]; then
  echo "STATUS_EVENTS_FILE must stay below /var/lib/legacy-hosting-status" >&2
  exit 1
fi
if [[ $STATUS_PUSH_STATE_FILE != /var/lib/legacy-hosting-status/* ]]; then
  echo "STATUS_PUSH_STATE_FILE must stay below /var/lib/legacy-hosting-status" >&2
  exit 1
fi
if [[ $STATUS_PUSH_VAPID_SUBJECT != mailto:* && $STATUS_PUSH_VAPID_SUBJECT != https://* ]]; then
  echo "STATUS_PUSH_VAPID_SUBJECT must use mailto: or https:" >&2
  exit 1
fi
if [[ ! $STATUS_PUSH_VAPID_PUBLIC_KEY =~ ^[A-Za-z0-9_-]{80,120}$ || \
      ! $STATUS_PUSH_VAPID_PRIVATE_KEY =~ ^[A-Za-z0-9_-]{40,100}$ ]]; then
  echo "Status VAPID keys have an invalid format" >&2
  exit 1
fi
node -e 'const targets=JSON.parse(process.env.STATUS_COMPONENTS); if(!Array.isArray(targets)||targets.length<1||targets.some((item)=>!String(item.url||"").startsWith("https://"))) process.exit(1)'
node -e 'const hosts=JSON.parse(process.env.STATUS_PUSH_ALLOWED_HOSTS); if(!Array.isArray(hosts)||hosts.length<1||hosts.some((host)=>!/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(String(host)))) process.exit(1)'
echo "Status production environment validation passed without printing secrets."
