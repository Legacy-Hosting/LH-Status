import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import packageMetadata from "../../package.json";
import {
  AlertTriangle,
  Bell,
  BellOff,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Clock3,
  RefreshCw,
  Siren,
} from "lucide-react";
import "./styles.css";
import "./push.css";

const cacheKey = "lh-status:last-snapshot";
const labels = {
  operational: "All systems operational",
  degraded: "Some systems are degraded",
  partial_outage: "Some systems are unavailable",
  major_outage: "Major service outage",
  unknown: "Status is currently unknown",
};
const historyRanges = ["5m", "15m", "1h", "24h", "7d", "30d", "90d"];

function graphTime(value, range) {
  const options = range === "90d" || range === "30d"
    ? { day: "2-digit", month: "short" }
    : range === "7d"
      ? { day: "2-digit", month: "short", hour: "2-digit" }
      : { hour: "2-digit", minute: "2-digit" };
  return new Intl.DateTimeFormat("en-GB", {
    ...options,
    timeZone: "Europe/Oslo",
  }).format(new Date(value));
}

function niceMaximum(value) {
  const maximum = Math.max(100, value || 0);
  const magnitude = 10 ** Math.floor(Math.log10(maximum));
  const normalized = maximum / magnitude;
  const rounded = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return rounded * magnitude;
}

function HistoryGraph({ data }) {
  const [hovered, setHovered] = useState(null);
  const width = 820;
  const height = 238;
  const left = 48;
  const right = 14;
  const top = 16;
  const bottom = 166;
  const stripTop = 190;
  const stripHeight = 11;
  const plotWidth = width - left - right;
  const points = data.points;
  const maximum = niceMaximum(Math.max(0, ...points.map((point) => point.maximumLatencyMs ?? 0)));
  const xFor = (index) => left + (points.length <= 1 ? 0 : (index / (points.length - 1)) * plotWidth);
  const yFor = (latency) => bottom - (latency / maximum) * (bottom - top);
  const segments = [];
  let segment = [];
  points.forEach((point, index) => {
    if (point.averageLatencyMs == null) {
      if (segment.length > 0) segments.push(segment);
      segment = [];
    } else {
      segment.push({ x: xFor(index), y: yFor(point.averageLatencyMs) });
    }
  });
  if (segment.length > 0) segments.push(segment);
  const hoveredPoint = hovered == null ? null : points[hovered];
  const hoveredX = hovered == null ? null : xFor(hovered);
  const statusColors = {
    operational: "#43d18a",
    degraded: "#e6ab50",
    outage: "#ef6673",
    unknown: "#353943",
  };

  return (
    <div className="history-chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${data.component.name} response time and service status`}
        onPointerLeave={() => setHovered(null)}
        onPointerMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const svgX = ((event.clientX - bounds.left) / bounds.width) * width;
          const index = Math.round(((svgX - left) / plotWidth) * (points.length - 1));
          setHovered(Math.max(0, Math.min(points.length - 1, index)));
        }}
      >
        <defs>
          <linearGradient id={`latency-fill-${data.component.key}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#49c9f2" stopOpacity="0.24" />
            <stop offset="1" stopColor="#49c9f2" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0, 0.5, 1].map((ratio) => {
          const y = bottom - ratio * (bottom - top);
          return (
            <g key={ratio}>
              <line className="chart-grid" x1={left} x2={width - right} y1={y} y2={y} />
              <text className="chart-axis" x={left - 9} y={y + 4} textAnchor="end">
                {Math.round(maximum * ratio)}
              </text>
            </g>
          );
        })}
        {segments.map((line, index) => {
          const path = line.map((point, pointIndex) => `${pointIndex === 0 ? "M" : "L"}${point.x},${point.y}`).join(" ");
          const area = `${path} L${line.at(-1).x},${bottom} L${line[0].x},${bottom} Z`;
          return (
            <g key={index}>
              <path d={area} fill={`url(#latency-fill-${data.component.key})`} />
              <path className="latency-line" d={path} />
            </g>
          );
        })}
        {points.map((point, index) => (
          <rect
            key={point.at}
            x={left + (index * plotWidth) / points.length}
            y={stripTop}
            width={Math.max(1, plotWidth / points.length + 0.2)}
            height={stripHeight}
            fill={statusColors[point.state]}
          />
        ))}
        <text className="chart-caption" x={left} y={stripTop - 8}>Service status</text>
        <text className="chart-axis" x={left} y={226}>{graphTime(data.startAt, data.range)}</text>
        <text className="chart-axis" x={left + plotWidth / 2} y={226} textAnchor="middle">
          {graphTime(new Date((Date.parse(data.startAt) + Date.parse(data.endAt)) / 2), data.range)}
        </text>
        <text className="chart-axis" x={width - right} y={226} textAnchor="end">{graphTime(data.endAt, data.range)}</text>
        {hoveredPoint && hoveredX != null && (
          <g>
            <line className="chart-hover-line" x1={hoveredX} x2={hoveredX} y1={top} y2={stripTop + stripHeight} />
            {hoveredPoint.averageLatencyMs != null && (
              <circle className="chart-hover-point" cx={hoveredX} cy={yFor(hoveredPoint.averageLatencyMs)} r="4" />
            )}
          </g>
        )}
      </svg>
      {hoveredPoint && hoveredX != null && (
        <div
          className="chart-tooltip"
          style={{ left: `clamp(94px, ${(hoveredX / width) * 100}%, calc(100% - 94px))` }}
        >
          <strong>{graphTime(hoveredPoint.at, data.range)}</strong>
          <span><i className={hoveredPoint.state} />{hoveredPoint.state.replace("_", " ")}</span>
          <span>Average: {hoveredPoint.averageLatencyMs == null ? "No response" : `${hoveredPoint.averageLatencyMs} ms`}</span>
          <span>Availability: {hoveredPoint.availabilityPercent == null ? "No data" : `${hoveredPoint.availabilityPercent}%`}</span>
        </div>
      )}
    </div>
  );
}

