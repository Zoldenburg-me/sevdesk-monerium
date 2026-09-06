import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MoneriumClient } from "../src/monerium.js";
import { SevdeskClient } from "../src/sevdesk.js";
import { SyncState } from "../src/state.js";
import { applySync, checkDrift, planSync } from "../src/sync.js";
import { mapOrder, paymentPurpose } from "../src/mapping.js";
import { formatCents, toCents } from "../src/money.js";
import { order, startMoneriumStub, startSevdeskStub, type MoneriumStub, type SevdeskStub } from "./stubs.js";

const CREDS = { clientId: "app-id", clientSecret: "app-secret" };
const SEV_TOKEN = "b7794de0085f5cd00560f160f290af38";
const ADDRESS = "0xAbC0000000000000000000000000000000000001";
const IBAN = "DE02100500000054540402";

let mon: MoneriumStub;
let sev: SevdeskStub;

before(async () => {
  mon = await startMoneriumStub(CREDS);
  sev = await startSevdeskStub(SEV_TOKEN);
});
after(async () => {
  await mon.close();
  await sev.close();
});

function deps(state = SyncState.inMemory()) {
  return {
    monerium: new MoneriumClient({ baseUrl: mon.url, ...CREDS }),
    sevdesk: new SevdeskClient({ baseUrl: sev.url, token: SEV_TOKEN }),
    state,
  };
}

beforeEach(() => {
  mon.ibans = [{ iban: "DE02 1005 0000 0054 5404 02", bic: "LHVBEE22", name: "Example UG", profile: "p1", address: ADDRESS, chain: "gnosis" }];
  mon.orders = [
    order({ id: "o-issue", kind: "issue", amount: "1234.56" }),
    order({
      id: "o-redeem",
      kind: "redeem",
      amount: "200",
      memo: "Miete September",
      counterpart: { identifier: { standard: "iban", iban: "EE127310138155512606682602" }, details: { companyName: "Vermieter GmbH", country: "DE" } },
      meta: { placedAt: "2026-09-02T08:00:00Z", processedAt: "2026-09-02T08:05:00Z", txHashes: ["0xdead"] },
    }),
    order({ id: "o-pending", kind: "issue", amount: "50", state: "pending", meta: { placedAt: "2026-09-03T08:00:00Z" } }),
    order({ id: "o-rejected", kind: "redeem", amount: "75", state: "rejected", meta: { placedAt: "2026-09-03T09:00:00Z", rejectedReason: "insufficient funds" } }),
  ];
  mon.balances = { [`gnosis:${ADDRESS.toLowerCase()}`]: "1034.56" };
  sev.accounts = [{ id: "1", objectName: "CheckAccount", name: "Kasse", iban: null, type: "register", currency: "EUR", status: "100" }];
  sev.transactions = [];
  sev.failNextCreates = 0;
  sev.requests = [];
});

test("money: exact cents, sub-cent refused", () => {
  assert.equal(toCents("1234.56"), 123456n);
  assert.equal(toCents("999"), 99900n);
  assert.equal(toCents("-0.5"), -50n);
  assert.equal(toCents("12.340"), 1234n);
  assert.throws(() => toCents("0.005"), /sub-cent/);
  assert.equal(formatCents(-5n), "-0.05");
  assert.equal(formatCents(123456n), "1234.56");
});

test("mapping: issue is positive, redeem negative, only processed orders, IBAN without spaces", () => {
  const issue = mapOrder(order({ id: "a", kind: "issue", amount: "10.5" }), 7);
  assert.ok(issue.ok);
  assert.equal(issue.draft.amount, 10.5);
  assert.equal(issue.draft.payeePayerName, "Anna Kunde");
  assert.equal(issue.draft.payeePayerAcctNo, IBAN);
  assert.equal(issue.draft.paymtPurpose, "Rechnung RE-2026-001");
  assert.equal(issue.draft.valueDate, "2026-09-01T10:15:00Z");
  assert.equal(issue.draft.status, 100);
  assert.deepEqual(issue.draft.checkAccount, { id: 7, objectName: "CheckAccount" });

  const redeem = mapOrder(order({ id: "b", kind: "redeem", amount: "10.5", counterpart: { identifier: { standard: "iban", iban: "EE12 7310 1381 5551 2606 682602" }, details: { firstName: "Jane", lastName: "Doe", country: "EE" } } }), 7);
  assert.ok(redeem.ok);
  assert.equal(redeem.draft.amount, -10.5);
  assert.equal(redeem.draft.payeePayerName, "Jane Doe");

  for (const state of ["placed", "pending", "rejected"] as const) {
    const r = mapOrder(order({ id: "c", kind: "issue", amount: "1", state }), 7);
    assert.ok(!r.ok && r.reason.includes(state));
  }
  const sub = mapOrder(order({ id: "d", kind: "issue", amount: "0.005" }), 7);
  assert.ok(!sub.ok && /sub-cent/.test(sub.reason));
  const usd = mapOrder(order({ id: "e", kind: "issue", amount: "1", currency: "usd" }), 7);
  assert.ok(!usd.ok && /usd/.test(usd.reason));

  const chain = mapOrder(order({ id: "f", kind: "redeem", amount: "3", counterpart: { identifier: { standard: "chain", address: "0x1234", chain: "polygon" }, details: {} } }), 7);
  assert.ok(chain.ok);
  assert.equal(chain.draft.payeePayerAcctNo, "polygon:0x1234");
  assert.equal(chain.draft.payeePayerName, "polygon 0x1234");

  assert.equal(paymentPurpose(order({ id: "g", kind: "issue", amount: "1", memo: "Rechnung 7", referenceNumber: "RF18000000000539007547034" })), "Rechnung 7 (RF18000000000539007547034)");
  assert.equal(paymentPurpose(order({ id: "h", kind: "issue", amount: "1", memo: "RF18 already here", referenceNumber: "RF18" })), "RF18 already here");
});

