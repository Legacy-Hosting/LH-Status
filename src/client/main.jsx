import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { AlertTriangle, CheckCircle2, CircleHelp, Clock3, RefreshCw } from "lucide-react";
import "./styles.css";

const cacheKey = "lh-status:last-snapshot";
const labels = {
  operational: "All systems operational",
  degraded: "Some systems are degraded",
  partial_outage: "Some systems are unavailable",
  major_outage: "Major service outage",
  unknown: "Status is currently unknown",
};

function cachedSnapshot() {
  try {
    return JSON.parse(localStorage.getItem(cacheKey) || "null");
  } catch {
    return null;
  }
}

function App() {
  const [snapshot, setSnapshot] = useState(cachedSnapshot);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
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

  return (
    <div className="page">
      <header><a href="/" className="brand"><span>L</span><div><strong>Legacy Hosting</strong><small>Service status</small></div></a><button onClick={() => void refresh()} disabled={loading}><RefreshCw size={16} className={loading ? "spin" : ""} />Refresh</button></header>
      <main>
        <section className={`overall ${overall}`}>
          <div className="overall-icon"><OverallIcon size={27} /></div>
          <div><span>Current status</span><h1>{labels[overall] ?? labels.unknown}</h1><p>{offline ? "Live status could not be reached. Showing the last snapshot stored in this browser." : stale ? "The latest probe snapshot is older than expected." : "Public probes run independently from the services in Amsterdam."}</p></div>
        </section>
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
        <section className="history"><div><span>Incident history</span><h2>No published incidents</h2></div><p>Incident publishing and subscriber notifications are planned for the next Status phase.</p></section>
      </main>
      <footer><span>Operated independently from FRA1</span><a href="https://legacyhosting.xyz">legacyhosting.xyz</a></footer>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
