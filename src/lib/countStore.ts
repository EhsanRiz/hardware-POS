// The counting phone's memory: which count it is on, what it knows about the
// shop, and every capture it has taken — sent or not.
//
// The back of a hardware store is where the signal goes to die, and a count
// that stops when the bars do is a count two people abandon by lunch. So a
// capture is written HERE first, always, and sent from here when the line
// allows; the screen never waits on the network to accept the next scan. The
// server takes each one once however many times it arrives (client_ref), which
// is what makes "send it again" the answer to every doubt.
//
// Kept under its own `count.` prefix rather than the till's `pos.` one: a till
// unpairing clears `pos.*` (cacheClearExcept), and what a counter captured is
// not the till's to throw away.
import {
  countState,
  finishCount,
  resumeCount,
  sendCapture,
  uploadCountPhoto,
  voidCapture,
  type CaptureInput,
  type CountJoin,
  type CountState,
} from "./countApi";
import { rawErrorMessage } from "./errors";
import { isNetworkError } from "./offline";
import { dropAllPhotos, dropPhoto, keepPhoto, readPhoto } from "./countPhotos";

const SESSION_KEY = "count.session";
const STATE_KEY = "count.state";
const CAPTURES_KEY = "count.captures";

export interface CountSession {
  token: string;
  job_id: string;
  doc_number: string;
  shop_name: string;
  note: string | null;
  counter_name: string;
  /** Where the counter is standing. Kept, because they stay there a while. */
  location: string;
  /** Why the phone can no longer count, once the server has said so. */
  ended: string | null;
  /**
   * The counter said "I'm done" (0115). Only they can say it, and they can
   * take it back until the count is posted; nothing else ends their count.
   */
  finished?: boolean;
}

export type CaptureState = "waiting" | "sent" | "failed" | "voiding";

/** A photo taken with a count. The picture itself waits in countPhotos. */
export interface LocalPhoto {
  ref: string;
  state: "waiting" | "sent" | "failed";
  error: string | null;
}

export interface LocalCapture extends CaptureInput {
  /** What the counter saw on the screen: the item's name. */
  label: string;
  state: CaptureState;
  error: string | null;
  photos?: LocalPhoto[];
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A full store is survivable; the screen still shows what is in memory.
  }
}

const listeners = new Set<() => void>();
function changed(): void {
  listeners.forEach((fn) => fn());
}
export function onCountChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getSession(): CountSession | null {
  return read<CountSession | null>(SESSION_KEY, null);
}

export function getState(): CountState | null {
  return read<CountState | null>(STATE_KEY, null);
}

export function getCaptures(): LocalCapture[] {
  return read<LocalCapture[]>(CAPTURES_KEY, []);
}

function saveCaptures(list: LocalCapture[]): void {
  write(CAPTURES_KEY, list);
  changed();
}

function patchSession(patch: Partial<CountSession>): void {
  const s = getSession();
  if (!s) return;
  write(SESSION_KEY, { ...s, ...patch });
  changed();
}

export function startSession(j: CountJoin): void {
  // A phone joining a new count starts with a clean list. Anything still
  // unsent from a finished count cannot be sent anywhere now.
  write(CAPTURES_KEY, []);
  write(STATE_KEY, null);
  void dropAllPhotos();
  write(SESSION_KEY, {
    token: j.token,
    job_id: j.job_id,
    doc_number: j.doc_number,
    shop_name: j.shop_name,
    note: j.note,
    counter_name: j.counter_name,
    location: "",
    ended: null,
    finished: false,
  } satisfies CountSession);
  changed();
}

export function leaveSession(): void {
  write(SESSION_KEY, null);
  write(STATE_KEY, null);
  write(CAPTURES_KEY, []);
  void dropAllPhotos();
  changed();
}

/** What this phone still has to send: counts, take-backs and photos. */
export function unsentCount(list: LocalCapture[] = getCaptures()): number {
  let n = 0;
  for (const c of list) {
    if (c.state === "waiting" || c.state === "voiding") n++;
    if (c.state !== "failed") n += (c.photos ?? []).filter((p) => p.state === "waiting").length;
  }
  return n;
}

/**
 * "I'm done." Refused while anything is still on the phone: the shop posts on
 * the strength of this, and a count still in a pocket would miss the post.
 */
export async function finish(): Promise<void> {
  const s = getSession();
  if (!s || s.ended) return;
  await syncCaptures();
  const left = unsentCount();
  if (left > 0) {
    throw new Error(
      `${left} still to send from this phone. Find signal, let them go, then try again.`
    );
  }
  await finishCount(s.token);
  patchSession({ finished: true });
}

/** "Not done after all." */
export async function carryOn(): Promise<void> {
  const s = getSession();
  if (!s || s.ended) return;
  await resumeCount(s.token);
  patchSession({ finished: false });
}

export function setLocation(location: string): void {
  patchSession({ location });
}

/** What the server says when this phone's count is over for it. */
function isEnded(message: string): boolean {
  return (
    /this count has finished/i.test(message) ||
    /taken off this count/i.test(message) ||
    /not on a count/i.test(message)
  );
}

/** Fetch what the shop has, for finding things with no signal later. */
export async function refreshState(): Promise<void> {
  const s = getSession();
  if (!s || s.ended) return;
  try {
    const st = await countState(s.token);
    write(STATE_KEY, st);
    changed();
  } catch (e) {
    const m = rawErrorMessage(e, "");
    if (!isNetworkError(e) && isEnded(m)) patchSession({ ended: m });
  }
}

