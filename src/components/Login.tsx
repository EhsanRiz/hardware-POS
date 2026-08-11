import { useState } from "react";
import { signIn } from "../lib/auth";
import { useAuth } from "../context/AuthContext";
import { shopSettings } from "../lib/settings";
import { clearPairing, registerName } from "../lib/device";
import { errorMessage } from "../lib/errors";
import { usePendingSync } from "../lib/sync";
import PinPad from "./PinPad";
import InstallButton from "./InstallButton";
import InnovaMark from "./InnovaMark";

/** Where staff reset a forgotten PIN, by SMS to their own phone. */
const ENROL_URL = "https://pos.innovaearth.com/enrol/";

/**
 * Daily sign-in.
 *
 * A PIN and nothing else. The till already knows which shop it belongs to — it
 * was paired once with a manager's phone and PIN — so the org is implied by the
 * device and the cashier never types a phone number to start their shift. It
 * works with the line down, because the credential is verified against a cached
 * hash when the server cannot be reached.
 *
 * Two ways out, because a screen that can only be satisfied by remembering
 * something is a trap: a forgotten PIN goes to the enrolment page and is reset
 * by SMS, and a tablet pointed at the wrong shop can be unpaired from here.
 */
export default function Login() {
  const { setUser } = useAuth();
  const { pending } = usePendingSync();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmUnpair, setConfirmUnpair] = useState(false);

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
      setError(errorMessage(e, "Sign-in failed"));
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

        <div className="login-outs">
          <a href={ENROL_URL} target="_blank" rel="noreferrer">
            Forgot your PIN?
          </a>
          <span aria-hidden="true">·</span>
          <button onClick={() => setConfirmUnpair(true)}>Not this shop?</button>
        </div>
      </div>

      <footer className="login-foot">
        <InstallButton className="mb-4" />
        <p>
          InnovaPOS · a product of InnovaEarth
          <br />© {new Date().getFullYear()} InnovaEarth · All rights reserved
        </p>
      </footer>

      {confirmUnpair && (
        <div className="modal-backdrop" onClick={() => setConfirmUnpair(false)}>
          <div
            className="modal-card"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Unpair this till"
          >
            <h2 className="modal-title">Unpair this till?</h2>

            {pending > 0 ? (
              <>
                {/* The register token is what replays a queued sale. Unpairing
                    with sales still waiting would strand real money, so this is
                    refused rather than warned about. */}
                <p className="modal-row-meta" style={{ fontSize: 14 }}>
                  {pending} {pending === 1 ? "sale is" : "sales are"} still
                  waiting to reach the server. Unpairing now would lose{" "}
                  {pending === 1 ? "it" : "them"}. Connect to the internet, let
                  the queue empty, then try again.
                </p>
                <button
                  className="btn-line"
                  style={{ marginTop: 16 }}
                  onClick={() => setConfirmUnpair(false)}
                >
                  Close
                </button>
              </>
            ) : (
              <>
                <p className="modal-row-meta" style={{ fontSize: 14 }}>
                  This device will stop being{" "}
                  <strong>{registerName()}</strong> at{" "}
                  <strong>{shopSettings().shop_name}</strong>, and a manager
                  will have to pair it again with their phone and PIN. Nobody's
                  PIN changes, and the shop's data is untouched.
                </p>
                <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
                  <button
                    className="btn-line"
                    onClick={() => setConfirmUnpair(false)}
                  >
                    Cancel
                  </button>
                  <button
                    className="btn-line quiet"
                    onClick={() => {
                      clearPairing();
                      setConfirmUnpair(false);
                    }}
                  >
                    Unpair this till
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
