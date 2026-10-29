import type { FolderFile } from "./skills";

// The skills added by hand with "Remember this skill" are kept in IndexedDB,
// which, unlike localStorage, can hold the files of a skill as they are. They
// are kept as files, not as read skills, so that they are read again with the
// rules of the plugin that opens them.

/** A skill as the browser remembers it: its files, and whether it is on */
export type StoredSkill = {
  /** The name of the skill */
  name: string;
  /** Whether the skill is on */
  enabled: boolean;
  /** The files, by path from the skill's folder, e.g. "stats/SKILL.md" */
  files: FolderFile[];
};

/** Where the panel remembers the skills added by hand */
export type SkillStorage = {
  /** Reads the remembered skills */
  load: typeof loadStoredSkills;
  /** Remembers a skill, or updates it */
  save: typeof storeSkill;
  /** Forgets a skill */
  remove: typeof forgetStoredSkill;
};

/** The database of the panel, named like its localStorage keys */
const databaseName = "tissuumaps.ai-chat";

/** The part of the database that holds the skills, by name */
const storeName = "skills";

/**
 * Opens the database of the panel, and creates it the first time
 *
 * @returns The database
 * @throws If the browser has no IndexedDB, or does not allow it
 */
function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(
      new Error("this browser cannot remember skills (it has no IndexedDB)"),
    );
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(storeName, { keyPath: "name" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        request.error ?? new Error("the browser storage cannot be opened"),
      );
  });
}

/**
 * Runs one request on the skills, in its own transaction
 *
 * @param mode - Whether the request only reads
 * @param makeRequest - Makes the request
 * @param options - Optional abort signal
 * @returns The result of the request, once the transaction is complete
 */
async function runRequest<TResult>(
  mode: IDBTransactionMode,
  makeRequest: (store: IDBObjectStore) => IDBRequest<TResult>,
  options?: { signal?: AbortSignal },
): Promise<TResult> {
  const { signal } = options ?? {};
  signal?.throwIfAborted();
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = makeRequest(transaction.objectStore(storeName));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("the browser storage failed"));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("the browser storage failed"));
    });
  } finally {
    database.close();
  }
}

/**
 * Reads the skills the browser remembers
 *
 * @param options - Optional abort signal
 * @returns The skills; none if the browser has no IndexedDB, since then it
 * could never remember one
 * @throws If the database cannot be read
 */
export function loadStoredSkills(options?: {
  signal?: AbortSignal;
}): Promise<StoredSkill[]> {
  if (typeof indexedDB === "undefined") {
    return Promise.resolve([]);
  }
  return runRequest(
    "readonly",
    (store) => store.getAll() as IDBRequest<StoredSkill[]>,
    options,
  );
}

/**
 * Remembers a skill in the browser, or updates it (e.g. when it is turned off)
 *
 * @param skill - The skill
 * @param options - Optional abort signal
 * @throws If the browser cannot remember it
 */
export async function storeSkill(
  skill: StoredSkill,
  options?: { signal?: AbortSignal },
): Promise<void> {
  await runRequest("readwrite", (store) => store.put(skill), options);
}

/**
 * Makes the browser forget a skill
 *
 * @param name - The name of the skill
 * @param options - Optional abort signal
 * @throws If the browser storage cannot be changed
 */
export async function forgetStoredSkill(
  name: string,
  options?: { signal?: AbortSignal },
): Promise<void> {
  await runRequest("readwrite", (store) => store.delete(name), options);
}
