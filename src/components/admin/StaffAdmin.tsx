import { useCallback, useEffect, useMemo, useState } from "react";
import {
  adminDeleteUser,
  adminInviteUser,
  adminListUsers,
  adminUpdateUser,
  type StaffUser,
} from "../../lib/adminApi";
import { CURRENCY, ENROL_URL } from "../../lib/config";
import { errorMessage } from "../../lib/errors";
import {
  ADMIN_LEVEL_PERMS,
  PERMISSIONS,
  ROLE_DEFAULTS,
  type PermKey,
  type RoleKey,
} from "../../lib/permissions";
import type { AdminProduct, User } from "../../lib/types";

const ROLES: { key: RoleKey; label: string; blurb: string }[] = [
  { key: "employee", label: "Counter", blurb: "Sells and takes payment." },
  { key: "manager", label: "Manager", blurb: "Runs the shop floor: stock, prices, accounts, cash-up." },
  { key: "admin", label: "Owner", blurb: "Everything, including staff and shop settings." },
];

/**
 * Who works here, and what each of them may do.
 *
 * Nobody's PIN is set — or seen — from this screen. A new colleague is invited
 * by phone number and chooses their own PIN after an OTP, so a manager can add
 * staff without ever holding a credential that would let them ring up a sale as
 * somebody else.
 *
 * Permissions layer on top of the role rather than replacing it: the role
 * grants a standard set, and the boxes below add to it. The ones the role
 * already covers are shown ticked and fixed, because pretending they could be
 * unticked would be a lie — the server unions the two.
 */
