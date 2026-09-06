import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MoneriumClient } from "../src/monerium.js";
import { SevdeskClient } from "../src/sevdesk.js";
import { SyncState } from "../src/state.js";
import { applySync, checkDrift, planSync } from "../src/sync.js";
import { JsonRpc } from "../src/chain.js";
import { mapTransfer } from "../src/mapping.js";
import { roundToCents, unitsToCents } from "../src/money.js";
import { order, startMoneriumStub, startRpcStub, startSevdeskStub, type MoneriumStub, type RpcStub, type SevdeskStub } from "./stubs.js";

const CREDS = { clientId: "app-id", clientSecret: "app-secret" };
const SEV_TOKEN = "b7794de0085f5cd00560f160f290af38";
const ME = "0xabc0000000000000000000000000000000000001";
const EURE = "0xcb444e90d8198415266c6a2724b7900fb12fc56e";
const ZERO = "0x0000000000000000000000000000000000000000";
const BOB = "0x000000000000000000000000000000000000b0b0";
const ALICE = "0x00000000000000000000000000000000000a11ce";
const E = 10n ** 18n;

let mon: MoneriumStub;
let sev: SevdeskStub;
let rpc: RpcStub;

before(async () => {
  mon = await startMoneriumStub(CREDS);
  sev = await startSevdeskStub(SEV_TOKEN);
  rpc = await startRpcStub();
});
after(async () => {
  await mon.close();
  await sev.close();
  await rpc.close();
});

function deps(state = SyncState.inMemory(), rpcUrl = rpc.url) {
  return {
    monerium: new MoneriumClient({ baseUrl: mon.url, ...CREDS }),
    sevdesk: new SevdeskClient({ baseUrl: sev.url, token: SEV_TOKEN }),
    state,
    rpcFor: (chain: string) => (chain === "gnosis" ? new JsonRpc(rpcUrl) : undefined),
  };
}

// Block n is mined at genesis + 5n seconds. Genesis is 2026-08-01T00:00Z, so
// 2026-09-01T10:15:00Z (the issue order's processedAt) is block 541_620.
const blockAt = (iso: string) => Math.round((Date.parse(iso) / 1000 - rpc.genesisTime) / rpc.blockSeconds);

beforeEach(() => {
  mon.ibans = [{ iban: "DE02 1005 0000 0054 5404 02", bic: "LHVBEE22", profile: "p1", address: ME, chain: "gnosis" }];
  mon.tokens = [{ kind: "evm", address: EURE, decimals: 18, chain: "gnosis", chainId: 100, currency: "eur", symbol: "EURe" }, { kind: "evm", address: "0x1234", decimals: 6, chain: "gnosis", chainId: 100, currency: "usd", symbol: "USDe" }];
  mon.orders = [
    order({ id: "o-issue", kind: "issue", amount: "1234.56", address: ME, meta: { placedAt: "2026-09-01T09:00:00Z", processedAt: "2026-09-01T10:15:00Z", txHashes: ["0xMINT1"] } }),
    order({ id: "o-redeem", kind: "redeem", amount: "200", address: ME, memo: "Miete September", counterpart: { identifier: { standard: "iban", iban: "EE127310138155512606682602" }, details: { companyName: "Vermieter GmbH", country: "DE" } }, meta: { placedAt: "2026-09-02T08:00:00Z", processedAt: "2026-09-02T08:05:00Z", txHashes: ["0xburn1"] } }),
  ];
  rpc.chainId = 100;
  rpc.maxRange = 100_000;
  rpc.head = blockAt("2026-09-05T00:00:00Z");
  rpc.calls = [];
  rpc.logs = [
    { token: EURE, from: ZERO, to: ME, value: 123456n * E / 100n, blockNumber: blockAt("2026-09-01T10:15:00Z"), txHash: "0xmint1", logIndex: 3 },
    { token: EURE, from: ME, to: ZERO, value: 200n * E, blockNumber: blockAt("2026-09-02T08:05:00Z"), txHash: "0xburn1", logIndex: 1 },
    { token: EURE, from: ME, to: BOB, value: 3456n * E / 100n, blockNumber: blockAt("2026-09-03T12:00:00Z"), txHash: "0xplainout", logIndex: 0 },
    { token: EURE, from: ALICE, to: ME, value: 10005n * E / 1000n, blockNumber: blockAt("2026-09-04T09:30:00Z"), txHash: "0xplainin", logIndex: 2 },
    { token: EURE, from: ZERO, to: ME, value: 7n * E, blockNumber: blockAt("2026-09-04T10:00:00Z"), txHash: "0xorphanmint", logIndex: 0 },
    { token: "0x1234", from: ALICE, to: ME, value: 99n, blockNumber: blockAt("2026-09-04T11:00:00Z"), txHash: "0xusd", logIndex: 0 },
  ];
  // 1234.56 - 200 - 34.56 + 10.005 + 7 (orphan mint) = 1017.005
  mon.balances = { [`gnosis:${ME}`]: "1017.005" };
  sev.accounts = [];
  sev.transactions = [];
  sev.requests = [];
});

