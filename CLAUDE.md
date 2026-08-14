# CLAUDE.md — working agreements

How to work in this repository. `README.md` says what the thing is and how to run
it; this says what is expected of a change. `design_handoff_innovapos/CLAUDE.md`
covers the design system and applies inside that folder.

## Every behaviour change ships with an end-to-end test

Not "where it seemed worth it" — every change a person could notice at the
counter or in the back office. `e2e/till.spec.ts` drives the built app in a
browser against the hand-written fake in `e2e/fake-backend.ts`, so the test
exercises the same path a cashier does: the click, the render, the request, the
printed slip.

A change to an RPC gets a database test too (`supabase/test/schema.test.sql`),
because the browser suite runs against a *model* of the server, and a model
agrees with the real thing right up until it doesn't. Neither suite replaces the
other.

The only changes that ship without one are those with no behaviour to observe:
documentation, comments, deploy configuration.

**Extend the fake backend when it lies.** It has hardcoded fields to `null` more
than once — `discount_reason` on both a sale and a history row, `amount_tendered`
and `change_due` — and each time it meant a real gap sat covered by a green test.
If the fake cannot represent what you are building, fixing the fake is part of
building it.

## Break every guard before you trust the test

A test that passes has proved nothing until it has been seen to fail. Before
shipping, deliberately break each thing the new tests are meant to protect, run
them, and confirm the right ones go red. Then restore and re-run.

Two ways this discipline has been quietly defeated here, both worth knowing:

- **A broken build is not a failing test.** If the neutered code does not
  compile, the suite fails for the wrong reason and proves nothing. Run the e2e
  suite with `CI=1` so it rebuilds, watch for `webServer` errors, and prefer
  breakages that still typecheck (`x` → `null`, not deleting a variable that is
  still referenced).
- **A test can pass for a reason you did not intend.** One assertion here held
  even with the line it was testing removed, because a different effect happened
  to clear the same state. If breaking the guard does not turn the test red, the
  test is not testing the guard.

Say in the commit or PR which guards were broken and that they failed. If a
non-vacuity check turns out to have proved nothing, say that too — a green run
over unbuilt code reads as coverage and is not.

## Migrations

- One numbered file per change in `supabase/migrations/`, applied in order by
  `npm run test:db`.
- **Adding a defaulted argument creates a NEW function signature.** `create or
  replace` leaves the old one standing beside it, and every existing caller that
  names no optional arguments becomes ambiguous and fails outright. Always `drop
  function if exists` with the old argument list first. This has bitten twice.
- Changing a function's return columns needs the same drop-and-recreate.
- After applying anything to production by hand, verify rather than assume:
  compare normalised function-body hashes between a fresh build from the
  migrations and the live database, and check each function has exactly one
  signature. `supabase/test/fingerprint.sql` does the broad version.

## Reporting

State what was verified and what was not. If a suite was not run, say so; if a
step was skipped, say which. Do not describe CI passing as a deploy, or a code
review as a test run.