export default function StaffAdmin({
  user,
  pin,
  products,
}: {
  user: User | null;
  pin: string;
  /** The catalogue the Manage area has already loaded — see CappedItems. */
  products: AdminProduct[];
}) {
  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<StaffUser | "new" | null>(null);
  // Who has just been invited, so the screen can say what happens next while
  // the manager is still standing there.
  const [invited, setInvited] = useState<StaffUser | null>(null);

  const isAdmin = user?.role === "admin";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStaff(await adminListUsers(pin));
      setError(null);
    } catch (e) {
      setError(errorMessage(e, "Could not load the staff list"));
    } finally {
      setLoading(false);
    }
  }, [pin]);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(u: StaffUser) {
    try {
      const outcome = await adminDeleteUser(pin, u.id);
      setEditing(null);
      await load();
      setNote(
        outcome === "disabled"
          ? `${u.name} has rung up sales, so they were signed out rather than deleted — their name is on invoices that still have to make sense.`
          : `${u.name} was removed.`
      );
    } catch (e) {
      setError(errorMessage(e, "Could not remove that person"));
    }
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-stone-200 bg-white">
        <h2 className="font-medium">Staff</h2>
        <span className="text-sm text-stone-500">
          {staff.filter((s) => s.active).length} active
        </span>
        <button
          className="ml-auto px-3 py-1.5 rounded-lg bg-stone-800 text-white text-sm"
          onClick={() => setEditing("new")}
        >
          Invite someone
        </button>
      </div>

      {note && (
        <div
          onClick={() => setNote(null)}
          className="px-4 py-2 bg-stone-100 text-stone-700 text-sm cursor-pointer"
        >
          {note}
        </div>
      )}
      {error && (
        <div
          onClick={() => setError(null)}
          className="px-4 py-2 bg-amber-100 text-amber-900 text-sm cursor-pointer"
        >
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto p-4">
        {loading ? (
          <p className="text-stone-500 text-sm">Loading…</p>
        ) : (
          <ul className="max-w-3xl divide-y divide-stone-200 bg-white rounded-xl border border-stone-200">
            {staff.map((s) => (
              <li key={s.id}>
                <button
                  className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-stone-50"
                  onClick={() => setEditing(s)}
                >
                  <span className="flex-1 min-w-0">
                    <span className={`block ${s.active ? "" : "text-stone-400 line-through"}`}>
                      {s.name}
                      {s.id === user?.id && (
                        <span className="ml-2 text-xs text-stone-500">(you)</span>
                      )}
                    </span>
                    <span className="block text-sm text-stone-500">
                      {s.phone}
                      {/* Said on the row, not only inside the editor: "who can
                          give what away" is the question an owner opens this
                          screen to answer, and opening five people one at a
                          time to answer it is the slow way. */}
                      {discountAllowance(s) && (
                        <span className="text-stone-400"> · {discountAllowance(s)}</span>
                      )}
                    </span>
                  </span>
                  <span className="text-sm text-stone-600">
                    {ROLES.find((r) => r.key === s.role)?.label ?? s.role}
                  </span>
                  <StatusChip status={s.status} active={s.active} />
                </button>
              </li>
            ))}
            {staff.length === 0 && (
              <li className="px-4 py-6 text-sm text-stone-500">Nobody yet.</li>
            )}
          </ul>
        )}
        {/* Not shown when the catalogue could not be read — "nothing is
            capped" and "we could not find out" are different statements, and
            only one of them is safe to make about a rule that binds the
            owner. An empty catalogue has nothing to cap either way. */}
        {!loading && products.length > 0 && <CappedItems products={products} />}
      </div>

      {editing && (
        <StaffEditor
          pin={pin}
          isAdmin={isAdmin}
          self={editing !== "new" && editing.id === user?.id}
          staff={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async (added) => {
            setEditing(null);
            if (added) setInvited(added);
            await load();
          }}
          onRemove={remove}
        />
      )}

      {invited && <WhatHappensNext staff={invited} onClose={() => setInvited(null)} />}
    </div>
  );
}

/**
 * What happens after an invite, said at the moment the manager expects it.
 *
 * Inviting somebody sends them nothing, on purpose: an unsolicited SMS with a
 * link is what a phishing message looks like, and the code that matters is the
 * one they ask for themselves. But nothing said so, so an invite looked like a
 * button that did nothing — the row appeared, no message arrived, and the
 * obvious conclusion was that it was broken.
 *
 * So the step the manager has to perform is named, with the address to pass on
 * and the number it must be typed against. They are standing next to the person
 * they just invited; this is the one moment telling them costs nothing.
 */
function WhatHappensNext({ staff, onClose }: { staff: StaffUser; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const message =
    `You have been added to the till at work. ` +
    `Go to ${ENROL_URL} and enter your number ${staff.phone} — ` +
    `you will get an SMS code, and then you choose your own PIN.`;

  return (
    <div className="vv-fixed bg-black/30 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6">
      <div className="bg-white w-full sm:max-w-lg sm:rounded-2xl p-5 space-y-4">
        <h3 className="font-semibold">{staff.name} is on the staff list</h3>

        <p className="text-sm text-stone-600">
          They cannot sign in yet. Nobody is sent a PIN — they choose their own,
          after proving the phone is theirs. Tell them to do this:
        </p>

        <ol className="text-sm text-stone-700 list-decimal pl-5 space-y-1">
          <li>
            Open <span className="font-medium break-all">{ENROL_URL}</span>
          </li>
          <li>
            Enter <span className="font-medium">{staff.phone}</span> — the number
            they were added with, or no code is sent
          </li>
          <li>Type the SMS code, then choose a PIN nobody else knows</li>
        </ol>

        {/* The counter is busy and the person is standing right there, so the
            message is ready to send rather than something to compose. */}
        <button
          className="w-full text-left text-sm bg-stone-50 border border-stone-200 rounded-lg p-3"
          onClick={() => {
            void navigator.clipboard?.writeText(message).then(
              () => setCopied(true),
              () => setCopied(false)
            );
          }}
        >
          <span className="block text-xs uppercase tracking-wide text-stone-400 mb-1">
            {copied ? "Copied — send it to them" : "Tap to copy a message for them"}
          </span>
          {message}
        </button>

        <div className="flex justify-end">
          <button className="px-4 py-2 rounded-lg bg-stone-800 text-white" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * How much this person may take off before a manager is needed, in a phrase.
 *
 * Empty for anybody a limit does not apply to — somebody who can approve
 * discounts is not held by one, and saying "up to 10%" next to a manager who
 * can wave through 100% would be worse than saying nothing.
 */
function discountAllowance(s: StaffUser): string | null {
  const byRole = new Set(ROLE_DEFAULTS[(s.role as RoleKey) ?? "employee"]);
  if (byRole.has("approve_discount") || s.permissions.includes("approve_discount")) {
    return "approves discounts";
  }
  const parts: string[] = [];
  if (s.discount_limit_percent != null) {
    parts.push(`${s.discount_limit_percent}% a line`);
  }
  if (s.discount_limit_amount != null) {
    parts.push(`${CURRENCY}${s.discount_limit_amount} a sale`);
  }
  if (!parts.length) return null;
  // "and", not "or": both are checked, and either one exceeded fetches a
  // manager. "or" read as though the cashier picked whichever suited them.
  return `may discount ${parts.join(" and ")}`;
}

/**
 * The lines the shop has put a floor under.
 *
 * These belong to the catalogue and are edited there, but they are read here
 * because this is the screen about who may give money away — and an item cap
 * is the one thing on that subject that binds everybody, the owner included.
 * Leaving it out would make this screen quietly wrong: it would look like the
 * limits above were the whole story.
 */
function CappedItems({ products }: { products: AdminProduct[] }) {
  const capped = useMemo(
    () =>
      products.filter(
        (p) =>
          p.active &&
          (p.max_discount_percent != null || p.max_discount_amount != null)
      ),
    [products]
  );

  return (
    <div className="max-w-3xl mt-6 bg-white rounded-xl border border-stone-200 p-4">
      <h3 className="font-medium">Items with a discount cap</h3>
      <p className="text-sm text-stone-500 mt-0.5">
        Nobody gets past these — not a manager, not the owner. Set them on the
        product in Catalogue.
      </p>
      {capped.length === 0 ? (
        <p className="text-sm text-stone-500 mt-3">
          Nothing is capped. Every line can be discounted as far as the person
          serving is allowed to go.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-stone-100">
          {capped.map((p) => (
            <li key={p.id} className="py-2 flex items-baseline gap-3 text-sm">
              <span className="flex-1 min-w-0 truncate">{p.name}</span>
              <span className="text-stone-600 tabular-nums">
                {[
                  p.max_discount_percent != null ? `${p.max_discount_percent}%` : null,
                  p.max_discount_amount != null
                    ? `${CURRENCY}${p.max_discount_amount} per ${p.unit_code}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" or ")}{" "}
                max
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatusChip({ status, active }: { status: StaffUser["status"]; active: boolean }) {
  // "Invited" is the one worth calling out: that person cannot sign in yet, and
  // the manager standing there wondering why is owed the reason.
  const label = !active ? "Signed out" : status === "invited" ? "PIN not set" : "Active";
  const tone = !active
    ? "bg-stone-100 text-stone-500"
    : status === "invited"
      ? "bg-amber-100 text-amber-800"
      : "bg-emerald-100 text-emerald-800";
  return <span className={`text-xs px-2 py-0.5 rounded-full ${tone}`}>{label}</span>;
}

function StaffEditor({
  pin,
  staff,
  isAdmin,
  self,
  onClose,
  onSaved,
  onRemove,
}: {
  pin: string;
  staff: StaffUser | null;
  isAdmin: boolean;
  self: boolean;
  onClose: () => void;
  /** Called with the new row after an invite, and with null after an edit. */
  onSaved: (invited: StaffUser | null) => Promise<void>;
  onRemove: (u: StaffUser) => Promise<void>;
}) {
  const [name, setName] = useState(staff?.name ?? "");
  const [phone, setPhone] = useState(staff?.phone ?? "");
  const [role, setRole] = useState<RoleKey>((staff?.role as RoleKey) ?? "employee");
  const [grants, setGrants] = useState<PermKey[]>((staff?.permissions ?? []) as PermKey[]);
  const [active, setActive] = useState(staff?.active ?? true);
  // Kept as typed text rather than numbers: an empty box has to be tellable
  // from a zero, and "" is the only thing that says "no limit" cleanly.
  const [limitPct, setLimitPct] = useState(
    staff?.discount_limit_percent != null ? String(staff.discount_limit_percent) : ""
  );
  const [limitAmt, setLimitAmt] = useState(
    staff?.discount_limit_amount != null ? String(staff.discount_limit_amount) : ""
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const fromRole = useMemo(() => new Set(ROLE_DEFAULTS[role]), [role]);

  function toggle(k: PermKey) {
    setGrants((g) => (g.includes(k) ? g.filter((x) => x !== k) : [...g, k]));
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      // Only the extras are sent. Anything the role already carries would be
      // stored twice and, worse, would stay behind if the role later changed.
      const extras = grants.filter((g) => !fromRole.has(g));
      if (staff) {
        await adminUpdateUser(pin, staff.id, {
          name,
          role,
          permissions: extras,
          active,
          // Zero is how the server is told to clear one, so an emptied box
          // sends 0 rather than null — null means "not editing this".
          discount_limit_percent: limitPct.trim() === "" ? 0 : Number(limitPct),
          discount_limit_amount: limitAmt.trim() === "" ? 0 : Number(limitAmt),
        });
        await onSaved(null);
      } else {
        const added = await adminInviteUser(pin, name, phone, role, extras);
        await onSaved(added);
      }
    } catch (e) {
      setError(errorMessage(e, "Could not save"));
    } finally {
      setBusy(false);
    }
  }

  const groups = Array.from(new Set(PERMISSIONS.map((p) => p.group)));

  return (
    <div className="vv-fixed bg-black/30 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6">
      <div className="bg-white w-full sm:max-w-2xl sm:rounded-2xl max-h-[92vh] overflow-auto">
        <header className="px-5 py-4 border-b border-stone-200 flex items-center gap-3">
          <h3 className="font-semibold">{staff ? staff.name : "Invite someone"}</h3>
          <button className="ml-auto text-stone-500" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="p-5 space-y-5">
          {error && (
            <p className="px-3 py-2 bg-amber-100 text-amber-900 text-sm rounded-lg">{error}</p>
          )}

          <label className="block">
            <span className="text-sm text-stone-600">Name</span>
            <input
              className="mt-1 w-full border border-stone-300 rounded-lg px-3 py-2"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Staff name"
            />
          </label>

          {!staff && (
            <label className="block">
              <span className="text-sm text-stone-600">Mobile number</span>
              <input
                className="mt-1 w-full border border-stone-300 rounded-lg px-3 py-2"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="082 123 4567"
                inputMode="tel"
                aria-label="Staff mobile number"
              />
              {/* The number is the invitation: it is how they prove who they
                  are and how they come to set a PIN nobody else knows. */}
              <span className="text-xs text-stone-500">
                They set their own PIN on this number. It cannot be changed here later.
              </span>
            </label>
          )}

          <fieldset>
            <legend className="text-sm text-stone-600 mb-1">Role</legend>
            <div className="space-y-1">
              {ROLES.map((r) => {
                const locked = r.key === "admin" && !isAdmin;
                return (
                  <label
                    key={r.key}
                    className={`flex gap-2 items-start p-2 rounded-lg ${
                      locked ? "opacity-40" : "hover:bg-stone-50"
                    }`}
                  >
                    <input
                      type="radio"
                      className="mt-1"
                      checked={role === r.key}
                      disabled={locked || self}
                      onChange={() => setRole(r.key)}
                    />
                    <span>
                      <span className="block text-sm">{r.label}</span>
                      <span className="block text-xs text-stone-500">{r.blurb}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            {self && (
              <p className="text-xs text-stone-500 mt-1">
                You cannot change your own role or sign yourself out.
              </p>
            )}
          </fieldset>

          <fieldset>
            <legend className="text-sm text-stone-600 mb-1">Also allowed to</legend>
            {groups.map((g) => (
              <div key={g} className="mb-3">
                <p className="text-xs uppercase tracking-wide text-stone-400 mb-1">{g}</p>
                <div className="grid sm:grid-cols-2 gap-1">
                  {PERMISSIONS.filter((p) => p.group === g).map((p) => {
                    const byRole = fromRole.has(p.key);
                    const locked =
                      byRole || (ADMIN_LEVEL_PERMS.includes(p.key) && !isAdmin);
                    return (
                      <label
                        key={p.key}
                        className={`flex gap-2 items-center text-sm p-1.5 rounded ${
                          locked ? "text-stone-400" : "hover:bg-stone-50"
                        }`}
                        title={byRole ? "Comes with the role" : undefined}
                      >
                        <input
                          type="checkbox"
                          checked={byRole || grants.includes(p.key)}
                          disabled={locked}
                          onChange={() => toggle(p.key)}
                        />
                        {p.label}
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </fieldset>

          <fieldset>
            <legend className="text-sm text-stone-600 mb-1">
              May discount without asking
            </legend>
            {/* The limit is not a ban. Past it the sale still happens — it
                waits for a manager's PIN, exactly as every discount does
                today. Setting one only buys this person the room to close a
                small sale without leaving the counter. */}
            <p className="text-xs text-stone-500 mb-2">
              Up to this much comes off on {name.trim() || "their"} own authority.
              Anything more still goes to a manager for approval. Leave both
              empty and every discount needs approving.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                {/* A rate, not a sum of money — it holds on every line, so 5%
                    means no single item goes out at more than 5% off however
                    big the rest of the basket is. Measuring it against the
                    sale total instead let 10% off one line pass as long as
                    the sale was large enough. */}
                <span className="text-xs text-stone-500">Percent off any one line</span>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    className="w-full border border-stone-300 rounded-lg px-3 py-2"
                    value={limitPct}
                    onChange={(e) => setLimitPct(e.target.value)}
                    inputMode="decimal"
                    placeholder="—"
                    aria-label="Discount limit percent"
                  />
                  <span className="text-stone-500">%</span>
                </div>
              </label>
              <label className="block">
                <span className="text-xs text-stone-500">And, per sale, at most</span>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-stone-500">{CURRENCY}</span>
                  <input
                    className="w-full border border-stone-300 rounded-lg px-3 py-2"
                    value={limitAmt}
                    onChange={(e) => setLimitAmt(e.target.value)}
                    inputMode="decimal"
                    placeholder="—"
                    aria-label="Discount limit amount"
                  />
                </div>
              </label>
            </div>
            {limitPct.trim() !== "" && limitAmt.trim() !== "" && (
              <p className="text-xs text-stone-500 mt-2">
                Both are checked. Whichever is exceeded first sends the sale for
                approval — {limitPct}% off any single line, or {CURRENCY}
                {limitAmt} across the whole sale.
              </p>
            )}
            {/* Somebody who can approve discounts cannot be limited by one:
                they would simply approve themselves. Saying so here is
                cheaper than letting an owner set a figure that does nothing
                and wonder later why it never bit. */}
            {(fromRole.has("approve_discount") || grants.includes("approve_discount")) && (
              <p className="text-xs text-amber-700 mt-2">
                {name.trim() || "This person"} can approve discounts, so no limit
                binds them — they would be approving themselves. To hold a line
                against everybody, cap the item in Catalogue instead.
              </p>
            )}
            {!fromRole.has("apply_discount") && !grants.includes("apply_discount") && (
              <p className="text-xs text-amber-700 mt-2">
                Tick “Apply discounts” above, or this limit has nothing to apply to.
              </p>
            )}
          </fieldset>

          {staff && !self && (
            <label className="flex gap-2 items-center text-sm">
              <input
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
              />
              May sign in
            </label>
          )}
        </div>

        <footer className="px-5 py-4 border-t border-stone-200 flex gap-2">
          {staff && !self && (
            <button
              className="px-3 py-2 text-sm text-red-700"
              onClick={() => (confirmRemove ? void onRemove(staff) : setConfirmRemove(true))}
            >
              {confirmRemove ? "Tap again to remove" : "Remove"}
            </button>
          )}
          <button className="ml-auto px-4 py-2 text-stone-600" onClick={onClose}>
            Cancel
          </button>
          <button
            className="px-4 py-2 rounded-lg bg-stone-800 text-white disabled:opacity-40"
            disabled={busy || !name.trim() || (!staff && !phone.trim())}
            onClick={save}
          >
            {busy ? "Saving…" : staff ? "Save" : "Send invite"}
          </button>
        </footer>
      </div>
    </div>
  );
}
