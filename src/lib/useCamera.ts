import { useEffect, useState } from "react";
import { cameraSeen, hasCamera } from "./device";

/**
 * Whether this device has a camera, for deciding what to offer.
 *
 * Seeded from what was true last time (see cameraSeen) so the first paint is
 * right on every load but the first, then confirmed against the hardware. A
 * camera can be plugged into a counter machine, so the answer is asked again
 * on every mount rather than trusted from the cache forever.
 */
export function useCamera(): boolean {
  const [on, setOn] = useState(cameraSeen);
  useEffect(() => {
    let alive = true;
    void hasCamera().then((v) => {
      if (alive) setOn(v);
    });
    return () => {
      alive = false;
    };
  }, []);
  return on;
}
