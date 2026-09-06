/**
 * The on-chain source: ERC-20 Transfer events of Monerium's EURe contract
 * touching the account's address. Ported from Zold's deposit scanner and
 * statement builder (chunked eth_getLogs under a block-span cap; binary
 * search from a timestamp to a block), rewritten over raw JSON-RPC so this
 * repo carries no chain library.
 *
 * WHY THIS SOURCE EXISTS: Monerium's order list covers SEPA and cross-chain
 * orders. A plain token transfer from the wallet to another address is real
 * money leaving the account with no order behind it, so a mirror built on
 * orders alone drifts from the balance the moment anyone moves EURe on-chain.
 *
 * The chain id reported by the RPC is checked against the one Monerium
 * publishes for the token's chain before any log is read. A wrong RPC is
 * invisible otherwise: the contract address exists nowhere, every range
 * returns nothing, and the mirror looks complete.
 */

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Public RPCs per Monerium chain name. Override with RPC_URL_<CHAIN>. */
export const DEFAULT_RPC_URLS: Record<string, string> = {
  ethereum: "https://ethereum-rpc.publicnode.com",
  gnosis: "https://rpc.gnosischain.com",
  polygon: "https://polygon-bor-rpc.publicnode.com",
  base: "https://mainnet.base.org",
  arbitrum: "https://arb1.arbitrum.io/rpc",
  linea: "https://rpc.linea.build",
  sepolia: "https://ethereum-sepolia-rpc.publicnode.com",
  chiado: "https://rpc.chiadochain.net",
  amoy: "https://polygon-amoy-bor-rpc.publicnode.com",
  basesepolia: "https://sepolia.base.org",
  arbitrumsepolia: "https://sepolia-rollup.arbitrum.io/rpc",
  lineasepolia: "https://rpc.sepolia.linea.build",
};

export function rpcUrlFor(chain: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`RPC_URL_${chain.toUpperCase()}`] || DEFAULT_RPC_URLS[chain];
}

export class RpcError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = "RpcError";
  }
}

export interface ChainTransfer {
  chain: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  /** ISO timestamp of the block. */
  at: string;
  from: string; // lowercase
  to: string; // lowercase
  /** Raw token units (wei-style integer). */
  value: bigint;
}

interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
  removed?: boolean;
}

