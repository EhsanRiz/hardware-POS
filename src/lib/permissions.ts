// The permission catalogue. Keys must match the server-side checks.
export const PERMISSIONS = [
  { key: "take_payments", label: "Take payments & issue receipts", group: "Sales" },
  { key: "apply_discount", label: "Apply discounts", group: "Sales" },
  { key: "approve_discount", label: "Approve discounts", group: "Sales" },
  { key: "void_refund", label: "Void & refund sales", group: "Sales" },
  { key: "manage_menu", label: "Manage menu & prices", group: "Management" },
  { key: "manage_inventory", label: "Manage inventory / stock", group: "Management" },
  { key: "manage_accounts", label: "Manage customer accounts", group: "Management" },
  { key: "view_reports", label: "View reports & receipts", group: "Management" },
  { key: "cash_management", label: "Cash-up & reconciliation", group: "Management" },
  { key: "manage_staff", label: "Manage staff", group: "Admin" },
  { key: "manage_settings", label: "Manage settings", group: "Admin" },
] as const;

export type PermKey = (typeof PERMISSIONS)[number]["key"];
export type RoleKey = "admin" | "manager" | "employee";

export const ALL_PERMS: PermKey[] = PERMISSIONS.map((p) => p.key);

export const ROLE_DEFAULTS: Record<RoleKey, PermKey[]> = {
  admin: ALL_PERMS,
  manager: [
    "take_payments",
    "apply_discount",
    "approve_discount",
    "void_refund",
    "manage_menu",
    "manage_inventory",
    "manage_accounts",
    "view_reports",
    "cash_management",
  ],
  employee: ["take_payments", "apply_discount"],
};

// Permissions that only an admin may grant.
export const ADMIN_LEVEL_PERMS: PermKey[] = ["manage_staff", "manage_settings"];

// Having any of these opens the "Manage" area.
export const MANAGEMENT_PERMS: PermKey[] = [
  "manage_menu",
  "manage_inventory",
  "manage_accounts",
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
