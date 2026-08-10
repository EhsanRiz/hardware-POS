import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AuthProvider } from "./context/AuthContext";
import ErrorBoundary from "./components/ErrorBoundary";
import "./index.css";

/**
 * Boot.
 *
 * Demo mode swaps the backend for an in-page stand-in so the till can be tried
 * with no project and no connection. It is dynamically imported so a production
 * bundle never contains it, and — more importantly — it is installed and
 * awaited BEFORE React mounts: the app fetches the catalogue on its first
 * render, so a stub installed afterwards would miss that request and the till
 * would come up empty.
 */
async function boot() {
  if (import.meta.env.VITE_DEMO === "1") {
    const { installDemoBackend } = await import("./demo/backend");
    installDemoBackend();
  }

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ErrorBoundary>
    </React.StrictMode>
  );
}

void boot();
