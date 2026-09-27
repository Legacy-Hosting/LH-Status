# Legacy Hosting Status

Independent public service-status page running in FRA1. It does not use the AMS3 VPC, Managed MySQL, LH-API, LH-SSO, or provider credentials.

The backend performs bounded HTTPS probes, writes the latest public snapshot atomically to local persistent storage, and serves the same snapshot through a small API. Nginx falls back to the stored JSON file if the Node.js process is unavailable, while the browser also retains the last successful snapshot locally.

No internal URL, token, infrastructure address, or error body is returned by the public API.

Incidents and planned maintenance are loaded from the local `STATUS_EVENTS_FILE` and copied into the same atomic public snapshot as component health. This keeps published events available through the Nginx fallback when the Node.js process is unavailable. Event text is schema-validated and rejects URLs, the internal `legacyh.fyi` domain, and private IPv4 addresses. Event component keys must match `STATUS_COMPONENTS`.

`/feed.atom` publishes the same validated incident and maintenance history as an Atom 1.0 feed. Entries use stable URN identifiers and link only to anchors under `STATUS_PUBLIC_ORIGIN`; feed XML is escaped server-side and does not contain probe URLs.

Use `/var/lib/legacy-hosting-status/status-events.json` in production. The file contains an array of `incident` or `maintenance` objects. Incidents use `investigating`, `identified`, `monitoring`, or `resolved`; maintenance uses `scheduled`, `in_progress`, or `completed`. Every object requires a stable lowercase `id`, public `title` and `message`, an impact (`none`, `minor`, `major`, or `critical`), component keys, and ISO timestamps. Resolved incidents also require `resolvedAt`; maintenance requires `scheduledFor` and `scheduledUntil`.

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

Production requires `/etc/legacy-hosting/status.env` with mode `0600`, a certificate for `status.legacyhosting.xyz`, `STATUS_PUBLIC_ORIGIN=https://status.legacyhosting.xyz`, `STATUS_DATA_FILE=/var/lib/legacy-hosting-status/status-snapshot.json`, and `STATUS_EVENTS_FILE=/var/lib/legacy-hosting-status/status-events.json`.
