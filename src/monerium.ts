/**
 * Minimal Monerium API v2 client for a PRIVATE application: the
 * client-credentials grant, whose token sees only the owning account's
 * wallets, IBANs and orders. Read-only by construction — this module has no
 * method that places an order, links an address or requests an IBAN.
 *
 * Shapes are taken from Monerium's published OpenAPI document
 * (https://docs.monerium.com/redocusaurus/api.yaml), not from memory.
 */

export class MoneriumApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "MoneriumApiError";
  }
}

export interface MoneriumConfig {
  baseUrl: string; // https://api.monerium.dev (sandbox) | https://api.monerium.app (production)
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
}

export type OrderKind = "issue" | "redeem";
export type OrderState = "placed" | "pending" | "processed" | "rejected";

export type CounterpartIdentifier =
  | { standard: "iban"; iban: string }
  | { standard: "chain"; address: string; chain: string }
  | { standard: "account"; accountNumber: string; address?: string; bic?: string };

/** Three shapes, by Monerium's spec: issue orders carry {name,address};
 *  redeem orders carry {firstName,lastName,country} or {companyName,country}. */
export interface CounterpartDetails {
  name?: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  country?: string;
  address?: string;
  [k: string]: unknown;
}

export interface MoneriumOrder {
  id: string;
  kind: OrderKind;
  profile: string;
  address: string;
  chain: string;
  currency: "eur" | "usd" | "gbp" | "isk";
  amount: string;
  counterpart: { identifier?: CounterpartIdentifier; details?: CounterpartDetails };
  memo: string;
  referenceNumber?: string;
  state: OrderState;
  meta: {
    placedAt: string;
    processedAt?: string;
    rejectedReason?: string;
    supportingDocumentId?: string;
    txHashes?: string[];
  };
}

export interface MoneriumIban {
  iban: string;
  bic: string;
  name?: string;
  profile: string;
  address: string;
  chain: string;
}

export interface OrdersQuery {
  profile?: string;
  address?: string;
  state?: OrderState;
  memo?: string;
  txHash?: string;
}

export class MoneriumClient {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly fetch: typeof fetch;

  constructor(private readonly cfg: MoneriumConfig) {
    this.fetch = cfg.fetch ?? globalThis.fetch;
  }

  get environment(): "sandbox" | "production" | "other" {
    const host = new URL(this.cfg.baseUrl).host;
    if (host === "api.monerium.dev") return "sandbox";
    if (host === "api.monerium.app") return "production";
    return "other";
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    const res = await this.fetch(`${this.cfg.baseUrl}/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
      }),
    }).catch((e: Error) => {
      throw new MoneriumApiError(`Monerium unreachable at ${new URL(this.cfg.baseUrl).host}: ${e.cause instanceof Error ? e.cause.message : e.message}`, 0);
    });
    if (!res.ok) {
      const text = await res.text();
      const hint =
        res.status === 400 || res.status === 401 || res.status === 403
          ? ` — Monerium refused the client id/secret pair against ${this.cfg.baseUrl} (${this.environment}). Sandbox keys against production, or the reverse, is the usual cause.`
          : "";
      throw new MoneriumApiError(`Monerium auth failed (${res.status}): ${text}${hint}`, res.status);
    }
    const data = (await res.json()) as { access_token: string; expires_in?: number };
    this.token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async get<T>(path: string, query?: Record<string, string | undefined>): Promise<T> {
    const token = await this.accessToken();
    const url = new URL(`${this.cfg.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v) url.searchParams.set(k, v);
    const res = await this.fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.monerium.api-v2+json" },
    }).catch((e: Error) => {
      throw new MoneriumApiError(`Monerium unreachable at ${url.host}: ${e.cause instanceof Error ? e.cause.message : e.message}`, 0);
    });
    const text = await res.text();
    if (!res.ok) throw new MoneriumApiError(`Monerium GET ${path} failed (${res.status}): ${text}`, res.status);
    return (text ? JSON.parse(text) : {}) as T;
  }

  authContext() {
    return this.get<{ userId: string; email: string; name: string; defaultProfile: string; profiles: { id: string; kind: string; name: string }[] }>("/auth/context");
  }

  async ibans(profile?: string): Promise<MoneriumIban[]> {
    const res = await this.get<{ ibans: MoneriumIban[] } | MoneriumIban[]>("/ibans", { profile });
    return Array.isArray(res) ? res : (res.ibans ?? []);
  }

  /**
   * Orders visible to this application. Monerium documents no pagination on
   * this endpoint; if an account ever outgrows one response, filter by
   * `address` or `state` to narrow it. Without `profile` Monerium answers
   * with the caller's default profile.
   */
  async orders(q: OrdersQuery = {}): Promise<MoneriumOrder[]> {
    const res = await this.get<{ orders: MoneriumOrder[] } | MoneriumOrder[]>("/orders", { ...q });
    return Array.isArray(res) ? res : (res.orders ?? []);
  }

  /** Token balance of one address on one chain, as Monerium sees it. */
  async balance(chain: string, address: string, currency = "eur"): Promise<string | undefined> {
    const res = await this.get<{ balances?: { currency: string; amount: string }[] }>(
      `/balances/${encodeURIComponent(chain)}/${encodeURIComponent(address)}`,
    );
    return res.balances?.find((b) => b.currency === currency)?.amount;
  }
}
