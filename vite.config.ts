import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { viteSingleFile } from "vite-plugin-singlefile";

/** The upstream Supabase project, proxied at /api to match production. */
const API_PROXY = {
  target:
    process.env.VITE_SUPABASE_URL ?? "https://krkatpesfwqnjitcxkco.supabase.co",
  changeOrigin: true,
  rewrite: (path: string) => path.replace(/^\/api/, ""),
};

// SINGLEFILE=1 builds one self-contained index.html (used for the hosted trial
// link served from a Supabase Edge Function). The normal build keeps the PWA.
const singleFile = process.env.SINGLEFILE === "1";

/**
 * `virtual:pwa-register`, for a build with no service worker.
 *
 * That module is supplied by vite-plugin-pwa, which the single-file build
 * leaves out — so the moment anything imported it, the demo stopped building
 * at all ("Rollup failed to resolve import"). A resolver is used rather than a
 * resolve.alias because the id is virtual: alias never gets a look at it.
 *
 * enforce: "pre" is load-bearing. Without it this sits AFTER vite's own
 * resolver in the chain, and vite has already failed the build by the time it
 * is asked — the identical error, from a plugin that looks correct.
 *
 * The stand-in is a no-op, which is the truth: a page with no worker has no
 * waiting version, so the update button correctly never appears on the trial
 * link.
 */
function pwaRegisterStub() {
  const id = "virtual:pwa-register";
  return {
    name: "pos-pwa-register-stub",
    enforce: "pre" as const,
    resolveId(source: string) {
      return source === id ? "\0" + id : null;
    },
    load(resolved: string) {
      if (resolved !== "\0" + id) return null;
      return "export function registerSW() { return async () => {}; }";
    },
  };
}

export default defineConfig({
  plugins: singleFile
    ? [react(), viteSingleFile(), pwaRegisterStub()]
    : [
        react(),
        VitePWA({
      // "prompt", not "autoUpdate": autoUpdate reloads the page by itself the
      // moment a new version lands, and a till that reloads mid-sale loses the
      // cart in front of a customer. src/lib/appUpdate.ts asks instead.
      registerType: "prompt",
      workbox: {
        // Fonts are part of the app shell: a till that loses the line before
        // they are cached would fall back to a system serif.
        // jpg is here for the one photograph on the sign-in screen (door.jpg,
        // 61 KB); the catalogue's JPEGs are kept out by globIgnores below.
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2,jpg}"],
        // Supplier catalogue photographs (public/catalogue) are ~10 MB of
        // JPEGs. Precaching them would balloon first install on a shop line;
        // they are picked up lazily by the runtime cache below instead.
        globIgnores: ["catalogue/**"],
        // Cache product images (Supabase Storage) so the product grid still
        // shows pictures while offline. Images are immutable (UUID filenames), so
        // CacheFirst is safe and fast.
        runtimeCaching: [
          {
            // Catalogue photos ship with the app but cache on first sight, so
            // items the shop actually browses still show pictures offline.
            urlPattern: /\/catalogue\/.*\.jpg$/i,
            handler: "CacheFirst",
            options: {
              cacheName: "catalogue-images",
              expiration: { maxEntries: 1500, maxAgeSeconds: 60 * 60 * 24 * 90 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /\/storage\/v1\/object\/public\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "product-images",
              expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      manifest: {
        name: "InnovaPOS",
        short_name: "InnovaPOS",
        description: "InnovaPOS — point of sale by InnovaEarth",
        theme_color: "#0e3a2d",
        background_color: "#f5f2ea",
        display: "standalone",
        orientation: "landscape",
        start_url: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          {
            src: "/icon-512-maskable.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
              },
            ],
            shortcuts: [
              {
                name: "New sale",
                short_name: "Sale",
                url: "/?go=sale",
                icons: [{ src: "/shortcut-icon.png", sizes: "96x96" }],
              },
              {
                name: "Customer accounts",
                short_name: "Accounts",
                url: "/?go=accounts",
                icons: [{ src: "/shortcut-icon.png", sizes: "96x96" }],
              },
              {
                name: "End of Day",
                short_name: "End of Day",
                url: "/?go=eod",
                icons: [{ src: "/shortcut-icon.png", sizes: "96x96" }],
              },
            ],
          },
        }),
      ],
  // Local development and `vite preview` mirror what the Cloudflare Worker does
  // in production (worker/index.ts): /api is the backend, on this same origin.
  // Without this, `npm run dev` would call a path nothing serves.
  server: {
    host: true,
    port: 5173,
    proxy: { "/api": API_PROXY },
  },
  preview: {
    proxy: { "/api": API_PROXY },
  },
});
