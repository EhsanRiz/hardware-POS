# InnovaPOS — landing page

The public page for **pos.innovaearth.com**. Plain static HTML/CSS/JS, no build
step, no backend.

Built to the **Classical** design system from `design_handoff_innovapos`: paper
ground, ink text, gold as stroke and never fill, Cormorant Garamond over Lora,
no sans-serif anywhere. Display type gets *lighter* as it gets bigger — bold is
retired from the system.

Brand tiers matter here. **InnovaEarth** is the house (contracts, invoices,
innovaearth.com); **InnovaPOS** is the product and the only tier that owns a
drawn mark; **Hardware** is the edition, earned by a hairline rule and one word
rather than a new logo. Never stack all three in one lockup.

Fonts are self-hosted in `assets/fonts/` — the same latin subsets the till uses,
so the marketing page and the product type identically.

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

The till is a separate Worker — `hardware-pos`, at
**app.innovaearth.com** — configured by `wrangler.toml` at the repo root. This
page links to it for store sign-in rather than hosting a login of its own.

Keeping them apart means a marketing-copy change can never take the till down,
and the two can differ where they should: this page sets
`not_found_handling = "none"` so a mistyped URL 404s properly, while the app
sets `single-page-application` so its client-side routes work.
