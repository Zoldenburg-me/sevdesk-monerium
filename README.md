# sevdesk-monerium

Mirrors a Monerium account's activity into sevDesk, so a business that runs
its euro account on Monerium can do its bookkeeping where it already does it.
One direction only: Monerium and the chain are read, sevDesk is written, and
nothing is booked — every line lands as a plain bank transaction that
sevDesk's own matching (or the bookkeeper) links to an invoice or receipt.

## What it does

For every Monerium IBAN the application can see:

1. finds the sevDesk check account holding that IBAN, or with
   `--create-accounts` creates a CSV file-import account for it (sevDesk's
   own guidance: "if you want to create payment entries via API, use a file
   import account");
2. reads the account's **processed** orders and creates one transaction per
   order — an `issue` order (SEPA received, EURe minted) as a credit, a
   `redeem` order (payout sent, EURe burned) as a debit, with the
   counterparty's name and IBAN and the payment memo as the purpose;
3. reads the **on-chain EURe transfers** of the linked address from a
   JSON-RPC node and creates one transaction per plain transfer — money that
   moved with no order behind it — with the other address as counterparty and
   the tx hash as purpose. The mint and burn legs of an order are folded onto
   that order by tx hash, never booked twice;
4. remembers which order or transfer became which sevDesk row, and the last
   block scanned per address, so re-running is cheap.

`placed`, `pending` and `rejected` orders are never mirrored. Money that has
not settled is not a bank movement, and a line in the books for a payment
that may still be rejected is the one kind of record this tool must not make.

## What it does not do

- It never books, links, enshrines or deletes anything in sevDesk, and never
  writes to Monerium or the chain (neither client has a method that could).
- A mint or burn on chain that matches no order this application can see is
  **reported, not booked**: the order it belongs to probably sits on another
  profile, and booking it blind would put a nameless line in the books.
  `check` shows the resulting gap and names it.
- It does not carry documents. Monerium's `supportingDocumentId` is ignored.
- It does not name addresses. An on-chain counterparty is booked as
  `<chain> <address>`; give it a name in sevDesk once and their auto-mapping
  takes it from there.

## Setup

```bash
cp .env.example .env   # fill in both credentials
npm install
npm run cli -- auth    # proves both credentials and shows what each side sees
```

Monerium: create a **Private** application in your own account
(Developers → Create application → Private). Its client-credentials token
sees only that account's wallets, IBANs and orders — the whole scope this
tool needs and nothing more. Sandbox is `https://api.monerium.dev`,
production `https://api.monerium.app`.

sevDesk: the API token under Settings → Users. It goes in the `Authorization`
header as-is (no `Bearer`); sevDesk's tokens do not expire.

Chain: the EURe contract per chain is read from Monerium's `/tokens`, never
hardcoded. The RPC per chain has a public default (`src/chain.ts`) and
`RPC_URL_<CHAIN>` overrides it. The RPC's chain id is checked against the one
Monerium publishes before any log is read — a wrong RPC returns nothing for
every range and would otherwise look like a complete mirror.

## Use

```bash
npm run cli -- accounts                       # Monerium IBANs beside sevDesk check accounts
npm run cli -- sync                           # plan only: prints what would be created
npm run cli -- sync --apply --create-accounts # do it
npm run cli -- sync --since 2026-09-01 --apply
npm run cli -- sync --no-chain                # orders only, no RPC needed
npm run cli -- check                          # balance drift per IBAN, reported not repaired
```

`sync` without `--apply` writes nothing. That is the default on purpose.

The first on-chain scan of an address needs a start: `--since`, else the
earliest processed order's date. Later runs continue from the last scanned
block (kept in the state file, advanced only after an apply completes), with
a confirmation margin of `CHAIN_CONFIRMATIONS` blocks (12) behind the head.
Long windows are read in chunks of `CHAIN_MAX_BLOCK_SPAN` (5000) blocks,
halved whenever the node refuses a range. Public RPCs are slow; a month of
Gnosis is roughly 100 requests.

Amounts on chain carry 18 decimals and books carry cents, so an on-chain
amount is rounded half-up to the cent and the exact figure is printed in the
purpose when that happened. `check` rounds the Monerium balance the same way.

## How duplicates are prevented

The state file (`SYNC_STATE_PATH`, default `./state/sync.json`) maps each
order id to the sevDesk row that mirrors it and is written after every
create, so a crash between two creates costs nothing on retry (tested).

sevDesk has no external-id field on a transaction, so losing the state file
is handled differently: the next sync reads the existing rows on the account
and **adopts** any whose day, signed amount, counterparty account and purpose
match an order, one row per order, and creates only what is genuinely
missing. Two identical payments on one day stay two rows (tested).

## Verified against, and not

Shapes come from the two published OpenAPI documents, not from memory:
sevDesk's at `https://api.sevdesk.de/openapi.yaml`, Monerium's at
`https://docs.monerium.com/redocusaurus/api.yaml`. The tests
(`npm test`, 22 checks) run the clients against in-process stubs that enforce
the auth each API demands, plus a JSON-RPC stub with a block-range cap.

**No call has been made to the real sevDesk API or a real Monerium
account.** In particular, untested until one run against each:

- whether sevDesk accepts an RFC3339 `Z` timestamp in `valueDate` (their
  examples show `+02:00` offsets);
- whether sevDesk's auto-mapping picks up invoice numbers from the memo we
  put in `paymtPurpose`;
- the `accountingNumber` a created file-import account is given by default
  (SKR03 1200 / SKR04 1800 — set it explicitly if the default is wrong);
- Monerium's `/orders` on a private application: the docs say it answers
  with the caller's default profile and document no pagination;
- that Monerium's `meta.txHashes` on a processed order names the mint/burn
  transaction the way the fold assumes, on every chain (it is documented so;
  no real order has been checked). An order whose burn is not in its
  `txHashes` would show up as an orphan burn, reported and not booked, so the
  failure mode is a visible skip rather than a duplicate;
- the public RPC defaults: chosen from each chain's published endpoints, not
  exercised; expect to set `RPC_URL_<CHAIN>` to a provider with a key for
  anything beyond a trial.

## Layout

```
src/money.ts     integer cents; token units to cents; the only float is the one sevDesk's POST wants
src/monerium.ts  read-only client, client-credentials grant, token registry
src/sevdesk.ts   check accounts, file-import account, transactions
src/chain.ts     JSON-RPC: chunked Transfer-log scan, block-by-timestamp search
src/mapping.ts   order / transfer -> transaction draft, pure; the fingerprint used for recovery
src/state.ts     the order-id and transfer-id -> row maps and scan cursors, written atomically
src/sync.ts      plan, apply, drift check
src/cli.ts       auth | accounts | sync | check
test/            stubs shaped from both OpenAPI documents, and the checks
```
