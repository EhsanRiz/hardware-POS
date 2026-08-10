# InnovaEarth POS — landing page

The public page for **pos.innovaearth.com**. Plain static HTML/CSS/JS, no build
step, no backend. It borrows the palette and type from innovaearth.com so the
two read as one company.

## Deploying

This is its own Cloudflare Worker — `innovaearth-pos-landing` — separate from
the `innovaearth` Worker that serves the main site, and separate from the till
app. Same account, so the `innovaearth.com` zone is already there.

```bash
cd landing
npx wrangler login       # once
npx wrangler deploy
```

Then attach the hostname: **Workers & Pages → innovaearth-pos-landing →
Settings → Domains & Routes → Add custom domain → `pos.innovaearth.com`**.
Because the zone is in the same account, Cloudflare creates the DNS record and
issues the certificate itself; nothing to configure by hand.

### Why a separate Worker

Adding a route to the existing `innovaearth` Worker would work, but it would
tie this page's deploys to the main site's, and both would share one asset
directory. Separate Workers keep marketing-site changes from touching the
product page and vice versa.

### The app lives elsewhere

The till is a separate Worker — `innovaearth-pos-app`, at
**app.innovaearth.com** — configured by `wrangler.toml` at the repo root. This
page links to it for store sign-in rather than hosting a login of its own.

Keeping them apart means a marketing-copy change can never take the till down,
and the two can differ where they should: this page sets
`not_found_handling = "none"` so a mistyped URL 404s properly, while the app
sets `single-page-application` so its client-side routes work.
