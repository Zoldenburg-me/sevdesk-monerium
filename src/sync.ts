/**
 * Plan, then apply. `planSync` reads every source and decides per movement
 * whether it is already mirrored, can be adopted from an existing sevDesk
 * row, must be created, or is skipped with a reason. `applySync` performs
 * the creates in date order and records each one in the state file before
 * moving to the next, so a crash between two creates costs nothing on retry.
 *
 * TWO SOURCES, one row each:
 *  - Monerium orders (SEPA in/out, cross-chain): the bank counterparty and
 *    the memo, the record a bookkeeper matches on.
 *  - On-chain EURe transfers of the linked address: money that moved with no
 *    order behind it. Mint/burn legs are an order's own settlement and are
 *    folded onto the order by tx hash rather than booked twice; one with no
 *    visible order is reported, not booked.
 *
 * Nothing here writes to Monerium or the chain. Nothing here books, links or
 * deletes anything in sevDesk. A drift between the ledgers is REPORTED by
 * `checkDrift`, never repaired: a tool that invents a balancing line to make
 * two systems agree is worse than the disagreement.
 */
import { formatCents, roundToCents, toCents } from "./money.js";
import { fingerprintOfSevdesk, mapOrder, mapTransfer, normalizeIban, transferKey } from "./mapping.js";
import { JsonRpc, rpcUrlFor, type ChainTransfer } from "./chain.js";
import type { MoneriumClient, MoneriumIban, MoneriumOrder, MoneriumToken } from "./monerium.js";
import type { SevdeskCheckAccount, SevdeskClient, SevdeskTransactionCreate } from "./sevdesk.js";
import type { SyncState } from "./state.js";

export interface SyncDeps {
  monerium: MoneriumClient;
  sevdesk: SevdeskClient;
  state: SyncState;
  log?: (line: string) => void;
  /** RPC per Monerium chain name; default resolves RPC_URL_<CHAIN> then a public RPC. */
  rpcFor?: (chain: string) => JsonRpc | undefined;
}

export interface SyncOptions {
  /** Only movements at or after this instant. Required for the first on-chain scan of an address. */
  since?: Date;
  /** Only movements before this instant. */
  until?: Date;
  /** Monerium profile to read; default: every profile that holds one of the IBANs. */
  profile?: string;
  /** Only these IBANs (spaces and case ignored). Default: every IBAN the application can see. */
  ibans?: string[];
  /** Create a sevDesk file-import account for an IBAN that has none. Off by default. */
  createAccounts?: boolean;
  /** Name for accounts we create; `{iban}` is substituted. */
  accountName?: string;
  /** Read on-chain transfers too. Default true. */
  chain?: boolean;
  /** Blocks behind the head to treat as final. Default 12. */
  confirmations?: number;
  /** Largest eth_getLogs span asked for before halving. Default 5000. */
  maxBlockSpan?: number;
}

export interface PlannedAccount {
  iban: string;
  bic: string;
  address: string;
  chain: string;
  checkAccountId: string | null;
  create: boolean;
  name: string;
  /** Present when the chain was scanned for this account. */
  scan?: { fromBlock: number; toBlock: number; token: string; note?: string };
  /** Set when the node's pruned history cut the requested window short. */
  historyNote?: string;
}

export type Source = "order" | "chain";

export type PlannedAction =
  | { kind: "create"; source: Source; id: string; iban: string; draft: SevdeskTransactionCreate; fingerprint: string }
  | { kind: "adopt"; source: Source; id: string; iban: string; transactionId: string; fingerprint: string }
  | { kind: "already"; source: Source; id: string; transactionId: string }
  | { kind: "covered"; source: Source; id: string; by: string }
  | { kind: "skip"; source: Source; id: string; reason: string };

export interface SyncPlan {
  accounts: PlannedAccount[];
  actions: PlannedAction[];
  ordersSeen: number;
  transfersSeen: number;
  /** Per-account notes about a source that could not be read; the other sources still ran. */
  notes: string[];
}

export interface SyncReport {
  accountsCreated: { iban: string; checkAccountId: string }[];
  created: { id: string; source: Source; transactionId: string }[];
  adopted: { id: string; source: Source; transactionId: string }[];
  skipped: { id: string; source: Source; reason: string }[];
  already: number;
  covered: number;
}

const orderAt = (o: MoneriumOrder) => o.meta.processedAt ?? o.meta.placedAt;

function inWindow(at: string, opts: SyncOptions): boolean {
  const t = new Date(at).getTime();
  if (opts.since && t < opts.since.getTime()) return false;
  if (opts.until && t >= opts.until.getTime()) return false;
  return true;
}

function findAccountByIban(accounts: SevdeskCheckAccount[], iban: string): SevdeskCheckAccount | undefined {
  const want = normalizeIban(iban);
  return accounts.find((a) => a.iban && normalizeIban(a.iban) === want && a.status !== "0");
}

