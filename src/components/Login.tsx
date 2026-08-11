import { useState } from "react";
import { signIn } from "../lib/auth";
import { useAuth } from "../context/AuthContext";
import { shopSettings } from "../lib/settings";
import { registerName } from "../lib/device";
import PinPad from "./PinPad";
import InstallButton from "./InstallButton";
import InnovaMark from "./InnovaMark";

/**
 * Daily sign-in.
 *
 * A PIN and nothing else. The till already knows which shop it belongs to — it
 * was paired once with a manager's phone and PIN — so the org is implied by the
 * device and the cashier never types a phone number to start their shift. It
 * works with the line down, because the credential is verified against a cached
 * hash when the server cannot be reached.
 */
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
        setError("That PIN was not recognised.");
      } else {
        setUser(user);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-head">
        <div className="sell-lockup">
          <InnovaMark size={30} onGreen />
          <span className="sell-wordmark" style={{ color: "var(--color-bg)" }}>
            Innova<span style={{ color: "var(--color-accent-400)" }}>POS</span>
          </span>
        </div>
        <h1 className="login-shop">{shopSettings().shop_name}</h1>
        <p className="login-till">{registerName()}</p>
      </div>

      <div className="login-body">
        <p className="login-prompt">Enter your PIN to sign in</p>
        <PinPad onSubmit={handle} busy={busy} />
        {error && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}
      </div>

      <footer className="login-foot">
        <InstallButton className="mb-4" />
        <p>
          InnovaPOS · a product of InnovaEarth
          <br />© {new Date().getFullYear()} InnovaEarth · All rights reserved
        </p>
      </footer>
    </div>
  );
}
