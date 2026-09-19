import { useEffect, useState } from "react";
import {
  biometricAvailable, biometricEnrol, biometricEnrolled, biometricForget,
} from "../lib/biometric";
import type { User } from "../lib/types";

/**
 * "Face or Touch ID" on the phone's own menu.
 *
 * A choice, and somewhere to un-choose it. The lock screen is the worst
 * moment to be setting anything up — somebody is standing there wanting back
 * into their phone — and an offer made only there has no way to say no later.
 * So the lock screen only USES it, and this is where it is turned on and off.
 *
 * What it turns on is small and worth stating plainly on the screen itself:
 * it replaces the PIN when the phone was put in a pocket and picked up again,
 * and nothing else. Signing in is unchanged, a reload still asks for the PIN,
 * and no PIN is stored either way (lib/biometric).
 *
 * Absent entirely on a handset with no sensor. A switch that can only fail is
 * worse than no switch.
 */
export default function BiometricSwitch({ user }: { user: User }) {
  const [hasSensor, setHasSensor] = useState(false);
  const [on, setOn] = useState(() => biometricEnrolled(user.id));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let gone = false;
    void biometricAvailable().then((ok) => !gone && setHasSensor(ok));
    return () => { gone = true; };
  }, []);

  if (!hasSensor) return null;

  async function toggle() {
    setBusy(true);
    setFailed(false);
    if (on) {
      biometricForget(user.id);
      setOn(false);
    } else if (await biometricEnrol(user.id, user.name)) {
      setOn(true);
    } else {
      // Cancelled at the system prompt, or the phone refused. Saying so
      // matters here in a way it does not at the lock screen: somebody who
      // came to this switch on purpose is owed an answer about whether it
      // took.
      setFailed(true);
    }
    setBusy(false);
  }

  return (
    <div>
      <label className="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          className="h-5 w-5"
          checked={on}
          disabled={busy}
          onChange={() => void toggle()}
        />
        <span className="text-[15px]">Enable Face or Touch ID</span>
      </label>
      <p className="text-xs text-stone-500 mt-1">
        {on
          ? "Used when this phone is put away and picked up again. Signing in still asks for your PIN."
          : "Instead of your PIN when this phone is put away and picked up again."}
      </p>
      {failed && (
        <p className="text-xs is-bad mt-1" role="alert">
          This phone did not set it up. Your PIN still works.
        </p>
      )}
    </div>
  );
}
