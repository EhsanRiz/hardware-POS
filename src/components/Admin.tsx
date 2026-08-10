import { useState } from "react";
import type { User } from "../lib/types";
import { can } from "../lib/permissions";
import BrandMark from "./BrandMark";
import ManageMenu from "./ManageMenu";
import CategoriesManager from "./CategoriesManager";
import InventoryManager from "./InventoryManager";
import AccountManager from "./AccountManager";
import StaffManager from "./StaffManager";
import SalesReport from "./SalesReport";
import EndOfDay from "./EndOfDay";
import PrinterSettings from "./PrinterSettings";

type Section =
  | "menu"
  | "categories"
  | "inventory"
  | "accounts"
  | "staff"
  | "reports"
  | "eod"
  | "printer";

interface Props {
  managerPin: string;
  actor: User;
  onClose: () => void;
  onProductsChanged: () => void;
}

export default function Admin({
  managerPin,
  actor,
  onClose,
  onProductsChanged,
}: Props) {
  const items: { key: Section; label: string; icon: string }[] = [
    ...(can(actor, "manage_menu")
      ? [
          { key: "menu" as Section, label: "Menu", icon: "☕" },
          { key: "categories" as Section, label: "Categories", icon: "🏷️" },
        ]
      : []),
    ...(can(actor, "manage_inventory")
      ? [{ key: "inventory" as Section, label: "Inventory", icon: "📦" }]
      : []),
    ...(can(actor, "manage_accounts")
      ? [{ key: "accounts" as Section, label: "Accounts", icon: "🧾" }]
      : []),
    ...(can(actor, "manage_staff")
      ? [{ key: "staff" as Section, label: "Staff", icon: "👥" }]
      : []),
    ...(can(actor, "view_reports")
      ? [{ key: "reports" as Section, label: "Reports", icon: "📊" }]
      : []),
    // End of Day is available to everyone so any staff member can print theirs.
    { key: "eod" as Section, label: "End of Day", icon: "🌙" },
    { key: "printer" as Section, label: "Printer", icon: "🖨️" },
  ];

  const [section, setSection] = useState<Section>(items[0]?.key ?? "menu");
  const current = items.find((i) => i.key === section);

  return (
    <div className="fixed inset-0 bg-stone-50 z-40 flex animate-fade-in">
      {/* Left sidebar */}
      <aside className="w-56 shrink-0 bg-white border-r border-stone-200 flex flex-col">
        <div className="h-16 flex items-center px-4 border-b border-stone-100">
          <BrandMark className="h-7" />
        </div>
        <p className="px-4 pt-4 pb-2 text-xs font-semibold text-taupe-light uppercase tracking-wider">
          Manage
        </p>
        <nav className="flex-1 px-2 space-y-1">
          {items.map((it) => (
            <button
              key={it.key}
              onClick={() => setSection(it.key)}
              className={`w-full flex items-center gap-3 px-3 h-11 rounded-lg font-medium transition-colors ${
                section === it.key
                  ? "bg-brand text-white"
                  : "text-stone-600 hover:bg-stone-100"
              }`}
            >
              <span className="text-lg">{it.icon}</span>
              {it.label}
            </button>
          ))}
        </nav>
        <div className="p-3 border-t border-stone-100">
          <p className="px-2 pb-2 text-xs text-taupe-light truncate">
            {actor.name} · <span className="capitalize">{actor.role}</span>
          </p>
          <button
            onClick={onClose}
            className="w-full h-11 rounded-lg bg-stone-100 text-stone-700 font-medium active:bg-stone-200"
          >
            ← Back to till
          </button>
        </div>
      </aside>

      {/* Content */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-16 shrink-0 bg-white border-b border-stone-200 flex items-center px-6">
          <h1 className="text-lg font-bold text-stone-800">{current?.label}</h1>
        </header>
        <div className="flex-1 overflow-y-auto">
          {section === "menu" && can(actor, "manage_menu") && (
            <ManageMenu managerPin={managerPin} onChanged={onProductsChanged} />
          )}
          {section === "categories" && can(actor, "manage_menu") && (
            <CategoriesManager
              managerPin={managerPin}
              onChanged={onProductsChanged}
            />
          )}
          {section === "inventory" && can(actor, "manage_inventory") && (
            <InventoryManager
              managerPin={managerPin}
              onChanged={onProductsChanged}
            />
          )}
          {section === "accounts" && can(actor, "manage_accounts") && (
            <AccountManager managerPin={managerPin} />
          )}
          {section === "staff" && can(actor, "manage_staff") && (
            <StaffManager managerPin={managerPin} actor={actor} />
          )}
          {section === "reports" && can(actor, "view_reports") && (
            <SalesReport managerPin={managerPin} actor={actor} />
          )}
          {section === "eod" && (
            <EndOfDay managerPin={managerPin} actor={actor} />
          )}
          {section === "printer" && <PrinterSettings />}
        </div>
      </div>
    </div>
  );
}
