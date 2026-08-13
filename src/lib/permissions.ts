// The permission catalogue. Keys must match `public.permissions` in the
// database, which is where they are actually enforced — this list only drives
// what the UI offers and hides.
export const PERMISSIONS = [
  { key: "take_payments", label: "Take payments & issue invoices", group: "Sales" },
  { key: "apply_discount", label: "Apply discounts", group: "Sales" },
  { key: "approve_discount", label: "Approve discounts", group: "Sales" },
  { key: "void_refund", label: "Void & refund sales", group: "Sales" },
  { key: "manage_catalogue", label: "Manage products & prices", group: "Management" },
  { key: "manage_inventory", label: "Adjust stock & receive goods", group: "Management" },
  { key: "manage_purchasing", label: "Manage suppliers & purchase orders", group: "Management" },
  { key: "manage_customers", label: "Manage customer accounts", group: "Management" },
  { key: "manage_quotes", label: "Create & convert quotes", group: "Management" },
  { key: "view_reports", label: "View reports", group: "Management" },
  // Deliberately separate from manage_catalogue: a counter supervisor can fix a
  // price or a barcode without being shown the shop's margins.
  { key: "view_cost_prices", label: "See cost prices & margins", group: "Management" },
  { key: "cash_management", label: "Cash-up & reconciliation", group: "Management" },
  { key: "manage_staff", label: "Manage staff", group: "Admin" },
  { key: "manage_settings", label: "Manage settings & tills", group: "Admin" },
] as const;

export type PermKey = (typeof PERMISSIONS)[number]["key"];
export type RoleKey = "admin" | "manager" | "employee";

/**
 * What a role is called on screen.
 *
 * Not the database word. "admin" and "employee" are how the schema thinks; a
 * shop floor says Owner and Counter, and the person reading it is a cashier
 * mid-shift, not a developer. Shared so the sign-in roster and the till header
 * cannot drift into calling the same person two different things.
 */
export const ROLE_TITLE: Record<RoleKey, string> = {
  admin: "Owner",
  manager: "Manager",
  employee: "Counter",
};

/** The title for a role, tolerating a value the client has not heard of. */
export function roleTitle(role: string | null | undefined): string {
  return ROLE_TITLE[(role ?? "") as RoleKey] ?? "Counter";
}

export const ALL_PERMS: PermKey[] = PERMISSIONS.map((p) => p.key);

// Mirrors role_default_permissions() in migration 0001. The server is the
// authority; this exists so the UI can show the right boxes before a save.
export const ROLE_DEFAULTS: Record<RoleKey, PermKey[]> = {
  admin: ALL_PERMS,
  manager: [
    "take_payments",
    "apply_discount",
    "approve_discount",
    "void_refund",
    "manage_catalogue",
    "manage_inventory",
    "manage_purchasing",
    "manage_customers",
    "manage_quotes",
    "view_reports",
    "view_cost_prices",
    "cash_management",
  ],
  employee: ["take_payments", "apply_discount"],
};

// Permissions that only an admin may grant.
export const ADMIN_LEVEL_PERMS: PermKey[] = ["manage_staff", "manage_settings"];

// Having any of these opens the "Manage" area.
export const MANAGEMENT_PERMS: PermKey[] = [
  "manage_catalogue",
  "manage_inventory",
  "manage_purchasing",
  "manage_customers",
  "view_reports",
  "cash_management",
  "manage_staff",
  "manage_settings",
];

interface PermHolder {
  role: string;
  permissions?: string[] | null;
}

export function can(user: PermHolder | null, perm: PermKey): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  return (user.permissions ?? []).includes(perm);
}

export function canAny(user: PermHolder | null, perms: PermKey[]): boolean {
  return perms.some((p) => can(user, p));
}