const shiftDays = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);

function defaultRpcFor(chain: string): JsonRpc | undefined {
  const url = rpcUrlFor(chain);
  return url ? new JsonRpc(url) : undefined;
}

/** Read one address's transfers for the window, or explain why not. Never throws: the order source must still run. */
async function scanAccount(
  deps: SyncDeps,
  acc: PlannedAccount,
  opts: SyncOptions,
  tokens: MoneriumToken[],
  earliestOrder: Date | undefined,
): Promise<{ transfers: ChainTransfer[]; token?: MoneriumToken; note?: string }> {
  const token = tokens.find((t) => t.chain === acc.chain && t.currency === "eur");
  if (!token) return { transfers: [], note: `Monerium publishes no EUR token on ${acc.chain}; on-chain transfers not read` };
  const rpc = (deps.rpcFor ?? defaultRpcFor)(acc.chain);
  if (!rpc) return { transfers: [], token, note: `no RPC for ${acc.chain} (set RPC_URL_${acc.chain.toUpperCase()}); on-chain transfers not read` };
  try {
    const reported = await rpc.chainId();
    if (reported !== token.chainId) {
      return { transfers: [], token, note: `RPC for ${acc.chain} reports chain id ${reported}, Monerium says ${token.chainId}; refusing to read logs from the wrong chain` };
    }
    const head = await rpc.headNumber();
    const safeHead = head - (opts.confirmations ?? 12);
    const cursor = deps.state.data.cursors[`${acc.chain}:${acc.address.toLowerCase()}`]?.lastScannedBlock;
    let fromBlock: number;
    if (cursor !== undefined && !opts.since) fromBlock = cursor + 1;
    else {
      const start = opts.since ?? earliestOrder;
      if (!start) return { transfers: [], token, note: `first on-chain scan of ${acc.address} needs --since (no cursor yet and no processed order to anchor on)` };
      fromBlock = await rpc.firstBlockAtOrAfter(start);
      const history = await rpc.historyStart();
      if (history.block > 0 && new Date(history.at).getTime() > start.getTime()) {
        acc.historyNote = `RPC for ${acc.chain} serves history from block ${history.block} (${history.at.slice(0, 10)}); transfers of ${acc.address} before that are not readable from this node`;
      }
    }
    let toBlock = safeHead;
    if (opts.until) {
      const untilBlock = await rpc.blockAtOrBefore(new Date(opts.until.getTime() - 1));
      if (untilBlock === null) return { transfers: [], token, note: "until precedes the chain" };
      toBlock = Math.min(toBlock, untilBlock);
    }
    if (fromBlock > toBlock) {
      acc.scan = { fromBlock, toBlock, token: token.address, note: "nothing new" };
      return { transfers: [], token };
    }
    const transfers = await rpc.scanTransfers({ chain: acc.chain, token: token.address, address: acc.address, fromBlock, toBlock, maxSpan: opts.maxBlockSpan });
    acc.scan = { fromBlock, toBlock, token: token.address };
    return { transfers, token };
  } catch (e) {
    return { transfers: [], token, note: `on-chain read failed for ${acc.chain} ${acc.address}: ${(e as Error).message}` };
  }
}