test("plan without --create-accounts writes nothing and names the missing account", async () => {
  const plan = await planSync(deps());
  assert.equal(plan.ordersSeen, 4);
  assert.equal(plan.accounts[0].checkAccountId, null);
  assert.equal(plan.accounts[0].create, false);
  assert.ok(plan.actions.every((a) => a.kind === "skip"));
  const skip = plan.actions.find((a) => a.id === "o-issue");
  assert.ok(skip?.kind === "skip" && skip.reason.includes(IBAN) && skip.reason.includes("--create-accounts"));
  assert.equal(sev.requests.filter((r) => r.method === "POST").length, 0, "a plan must not POST");
});

test("apply creates the file-import account and one line per processed order; pending and rejected are skipped", async () => {
  const state = SyncState.inMemory();
  const plan = await planSync(deps(state), { createAccounts: true });
  assert.equal(plan.accounts[0].create, true);
  assert.deepEqual(
    plan.actions.map((a) => [a.id, a.kind]),
    [["o-issue", "create"], ["o-redeem", "create"], ["o-pending", "skip"], ["o-rejected", "skip"]],
  );
  const report = await applySync(deps(state), plan);
  assert.equal(report.accountsCreated.length, 1);
  assert.equal(report.created.length, 2);
  assert.equal(report.skipped.length, 2);

  const acc = sev.accounts.find((a) => a.iban === IBAN);
  assert.ok(acc, "account created with the IBAN");
  assert.equal(acc.type, "online");
  assert.equal(acc.importType, "CSV");
  const createReq = sev.requests.find((r) => r.path === "/CheckAccount/Factory/fileImportAccount");
  assert.equal(createReq?.headers.authorization, SEV_TOKEN, "raw token, no Bearer");
  assert.deepEqual(createReq?.body, { name: `Monerium ${IBAN}`, importType: "CSV", iban: IBAN });

  assert.equal(sev.transactions.length, 2);
  const [t1, t2] = sev.transactions;
  assert.equal(t1.amount, "1234.56");
  assert.equal(t1.payeePayerName, "Anna Kunde");
  assert.equal(t1.payeePayerAcctNo, IBAN);
  assert.equal(t1.checkAccount.id, acc.id);
  assert.equal(t1.status, "100");
  assert.equal(t2.amount, "-200.00");
  assert.equal(t2.payeePayerName, "Vermieter GmbH");
  assert.equal(t2.paymtPurpose, "Miete September");
  assert.equal(state.data.orders["o-issue"].transactionId, t1.id);
  assert.equal(state.data.accounts[IBAN].checkAccountId, acc.id);

  // Second run: nothing to do.
  const again = await planSync(deps(state));
  assert.deepEqual(again.actions.map((a) => a.kind), ["already", "already", "skip", "skip"]);
  await applySync(deps(state), again);
  assert.equal(sev.transactions.length, 2);
});

test("a lost state file is recovered by adopting existing rows, not by creating them again", async () => {
  const state = SyncState.inMemory();
  await applySync(deps(state), await planSync(deps(state), { createAccounts: true }));
  assert.equal(sev.transactions.length, 2);

  const fresh = SyncState.inMemory();
  const plan = await planSync(deps(fresh));
  assert.equal(plan.accounts[0].checkAccountId, sev.accounts.find((a) => a.iban === IBAN)!.id, "account found by IBAN without state");
  assert.deepEqual(plan.actions.map((a) => a.kind), ["adopt", "adopt", "skip", "skip"]);
  const report = await applySync(deps(fresh), plan);
  assert.equal(report.adopted.length, 2);
  assert.equal(report.created.length, 0);
  assert.equal(sev.transactions.length, 2);
  assert.equal(fresh.data.orders["o-redeem"].adopted, true);
});

