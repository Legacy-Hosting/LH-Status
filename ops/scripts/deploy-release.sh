#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 || $# -ne 3 ]]; then
  echo "Usage as root: $0 ARCHIVE CHECKSUM VERSION" >&2
  exit 2
fi
archive=$(readlink -f "$1")
checksum=$(readlink -f "$2")
version=$3
if [[ ! -f $archive || ! -f $checksum || \
      ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]]; then
  echo "Invalid Status release archive, checksum, or version" >&2
  exit 1
fi
expected=$(awk 'NR==1 {print $1}' "$checksum")
actual=$(sha256sum "$archive" | awk '{print $1}')
if [[ ! $expected =~ ^[a-f0-9]{64}$ || $expected != "$actual" ]]; then
  echo "Status release checksum verification failed" >&2
  exit 1
fi

base=/opt/legacy-hosting/status
release="$base/releases/$version"
environment_file=/etc/legacy-hosting/status.env
if [[ -e $release ]]; then
  echo "Status release already exists: $release" >&2
  exit 1
fi
for certificate_file in fullchain.pem privkey.pem; do
  if [[ ! -r /etc/letsencrypt/live/status.legacyhosting.xyz/$certificate_file ]]; then
    echo "Missing TLS certificate file for status.legacyhosting.xyz" >&2
    exit 1
  fi
done
install -d -m 0755 "$base/releases" /var/www /var/lib/legacy-hosting-status
staging=$(mktemp -d "$base/releases/.staging-${version}.XXXXXX")
trap 'rm -rf -- "$staging"' EXIT
tar -xzf "$archive" --no-same-owner --strip-components=1 -C "$staging"
for path in dist/client/index.html dist/server/server.js package.json pnpm-lock.yaml \
  ecosystem.config.cjs ops/nginx/status.legacyhosting.xyz.conf \
  ops/scripts/validate-production-env.sh; do
  if [[ ! -e $staging/$path ]]; then
    echo "Status release is missing $path" >&2
    exit 1
  fi
done
"$staging/ops/scripts/validate-production-env.sh" "$environment_file"
ln -s "$environment_file" "$staging/.env"
pnpm --dir "$staging" install --prod --frozen-lockfile
chown -R root:root "$staging"
chmod 0755 "$staging"
mv "$staging" "$release"
trap - EXIT

previous=
if [[ -L $base/current ]]; then
  previous=$(readlink -f "$base/current" 2>/dev/null || true)
  if [[ -n $previous && $previous == "$base/releases/"* && -d $previous ]]; then
    ln -sfn "$previous" "$base/previous"
  else
    echo "Current Status symlink points outside the release directory" >&2
    exit 1
  fi
elif [[ -e $base/current ]]; then
  echo "$base/current must be a release symlink" >&2
  exit 1
fi
ln -sfn "$release" "$base/current"
ln -sfn "$base/current/dist/client" /var/www/legacy-hosting-status

rollback_on_error() {
  pm2 delete lh-status >/dev/null 2>&1 || true
  if [[ -n $previous && -d $previous ]]; then
    ln -sfn "$previous" "$base/current"
    ln -sfn "$base/current/dist/client" /var/www/legacy-hosting-status
    pm2 start "$previous/ecosystem.config.cjs" --update-env || true
  else
    rm -f -- "$base/current" /var/www/legacy-hosting-status
  fi
}
trap rollback_on_error ERR
pm2 delete lh-status >/dev/null 2>&1 || true
pm2 start "$release/ecosystem.config.cjs" --update-env
pm2 save
curl --fail --silent --show-error --retry 10 --retry-delay 2 --retry-connrefused \
  http://127.0.0.1:8082/health | grep -q '"status":"ok"'
install -m 0644 "$release/ops/nginx/status.legacyhosting.xyz.conf" \
  /etc/nginx/sites-available/status.legacyhosting.xyz.conf
ln -sfn /etc/nginx/sites-available/status.legacyhosting.xyz.conf \
  /etc/nginx/sites-enabled/status.legacyhosting.xyz.conf
nginx -t
systemctl reload nginx
curl --fail --silent --show-error --retry 5 --retry-delay 2 \
  --resolve status.legacyhosting.xyz:443:127.0.0.1 \
  https://status.legacyhosting.xyz/ >/dev/null
trap - ERR

printf '%s\n' "$version" > "$base/current-release"
echo "LH-Status $version deployed and verified."
