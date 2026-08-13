import { useCallback, useEffect, useMemo, useState } from "react";
import {
  adminDeleteUser,
  adminInviteUser,
  adminListUsers,
  adminUpdateUser,
  type StaffUser,
} from "../../lib/adminApi";
import { errorMessage } from "../../lib/errors";
import {
  ADMIN_LEVEL_PERMS,
  PERMISSIONS,
  ROLE_DEFAULTS,
  type PermKey,
  type RoleKey,
} from "../../lib/permissions";
import type { User } from "../../lib/types";

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
export default function StaffAdmin({ user, pin }: { user: User | null; pin: string }) {
  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<StaffUser | "new" | null>(null);

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
                    <span className="block text-sm text-stone-500">{s.phone}</span>
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
      </div>

      {editing && (
        <StaffEditor
          pin={pin}
          isAdmin={isAdmin}
          self={editing !== "new" && editing.id === user?.id}
          staff={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
          onRemove={remove}
        />
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
  onSaved: () => Promise<void>;
  onRemove: (u: StaffUser) => Promise<void>;
}) {
  const [name, setName] = useState(staff?.name ?? "");
  const [phone, setPhone] = useState(staff?.phone ?? "");
  const [role, setRole] = useState<RoleKey>((staff?.role as RoleKey) ?? "employee");
  const [grants, setGrants] = useState<PermKey[]>((staff?.permissions ?? []) as PermKey[]);
  const [active, setActive] = useState(staff?.active ?? true);
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
        await adminUpdateUser(pin, staff.id, { name, role, permissions: extras, active });
      } else {
        await adminInviteUser(pin, name, phone, role, extras);
      }
      await onSaved();
    } catch (e) {
      setError(errorMessage(e, "Could not save"));
    } finally {
      setBusy(false);
    }
  }

  const groups = Array.from(new Set(PERMISSIONS.map((p) => p.group)));

  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6">
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
