/**
 * Where the browser remembers an unfinished upload. No API call lists the
 * parts S3 already holds, so this record is the source of truth for a resume:
 * it works in the same browser profile with storage intact, and another device
 * or cleared site data starts the upload again from zero.
 */

/** One unfinished upload: what `create` returned plus every part that landed. */
export interface UploadRecord {
  v: 1;
  key: string;
  ticket: string;
  videoId: string;
  uploadId: string;
  partSize: number;
  totalParts: number;
  size: number;
  createdAt: number;
  /** When the ticket stops working, in ms since the epoch. */
  expiresAt: number;
  /** Part number to ETag, for each part S3 has confirmed. */
  parts: Record<number, string>;
}

export interface UploadStore {
  get(key: string): Promise<UploadRecord | undefined>;
  set(key: string, record: UploadRecord): Promise<void>;
  delete(key: string): Promise<void>;
}

/** A store that lasts as long as the page. Records are copied in and out. */
export function memoryStore(): UploadStore {
  const m = new Map<string, string>();
  return {
    get: async (k) => {
      const s = m.get(k);
      return s === undefined ? undefined : (JSON.parse(s) as UploadRecord);
    },
    set: async (k, r) => void m.set(k, JSON.stringify(r)),
    delete: async (k) => void m.delete(k),
  };
}

/**
 * The default store: one IndexedDB object store, opened on first use. Falls
 * back to memory where IndexedDB is missing or refuses (server rendering, some
 * private-browsing modes), so an upload still works, it just cannot resume
 * after a reload.
 */
export function indexedDBStore(name = "transcodely-uploads"): UploadStore {
  const mem = memoryStore();
  let db: Promise<IDBDatabase | undefined> | undefined;
  const open = () =>
    (db ??= new Promise((done) => {
      try {
        const r = indexedDB.open(name, 1);
        r.onupgradeneeded = () => r.result.createObjectStore("uploads");
        r.onsuccess = () => done(r.result);
        r.onerror = r.onblocked = () => done(undefined);
      } catch {
        done(undefined);
      }
    }));
  const run = async <T>(
    write: boolean,
    op: (s: IDBObjectStore) => IDBRequest,
    fallback: () => Promise<T>,
  ): Promise<T> => {
    const d = await open();
    if (!d) return fallback();
    try {
      return await new Promise<T>((done, fail) => {
        const t = d.transaction("uploads", write ? "readwrite" : "readonly");
        const q = op(t.objectStore("uploads"));
        // Resolve on commit, not on the request, so a write is durable before
        // the uploader counts the part as done.
        t.oncomplete = () => done(q.result as T);
        t.onerror = t.onabort = () => fail(t.error);
      });
    } catch {
      return fallback();
    }
  };
  return {
    get: (k) => run(false, (s) => s.get(k), () => mem.get(k)),
    set: (k, r) => run(true, (s) => s.put(r, k), () => mem.set(k, r)).then(() => undefined),
    delete: (k) => run(true, (s) => s.delete(k), () => mem.delete(k)).then(() => undefined),
  };
}
