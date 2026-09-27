# Legacy Hosting Status

Independent public service-status page running in FRA1. It does not use the AMS3 VPC, Managed MySQL, LH-API, LH-SSO, or provider credentials.

The backend performs bounded HTTPS probes, writes the latest public snapshot atomically to local persistent storage, and serves the same snapshot through a small API. Nginx falls back to the stored JSON file if the Node.js process is unavailable, while the browser also retains the last successful snapshot locally.

No internal URL, token, infrastructure address, or error body is returned by the public API.

## Development

```bash
pnpm install
pnpm dev
pnpm dev:ui
```

## Release and deployment

Tags named `v*` publish immutable archives to `LH-Releases/LH-Status` and checksums to its `SHA256` directory. Deploy on `fra1-status-01` with:

```bash
ops/scripts/deploy-release.sh ARCHIVE CHECKSUM VERSION
```

Production requires `/etc/legacy-hosting/status.env` with mode `0600`, a certificate for `status.legacyhosting.xyz`, and `STATUS_DATA_FILE=/var/lib/legacy-hosting-status/status-snapshot.json`.
