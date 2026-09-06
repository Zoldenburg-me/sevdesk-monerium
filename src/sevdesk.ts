/**
 * Minimal sevDesk API v1 client, limited to what mirroring bank activity
 * needs: list check accounts, create a CSV file-import account, list and
 * create transactions. Nothing here books, links or enshrines anything —
 * every transaction is created at status 100 ("created") and left for the
 * bookkeeper or sevDesk's own auto-mapping to match against invoices.
 *
 * Shapes come from https://api.sevdesk.de/openapi.yaml:
 *  - auth is the raw API token in the Authorization header, no "Bearer";
 *  - every list answers { objects: [...] } and pages with limit/offset;
 *  - "If you want to create payment entries via API, use a file import
 *    account" — hence createFileImportAccount, never a clearing account;
 *  - POST /CheckAccountTransaction: "only status 100 makes sense".
 */

export class SevdeskApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "SevdeskApiError";
  }
}

export interface SevdeskConfig {
  baseUrl?: string; // default https://my.sevdesk.de/api/v1
  token: string;
  fetch?: typeof fetch;
}

export interface SevdeskCheckAccount {
  id: string;
  objectName: "CheckAccount";
  name: string;
  iban: string | null;
  type: "online" | "offline" | "register";
  importType?: "CSV" | "MT940" | null;
  currency: string;
  status: "0" | "100";
  accountingNumber?: string;
  autoMapTransactions?: string | null;
}

/** What POST /CheckAccountTransaction accepts. Amount is a float on the wire. */
export interface SevdeskTransactionCreate {
  valueDate: string;
  entryDate?: string;
  amount: number;
  payeePayerName: string;
  payeePayerAcctNo?: string;
  payeePayerBankCode?: string;
  paymtPurpose?: string;
  checkAccount: { id: number; objectName: "CheckAccount" };
  status: 100;
}

/** What sevDesk returns: every scalar is a string, including amount and status. */
export interface SevdeskTransaction {
  id: string;
  objectName: "CheckAccountTransaction";
  valueDate: string;
  entryDate?: string | null;
  amount: string;
  payeePayerName: string | null;
  payeePayerAcctNo?: string | null;
  payeePayerBankCode?: string | null;
  paymtPurpose?: string | null;
  checkAccount: { id: string; objectName: "CheckAccount" };
  status: "100" | "200" | "300" | "350" | "400";
}

export class SevdeskClient {
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly cfg: SevdeskConfig) {
    this.baseUrl = (cfg.baseUrl ?? "https://my.sevdesk.de/api/v1").replace(/\/$/, "");
    this.fetch = cfg.fetch ?? globalThis.fetch;
  }

  private async request<T>(method: string, path: string, opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const res = await this.fetch(url, {
      method,
      headers: {
        authorization: this.cfg.token,
        accept: "application/json",
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }).catch((e: Error) => {
      throw new SevdeskApiError(`sevDesk unreachable at ${url.host}: ${e.cause instanceof Error ? e.cause.message : e.message}`, 0);
    });
    const text = await res.text();
    if (!res.ok) {
      const hint = res.status === 401 ? " — sevDesk rejected the API token (Settings -> Users -> API token)." : "";
      throw new SevdeskApiError(`sevDesk ${method} ${path} failed (${res.status}): ${text.slice(0, 500)}${hint}`, res.status);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async bookkeepingVersion(): Promise<string> {
    const res = await this.request<{ objects?: { version?: string } }>("GET", "/Tools/bookkeepingSystemVersion");
    return res.objects?.version ?? "unknown";
  }

  async checkAccounts(): Promise<SevdeskCheckAccount[]> {
    const res = await this.request<{ objects: SevdeskCheckAccount[] }>("GET", "/CheckAccount");
    return res.objects ?? [];
  }

  /** The one account type the API lets us create AND post transactions to. */
  async createFileImportAccount(input: { name: string; iban: string; accountingNumber?: number }): Promise<SevdeskCheckAccount> {
    const res = await this.request<{ objects: SevdeskCheckAccount }>("POST", "/CheckAccount/Factory/fileImportAccount", {
      body: { name: input.name, importType: "CSV", iban: input.iban, ...(input.accountingNumber ? { accountingNumber: input.accountingNumber } : {}) },
    });
    return res.objects;
  }

  async transactionsPage(params: { checkAccountId: string | number; startDate?: string; endDate?: string; limit: number; offset: number }): Promise<SevdeskTransaction[]> {
    const res = await this.request<{ objects: SevdeskTransaction[] }>("GET", "/CheckAccountTransaction", {
      query: {
        "checkAccount[id]": params.checkAccountId,
        "checkAccount[objectName]": "CheckAccount",
        startDate: params.startDate,
        endDate: params.endDate,
        limit: params.limit,
        offset: params.offset,
      },
    });
    return res.objects ?? [];
  }

  /** Walks every page. A page shorter than `limit` is the last one. */
  async allTransactions(params: { checkAccountId: string | number; startDate?: string; endDate?: string }, limit = 500): Promise<SevdeskTransaction[]> {
    const out: SevdeskTransaction[] = [];
    for (let offset = 0; ; offset += limit) {
      const page = await this.transactionsPage({ ...params, limit, offset });
      out.push(...page);
      if (page.length < limit) return out;
    }
  }

  async createTransaction(body: SevdeskTransactionCreate): Promise<SevdeskTransaction> {
    const res = await this.request<{ objects: SevdeskTransaction } | SevdeskTransaction>("POST", "/CheckAccountTransaction", { body });
    return "objects" in res ? res.objects : res;
  }
}
