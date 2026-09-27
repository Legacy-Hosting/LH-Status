import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  Bell,
  BellOff,
  CalendarClock,
  CheckCircle2,
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
  const history = events.filter(
    (event) => event.status === "resolved" || event.status === "completed",
  ).slice(0, 5);

  return (
    <div className="page">
      <header><a href="/" className="brand"><span>L</span><div><strong>Legacy Hosting</strong><small>Service status</small></div></a><div className="header-actions"><a href="/feed.atom">Atom feed</a>{pushSupported && <button className="push-button" onClick={() => void togglePush()} disabled={["checking", "busy", "denied", "unavailable"].includes(pushState)}>{pushState === "subscribed" ? <BellOff size={16} /> : <Bell size={16} />}<span>{pushState === "subscribed" ? "Unsubscribe" : pushState === "busy" ? "Saving…" : "Subscribe"}</span></button>}<button onClick={() => void refresh()} disabled={loading}><RefreshCw size={16} className={loading ? "spin" : ""} />Refresh</button></div></header>
      <main>
        <section className={`overall ${overall}`}>
          <div className="overall-icon"><OverallIcon size={27} /></div>
          <div><span>Current status</span><h1>{labels[overall] ?? labels.unknown}</h1><p>{offline ? "Live status could not be reached. Showing the last snapshot stored in this browser." : stale ? "The latest probe snapshot is older than expected." : "Public probes run independently from the services in Amsterdam."}</p></div>
        </section>
        {pushMessage && <p className="subscription-message" role="status">{pushMessage}</p>}
        <div className="title"><div><span>Components</span><h2>Legacy Hosting services</h2></div><div><Clock3 size={14} />Updated {updated}</div></div>
        <section className="components">
          {(snapshot?.components ?? []).map((component) => (
            <article key={component.key}>
              <div><strong>{component.name}</strong><small>{component.latencyMs == null ? "No response" : `${component.latencyMs} ms`}</small></div>
              <span className={`badge ${component.state}`}><i />{component.state.replace("_", " ")}</span>
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
        {history.length > 0 && (
          <section className="event-section history">
            <div className="event-heading"><CheckCircle2 size={18} /><div><span>History</span><h2>Recently resolved</h2></div></div>
            <div className="event-list">{history.map((event) => <EventCard event={event} key={event.id} />)}</div>
          </section>
        )}
      </main>
      <footer><span>LH-Status v0.4.0 · Operated independently from FRA1</span><a href="https://legacyhosting.xyz">legacyhosting.xyz</a></footer>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