test("units: 18-decimal amounts to cents, half-up, exact figure kept", () => {
  assert.deepEqual(unitsToCents(10005n * E / 1000n, 18), { cents: 1001n, exact: "10.005", rounded: true });
  assert.deepEqual(unitsToCents(3456n * E / 100n, 18), { cents: 3456n, exact: "34.56", rounded: false });
  assert.deepEqual(unitsToCents(1n, 18), { cents: 0n, exact: "0.000000000000000001", rounded: true });
  assert.deepEqual(unitsToCents(5n, 6), { cents: 0n, exact: "0.000005", rounded: true });
  assert.equal(unitsToCents(1234567n, 6).cents, 123n);
  assert.equal(roundToCents("1017.005"), 201701n);
  assert.equal(roundToCents("-0.004"), 0n);
});

test("mapTransfer: direction by our address, mint/burn refused, rounding shown in the purpose", () => {
  const out = mapTransfer({ chain: "gnosis", txHash: "0xa", logIndex: 0, blockNumber: 1, at: "2026-09-03T12:00:00Z", from: ME, to: BOB, value: 3456n * E / 100n }, ME, 18, 9);
  assert.ok(out.ok);
  assert.equal(out.draft.amount, -34.56);
  assert.equal(out.draft.payeePayerName, `gnosis ${BOB}`);
  assert.equal(out.draft.payeePayerAcctNo, `gnosis:${BOB}`);
  assert.equal(out.draft.paymtPurpose, "EURe on-chain transfer 0xa");
  const inn = mapTransfer({ chain: "gnosis", txHash: "0xb", logIndex: 0, blockNumber: 1, at: "2026-09-04T09:30:00Z", from: ALICE, to: ME, value: 10005n * E / 1000n }, ME, 18, 9);
  assert.ok(inn.ok);
  assert.equal(inn.draft.amount, 10.01);
  assert.match(inn.draft.paymtPurpose!, /\(exact 10\.005 EURe\)$/);
  const mint = mapTransfer({ chain: "gnosis", txHash: "0xc", logIndex: 0, blockNumber: 1, at: "2026-09-04T09:30:00Z", from: ZERO, to: ME, value: E }, ME, 18, 9);
  assert.ok(!mint.ok && /mint\/burn/.test(mint.reason));
});