const hex = (n: number | bigint) => `0x${n.toString(16)}`;
const addressTopic = (address: string) => `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
const topicToAddress = (topic: string) => `0x${topic.slice(-40).toLowerCase()}`;

export class JsonRpc {
  private id = 0;
  private readonly fetch: typeof fetch;
  private blockTimes = new Map<number, number>();
  private earliest: number | undefined;

  constructor(readonly url: string, opts: { fetch?: typeof fetch } = {}) {
    this.fetch = opts.fetch ?? globalThis.fetch;
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const res = await this.fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
    }).catch((e: Error) => {
      throw new RpcError(`RPC unreachable at ${new URL(this.url).host}: ${e.cause instanceof Error ? e.cause.message : e.message}`);
    });
    const text = await res.text();
    if (!res.ok) throw new RpcError(`RPC ${method} failed (${res.status}): ${text.slice(0, 300)}`);
    const body = JSON.parse(text) as { result?: T; error?: { code?: number; message?: string } };
    if (body.error) throw new RpcError(`RPC ${method}: ${body.error.message ?? "error"}`, body.error.code);
    return body.result as T;
  }

  async chainId(): Promise<number> {
    return Number(await this.call<string>("eth_chainId"));
  }

  async headNumber(): Promise<number> {
    return Number(await this.call<string>("eth_blockNumber"));
  }

  /** Block timestamp in seconds, cached — a scan asks for the same block repeatedly. */
  async blockTimestamp(number: number): Promise<number> {
    const cached = this.blockTimes.get(number);
    if (cached !== undefined) return cached;
    const blk = await this.call<{ timestamp: string } | null>("eth_getBlockByNumber", [hex(number), false]);
    if (!blk) throw new RpcError(`block ${number} not found`);
    const ts = Number(blk.timestamp);
    this.blockTimes.set(number, ts);
    return ts;
  }

  /**
   * The oldest block this node still serves. Public nodes prune: Base
   * Sepolia's answers "pruned history unavailable: requested 0, earliest
   * available 45000000" for anything older. The number is taken from that
   * message when present, else found by bisection on readability.
   */
  async earliestBlock(): Promise<number> {
    if (this.earliest !== undefined) return this.earliest;
    try {
      await this.blockTimestamp(0);
      this.earliest = 0;
    } catch (e) {
      const m = /earliest available (\d+)/i.exec((e as Error).message);
      if (m) this.earliest = Number(m[1]);
      else {
        let lo = 0; // unreadable
        let hi = await this.headNumber(); // readable
        await this.blockTimestamp(hi);
        while (hi - lo > 1) {
          const mid = Math.floor((lo + hi) / 2);
          try {
            await this.blockTimestamp(mid);
            hi = mid;
          } catch {
            lo = mid;
          }
        }
        this.earliest = hi;
      }
    }
    return this.earliest;
  }

  /** Where readable history begins on this node, as block and time. */
  async historyStart(): Promise<{ block: number; at: string }> {
    const block = await this.earliestBlock();
    return { block, at: new Date((await this.blockTimestamp(block)) * 1000).toISOString() };
  }

  /**
   * The last block mined at or before `when`: a binary search over block
   * timestamps, about 30 reads on a chain with millions of blocks. Null when
   * readable history starts after `when`.
   */
  async blockAtOrBefore(when: Date): Promise<number | null> {
    const target = Math.floor(when.getTime() / 1000);
    const head = await this.headNumber();
    if ((await this.blockTimestamp(head)) <= target) return head;
    const earliest = await this.earliestBlock();
    if ((await this.blockTimestamp(earliest)) > target) return null;
    let lo = earliest;
    let hi = head;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await this.blockTimestamp(mid)) <= target) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /** The first block mined at or after `when`, clamped to the start of readable history. */
  async firstBlockAtOrAfter(when: Date): Promise<number> {
    const before = await this.blockAtOrBefore(new Date(when.getTime() - 1000));
    return before === null ? this.earliestBlock() : before + 1;
  }

  /** ERC-20 balance of `owner` in raw units, at the latest block. */
  async erc20Balance(token: string, owner: string): Promise<bigint> {
    const data = `0x70a08231${owner.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
    const out = await this.call<string>("eth_call", [{ to: token, data }, "latest"]);
    return BigInt(out === "0x" ? 0 : out);
  }

  private async logsInRange(filter: { address: string; topics: (string | null)[]; fromBlock: number; toBlock: number }): Promise<RpcLog[]> {
    return this.call<RpcLog[]>("eth_getLogs", [
      { address: filter.address, topics: filter.topics, fromBlock: hex(filter.fromBlock), toBlock: hex(filter.toBlock) },
    ]);
  }

  /**
   * Every Transfer of `token` where `address` is sender or receiver, in
   * [fromBlock, toBlock]. Two filters per chunk (topic 1 = from, topic 2 =
   * to) because a log filter cannot OR across topic positions; a
   * self-transfer would match both and is folded on txHash:logIndex.
   *
   * Chunks start at `maxSpan` blocks and HALVE when the node refuses a range
   * (public RPCs cap spans or result counts, with no common error shape), so
   * a long window costs more requests rather than failing. Any other error
   * is thrown.
   */
  async scanTransfers(params: { chain: string; token: string; address: string; fromBlock: number; toBlock: number; maxSpan?: number; onChunk?: (from: number, to: number) => void }): Promise<ChainTransfer[]> {
    const seen = new Set<string>();
    const out: ChainTransfer[] = [];
    let span = Math.max(1, params.maxSpan ?? 5000);
    let from = params.fromBlock;
    const me = addressTopic(params.address);
    while (from <= params.toBlock) {
      const to = Math.min(params.toBlock, from + span - 1);
      let logs: RpcLog[];
      try {
        const [sent, received] = await Promise.all([
          this.logsInRange({ address: params.token, topics: [TRANSFER_TOPIC, me], fromBlock: from, toBlock: to }),
          this.logsInRange({ address: params.token, topics: [TRANSFER_TOPIC, null, me], fromBlock: from, toBlock: to }),
        ]);
        logs = [...sent, ...received];
      } catch (e) {
        const msg = (e as Error).message;
        if (span > 1 && /range|limit|exceed|too many|too large|more than|response size|timeout/i.test(msg)) {
          span = Math.max(1, Math.floor(span / 2));
          continue;
        }
        throw e;
      }
      params.onChunk?.(from, to);
      for (const log of logs) {
        if (log.removed) continue;
        if (log.topics.length < 3 || log.topics[0] !== TRANSFER_TOPIC) continue;
        const key = `${log.transactionHash}:${Number(log.logIndex)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const blockNumber = Number(log.blockNumber);
        out.push({
          chain: params.chain,
          txHash: log.transactionHash,
          logIndex: Number(log.logIndex),
          blockNumber,
          at: new Date((await this.blockTimestamp(blockNumber)) * 1000).toISOString(),
          from: topicToAddress(log.topics[1]),
          to: topicToAddress(log.topics[2]),
          value: BigInt(log.data === "0x" ? 0 : log.data),
        });
      }
      from = to + 1;
    }
    out.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    return out;
  }
}
