import type { CSSProperties } from "react";

export const appTitle = "HexDeck";

const styles = {
  shell: {
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    margin: 0,
    background:
      "radial-gradient(circle at top, rgba(56, 189, 248, 0.22), transparent 36%), linear-gradient(160deg, #020617 0%, #0f172a 48%, #111827 100%)",
    color: "#e2e8f0",
    fontFamily:
      '"Inter", "Segoe UI", "Helvetica Neue", Arial, sans-serif',
  },
  panel: {
    width: "min(92vw, 720px)",
    borderRadius: "28px",
    border: "1px solid rgba(148, 163, 184, 0.2)",
    background: "rgba(15, 23, 42, 0.72)",
    boxShadow: "0 24px 80px rgba(2, 6, 23, 0.55)",
    padding: "40px",
    backdropFilter: "blur(18px)",
  },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    gap: "10px",
    padding: "8px 14px",
    borderRadius: "999px",
    background: "rgba(14, 165, 233, 0.14)",
    color: "#7dd3fc",
    fontSize: "0.875rem",
    fontWeight: 600,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  },
  title: {
    margin: "20px 0 12px",
    fontSize: "clamp(2.5rem, 8vw, 4.5rem)",
    lineHeight: 1,
    letterSpacing: "-0.06em",
  },
  text: {
    margin: 0,
    maxWidth: "58ch",
    color: "#cbd5e1",
    fontSize: "1.05rem",
    lineHeight: 1.7,
  },
} satisfies Record<string, CSSProperties>;

export function App() {
  return (
    <main style={styles.shell}>
      <section style={styles.panel}>
        <div style={styles.badge}>HexDeck</div>
        <h1 style={styles.title}>{appTitle}</h1>
        <p style={styles.text}>
          A clean Tauri + Vite + React + TypeScript shell, ready for the first
          product slice.
        </p>
      </section>
    </main>
  );
}