test("blockAtOrBefore / firstBlockAtOrAfter: binary search over block times", async () => {
  const j = new JsonRpc(rpc.url);
  assert.equal(await j.blockAtOrBefore(new Date("2026-09-01T10:15:00Z")), blockAt("2026-09-01T10:15:00Z"));
  assert.equal(await j.blockAtOrBefore(new Date("2026-09-01T10:15:03Z")), blockAt("2026-09-01T10:15:00Z"));
  assert.equal(await j.firstBlockAtOrAfter(new Date("2026-09-01T10:15:01Z")), blockAt("2026-09-01T10:15:00Z") + 1);
  assert.equal(await j.blockAtOrBefore(new Date("2020-01-01T00:00:00Z")), null);
  assert.equal(await j.firstBlockAtOrAfter(new Date("2020-01-01T00:00:00Z")), 0);
  assert.equal(await j.blockAtOrBefore(new Date("2030-01-01T00:00:00Z")), rpc.head);
  const reads = rpc.calls.filter((c) => c.method === "eth_getBlockByNumber").length;
  assert.ok(reads < 200, `binary search, not a linear walk: ${reads} block reads`);
});

test("sync reads both sources: plain transfers booked, mint/burn folded onto their orders, orphan mint reported", async () => {
  const state = SyncState.inMemory();
  const plan = await planSync(deps(state), { createAccounts: true, since: new Date("2026-09-01T00:00:00Z") });
  assert.equal(plan.notes.length, 0, plan.notes.join("; "));
  assert.equal(plan.transfersSeen, 5, "USD token logs are not read");
  const kinds = Object.fromEntries(plan.actions.map((a) => [a.id, a.kind]));
  assert.equal(kinds["o-issue"], "create");
  assert.equal(kinds["o-redeem"], "create");
  assert.equal(kinds["gnosis:0xmint1:3"], "covered");
  assert.equal(kinds["gnosis:0xburn1:1"], "covered");
  assert.equal(kinds["gnosis:0xplainout:0"], "create");
  assert.equal(kinds["gnosis:0xplainin:2"], "create");
  assert.equal(kinds["gnosis:0xorphanmint:0"], "skip");
  const orphan = plan.actions.find((a) => a.id === "gnosis:0xorphanmint:0");
  assert.ok(orphan?.kind === "skip" && /matches no Monerium order/.test(orphan.reason));
  const creates = plan.actions.filter((a) => a.kind === "create");
  assert.deepEqual(creates.map((a) => a.kind === "create" && a.draft.valueDate.slice(0, 10)), ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"], "date order across sources");
  assert.equal(plan.accounts[0].scan?.fromBlock, blockAt("2026-09-01T00:00:00Z"));
  assert.equal(plan.accounts[0].scan?.toBlock, rpc.head - 12);

  const report = await applySync(deps(state), plan);
  assert.equal(report.created.length, 4);
  assert.equal(report.covered, 2);
  assert.equal(report.skipped.length, 1);
  assert.equal(state.data.cursors[`gnosis:${ME}`].lastScannedBlock, rpc.head - 12);
  const rows = sev.transactions.map((t) => [t.amount, t.payeePayerAcctNo]);
  assert.deepEqual(rows, [["1234.56", "DE02100500000054540402"], ["-200.00", "EE127310138155512606682602"], ["-34.56", `gnosis:${BOB}`], ["10.01", `gnosis:${ALICE}`]]);

  // Second run: the cursor advances from the last scanned block, nothing new.
  rpc.calls = [];
  const again = await planSync(deps(state));
  assert.equal(again.accounts[0].scan?.note, "nothing new");
  assert.deepEqual(again.actions.map((a) => a.kind), ["already", "already"]);
  assert.equal(rpc.calls.filter((c) => c.method === "eth_getLogs").length, 0);

  // Drift: 1017.005 rounds to 1017.01; sevDesk holds 1010.01; the 7 EUR orphan mint is the delta.
  const drift = await checkDrift(deps(state));
  assert.equal(drift[0].sevdeskSum, "1010.01");
  assert.equal(drift[0].deltaCents, 700n);
  assert.match(drift[0].note, /mint\/burn with no visible order/);
});

test("new blocks after the cursor are picked up on the next run", async () => {
  const state = SyncState.inMemory();
  await applySync(deps(state), await planSync(deps(state), { createAccounts: true, since: new Date("2026-09-01T00:00:00Z") }));
  rpc.head += 5000;
  rpc.logs.push({ token: EURE, from: ME, to: BOB, value: 5n * E, blockNumber: rpc.head - 100, txHash: "0xlater", logIndex: 0 });
  const plan = await planSync(deps(state));
  assert.equal(plan.accounts[0].scan?.fromBlock, state.data.cursors[`gnosis:${ME}`].lastScannedBlock + 1);
  assert.deepEqual(plan.actions.filter((a) => a.kind === "create").map((a) => a.id), ["gnosis:0xlater:0"]);
  await applySync(deps(state), plan);
  assert.equal(sev.transactions.length, 5);
});

test("a lost state file adopts on-chain rows too, and never books a transfer twice", async () => {
  const state = SyncState.inMemory();
  await applySync(deps(state), await planSync(deps(state), { createAccounts: true, since: new Date("2026-09-01T00:00:00Z") }));
  const fresh = SyncState.inMemory();
  const plan = await planSync(deps(fresh), { since: new Date("2026-09-01T00:00:00Z") });
  const adopted = plan.actions.filter((a) => a.kind === "adopt").map((a) => a.id).sort();
  assert.deepEqual(adopted, ["gnosis:0xplainin:2", "gnosis:0xplainout:0", "o-issue", "o-redeem"]);
  assert.equal(plan.actions.filter((a) => a.kind === "create").length, 0);
  await applySync(deps(fresh), plan);
  assert.equal(sev.transactions.length, 4);
});

test("a node that caps the block range is handled by halving the span, not by failing", async () => {
  rpc.maxRange = 1000;
  const state = SyncState.inMemory();
  const plan = await planSync(deps(state), { createAccounts: true, since: new Date("2026-09-01T00:00:00Z"), maxBlockSpan: 5000 });
  assert.equal(plan.notes.length, 0, plan.notes.join("; "));
  assert.equal(plan.transfersSeen, 5);
  const spans = rpc.calls.filter((c) => c.method === "eth_getLogs").map((c) => { const f = c.params[0] as { fromBlock: string; toBlock: string }; return Number(f.toBlock) - Number(f.fromBlock) + 1; });
  assert.ok(spans.some((s) => s > 1000), "the first ask was the large span");
  assert.ok(spans.filter((s) => s <= 1000).length > 10, "later asks fit the cap");
});

test("the wrong RPC (chain id mismatch) is refused; orders still sync; the note says why", async () => {
  rpc.chainId = 137;
  const state = SyncState.inMemory();
  const plan = await planSync(deps(state), { createAccounts: true, since: new Date("2026-09-01T00:00:00Z") });
  assert.equal(plan.transfersSeen, 0);
  assert.match(plan.notes[0], /reports chain id 137, Monerium says 100/);
  assert.deepEqual(plan.actions.map((a) => a.kind), ["create", "create"]);
  assert.equal(rpc.calls.filter((c) => c.method === "eth_getLogs").length, 0);
});

test("first scan without --since and without any order refuses on-chain reading, loudly", async () => {
  mon.orders = [];
  const plan = await planSync(deps(), { createAccounts: true });
  assert.match(plan.notes[0], /needs --since/);
  assert.equal(plan.transfersSeen, 0);
});

test("--no-chain and an unreachable RPC both leave the order source working", async () => {
  const off = await planSync(deps(), { createAccounts: true, chain: false, since: new Date("2026-09-01T00:00:00Z") });
  assert.equal(off.transfersSeen, 0);
  assert.equal(off.actions.length, 2);
  const dead = await planSync(deps(SyncState.inMemory(), "http://127.0.0.1:9"), { createAccounts: true, since: new Date("2026-09-01T00:00:00Z") });
  assert.match(dead.notes[0], /on-chain read failed.*RPC unreachable/);
  assert.equal(dead.actions.length, 2);
});
