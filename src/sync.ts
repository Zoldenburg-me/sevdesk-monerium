/**
 * Plan, then apply. `planSync` reads both sides and decides per order
 * whether it is already mirrored, can be adopted from an existing sevDesk
 * row, must be created, or is skipped with a reason. `applySync` performs
 * the creates in date order and records each one in the state file before
 * moving to the next, so a crash between two creates costs nothing on retry.
 *
 * Nothing here writes to Monerium. Nothing here books, links or deletes
 * anything in sevDesk. A drift between the two ledgers is REPORTED by
 * `checkDrift`, never repaired: a tool that invents a balancing line to make
 * two systems agree is worse than the disagreement.
 */
import { formatCents, toCents } from "./money.js";
import { fingerprintOfSevdesk, mapOrder, normalizeIban } from "./mapping.js";
import type { MoneriumClient, MoneriumIban, MoneriumOrder } from "./monerium.js";
import type { SevdeskCheckAccount, SevdeskClient, SevdeskTransactionCreate } from "./sevdesk.js";
import type { SyncState } from "./state.js";

export interface SyncDeps {
  monerium: MoneriumClient;
  sevdesk: SevdeskClient;
  state: SyncState;
  log?: (line: string) => void;
}

export interface SyncOptions {
  /** Only orders processed at or after this instant. */
  since?: Date;
  /** Only orders processed before this instant. */
  until?: Date;
  /** Monerium profile to read; default is the application's own. */
  profile?: string;
  /** Create a sevDesk file-import account for an IBAN that has none. Off by default. */
  createAccounts?: boolean;
  /** Name for accounts we create; `{iban}` is substituted. */
  accountName?: string;
}

export interface PlannedAccount {
  iban: string;
  bic: string;
  address: string;
  chain: string;
  checkAccountId: string | null;
  create: boolean;
  name: string;
}

export type PlannedAction =
  | { kind: "create"; orderId: string; iban: string; draft: SevdeskTransactionCreate; fingerprint: string }
  | { kind: "adopt"; orderId: string; iban: string; transactionId: string; fingerprint: string }
  | { kind: "already"; orderId: string; transactionId: string }
  | { kind: "skip"; orderId: string; reason: string };

export interface SyncPlan {
  accounts: PlannedAccount[];
  actions: PlannedAction[];
  ordersSeen: number;
}

export interface SyncReport {
  accountsCreated: { iban: string; checkAccountId: string }[];
  created: { orderId: string; transactionId: string }[];
  adopted: { orderId: string; transactionId: string }[];
  skipped: { orderId: string; reason: string }[];
  already: number;
}

function inWindow(o: MoneriumOrder, opts: SyncOptions): boolean {
  const at = new Date(o.meta.processedAt ?? o.meta.placedAt).getTime();
  if (opts.since && at < opts.since.getTime()) return false;
  if (opts.until && at >= opts.until.getTime()) return false;
  return true;
}

function findAccountByIban(accounts: SevdeskCheckAccount[], iban: string): SevdeskCheckAccount | undefined {
  const want = normalizeIban(iban);
  return accounts.find((a) => a.iban && normalizeIban(a.iban) === want && a.status !== "0");
}

const shiftDays = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);