test("two identical orders on one day are two rows, and recovery adopts one each", async () => {
  mon.orders = [order({ id: "twin-1", kind: "issue", amount: "40" }), order({ id: "twin-2", kind: "issue", amount: "40" })];
  const state = SyncState.inMemory();
  await applySync(deps(state), await planSync(deps(state), { createAccounts: true }));
  assert.equal(sev.transactions.length, 2);

  // Lose the state with one row missing on the sevDesk side: one adopt, one create.
  sev.transactions.pop();
  const fresh = SyncState.inMemory();
  const plan = await planSync(deps(fresh));
  assert.deepEqual(plan.actions.map((a) => a.kind).sort(), ["adopt", "create"]);
  await applySync(deps(fresh), plan);
  assert.equal(sev.transactions.length, 2);
  assert.notEqual(fresh.data.orders["twin-1"].transactionId, fresh.data.orders["twin-2"].transactionId);
});

test("a failed create mid-run keeps what landed and the retry creates only the rest", async () => {
  const state = SyncState.inMemory();
  const plan = await planSync(deps(state), { createAccounts: true });
  sev.failNextCreates = 0;
  // Fail the SECOND create.
  const origLength = sev.transactions.length;
  let calls = 0;
  const d = deps(state);
  const realCreate = d.sevdesk.createTransaction.bind(d.sevdesk);
  d.sevdesk.createTransaction = async (b) => {
    calls++;
    if (calls === 2) throw new Error("simulated outage");
    return realCreate(b);
  };
  await assert.rejects(applySync(d, plan), /simulated outage/);
  assert.equal(sev.transactions.length, origLength + 1);
  assert.ok(state.data.orders["o-issue"], "the landed create is recorded before the failure");
  assert.ok(!state.data.orders["o-redeem"]);

  const retry = await planSync(deps(state));
  assert.deepEqual(retry.actions.map((a) => [a.id, a.kind]), [["o-issue", "already"], ["o-redeem", "create"], ["o-pending", "skip"], ["o-rejected", "skip"]]);
  await applySync(deps(state), retry);
  assert.equal(sev.transactions.length, origLength + 2);
});

test("orders on an address without an IBAN are skipped and say why", async () => {
  mon.orders.push(order({ id: "o-other", kind: "issue", amount: "5", address: "0x0000000000000000000000000000000000000099" }));
  const plan = await planSync(deps(), { createAccounts: true });
  const s = plan.actions.find((a) => a.id === "o-other");
  assert.ok(s?.kind === "skip" && /no Monerium IBAN/.test(s.reason));
});

test("--since / --until bound the window by processedAt", async () => {
  const plan = await planSync(deps(), { createAccounts: true, since: new Date("2026-09-02T00:00:00Z"), until: new Date("2026-09-03T00:00:00Z") });
  assert.deepEqual(plan.actions.map((a) => a.id), ["o-redeem"]);
});

test("drift: agreement after a full sync, a delta when EURe moved without an order", async () => {
  const state = SyncState.inMemory();
  await applySync(deps(state), await planSync(deps(state), { createAccounts: true }));
  let lines = await checkDrift(deps(state));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].sevdeskSum, "1034.56");
  assert.equal(lines[0].deltaCents, 0n);
  assert.equal(lines[0].note, "in agreement");

  mon.balances[`gnosis:${ADDRESS.toLowerCase()}`] = "1000.00"; // 34.56 EURe sent on-chain, no order
  lines = await checkDrift(deps(state));
  assert.equal(lines[0].deltaCents, -3456n);
  assert.match(lines[0].note, /unmirrored movements/);
  assert.equal(sev.transactions.length, 2, "drift is reported, never repaired");
});

test("wrong credentials fail with the service named, and no row is written", async () => {
  const badMon = { ...deps(), monerium: new MoneriumClient({ baseUrl: mon.url, clientId: "app-id", clientSecret: "nope" }) };
  await assert.rejects(planSync(badMon, { createAccounts: true }), /Monerium refused the client id\/secret pair/);
  const badSev = { ...deps(), sevdesk: new SevdeskClient({ baseUrl: sev.url, token: "wrong" }) };
  await assert.rejects(planSync(badSev, { createAccounts: true }), /sevDesk rejected the API token/);
  assert.equal(sev.transactions.length, 0);
  assert.equal(sev.accounts.length, 1);
});

test("Monerium token is fetched once and reused", async () => {
  const d = deps();
  const before = mon.tokenGrants;
  await d.monerium.ibans();
  await d.monerium.orders();
  await d.monerium.authContext();
  assert.equal(mon.tokenGrants - before, 1);
});
