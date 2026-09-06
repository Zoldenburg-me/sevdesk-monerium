# sevdesk-monerium

Mirrors a Monerium account's SEPA activity into sevDesk, so a business that
runs its euro account on Monerium can do its bookkeeping where it already does
it. One direction only: Monerium is read, sevDesk is written, and nothing is
booked — every line lands as a plain bank transaction that sevDesk's own
matching (or the bookkeeper) links to an invoice or receipt.

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
3. remembers which order became which sevDesk row, so re-running is free.

`placed`, `pending` and `rejected` orders are never mirrored. Money that has
not settled is not a bank movement, and a line in the books for a payment
that may still be rejected is the one kind of record this tool must not make.

## What it does not do

- **It cannot see on-chain EURe transfers.** Monerium's order list covers
  SEPA and cross-chain orders. A plain token transfer from the wallet to
  another address is real money leaving the account with no order behind it.
  `check` shows the resulting gap between Monerium's balance and sevDesk's
  running sum and says what it probably is; it never invents a line to close
  it. Reading the chain for those transfers is the obvious next piece.
- It never books, links, enshrines or deletes anything in sevDesk, and never
  writes to Monerium (the client has no method that could).
- It does not carry documents. Monerium's `supportingDocumentId` is ignored.

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

## Use

```bash
npm run cli -- accounts                       # Monerium IBANs beside sevDesk check accounts
npm run cli -- sync                           # plan only: prints what would be created
npm run cli -- sync --apply --create-accounts # do it
npm run cli -- sync --since 2026-09-01 --apply
npm run cli -- check                          # balance drift per IBAN, reported not repaired
```

`sync` without `--apply` writes nothing. That is the default on purpose.

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
(`npm test`, 12 checks) run both clients against in-process stubs that enforce
the auth each API demands.

**No call has been made to the real sevDesk API or a real Monerium
account.** In particular, untested until one run against each:

- whether sevDesk accepts an RFC3339 `Z` timestamp in `valueDate` (their
  examples show `+02:00` offsets);
- whether sevDesk's auto-mapping picks up invoice numbers from the memo we
  put in `paymtPurpose`;
- the `accountingNumber` a created file-import account is given by default
  (SKR03 1200 / SKR04 1800 — set it explicitly if the default is wrong);
- Monerium's `/orders` on a private application: the docs say it answers
  with the caller's default profile and document no pagination.

## Layout

```
src/money.ts     integer cents; the only float is the one sevDesk's POST wants
src/monerium.ts  read-only client, client-credentials grant
src/sevdesk.ts   check accounts, file-import account, transactions
src/mapping.ts   order -> transaction draft, pure; the fingerprint used for recovery
src/state.ts     the order-id -> row map, written atomically
src/sync.ts      plan, apply, drift check
src/cli.ts       auth | accounts | sync | check
test/            stubs shaped from both OpenAPI documents, and the checks
```