export async function planSync(deps: SyncDeps, opts: SyncOptions = {}): Promise<SyncPlan> {
  const log = deps.log ?? (() => {});
  const { state } = deps;

  const ibans = await deps.monerium.ibans(opts.profile);
  const byAddress = new Map<string, MoneriumIban>();
  for (const i of ibans) byAddress.set(i.address.toLowerCase(), i);

  const sevAccounts = await deps.sevdesk.checkAccounts();
  const accounts: PlannedAccount[] = [];
  for (const i of ibans) {
    const iban = normalizeIban(i.iban);
    const known = state.data.accounts[iban]?.checkAccountId;
    const existing = (known && sevAccounts.find((a) => a.id === known)) || findAccountByIban(sevAccounts, iban);
    const name = (opts.accountName ?? "Monerium {iban}").replace("{iban}", iban);
    accounts.push({
      iban,
      bic: i.bic,
      address: i.address,
      chain: i.chain,
      checkAccountId: existing?.id ?? null,
      create: !existing && !!opts.createAccounts,
      name,
    });
    if (existing && existing.type !== "online") {
      log(`note: sevDesk account ${existing.id} (${existing.name}) for ${iban} is type ${existing.type}; sevDesk documents transaction creation for online (file-import) accounts only`);
    }
  }

  const orders = (await deps.monerium.orders({ profile: opts.profile })).filter((o) => inWindow(o, opts));
  // Oldest first, so creates land in the order the bank would have shown them.
  orders.sort((a, b) => (a.meta.processedAt ?? a.meta.placedAt).localeCompare(b.meta.processedAt ?? b.meta.placedAt));

  // Existing sevDesk rows per account, keyed by fingerprint, for the recovery
  // pass. Rows already claimed in the state file are excluded so a lost
  // state cannot re-adopt one row for two orders.
  const claimed = new Set(Object.values(state.data.orders).map((o) => o.transactionId));
  const unclaimedByAccount = new Map<string, Map<string, string[]>>();
  const dates = orders.map((o) => new Date(o.meta.processedAt ?? o.meta.placedAt).getTime()).filter((n) => !Number.isNaN(n));
  for (const acc of accounts) {
    if (!acc.checkAccountId) continue;
    const map = new Map<string, string[]>();
    if (dates.length) {
      const rows = await deps.sevdesk.allTransactions({
        checkAccountId: acc.checkAccountId,
        startDate: shiftDays(new Date(Math.min(...dates)), -1).toISOString(),
        endDate: shiftDays(new Date(Math.max(...dates)), 1).toISOString(),
      });
      for (const r of rows) {
        if (claimed.has(r.id)) continue;
        const fp = fingerprintOfSevdesk(r);
        if (!fp) continue;
        const q = map.get(fp) ?? [];
        q.push(r.id);
        map.set(fp, q);
      }
    }
    unclaimedByAccount.set(acc.iban, map);
  }

  const actions: PlannedAction[] = [];
  for (const o of orders) {
    const already = state.data.orders[o.id];
    if (already) {
      actions.push({ kind: "already", orderId: o.id, transactionId: already.transactionId });
      continue;
    }
    const ibanEntry = byAddress.get(o.address.toLowerCase());
    if (!ibanEntry) {
      actions.push({ kind: "skip", orderId: o.id, reason: `address ${o.address} has no Monerium IBAN, so there is no bank account to mirror it into` });
      continue;
    }
    const acc = accounts.find((a) => a.iban === normalizeIban(ibanEntry.iban))!;
    if (!acc.checkAccountId && !acc.create) {
      actions.push({ kind: "skip", orderId: o.id, reason: `no sevDesk account holds IBAN ${acc.iban}; run with --create-accounts or create a CSV import account with that IBAN in sevDesk` });
      continue;
    }
    // Account id may not exist yet (planned create); mapping uses 0 as a placeholder and apply fills it.
    const mapped = mapOrder(o, acc.checkAccountId ? Number(acc.checkAccountId) : 0);
    if (!mapped.ok) {
      actions.push({ kind: "skip", orderId: o.id, reason: mapped.reason });
      continue;
    }
    const queue = unclaimedByAccount.get(acc.iban)?.get(mapped.fingerprint);
    const adoptId = queue?.shift();
    if (adoptId) {
      actions.push({ kind: "adopt", orderId: o.id, iban: acc.iban, transactionId: adoptId, fingerprint: mapped.fingerprint });
    } else {
      actions.push({ kind: "create", orderId: o.id, iban: acc.iban, draft: mapped.draft, fingerprint: mapped.fingerprint });
    }
  }

  return { accounts, actions, ordersSeen: orders.length };
}

