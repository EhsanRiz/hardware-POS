import { useEffect, useState } from "react";
import { canSignInOffline, loginRoster, signIn } from "../lib/auth";
import { ENROL_URL } from "../lib/config";
import { useAuth } from "../context/AuthContext";
import { shopSettings } from "../lib/settings";
import { clearPairing, registerName } from "../lib/device";
import { errorMessage } from "../lib/errors";
import { isOnline } from "../lib/offline";
import { usePendingSync } from "../lib/sync";
import PinPad from "./PinPad";
import InstallButton from "./InstallButton";
import InnovaMark from "./InnovaMark";
import type { LoginCandidate } from "../lib/types";

/**
 * Daily sign-in.
 *
 * Pick your name, then prove it with your PIN. The till already knows which
 * shop it belongs to — it was paired once with a manager's phone and PIN — so
 * the org is implied by the device and the cashier never types a phone number
 * to start their shift. It works with the line down, because the roster is
 * cached and the credential is verified against a cached hash when the server
 * cannot be reached.
 *
 * The name is not decoration. Sign-in used to take a PIN alone and look up
 * whoever owned it, and nothing requires a PIN to be unique — so two people
 * choosing the same six digits meant the second silently became the first.
 * Choosing a name makes the PIN confirm an identity instead of deciding one,
 * which is what lets a cashier be held to what was rung up under their name.
 *
 * It is also the handover: a manager finishes, taps Sign out, and the next
 * operator picks their own name rather than inheriting the screen.
 *
 * Two ways out, because a screen that can only be satisfied by remembering
 * something is a trap: a forgotten PIN goes to the enrolment page and is reset
 * by SMS, and a tablet pointed at the wrong shop can be unpaired from here.
 */
const ROLE_LABEL: Record<LoginCandidate["role"], string> = {
  admin: "Owner",
  manager: "Manager",
  employee: "Counter",
};

export default function Login() {
  const { setUser } = useAuth();
  const { pending } = usePendingSync();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmUnpair, setConfirmUnpair] = useState(false);
  const [roster, setRoster] = useState<LoginCandidate[] | null>(null);
  const [who, setWho] = useState<LoginCandidate | null>(null);

  useEffect(() => {
    void loginRoster().then(setRoster, () => setRoster([]));
  }, []);

  // Somebody who has never signed in on this till has no cached credential, so
  // offline there is nothing to check their PIN against. Saying so beats a
  // "wrong PIN" they cannot do anything about.
  const offlineStranger = !!who && !isOnline() && !canSignInOffline(who.id);

  const handle = async (pin: string) => {
    if (!who) return;
    setBusy(true);
    setError(null);
    try {
      const user = await signIn(who.id, pin);
      if (!user) {
        setError(
          offlineStranger
            ? `${who.name} has not signed in on this till before, so it cannot check their PIN while the line is down.`
            : "That PIN was not recognised."
        );
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
        {!who ? (
          <>
            <p className="login-prompt">Who is on the till?</p>
            {roster === null ? (
              <p className="login-prompt">Loading…</p>
            ) : roster.length === 0 ? (
              /* No roster and no cache. Rather than a dead screen, name the two
                 things that actually cause it. */
              <p className="login-prompt">
                Nobody on this shop's staff list has set a PIN yet, or this till
                has not reached the server since it was paired. A manager can
                add staff from Manage on a till that is online.
              </p>
            ) : (
              <ul className="login-who">
                {roster.map((c) => (
                  <li key={c.id}>
                    <button onClick={() => { setWho(c); setError(null); }}>
                      <span className="login-who-name">{c.name}</span>
                      <span className="login-who-role">{ROLE_LABEL[c.role]}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <>
            <p className="login-prompt">
              <strong>{who.name}</strong> — enter your PIN
            </p>
            <PinPad onSubmit={handle} busy={busy} />
            <button
              className="login-back"
              onClick={() => { setWho(null); setError(null); }}
            >
              Not {who.name}?
            </button>
          </>
        )}
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
