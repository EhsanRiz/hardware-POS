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

### One decision still open

The till app also needs a home. Two options, and this config assumes neither:

- `pos.innovaearth.com` serves this page, and the app lives at
  `app.innovaearth.com`. Cleanest split, two Workers, no path routing.
- `pos.innovaearth.com` serves both, with the app under `/app`. One hostname
  for customers to remember, but the Worker then needs a route rule so `/app/*`
  reaches the till build instead of this one.

Note `not_found_handling = "none"` rather than `single-page-application`. With
one real page, an SPA fallback answers every mistyped URL with the homepage and
HTTP 200 — a soft 404. If the app is later served from the same Worker under a
path, that setting needs revisiting for the app's client-side routes.

It lives inside the `hardware-pos` repo for now purely so it has a home; it
shares no code with the till and can be lifted into its own repo unchanged.

## The search demo is real

`assets/demo.js` runs the same normalisation and matching rules as
`src/lib/search.ts` in the POS, and as `pos_search_products` in migrations
0010–0011. Visitors can verify the claim by typing into it. If those rules
change, change them here too — a demo that no longer reflects the product is
worse than none.

## Claims on this page

Everything stated is either shipped or explicitly labelled as not yet. Two
things to keep honest as the product moves:

- **Vertical status badges.** Hardware says *first site going live*; hospitality
  says *in production*. Update these as reality changes rather than leaving them
  aspirational.
- **Semantic search** is described as underway and not shipped. When it ships,
  move it up into the feature list.

There are no customer names, logos or testimonials on the page. Add them once
you have permission from the shops concerned — invented proof is the fastest way
to lose a first customer who checks.