function newRef(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

/**
 * Write a capture down, with any photos taken of it. Kept whether or not it
 * can be sent yet; the photos wait in IndexedDB before the capture is listed,
 * so a capture on the list never points at a photo that was not kept.
 */
export async function addCapture(
  c: Omit<CaptureInput, "client_ref" | "captured_at">,
  label: string,
  photos: string[] = []
): Promise<LocalCapture> {
  const kept: LocalPhoto[] = [];
  for (const dataUrl of photos) {
    const ref = newRef();
    await keepPhoto(ref, dataUrl);
    kept.push({ ref, state: "waiting", error: null });
  }
  const capture: LocalCapture = {
    ...c,
    client_ref: newRef(),
    captured_at: new Date().toISOString(),
    label,
    state: "waiting",
    error: null,
    photos: kept,
  };
  saveCaptures([...getCaptures(), capture]);
  void syncCaptures();
  return capture;
}

/**
 * Take one back. One that never left the phone just goes; one the server
 * has is marked and the server told, so the shop stops counting it.
 */
export function undoCapture(ref: string): void {
  const list = getCaptures();
  const c = list.find((x) => x.client_ref === ref);
  if (!c) return;
  for (const p of c.photos ?? []) void dropPhoto(p.ref);
  // Refused, or never sent and not on its way right now: nothing to tell the
  // server. One being sent at this moment may land, so it is taken back
  // properly like any other.
  if (c.state === "failed" || (c.state === "waiting" && inFlight !== ref)) {
    saveCaptures(list.filter((x) => x.client_ref !== ref));
    return;
  }
  saveCaptures(list.map((x) => (x.client_ref === ref ? { ...x, state: "voiding" } : x)));
  void syncCaptures();
}

let syncing = false;
/** Asked for while a run was going: go round once more when it finishes. */
let again = false;
/** The capture on the wire right now, if any. */
let inFlight: string | null = null;

/**
 * Send what is waiting, in the order it was counted.
 *
 * A dead line stops the run and leaves everything as it was — the next try
 * picks up exactly where this one stopped. A refusal is kept on the phone
 * with the server's reason, never dropped: the counter can see it, and it is
 * a number somebody wrote down.
 */
export async function syncCaptures(): Promise<void> {
  if (syncing) {
    again = true;
    return;
  }
  const s = getSession();
  if (!s || s.ended) return;
  syncing = true;
  again = false;
  let learned = false;
  let lineDown = false;
  try {
    for (const c of getCaptures()) {
      if (c.state !== "waiting" && c.state !== "voiding") continue;
      try {
        if (c.state === "waiting") {
          inFlight = c.client_ref;
          const r = await sendCapture(s.token, c);
          if (!c.product_id && !c.new_item_id) learned = true;
          // Taken back while it was on the wire: it landed, so it stays
          // marked for taking back — the next round tells the server.
          const now = getCaptures().find((x) => x.client_ref === c.client_ref);
          update(c.client_ref, {
            state: now?.state === "voiding" ? "voiding" : "sent",
            error: null,
            product_id: r.product_id,
            new_item_id: r.new_item_id,
          });
        } else {
          await voidCapture(s.token, c.client_ref);
          saveCaptures(getCaptures().filter((x) => x.client_ref !== c.client_ref));
        }
      } catch (e) {
        if (isNetworkError(e)) {
          lineDown = true;
          break;
        }
        const m = rawErrorMessage(e, "The shop's server refused this one");
        if (isEnded(m)) {
          patchSession({ ended: m });
          break;
        }
        update(c.client_ref, { state: "failed", error: m });
      }
    }
    // Then the photos, for counts the server now holds. A photo is only ever
    // sent after its count, because it hangs on that count.
    if (!lineDown && !getSession()?.ended) {
      outer: for (const c of getCaptures()) {
        if (c.state !== "sent") continue;
        for (const p of c.photos ?? []) {
          if (p.state !== "waiting") continue;
          const dataUrl = await readPhoto(p.ref);
          if (!dataUrl) {
            setPhoto(c.client_ref, p.ref, { state: "failed", error: "The photo was lost on this phone" });
            continue;
          }
          try {
            await uploadCountPhoto(s.token, c.client_ref, p.ref, dataUrl);
            setPhoto(c.client_ref, p.ref, { state: "sent", error: null });
            void dropPhoto(p.ref);
          } catch (e) {
            if (isNetworkError(e)) {
              lineDown = true;
              break outer;
            }
            const m = rawErrorMessage(e, "The photo was refused");
            if (isEnded(m)) {
              patchSession({ ended: m });
              break outer;
            }
            setPhoto(c.client_ref, p.ref, { state: "failed", error: m });
          }
        }
      }
    }
  } finally {
    syncing = false;
    inFlight = null;
  }
  if (again && !lineDown) void syncCaptures();
  // Something new went up: the phone's list of new items should know its id,
  // and whatever the other counter has met since.
  if (learned) void refreshState();
}

function setPhoto(captureRef: string, photoRef: string, patch: Partial<LocalPhoto>): void {
  saveCaptures(
    getCaptures().map((x) =>
      x.client_ref === captureRef
        ? { ...x, photos: (x.photos ?? []).map((p) => (p.ref === photoRef ? { ...p, ...patch } : p)) }
        : x
    )
  );
}

function update(ref: string, patch: Partial<LocalCapture>): void {
  saveCaptures(getCaptures().map((x) => (x.client_ref === ref ? { ...x, ...patch } : x)));
}
