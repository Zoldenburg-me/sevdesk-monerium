/**
 * The order-id -> sevDesk-transaction map, kept in one JSON file. It is a
 * cache of what has already been mirrored, not the source of truth: losing
 * it costs one slower sync (see the recovery pass in sync.ts), never a
 * duplicate line.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SyncStateData {
  version: 1;
  /** IBAN (normalized) -> sevDesk CheckAccount id. */
  accounts: Record<string, { checkAccountId: string; createdByUs?: boolean }>;
  /** Monerium order id -> the sevDesk row that mirrors it. */
  orders: Record<string, { transactionId: string; fingerprint: string; syncedAt: string; adopted?: boolean }>;
}

const empty = (): SyncStateData => ({ version: 1, accounts: {}, orders: {} });

export class SyncState {
  data: SyncStateData;

  constructor(readonly path: string | null) {
    this.data = empty();
    if (path) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as SyncStateData;
        if (parsed.version !== 1) throw new Error(`unsupported state version ${parsed.version} in ${path}`);
        this.data = { ...empty(), ...parsed };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
  }

  static inMemory(): SyncState {
    return new SyncState(null);
  }

  /** Atomic: written beside the file and renamed, so a crash mid-write leaves the old file intact. */
  save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n");
    renameSync(tmp, this.path);
  }
}
