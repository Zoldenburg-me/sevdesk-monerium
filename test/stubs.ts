/**
 * In-process stand-ins for both APIs, shaped from their OpenAPI documents:
 * Monerium wants the client-credentials grant and the v2 Accept header;
 * sevDesk wants the raw token in Authorization and answers every list as
 * { objects: [...] } with string scalars. Each stub enforces its own auth so
 * a test that passes here at least sent the headers the real API demands.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { MoneriumIban, MoneriumOrder } from "../src/monerium.js";
import type { SevdeskCheckAccount, SevdeskTransaction } from "../src/sevdesk.js";

async function body(req: IncomingMessage): Promise<string> {
  let s = "";
  for await (const c of req) s += c;
  return s;
}
function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return `http://127.0.0.1:${addr.port}`;
}

export interface MoneriumStub {
  url: string;
  ibans: MoneriumIban[];
  orders: MoneriumOrder[];
  balances: Record<string, string>; // `${chain}:${address.toLowerCase()}` -> eur amount
  tokenGrants: number;
  close(): Promise<void>;
}

export async function startMoneriumStub(creds: { clientId: string; clientSecret: string }): Promise<MoneriumStub> {
  const stub: MoneriumStub = { url: "", ibans: [], orders: [], balances: {}, tokenGrants: 0, close: async () => {} };
  const token = "stub-access-token";
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "POST" && url.pathname === "/auth/token") {
      const p = new URLSearchParams(await body(req));
      if (p.get("grant_type") !== "client_credentials" || p.get("client_id") !== creds.clientId || p.get("client_secret") !== creds.clientSecret) {
        return json(res, 401, { code: 401, status: "Unauthorized", message: "invalid client" });
      }
      stub.tokenGrants++;
      return json(res, 200, { access_token: token, token_type: "Bearer", expires_in: 3600 });
    }
    if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { message: "no token" });
    if (req.headers.accept !== "application/vnd.monerium.api-v2+json") return json(res, 406, { message: "v2 accept header required" });
    if (url.pathname === "/auth/context") return json(res, 200, { userId: "u1", email: "ops@example.test", name: "Example UG", defaultProfile: "p1", profiles: [{ id: "p1", kind: "corporate", name: "Example UG" }] });
    if (url.pathname === "/ibans") return json(res, 200, { ibans: stub.ibans });
    if (url.pathname === "/orders") {
      const state = url.searchParams.get("state");
      const address = url.searchParams.get("address");
      return json(res, 200, { orders: stub.orders.filter((o) => (!state || o.state === state) && (!address || o.address.toLowerCase() === address.toLowerCase())) });
    }
    const m = /^\/balances\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (m) {
      const amount = stub.balances[`${m[1]}:${m[2].toLowerCase()}`];
      return json(res, 200, { address: m[2], chain: m[1], balances: amount === undefined ? [] : [{ currency: "eur", amount }] });
    }
    json(res, 404, { message: `stub: no route ${req.method} ${url.pathname}` });
  });
  stub.url = await listen(server);
  stub.close = () => new Promise((r) => server.close(() => r()));
  return stub;
}

export interface SevdeskStub {
  url: string;
  accounts: SevdeskCheckAccount[];
  transactions: SevdeskTransaction[];
  /** Fail the next N transaction creates with a 500, to test crash recovery. */
  failNextCreates: number;
  requests: { method: string; path: string; headers: IncomingMessage["headers"]; body: unknown }[];
  close(): Promise<void>;
}

export async function startSevdeskStub(token: string): Promise<SevdeskStub> {
  const stub: SevdeskStub = { url: "", accounts: [], transactions: [], failNextCreates: 0, requests: [], close: async () => {} };
  let nextId = 1000;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const raw = await body(req);
    const parsed = raw ? JSON.parse(raw) : undefined;
    stub.requests.push({ method: req.method ?? "", path: url.pathname, headers: req.headers, body: parsed });
    if (req.headers.authorization !== token) return json(res, 401, { error: { message: "Authentication required" } });
    if (req.method === "GET" && url.pathname === "/Tools/bookkeepingSystemVersion") return json(res, 200, { objects: { version: "2.0" } });
    if (req.method === "GET" && url.pathname === "/CheckAccount") return json(res, 200, { objects: stub.accounts });
    if (req.method === "POST" && url.pathname === "/CheckAccount/Factory/fileImportAccount") {
      const acc: SevdeskCheckAccount = { id: String(nextId++), objectName: "CheckAccount", name: parsed.name, iban: parsed.iban ?? null, type: "online", importType: parsed.importType, currency: "EUR", status: "100", autoMapTransactions: "1" };
      stub.accounts.push(acc);
      return json(res, 201, { objects: acc });
    }
    if (req.method === "GET" && url.pathname === "/CheckAccountTransaction") {
      const accId = url.searchParams.get("checkAccount[id]");
      const start = url.searchParams.get("startDate");
      const end = url.searchParams.get("endDate");
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const rows = stub.transactions
        .filter((t) => !accId || t.checkAccount.id === accId)
        .filter((t) => !start || t.valueDate >= start)
        .filter((t) => !end || t.valueDate <= end)
        .slice(offset, offset + limit);
      return json(res, 200, { objects: rows });
    }
    if (req.method === "POST" && url.pathname === "/CheckAccountTransaction") {
      if (stub.failNextCreates > 0) {
        stub.failNextCreates--;
        return json(res, 500, { error: { message: "stub: simulated outage" } });
      }
      for (const k of ["valueDate", "checkAccount", "amount", "status", "payeePayerName"]) {
        if (parsed[k] === undefined) return json(res, 400, { error: { message: `missing ${k}` } });
      }
      const row: SevdeskTransaction = {
        id: String(nextId++),
        objectName: "CheckAccountTransaction",
        valueDate: parsed.valueDate,
        entryDate: parsed.entryDate ?? null,
        amount: Number(parsed.amount).toFixed(2),
        payeePayerName: parsed.payeePayerName,
        payeePayerAcctNo: parsed.payeePayerAcctNo ?? null,
        payeePayerBankCode: parsed.payeePayerBankCode ?? null,
        paymtPurpose: parsed.paymtPurpose ?? null,
        checkAccount: { id: String(parsed.checkAccount.id), objectName: "CheckAccount" },
        status: String(parsed.status) as SevdeskTransaction["status"],
      };
      stub.transactions.push(row);
      return json(res, 201, { objects: row });
    }
    json(res, 404, { error: { message: `stub: no route ${req.method} ${url.pathname}` } });
  });
  stub.url = await listen(server);
  stub.close = () => new Promise((r) => server.close(() => r()));
  return stub;
}

export function order(o: Partial<MoneriumOrder> & { id: string; kind: MoneriumOrder["kind"]; amount: string }): MoneriumOrder {
  return {
    profile: "p1",
    address: "0xAbC0000000000000000000000000000000000001",
    chain: "gnosis",
    currency: "eur",
    counterpart: { identifier: { standard: "iban", iban: "DE02 1005 0000 0054 5404 02" }, details: { name: "Anna Kunde", address: "Berlin" } },
    memo: "Rechnung RE-2026-001",
    state: "processed",
    meta: { placedAt: "2026-09-01T09:00:00Z", processedAt: "2026-09-01T10:15:00Z" },
    ...o,
  };
}
