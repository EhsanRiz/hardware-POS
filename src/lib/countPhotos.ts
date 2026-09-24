// Photos a counting phone has taken and not yet sent.
//
// Kept in IndexedDB, not beside the captures in localStorage: a downscaled
// photo is ~150 KB, localStorage holds about 5 MB for the whole site, and a
// day in a storeroom with no signal is a few hundred photos. IndexedDB holds
// that comfortably and survives the phone going flat, which is the point.
//
// If IndexedDB will not open (a private window on an old iPhone), photos are
// kept in memory instead: they still send once the signal returns, as long
// as the page is not closed first. Counts themselves never depend on this.

const DB = "count-photos";
const STORE = "photos";

let opening: Promise<IDBDatabase | null> | null = null;
const memory = new Map<string, string>();

function db(): Promise<IDBDatabase | null> {
  if (!opening) {
    opening = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return opening;
}

function run<T>(
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>
): Promise<T | undefined> {
  return db().then(
    (d) =>
      new Promise((resolve) => {
        if (!d) return resolve(undefined);
        try {
          const req = fn(d.transaction(STORE, mode).objectStore(STORE));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      })
  );
}

/** Keep a photo (a data: URL) until it has been sent. */
export async function keepPhoto(ref: string, dataUrl: string): Promise<void> {
  memory.set(ref, dataUrl);
  const ok = await run("readwrite", (s) => s.put(dataUrl, ref));
  // Stored for good: the memory copy was only a stand-in while it wrote.
  if (ok !== undefined) memory.delete(ref);
}

export async function readPhoto(ref: string): Promise<string | null> {
  const mem = memory.get(ref);
  if (mem) return mem;
  const v = await run<string>("readonly", (s) => s.get(ref) as IDBRequest<string>);
  return v ?? null;
}

export async function dropPhoto(ref: string): Promise<void> {
  memory.delete(ref);
  await run("readwrite", (s) => s.delete(ref));
}

/** Every photo this phone holds — for leaving a count behind entirely. */
export async function dropAllPhotos(): Promise<void> {
  memory.clear();
  await run("readwrite", (s) => s.clear());
}
