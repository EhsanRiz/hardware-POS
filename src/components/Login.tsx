import { useState } from "react";
import { signIn } from "../lib/auth";
import { useAuth } from "../context/AuthContext";
import { shopSettings } from "../lib/settings";
import PinPad from "./PinPad";
import BrandMark from "./BrandMark";
import ShopLogo from "./ShopLogo";
import InstallButton from "./InstallButton";

export default function Login() {
  const { setUser } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handle = async (pin: string) => {
    setBusy(true);
    setError(null);
    try {
      const user = await signIn(pin);
      if (!user) {
        setError("Incorrect PIN");
      } else {
        setUser(user);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Login failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-full flex flex-col bg-gradient-to-b from-brand-light to-white">
      {/* Shop logo */}
      <div className="pt-10 pb-2 flex flex-col items-center animate-fade-in">
        <ShopLogo className="h-24 w-auto" />
        <span className="sr-only">{shopSettings().shop_name}</span>
        <p className="text-taupe mt-3">Enter your PIN to sign in</p>
      </div>

      {/* Keypad */}
      <div className="flex-1 flex flex-col items-center justify-center px-6">
        <div className="animate-slide-up w-full flex flex-col items-center">
          <PinPad onSubmit={handle} busy={busy} />
          {error && (
            <p className="mt-4 text-red-600 font-medium animate-fade-in" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>

      {/* Branding footer */}
      <footer className="pb-6 pt-4 flex flex-col items-center gap-1.5">
        <InstallButton className="mb-4" />
        <BrandMark className="h-6 opacity-90" />
        <p className="text-[11px] text-taupe-light text-center">
          © {new Date().getFullYear()} 4D Climate Solutions · All rights reserved
        </p>
      </footer>
    </div>
  );
}
