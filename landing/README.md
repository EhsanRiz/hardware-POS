# InnovaEarth POS — landing page

The public page for **pos.innovaearth.com**. Plain static HTML/CSS/JS, no build
step, no backend. It borrows the palette and type from innovaearth.com so the
two read as one company.

## Deploying

Cloudflare, same account as the `innovaearth.com` zone:

```bash
npx wrangler deploy      # from this directory
```

Then add **pos.innovaearth.com** as a custom domain. Because the zone is already
in the account, DNS resolves without being configured by hand.

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