function ComponentHistory({ component }) {
  const [range, setRange] = useState("1h");
  const [data, setData] = useState(null);
  const [state, setState] = useState("loading");

  useEffect(() => {
    let active = true;
    const load = async (background = false) => {
      if (!background) setState("loading");
      try {
        const response = await fetch(`/api/v1/history/${encodeURIComponent(component.key)}?range=${range}`, {
          headers: { accept: "application/json" },
          cache: "no-store",
        });
        if (!response.ok) throw new Error("history unavailable");
        const next = await response.json();
        if (active) {
          setData(next);
          setState("ready");
        }
      } catch {
        if (active) setState("error");
      }
    };
    void load();
    const timer = setInterval(() => void load(true), 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [component.key, range]);

  return (
    <div className="component-history">
      <div className="history-toolbar">
        <div>
          <strong>Response time</strong>
          <small>
            {data?.summary.samples
              ? `${data.summary.averageLatencyMs ?? "—"} ms average · ${data.summary.availabilityPercent ?? "—"}% available`
              : "History begins when monitoring is enabled"}
          </small>
        </div>
        <div className="range-picker" aria-label="History range">
          {historyRanges.map((option) => (
            <button
              className={range === option ? "active" : ""}
              key={option}
              onClick={() => setRange(option)}
              type="button"
            >
              {option}
            </button>
          ))}
        </div>
      </div>
      {state === "loading" && <div className="history-message">Loading probe history…</div>}
      {state === "error" && <div className="history-message error">Probe history is temporarily unavailable.</div>}
      {state === "ready" && data && <HistoryGraph data={data} />}
      <div className="history-legend" aria-label="Service status legend">
        <span><i className="operational" />Operational</span>
        <span><i className="degraded" />Degraded</span>
        <span><i className="outage" />Outage</span>
        <span><i className="unknown" />No data</span>
      </div>
    </div>
  );
}

function applicationServerKey(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function cachedSnapshot() {
  try {
    return JSON.parse(localStorage.getItem(cacheKey) || "null");
  } catch {
    return null;
  }
}

function eventTime(value) {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Oslo",
  }).format(new Date(value));
}

function EventCard({ event }) {
  const timestamp = event.type === "maintenance"
    ? `${eventTime(event.scheduledFor)}–${eventTime(event.scheduledUntil)}`
    : `Updated ${eventTime(event.updatedAt)}`;
  return (
    <article className={`event-card ${event.impact}`} id={`event-${event.id}`}>
      <div className="event-copy">
        <div className="event-meta">
          <span>{event.status.replaceAll("_", " ")}</span>
          <time>{timestamp}</time>
        </div>
        <h3>{event.title}</h3>
        <p>{event.message}</p>
        {event.components.length > 0 && (
          <div className="event-components">
            {event.components.map((component) => <b key={component}>{component}</b>)}
          </div>
        )}
      </div>
      <span className={`impact ${event.impact}`}>{event.impact} impact</span>
    </article>
  );
}

function App() {
  const [snapshot, setSnapshot] = useState(cachedSnapshot);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const [pushState, setPushState] = useState(pushSupported ? "checking" : "unsupported");
  const [pushMessage, setPushMessage] = useState("");
  const [expandedComponent, setExpandedComponent] = useState(null);
  const refresh = async () => {
    try {
      const response = await fetch("/api/v1/status", {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) throw new Error("status unavailable");
      const next = await response.json();
      localStorage.setItem(cacheKey, JSON.stringify(next));
      setSnapshot(next);
      setOffline(false);
    } catch {
      setOffline(true);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!pushSupported) return;
    let active = true;
    void (async () => {
      try {
        const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        const subscription = await registration.pushManager.getSubscription();
        if (active) setPushState(subscription ? "subscribed" : "available");
      } catch {
        if (active) setPushState("unavailable");
      }
    })();
    return () => { active = false; };
  }, [pushSupported]);

  const togglePush = async () => {
    if (!pushSupported || pushState === "busy") return;
    setPushState("busy");
    setPushMessage("");
    try {
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      if (existing) {
        const response = await fetch("/api/v1/subscriptions/push", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(existing.toJSON()),
        });
        if (!response.ok) throw new Error("unsubscribe_failed");
        await existing.unsubscribe();
        setPushState("available");
        setPushMessage("Browser notifications are disabled on this device.");
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setPushState(permission === "denied" ? "denied" : "available");
        setPushMessage("Notification permission was not granted.");
        return;
      }
      const keyResponse = await fetch("/api/v1/subscriptions/push/key", {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!keyResponse.ok) throw new Error("push_unavailable");
      const keyPayload = await keyResponse.json();
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(keyPayload.data.publicKey),
      });
      const response = await fetch("/api/v1/subscriptions/push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(subscription.toJSON()),
      });
      if (!response.ok) {
        await subscription.unsubscribe();
        throw new Error("subscribe_failed");
      }
      setPushState("subscribed");
      setPushMessage("This device will receive published incident and maintenance updates.");
    } catch {
      setPushState("unavailable");
      setPushMessage("Browser notifications are temporarily unavailable. The Atom feed remains available.");
    }
  };
  const overall = snapshot?.overall ?? "unknown";
  const stale =
    Boolean(snapshot?.stale) ||
    !snapshot?.generatedAt ||
    Date.now() - Date.parse(snapshot.generatedAt) > 90_000;
  const updated = useMemo(() => {
    if (!snapshot?.generatedAt) return "No successful probe yet";
    return new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeStyle: "medium",
      timeZone: "Europe/Oslo",
    }).format(new Date(snapshot.generatedAt));
  }, [snapshot?.generatedAt]);
  const OverallIcon = overall === "operational" ? CheckCircle2 : overall === "unknown" ? CircleHelp : AlertTriangle;
  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  const incidents = events.filter(
    (event) => event.type === "incident" && event.status !== "resolved",
  );
  const maintenance = events.filter(
    (event) => event.type === "maintenance" && event.status !== "completed",
  );
  const eventHistory = events.filter(
    (event) => event.status === "resolved" || event.status === "completed",
  ).slice(0, 5);

  return (
    <div className="page">
      <header><a href="/" className="brand"><img src="/favicon-192.png" alt="Legacy Hosting logo" /><div><strong>Legacy Hosting</strong><small>Service status</small></div></a><div className="header-actions"><a href="/feed.atom">Atom feed</a>{pushSupported && <button className="push-button" onClick={() => void togglePush()} disabled={["checking", "busy", "denied", "unavailable"].includes(pushState)}>{pushState === "subscribed" ? <BellOff size={16} /> : <Bell size={16} />}<span>{pushState === "subscribed" ? "Unsubscribe" : pushState === "busy" ? "Saving…" : "Subscribe"}</span></button>}<button onClick={() => void refresh()} disabled={loading}><RefreshCw size={16} className={loading ? "spin" : ""} />Refresh</button></div></header>
      <main>
        <section className={`overall ${overall}`}>
          <div className="overall-icon"><OverallIcon size={27} /></div>
          <div><span>Current status</span><h1>{labels[overall] ?? labels.unknown}</h1><p>{offline ? "Live status could not be reached. Showing the last snapshot stored in this browser." : stale ? "The latest status snapshot is older than expected." : "Current availability across Legacy Hosting services."}</p></div>
        </section>
        {pushMessage && <p className="subscription-message" role="status">{pushMessage}</p>}
        <div className="title"><div><span>Components</span><h2>Legacy Hosting services</h2></div><div><Clock3 size={14} />Updated {updated}</div></div>
        <section className="components">
          {(snapshot?.components ?? []).map((component) => (
            <article className={expandedComponent === component.key ? "expanded" : ""} key={component.key}>
              <button
                className="component-summary"
                type="button"
                aria-expanded={expandedComponent === component.key}
                onClick={() => setExpandedComponent((current) => current === component.key ? null : component.key)}
              >
                <div><strong>{component.name}</strong><small>{component.latencyMs == null ? "No response" : `${component.latencyMs} ms`}</small></div>
                <div className="component-state"><span className={`badge ${component.state}`}><i />{component.state.replace("_", " ")}</span><ChevronDown size={17} /></div>
              </button>
              {expandedComponent === component.key && <ComponentHistory component={component} />}
            </article>
          ))}
          {!snapshot?.components?.length && <div className="empty">Waiting for the first independent probe snapshot.</div>}
        </section>
        <div className="event-groups">
          <section className="event-section">
            <div className="event-heading"><Siren size={18} /><div><span>Incidents</span><h2>{incidents.length > 0 ? "Active incidents" : "No active incidents"}</h2></div></div>
            {incidents.length > 0
              ? <div className="event-list">{incidents.map((event) => <EventCard event={event} key={event.id} />)}</div>
              : <p className="event-empty">There are no published incidents affecting Legacy Hosting services.</p>}
          </section>
          <section className="event-section">
            <div className="event-heading"><CalendarClock size={18} /><div><span>Maintenance</span><h2>{maintenance.length > 0 ? "Scheduled maintenance" : "No maintenance scheduled"}</h2></div></div>
            {maintenance.length > 0
              ? <div className="event-list">{maintenance.map((event) => <EventCard event={event} key={event.id} />)}</div>
              : <p className="event-empty">No planned maintenance is currently published.</p>}
          </section>
        </div>
        {eventHistory.length > 0 && (
          <section className="event-section history">
            <div className="event-heading"><CheckCircle2 size={18} /><div><span>History</span><h2>Recently resolved</h2></div></div>
            <div className="event-list">{eventHistory.map((event) => <EventCard event={event} key={event.id} />)}</div>
          </section>
        )}
      </main>
      <footer><span>LH-Status v{packageMetadata.version}</span><a href="https://legacyhosting.xyz">legacyhosting.xyz</a></footer>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
