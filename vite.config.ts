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

export default defineConfig({
  plugins: singleFile
    ? [react(), viteSingleFile()]
    : [
        react(),
        VitePWA({
      registerType: "autoUpdate",
      workbox: {
        // Fonts are part of the app shell: a till that loses the line before
        // they are cached would fall back to a system serif.
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
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