export async function planSync(deps: SyncDeps, opts: SyncOptions = {}): Promise<SyncPlan> {
  const log = deps.log ?? (() => {});
  const { state } = deps;
  const notes: string[] = [];

  let ibans = await deps.monerium.ibans(opts.profile);
  if (opts.ibans?.length) {
    const want = new Set(opts.ibans.map(normalizeIban));
    ibans = ibans.filter((i) => want.has(normalizeIban(i.iban)));
    for (const w of want) if (!ibans.some((i) => normalizeIban(i.iban) === w)) notes.push(`IBAN ${w} is not one Monerium attributes to this application`);
  }
  const byAddress = new Map<string, MoneriumIban>();
  for (const i of ibans) byAddress.set(i.address.toLowerCase(), i);

  const sevAccounts = await deps.sevdesk.checkAccounts();
  const accounts: PlannedAccount[] = [];
  for (const i of ibans) {
    const iban = normalizeIban(i.iban);
    const known = state.data.accounts[iban]?.checkAccountId;
    const existing = (known && sevAccounts.find((a) => a.id === known)) || findAccountByIban(sevAccounts, iban);
    const name = (opts.accountName ?? "Monerium {iban}").replace("{iban}", iban);
    accounts.push({ iban, bic: i.bic, address: i.address, chain: i.chain, checkAccountId: existing?.id ?? null, create: !existing && !!opts.createAccounts, name });
    if (existing && existing.type !== "online") {
      log(`note: sevDesk account ${existing.id} (${existing.name}) for ${iban} is type ${existing.type}; sevDesk documents transaction creation for online (file-import) accounts only`);
    }
  }

  // Orders are read PER PROFILE. Unscoped, Monerium answers with the
  // caller's default profile only, so on an application that serves several
  // profiles every other profile's orders would silently be missing (found
  // against the real sandbox: 60 IBANs, one profile's orders).
  const profiles = opts.profile ? [opts.profile] : [...new Set(ibans.map((i) => i.profile).filter(Boolean))];
  const allOrders: MoneriumOrder[] = [];
  const seenOrder = new Set<string>();
  for (const profile of profiles.length ? profiles : [undefined]) {
    for (const o of await deps.monerium.orders({ profile })) {
      if (seenOrder.has(o.id)) continue;
      seenOrder.add(o.id);
      allOrders.push(o);
    }
  }
  const orders = allOrders.filter((o) => inWindow(orderAt(o), opts));
  orders.sort((a, b) => orderAt(a).localeCompare(orderAt(b)));
  // Every tx hash any order settled through, whatever its window: a mint or
  // burn in the scanned range belongs to its order even if the order itself
  // was processed outside the window.
  const orderByTx = new Map<string, string>();
  for (const o of allOrders) for (const h of o.meta.txHashes ?? []) orderByTx.set(h.toLowerCase(), o.id);
  const earliestOrder = allOrders
    .filter((o) => o.state === "processed")
    .map((o) => new Date(o.meta.placedAt))
    .filter((d) => !Number.isNaN(d.getTime()))
    .sort((a, b) => a.getTime() - b.getTime())[0];

  // On-chain transfers per account.
  const chainRows: { acc: PlannedAccount; t: ChainTransfer; decimals: number }[] = [];
  if (opts.chain !== false) {
    let tokens: MoneriumToken[] = [];
    try {
      tokens = await deps.monerium.tokens();
    } catch (e) {
      notes.push(`Monerium /tokens unavailable (${(e as Error).message}); on-chain transfers not read`);
    }
    if (tokens.length) {
      for (const acc of accounts) {
        if (!acc.checkAccountId && !acc.create) continue;
        const r = await scanAccount(deps, acc, opts, tokens, earliestOrder);
        if (r.note) notes.push(r.note);
        if (acc.historyNote) notes.push(acc.historyNote);
        for (const t of r.transfers) chainRows.push({ acc, t, decimals: r.token!.decimals });
      }
    }
  }

  // Existing sevDesk rows per account, keyed by fingerprint, for the recovery
  // pass. Rows already claimed in the state file are excluded so a lost
  // state cannot re-adopt one row for two movements.
  const claimed = new Set([...Object.values(state.data.orders), ...Object.values(state.data.transfers)].map((o) => o.transactionId));
  const unclaimedByAccount = new Map<string, Map<string, string[]>>();
  const dates = [...orders.map((o) => new Date(orderAt(o)).getTime()), ...chainRows.map((r) => new Date(r.t.at).getTime())].filter((n) => !Number.isNaN(n));
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
  const place = (source: Source, id: string, acc: PlannedAccount, mapped: ReturnType<typeof mapOrder>) => {
    if (!mapped.ok) {
      actions.push({ kind: "skip", source, id, reason: mapped.reason });
      return;
    }
    const queue = unclaimedByAccount.get(acc.iban)?.get(mapped.fingerprint);
    const adoptId = queue?.shift();
    if (adoptId) actions.push({ kind: "adopt", source, id, iban: acc.iban, transactionId: adoptId, fingerprint: mapped.fingerprint });
    else actions.push({ kind: "create", source, id, iban: acc.iban, draft: mapped.draft, fingerprint: mapped.fingerprint });
  };

  for (const o of orders) {
    const already = state.data.orders[o.id];
    if (already) {
      actions.push({ kind: "already", source: "order", id: o.id, transactionId: already.transactionId });
      continue;
    }
    const ibanEntry = byAddress.get(o.address.toLowerCase());
    if (!ibanEntry) {
      actions.push({ kind: "skip", source: "order", id: o.id, reason: `address ${o.address} has no Monerium IBAN, so there is no bank account to mirror it into` });
      continue;
    }
    const acc = accounts.find((a) => a.iban === normalizeIban(ibanEntry.iban))!;
    if (!acc.checkAccountId && !acc.create) {
      actions.push({ kind: "skip", source: "order", id: o.id, reason: `no sevDesk account holds IBAN ${acc.iban}; run with --create-accounts or create a CSV import account with that IBAN in sevDesk` });
      continue;
    }
    place("order", o.id, acc, mapOrder(o, acc.checkAccountId ? Number(acc.checkAccountId) : 0));
  }

  for (const { acc, t, decimals } of chainRows) {
    const id = transferKey(t);
    const already = state.data.transfers[id];
    if (already) {
      actions.push({ kind: "already", source: "chain", id, transactionId: already.transactionId });
      continue;
    }
    const byOrder = orderByTx.get(t.txHash.toLowerCase());
    if (byOrder) {
      actions.push({ kind: "covered", source: "chain", id, by: byOrder });
      continue;
    }
    const mapped = mapTransfer(t, acc.address, decimals, acc.checkAccountId ? Number(acc.checkAccountId) : 0);
    if (!mapped.ok && /mint\/burn/.test(mapped.reason)) {
      actions.push({ kind: "skip", source: "chain", id, reason: `mint/burn ${t.txHash} matches no Monerium order this application can see — not booked; check the order list (another profile?) before booking it by hand` });
      continue;
    }
    place("chain", id, acc, mapped);
  }

  // Creates land in date order across both sources.
  const at = (a: PlannedAction) => (a.kind === "create" ? a.draft.valueDate : "");
  actions.sort((a, b) => (a.kind === "create" && b.kind === "create" ? at(a).localeCompare(at(b)) : 0));

  return { accounts, actions, ordersSeen: orders.length, transfersSeen: chainRows.length, notes };
}

