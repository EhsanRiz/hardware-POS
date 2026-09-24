import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AuthProvider } from "./context/AuthContext";
import ErrorBoundary from "./components/ErrorBoundary";
import { trackVisualViewport } from "./lib/visualViewport";
import { installErrorReporting } from "./lib/errorReport";
import "./index.css";
import { startUpdateWatch } from "./lib/appUpdate";
import { publishSlipMetrics } from "./lib/config";
import { installNumberSelect } from "./lib/numberFields";
// Catches the browser's install offer, which fires before React mounts.
import "./lib/install";

/**
 * The counting phone installs as its own app (0115): its own name and icon,
 * opening at /count rather than at the till's pairing screen. The page is
 * the same index.html, so the manifest it names is swapped here — first
 * thing, before the browser gets round to deciding the page is installable —
 * and so is the name iOS puts under the icon.
 */
const COUNTING = /^\/count\/?$/.test(location.pathname);
if (COUNTING) {
  let link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "manifest";
    document.head.appendChild(link);
  }
  link.href = "/count.webmanifest";
  document
    .querySelector('meta[name="apple-mobile-web-app-title"]')
    ?.setAttribute("content", "Count");
  document.title = "Count · InnovaPOS";
}

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
  // Before React mounts, so the first dialog opened on a tablet already knows
  // where the screen is.
  trackVisualViewport();
  // Errors go to the server from here on, the line permitting. Installed
  // before React mounts so a crash in the first render is heard too.
  installErrorReporting();
  // Tapping a number field selects what is in it, everywhere.
  installNumberSelect();

  if (import.meta.env.VITE_DEMO === "1") {
    const { installDemoBackend } = await import("./demo/backend");
    installDemoBackend();
  }

  // /count is the counting phone (src/count): no pairing, no sign-in, no
  // till. Loaded on its own so a till never carries it and a counter's phone
  // never runs the till's start-up.
  if (COUNTING) {
    const { default: CountApp } = await import("./count/CountApp");
    ReactDOM.createRoot(document.getElementById("root")!).render(
      <React.StrictMode>
        <ErrorBoundary>
          <CountApp />
        </ErrorBoundary>
      </React.StrictMode>
    );
    return;
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

// Watch for a newer till, and say so rather than reloading underneath
// whoever is serving a customer. See src/lib/appUpdate.ts.
startUpdateWatch();

// The printed slip's type is sized off how many columns this device prints
// at, which is a setting — so the CSS cannot know it and is told. See
// config.ts, and the #print-area rule in index.css.
publishSlipMetrics();
