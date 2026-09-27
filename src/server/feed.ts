import type { StatusSnapshot } from "./status.js";

function xml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildAtomFeed(snapshot: StatusSnapshot, publicOrigin: string) {
  const origin = new URL(publicOrigin).origin;
  const feedUrl = `${origin}/feed.atom`;
  const updated = snapshot.events.reduce(
    (latest, event) => Date.parse(event.updatedAt) > Date.parse(latest)
      ? event.updatedAt
      : latest,
    snapshot.generatedAt ?? "1970-01-01T00:00:00.000Z",
  );
  const entries = snapshot.events.slice(0, 50).map((event) => {
    const categories = [event.type, event.status, event.impact, ...event.components]
      .map((category) => `<category term="${xml(category)}"/>`)
      .join("");
    return [
      "<entry>",
      `<title>${xml(event.title)}</title>`,
      `<id>urn:legacy-hosting:status:${xml(event.id)}</id>`,
      `<link href="${origin}/#event-${xml(event.id)}"/>`,
      `<published>${xml(event.startedAt)}</published>`,
      `<updated>${xml(event.updatedAt)}</updated>`,
      categories,
      `<summary type="text">${xml(event.message)}</summary>`,
      "</entry>",
    ].join("");
  }).join("");

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    "<title>Legacy Hosting service status</title>",
    `<id>${origin}/</id>`,
    `<link href="${feedUrl}" rel="self" type="application/atom+xml"/>`,
    `<link href="${origin}/" rel="alternate" type="text/html"/>`,
    `<updated>${xml(updated)}</updated>`,
    "<subtitle>Published incidents and planned maintenance for Legacy Hosting services.</subtitle>",
    entries,
    "</feed>",
  ].join("");
}
