import { useEffect, useState } from "react";
import { managerListUsers, managerUpsertUser, type StaffMember } from "../lib/api";
import type { User } from "../lib/types";
import { formatPhone } from "../lib/format";
import {
  PERMISSIONS,
  ROLE_DEFAULTS,
  ADMIN_LEVEL_PERMS,
  ALL_PERMS,
  type PermKey,
  type RoleKey,
} from "../lib/permissions";

function StaffForm({
  initial,
  actor,
  managerPin,
  onSaved,
  onCancel,
}: {
  initial: StaffMember | null;
  actor: User;
  managerPin: string;
  onSaved: (s: StaffMember) => void;
  onCancel: () => void;
}) {
  const actorIsAdmin = actor.role === "admin";
  const [name, setName] = useState(initial?.name ?? "");
  const [role, setRole] = useState<RoleKey>((initial?.role as RoleKey) ?? "employee");
  const [pin, setPin] = useState("");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [active, setActive] = useState(initial?.active ?? true);
  const [perms, setPerms] = useState<PermKey[]>(
    (initial?.permissions as PermKey[]) ?? ROLE_DEFAULTS["employee"]
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const roles: RoleKey[] = actorIsAdmin
    ? ["employee", "manager", "admin"]
    : ["employee", "manager"];

  const changeRole = (r: RoleKey) => {
    setRole(r);
    setPerms(ROLE_DEFAULTS[r]); // reset to that role's defaults, then editable
  };

  const togglePerm = (key: PermKey) => {
    setPerms((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  };

  const isAdminRole = role === "admin";

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await managerUpsertUser(managerPin, {
        id: initial?.id ?? null,
        name: name.trim(),
        role,
        pin: pin.trim() === "" ? null : pin.trim(),
        active,
        phone: phone.trim() === "" ? null : phone.trim(),
        email: email.trim() === "" ? null : email.trim(),
        permissions: isAdminRole ? ALL_PERMS : perms,
      });
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50 animate-fade-in">
      <div className="bg-white rounded-2xl p-6 w-full max-w-md animate-scale-in max-h-[90vh] overflow-y-auto">
        <h2 className="text-xl font-bold text-stone-800 mb-4">
          {initial ? "Edit staff" : "New staff"}
        </h2>

        <label className="block text-sm font-medium text-stone-600 mb-1">Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          className="w-full h-12 px-3 rounded-lg border border-stone-300 mb-4 focus:border-brand outline-none"
          placeholder="e.g. Thabo"
        />

        <div className="grid grid-cols-2 gap-3 mb-4">
          <div>
            <label className="block text-sm font-medium text-stone-600 mb-1">Phone</label>
            <input
              type="tel"
              inputMode="numeric"
              value={phone}
              onChange={(e) => setPhone(formatPhone(e.target.value))}
              className="w-full h-12 px-3 rounded-lg border border-stone-300 focus:border-brand outline-none"
              placeholder="5012 3456"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-stone-600 mb-1">
              Email <span className="text-taupe-light">(optional)</span>
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full h-12 px-3 rounded-lg border border-stone-300 focus:border-brand outline-none"
              placeholder="name@email.com"
            />
          </div>
        </div>

        <label className="block text-sm font-medium text-stone-600 mb-1">Role</label>
        <div className="flex gap-2 mb-4">
          {roles.map((r) => (
            <button
              key={r}
              onClick={() => changeRole(r)}
              className={`flex-1 h-11 rounded-lg font-medium capitalize ${
                role === r ? "bg-brand text-white" : "bg-stone-100 text-stone-600"
              }`}
            >
              {r}
            </button>
          ))}
        </div>

        {/* Permissions */}
        <label className="block text-sm font-medium text-stone-600 mb-2">
          Permissions{" "}
          {isAdminRole && (
            <span className="text-taupe-light">(admins have all)</span>
          )}
        </label>
        <div className="space-y-1.5 mb-4">
          {PERMISSIONS.map((p) => {
            const adminLevel = ADMIN_LEVEL_PERMS.includes(p.key);
            const disabled = isAdminRole || (adminLevel && !actorIsAdmin);
            const checked = isAdminRole || perms.includes(p.key);
            return (
              <label
                key={p.key}
                className={`flex items-center gap-2.5 p-2 rounded-lg ${
                  disabled ? "opacity-60" : "active:bg-stone-50"
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => togglePerm(p.key)}
                  className="w-5 h-5 accent-brand"
                />
                <span className="text-stone-700 text-sm">{p.label}</span>
              </label>
            );
          })}
        </div>

        <label className="block text-sm font-medium text-stone-600 mb-1">
          PIN{" "}
          <span className="text-taupe-light">
            {initial ? "(leave blank to keep)" : "(4+ digits)"}
          </span>
        </label>
        <input
          type="tel"
          inputMode="numeric"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
          maxLength={6}
          className="w-full h-12 px-3 rounded-lg border border-stone-300 mb-4 tracking-widest focus:border-brand outline-none"
          placeholder="••••"
        />

        <label className="flex items-center gap-2 mb-4 select-none">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="w-5 h-5 accent-brand"
          />
          <span className="text-stone-700">Active (can sign in)</span>
        </label>

        {error && <p className="text-red-600 text-sm mb-3 animate-fade-in">{error}</p>}

        <div className="flex gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="flex-1 h-12 rounded-lg bg-stone-100 text-stone-600 font-medium active:bg-stone-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={busy || name.trim() === ""}
            className="flex-1 h-12 rounded-lg bg-brand text-white font-semibold active:bg-brand-dark disabled:opacity-40"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function StaffManager({
  managerPin,
  actor,
}: {
  managerPin: string;
  actor: User;
}) {
  const [users, setUsers] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<StaffMember | null>(null);
  const [creating, setCreating] = useState(false);

  const load = () => {
    managerListUsers(managerPin)
      .then(setUsers)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  };
  useEffect(load, [managerPin]);

  const apply = (saved: StaffMember) => {
    setUsers((prev) => {
      const exists = prev.some((u) => u.id === saved.id);
      return exists
        ? prev.map((u) => (u.id === saved.id ? { ...u, ...saved } : u))
        : [...prev, saved];
    });
    setCreating(false);
    setEditing(null);
  };

  return (
    <div className="p-4">
      <div className="max-w-3xl mx-auto">
        <div className="flex justify-between items-center mb-3">
          <p className="text-taupe text-sm">{users.length} staff</p>
          <button
            onClick={() => setCreating(true)}
            className="h-10 px-4 rounded-lg bg-brand text-white font-semibold shadow-sm active:!scale-95"
          >
            + Add staff
          </button>
        </div>

        {loading && <p className="text-stone-400">Loading…</p>}
        {error && <p className="text-red-600">{error}</p>}

        <div className="space-y-2">
          {users.map((u) => (
            <div
              key={u.id}
              className={`flex items-center gap-3 p-3 rounded-xl bg-white border border-stone-200 animate-fade-in ${
                u.active ? "" : "opacity-60"
              }`}
            >
              <div className="w-10 h-10 rounded-full bg-brand-light text-brand-dark font-bold flex items-center justify-center">
                {u.name.charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-stone-800 truncate">{u.name}</p>
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={`text-xs font-medium px-2 py-0.5 rounded-full capitalize ${
                      u.role === "admin"
                        ? "bg-brand text-white"
                        : u.role === "manager"
                        ? "bg-accent/20 text-accent-dark"
                        : "bg-stone-100 text-stone-500"
                    }`}
                  >
                    {u.role}
                  </span>
                  {u.phone && <span className="text-xs text-taupe">{u.phone}</span>}
                  {!u.active && (
                    <span className="text-xs text-stone-400">inactive</span>
                  )}
                </div>
              </div>
              <button
                onClick={() => setEditing(u)}
                className="text-sm font-medium text-info px-3 py-1.5 rounded active:bg-stone-100"
              >
                Edit
              </button>
            </div>
          ))}
        </div>
      </div>

      {(creating || editing) && (
        <StaffForm
          initial={editing}
          actor={actor}
          managerPin={managerPin}
          onSaved={apply}
          onCancel={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}
