#!/usr/bin/env node
/**
 * sevdesk-monerium — mirror Monerium SEPA activity into sevDesk.
 *
 *   auth                      verify both credentials, print what each sees
 *   accounts                  Monerium IBANs beside sevDesk check accounts
 *   sync [--since D] [--until D] [--apply] [--create-accounts]
 *                             plan (default) or apply the mirror
 *   check                     balance drift per IBAN, reported not repaired
 *
 * Writes to sevDesk happen only under `sync --apply`. Nothing ever writes
 * to Monerium.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { MoneriumClient } from "./monerium.js";
import { SevdeskClient } from "./sevdesk.js";
import { SyncState } from "./state.js";
import { applySync, checkDrift, planSync, type SyncPlan } from "./sync.js";
import { formatCents } from "./money.js";

function loadEnv() {
  const p = resolve(process.cwd(), ".env");
  if (existsSync(p)) process.loadEnvFile(p);
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing ${name} (see .env.example)`);
    process.exit(2);
  }
  return v;
}

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { command: positional[0], flags };
}

function parseDate(v: string | boolean | undefined, name: string): Date | undefined {
  if (typeof v !== "string") return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    console.error(`--${name} must be a date, got "${v}"`);
    process.exit(2);
  }
  return d;
}

function printPlan(plan: SyncPlan) {
  for (const a of plan.accounts) {
    const status = a.checkAccountId ? `sevDesk account ${a.checkAccountId}` : a.create ? `WILL CREATE sevDesk file-import account "${a.name}"` : "NO sevDesk account (orders skipped; use --create-accounts)";
    console.log(`${a.iban}  ${a.chain} ${a.address}  ->  ${status}`);
  }
  const counts = { create: 0, adopt: 0, already: 0, skip: 0 };
  for (const a of plan.actions) counts[a.kind]++;
  console.log(`orders in window: ${plan.ordersSeen}  create: ${counts.create}  adopt: ${counts.adopt}  already: ${counts.already}  skip: ${counts.skip}`);
  for (const a of plan.actions) {
    if (a.kind === "create") console.log(`  + ${a.draft.valueDate.slice(0, 10)}  ${a.draft.amount.toFixed(2).padStart(12)} EUR  ${a.draft.payeePayerName}  "${a.draft.paymtPurpose ?? ""}"  [${a.orderId}]`);
    else if (a.kind === "adopt") console.log(`  = adopt existing sevDesk row ${a.transactionId}  [${a.orderId}]`);
    else if (a.kind === "skip") console.log(`  - skip ${a.orderId}: ${a.reason}`);
  }
}

async function main() {
  loadEnv();
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (!command || flags.help) {
    console.log("usage: sevdesk-monerium <auth|accounts|sync|check> [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--apply] [--create-accounts] [--profile ID]");
    process.exit(flags.help ? 0 : 2);
  }

  const monerium = new MoneriumClient({
    baseUrl: process.env.MONERIUM_BASE_URL || "https://api.monerium.app",
    clientId: need("MONERIUM_CLIENT_ID"),
    clientSecret: need("MONERIUM_CLIENT_SECRET"),
  });
  const sevdesk = new SevdeskClient({ baseUrl: process.env.SEVDESK_BASE_URL, token: need("SEVDESK_API_TOKEN") });
  const state = new SyncState(resolve(process.cwd(), process.env.SYNC_STATE_PATH || "./state/sync.json"));
  const profile = (typeof flags.profile === "string" ? flags.profile : process.env.MONERIUM_PROFILE) || undefined;
  const deps = { monerium, sevdesk, state, log: (l: string) => console.log(l) };

  console.log(`Monerium: ${monerium.environment}   sevDesk: ${process.env.SEVDESK_BASE_URL || "https://my.sevdesk.de/api/v1"}   state: ${state.path}`);

  switch (command) {
    case "auth": {
      const ctx = await monerium.authContext();
      console.log(`Monerium ok: ${ctx.name ?? ctx.email ?? ctx.userId}, default profile ${ctx.defaultProfile}, profiles: ${(ctx.profiles ?? []).map((p) => `${p.name} (${p.kind}, ${p.id})`).join("; ")}`);
      const version = await sevdesk.bookkeepingVersion();
      const accounts = await sevdesk.checkAccounts();
      console.log(`sevDesk ok: bookkeeping system ${version}, ${accounts.length} check account(s)`);
      return;
    }
    case "accounts": {
      const ibans = await monerium.ibans(profile);
      console.log("Monerium IBANs:");
      for (const i of ibans) console.log(`  ${i.iban}  ${i.bic}  ${i.chain} ${i.address}${i.name ? `  ${i.name}` : ""}`);
      const accounts = await sevdesk.checkAccounts();
      console.log("sevDesk check accounts:");
      for (const a of accounts) console.log(`  ${a.id.padStart(6)}  ${a.type.padEnd(8)} ${(a.importType ?? "").padEnd(5)} ${a.currency}  ${a.status === "0" ? "archived" : "active  "}  ${a.iban ?? "-"}  ${a.name}`);
      return;
    }
    case "sync": {
      const plan = await planSync(deps, {
        since: parseDate(flags.since, "since"),
        until: parseDate(flags.until, "until"),
        profile,
        createAccounts: flags["create-accounts"] === true,
        accountName: typeof flags["account-name"] === "string" ? flags["account-name"] : undefined,
      });
      printPlan(plan);
      if (flags.apply !== true) {
        console.log("dry run — nothing written. Re-run with --apply to create the lines above in sevDesk.");
        return;
      }
      const report = await applySync(deps, plan);
      console.log(`applied: ${report.created.length} created, ${report.adopted.length} adopted, ${report.already} already mirrored, ${report.skipped.length} skipped, ${report.accountsCreated.length} account(s) created`);
      return;
    }
    case "check": {
      const lines = await checkDrift(deps, { profile });
      for (const l of lines) {
        console.log(`${l.iban}  Monerium ${l.moneriumBalance ?? "?"} EUR  sevDesk ${l.sevdeskSum ?? "?"} EUR  delta ${l.deltaCents === null ? "?" : formatCents(l.deltaCents)}  — ${l.note}`);
      }
      return;
    }
    default:
      console.error(`unknown command ${command}`);
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
