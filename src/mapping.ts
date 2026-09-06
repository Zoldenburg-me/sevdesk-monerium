/**
 * The pure core: one Monerium order -> one sevDesk transaction draft.
 * No I/O, so every rule here is unit-testable without either API.
 *
 * Sign convention (sevDesk): positive = money arrived on the account,
 * negative = money left it. Monerium: an `issue` order is a SEPA payment
 * received (tokens minted), a `redeem` order is a payout sent (tokens burned).
 *
 * ONLY `processed` orders are mirrored. `placed`/`pending` money has not
 * settled and may still be rejected; a rejected order never moved anything.
 * Mirroring a pending order would put a line in the books for money that
 * might never arrive — exactly the kind of record this tool must not create.
 */
import { toCents, centsToNumber, formatCents } from "./money.js";
import type { MoneriumOrder } from "./monerium.js";
import type { SevdeskTransaction, SevdeskTransactionCreate } from "./sevdesk.js";

export type MappingResult =
  | { ok: true; draft: SevdeskTransactionCreate; cents: bigint; fingerprint: string }
  | { ok: false; reason: string };

export function normalizeIban(iban: string): string {
  return iban.replace(/\s+/g, "").toUpperCase();
}

export function counterpartName(order: MoneriumOrder): string {
  const d = order.counterpart?.details ?? {};
  const joined = [d.firstName, d.lastName].filter(Boolean).join(" ").trim();
  const name = (d.name ?? d.companyName ?? joined ?? "").toString().trim();
  if (name) return name;
  const id = order.counterpart?.identifier;
  if (id?.standard === "iban") return normalizeIban(id.iban);
  if (id?.standard === "chain") return `${id.chain} ${id.address}`;
  if (id?.standard === "account") return id.accountNumber;
  return "Unknown counterpart";
}

export function counterpartAccount(order: MoneriumOrder): { acctNo?: string; bankCode?: string } {
  const id = order.counterpart?.identifier;
  if (!id) return {};
  if (id.standard === "iban") return { acctNo: normalizeIban(id.iban) };
  if (id.standard === "chain") return { acctNo: `${id.chain}:${id.address}` };
  return { acctNo: id.accountNumber, bankCode: id.bic };
}

export function paymentPurpose(order: MoneriumOrder): string {
  const memo = (order.memo ?? "").trim();
  const ref = (order.referenceNumber ?? "").trim();
  if (ref && !memo.includes(ref)) return memo ? `${memo} (${ref})` : ref;
  return memo;
}

/** Calendar day of an RFC3339 timestamp, in UTC. Used only for matching. */
export function dayOf(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

/**
 * What two sources must agree on to be the same movement: the day, the
 * signed amount, the counterpart's account and the purpose. sevDesk has no
 * external-id field on a transaction, so this is how a lost state file is
 * recovered without creating the same line twice.
 */
export function fingerprint(p: { day: string; cents: bigint; acctNo?: string | null; purpose?: string | null }): string {
  return [p.day, formatCents(p.cents), (p.acctNo ?? "").trim(), (p.purpose ?? "").trim()].join("|");
}

export function fingerprintOfSevdesk(t: SevdeskTransaction): string | undefined {
  try {
    return fingerprint({ day: dayOf(t.valueDate), cents: toCents(t.amount), acctNo: t.payeePayerAcctNo, purpose: t.paymtPurpose });
  } catch {
    return undefined;
  }
}

export function mapOrder(order: MoneriumOrder, checkAccountId: number): MappingResult {
  if (order.state !== "processed") return { ok: false, reason: `order is ${order.state}, not processed` };
  if (order.currency !== "eur") return { ok: false, reason: `currency ${order.currency} is not eur` };
  let cents: bigint;
  try {
    cents = toCents(order.amount);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  if (cents <= 0n) return { ok: false, reason: `amount ${order.amount} is not positive` };
  const signed = order.kind === "issue" ? cents : -cents;
  const valueDate = order.meta.processedAt ?? order.meta.placedAt;
  const { acctNo, bankCode } = counterpartAccount(order);
  const purpose = paymentPurpose(order);
  const draft: SevdeskTransactionCreate = {
    valueDate,
    entryDate: valueDate,
    amount: centsToNumber(signed),
    payeePayerName: counterpartName(order),
    ...(acctNo ? { payeePayerAcctNo: acctNo } : {}),
    ...(bankCode ? { payeePayerBankCode: bankCode } : {}),
    paymtPurpose: purpose,
    checkAccount: { id: checkAccountId, objectName: "CheckAccount" },
    status: 100,
  };
  return { ok: true, draft, cents: signed, fingerprint: fingerprint({ day: dayOf(valueDate), cents: signed, acctNo, purpose }) };
}

// ---------------------------------------------------------------------------
// On-chain transfers
// ---------------------------------------------------------------------------
import { unitsToCents } from "./money.js";
import type { ChainTransfer } from "./chain.js";
import { ZERO_ADDRESS } from "./chain.js";

export const transferKey = (t: { chain: string; txHash: string; logIndex: number }) => `${t.chain}:${t.txHash.toLowerCase()}:${t.logIndex}`;

/**
 * A plain EURe transfer between two addresses, as a bank line. Mint and
 * burn legs (from or to the zero address) are Monerium's settlement of an
 * order and are never mapped here: the order carries the bank counterparty
 * and is the better record, and mapping both would book one payment twice.
 * The caller decides what to do with a mint/burn that matches no order.
 */
export function mapTransfer(t: ChainTransfer, account: string, decimals: number, checkAccountId: number): MappingResult {
  const me = account.toLowerCase();
  if (t.from === ZERO_ADDRESS || t.to === ZERO_ADDRESS) return { ok: false, reason: "mint/burn leg of a Monerium order" };
  if (t.from !== me && t.to !== me) return { ok: false, reason: "does not touch the account" };
  if (t.value <= 0n) return { ok: false, reason: "zero-value transfer" };
  const { cents, exact, rounded } = unitsToCents(t.value, decimals);
  if (cents === 0n) return { ok: false, reason: `dust: ${exact} EURe rounds to zero cents` };
  const incoming = t.to === me;
  const signed = incoming ? cents : -cents;
  const other = incoming ? t.from : t.to;
  const acctNo = `${t.chain}:${other}`;
  const purpose = `EURe on-chain transfer ${t.txHash}${rounded ? ` (exact ${exact} EURe)` : ""}`;
  const draft: SevdeskTransactionCreate = {
    valueDate: t.at,
    entryDate: t.at,
    amount: centsToNumber(signed),
    payeePayerName: `${t.chain} ${other}`,
    payeePayerAcctNo: acctNo,
    paymtPurpose: purpose,
    checkAccount: { id: checkAccountId, objectName: "CheckAccount" },
    status: 100,
  };
  return { ok: true, draft, cents: signed, fingerprint: fingerprint({ day: dayOf(t.at), cents: signed, acctNo, purpose }) };
}
