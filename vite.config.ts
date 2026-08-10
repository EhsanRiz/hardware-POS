import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { viteSingleFile } from "vite-plugin-singlefile";

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
        // Cache product images (Supabase Storage) so the product grid still
        // shows pictures while offline. Images are immutable (UUID filenames), so
        // CacheFirst is safe and fast.
        runtimeCaching: [
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
        name: "Hardware POS",
        short_name: "Hardware",
        description: "Point of sale for hardware & building supplies",
        theme_color: "#189c3a",
        background_color: "#ffffff",
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
  server: {
    host: true,
    port: 5173,
  },
});