export async function applySync(deps: SyncDeps, plan: SyncPlan): Promise<SyncReport> {
  const log = deps.log ?? (() => {});
  const { state } = deps;
  const report: SyncReport = { accountsCreated: [], created: [], adopted: [], skipped: [], already: 0, covered: 0 };

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

  const table = (source: Source) => (source === "order" ? state.data.orders : state.data.transfers);

  for (const a of plan.actions) {
    if (a.kind === "already") {
      report.already++;
      continue;
    }
    if (a.kind === "covered") {
      report.covered++;
      continue;
    }
    if (a.kind === "skip") {
      report.skipped.push({ id: a.id, source: a.source, reason: a.reason });
      continue;
    }
    if (a.kind === "adopt") {
      table(a.source)[a.id] = { transactionId: a.transactionId, fingerprint: a.fingerprint, syncedAt: new Date().toISOString(), adopted: true };
      state.save();
      report.adopted.push({ id: a.id, source: a.source, transactionId: a.transactionId });
      continue;
    }
    const acc = plan.accounts.find((x) => x.iban === a.iban);
    if (!acc?.checkAccountId) {
      report.skipped.push({ id: a.id, source: a.source, reason: `no sevDesk account for ${a.iban}` });
      continue;
    }
    const draft: SevdeskTransactionCreate = { ...a.draft, checkAccount: { id: Number(acc.checkAccountId), objectName: "CheckAccount" } };
    const row = await deps.sevdesk.createTransaction(draft);
    // Recorded BEFORE the next create: a crash here leaves a retry with
    // nothing to redo for this movement.
    table(a.source)[a.id] = { transactionId: row.id, fingerprint: a.fingerprint, syncedAt: new Date().toISOString() };
    state.save();
    report.created.push({ id: a.id, source: a.source, transactionId: row.id });
    log(`created ${row.id}: ${draft.valueDate.slice(0, 10)} ${formatCents(toCents(String(draft.amount)))} EUR ${draft.payeePayerName} "${draft.paymtPurpose ?? ""}"`);
  }

  // The scan cursor moves only once everything in the range is recorded, so
  // a failed apply re-reads the same blocks next time.
  for (const acc of plan.accounts) {
    if (acc.scan && acc.checkAccountId) {
      state.data.cursors[`${acc.chain}:${acc.address.toLowerCase()}`] = { lastScannedBlock: acc.scan.toBlock };
    }
  }
  state.save();
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
 * sevDesk account that mirrors it. With both sources synced the two should
 * agree to the cent; the note names the usual causes when they do not.
 * Nothing is repaired.
 */
export async function checkDrift(deps: SyncDeps, opts: { profile?: string; ibans?: string[] } = {}): Promise<DriftLine[]> {
  let ibans = await deps.monerium.ibans(opts.profile);
  if (opts.ibans?.length) {
    const want = new Set(opts.ibans.map(normalizeIban));
    ibans = ibans.filter((i) => want.has(normalizeIban(i.iban)));
  }
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
    const bal = moneriumBalance === null ? null : roundToCents(moneriumBalance);
    const delta = bal === null ? null : bal - sum;
    const note =
      delta === null
        ? "Monerium reported no EUR balance for this address"
        : delta === 0n
          ? "in agreement"
          : `Monerium holds ${formatCents(delta)} EUR more than sevDesk's running sum: unmirrored movements (run sync, with --since for the first on-chain scan), a mint/burn with no visible order, sub-cent rounding, or transfers still inside the confirmation window`;
    out.push({ iban, chain: i.chain, address: i.address, checkAccountId: acc.id, moneriumBalance, sevdeskSum: formatCents(sum), deltaCents: delta, note });
  }
  return out;
}
