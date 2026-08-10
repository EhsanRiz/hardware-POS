# Getting started with Claude Code

Step-by-step, from this zip to working code. Assumes you have a GitHub account and
Node.js installed.

## 1. Put this on GitHub

Unzip the folder, open a terminal inside it, then:

```bash
git init
git add .
git commit -m "Design handoff: InnovaPOS brand and till screen"
```

Create an empty repository on github.com — call it `innovapos`, do **not** add a README
or .gitignore (you already have one) — then connect and push:

```bash
git remote add origin https://github.com/YOUR-USERNAME/innovapos.git
git branch -M main
git push -u origin main
```

If you would rather not use the terminal, GitHub Desktop (desktop.github.com) does the
same thing with a UI: "Add local repository", point it at this folder, then "Publish
repository".

## 2. Install Claude Code

```bash
npm install -g @anthropic-ai/claude-code
```

Then, from inside the project folder:

```bash
claude
```

It will walk you through signing in the first time.

## 3. Move CLAUDE.md to the repository root

`CLAUDE.md` is a file Claude Code reads automatically at the start of every session, so
it needs to sit at the top level of the repo rather than inside this handoff folder:

```bash
mv design_handoff_innovapos/CLAUDE.md ./CLAUDE.md
git add -A && git commit -m "Add CLAUDE.md" && git push
```

Everything in it — the offline-first requirement, the contrast floors, the scope
discipline — then applies to every conversation without you repeating it.

## 4. First session: decide the stack

Do not start with UI. Start by deciding what you are building in. Paste this:

> Read CLAUDE.md and design_handoff_innovapos/README.md in full.
>
> I'm starting this project from scratch. Before writing any code, recommend a stack for a
> point-of-sale application that must run offline on a desktop till and a tablet, keep a
> local database, and sync to a server when the connection returns. Give me two options
> with the trade-offs, and tell me which you'd pick and why. Don't write code yet.

Read both options. Pick one. Then:

> Set up the project with <your choice>. Scaffold it, get it running, and commit.
> No UI yet.

## 5. Second session: tokens and the number formatter

> Implement the design tokens from the README's "Design tokens" section using this
> project's theming approach. Include the type scale, the contrast floors, and a South
> African currency formatter that produces "R 3 019.82" with thin spaces. Write tests for
> the formatter.

Get this right before any UI exists. Every screen depends on it.

## 6. Third session: the till screen

> Build the Sell screen from section 1 of design_handoff_innovapos/README.md. Static
> first, with the four reference line items from the table. Match the values exactly —
> the 1360px minimum frame width, the grid tracks, the double gold rule above the total.
> No behavior yet.

Then, one at a time, in this order:

> Now add scanning: the scan field appends a line, the new row tints, totals recompute,
> focus returns to the field.

> Now add the cut-to-length and weighed line types, including the metadata each records.

> Now add cash tender: keypad, quick-cash keys, live change due, and Tender & print.

> Now add the offline queue and the sync chip in the header.

## 7. How to work with it well

- **One thing per request.** "Build the till" gets you a mess. "Add the keypad" gets you a
  keypad.
- **Point at the README rather than re-describing.** "Section 1.3 of the README" is more
  reliable than paraphrasing the spec from memory.
- **Commit after every working step.** `git commit` often, so you can always get back to
  the last thing that worked.
- **Push back on scope.** If it starts adding quotes or stock takes to the sell screen,
  say so — CLAUDE.md tells it not to, but reminding it is cheap.
- **Ask it to explain before it changes.** "What would you change and why?" before
  "change it" saves a lot of rework.
- **It cannot see.** It has no eyes on the running app. Screenshot and paste when
  something looks wrong.

## 8. What is still missing

Things neither this package nor Claude Code can supply:

- Real product photography and store photography.
- Production vector art for the marks — the SVGs here are sketches.
- A CIPC name check and a trade-mark search on "InnovaPOS".
- Card-terminal integration decisions (Yoco, Ikhokha, a bank terminal) — a commercial
  choice before it is a technical one.
- The actual product catalogue with both price bands.