export async function applySync(deps: SyncDeps, plan: SyncPlan): Promise<SyncReport> {
  const log = deps.log ?? (() => {});
  const { state } = deps;
  const report: SyncReport = { accountsCreated: [], created: [], adopted: [], skipped: [], already: 0 };

  for (const acc of plan.accounts) {
    if (acc.checkAccountId) {
      state.data.accounts[acc.iban] = { ...state.data.accounts[acc.iban], checkAccountId: acc.checkAccountId };
      continue;
    }
    if (!acc.create) continue;
    const created = await deps.sevdesk.createFileImportAccount({ name: acc.name, iban: acc.iban });
    acc.checkAccountId = created.id;
    state.data.accounts[acc.iban] = { checkAccountId: created.id, createdByUs: true };
    state.save();
    report.accountsCreated.push({ iban: acc.iban, checkAccountId: created.id });
    log(`created sevDesk file-import account ${created.id} "${acc.name}" for ${acc.iban}`);
  }

  for (const a of plan.actions) {
    if (a.kind === "already") {
      report.already++;
      continue;
    }
    if (a.kind === "skip") {
      report.skipped.push({ orderId: a.orderId, reason: a.reason });
      continue;
    }
    if (a.kind === "adopt") {
      state.data.orders[a.orderId] = { transactionId: a.transactionId, fingerprint: a.fingerprint, syncedAt: new Date().toISOString(), adopted: true };
      state.save();
      report.adopted.push({ orderId: a.orderId, transactionId: a.transactionId });
      continue;
    }
    const acc = plan.accounts.find((x) => x.iban === a.iban);
    if (!acc?.checkAccountId) {
      report.skipped.push({ orderId: a.orderId, reason: `no sevDesk account for ${a.iban}` });
      continue;
    }
    const draft: SevdeskTransactionCreate = { ...a.draft, checkAccount: { id: Number(acc.checkAccountId), objectName: "CheckAccount" } };
    const row = await deps.sevdesk.createTransaction(draft);
    // Recorded BEFORE the next create: a crash here leaves a retry with
    // nothing to redo for this order.
    state.data.orders[a.orderId] = { transactionId: row.id, fingerprint: a.fingerprint, syncedAt: new Date().toISOString() };
    state.save();
    report.created.push({ orderId: a.orderId, transactionId: row.id });
    log(`created ${row.id}: ${draft.valueDate.slice(0, 10)} ${formatCents(toCents(String(draft.amount)))} EUR ${draft.payeePayerName} "${draft.paymtPurpose ?? ""}"`);
  }
  return report;
}

export interface DriftLine {
  iban: string;
  chain: string;
  address: string;
  checkAccountId: string | null;
  moneriumBalance: string | null;
  sevdeskSum: string | null;
  deltaCents: bigint | null;
  note: string;
}

/**
 * Compares Monerium's view of each wallet with the running sum of the
 * sevDesk account that mirrors it. A non-zero delta is not necessarily an
 * error: EURe moved on-chain without a Monerium order (a plain token
 * transfer) is real money that no order describes, and this tool cannot
 * see it. The line says so rather than pretending the books are complete.
 */
export async function checkDrift(deps: SyncDeps, opts: { profile?: string } = {}): Promise<DriftLine[]> {
  const ibans = await deps.monerium.ibans(opts.profile);
  const sevAccounts = await deps.sevdesk.checkAccounts();
  const out: DriftLine[] = [];
  for (const i of ibans) {
    const iban = normalizeIban(i.iban);
    const known = deps.state.data.accounts[iban]?.checkAccountId;
    const acc = (known && sevAccounts.find((a) => a.id === known)) || findAccountByIban(sevAccounts, iban);
    let moneriumBalance: string | null = null;
    try {
      moneriumBalance = (await deps.monerium.balance(i.chain, i.address)) ?? null;
    } catch (e) {
      out.push({ iban, chain: i.chain, address: i.address, checkAccountId: acc?.id ?? null, moneriumBalance: null, sevdeskSum: null, deltaCents: null, note: `Monerium balance unavailable: ${(e as Error).message}` });
      continue;
    }
    if (!acc) {
      out.push({ iban, chain: i.chain, address: i.address, checkAccountId: null, moneriumBalance, sevdeskSum: null, deltaCents: null, note: "no sevDesk account holds this IBAN" });
      continue;
    }
    const rows = await deps.sevdesk.allTransactions({ checkAccountId: acc.id });
    let sum = 0n;
    for (const r of rows) sum += toCents(r.amount);
    const bal = moneriumBalance === null ? null : toCents(moneriumBalance);
    const delta = bal === null ? null : bal - sum;
    const note =
      delta === null
        ? "Monerium reported no EUR balance for this address"
        : delta === 0n
          ? "in agreement"
          : `Monerium holds ${formatCents(delta)} EUR more than sevDesk's running sum; unmirrored orders (run sync) or on-chain EURe transfers, which have no Monerium order and are invisible to this tool`;
    out.push({ iban, chain: i.chain, address: i.address, checkAccountId: acc.id, moneriumBalance, sevdeskSum: formatCents(sum), deltaCents: delta, note });
  }
  return out;
}
