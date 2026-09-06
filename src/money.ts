/**
 * Money is integer cents end to end. Monerium reports order amounts as
 * decimal strings; sevDesk takes a float. Converting through a JS number
 * before the arithmetic is done would round 0.1 + 0.2 style, so the only
 * float in this repo is produced at the very last step, for the wire.
 */

export function toCents(amount: string | number): bigint {
  const s = String(amount).trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`not a decimal amount: "${s}"`);
  const [, sign, whole, frac = ""] = m;
  if (frac.length > 2 && /[1-9]/.test(frac.slice(2))) {
    throw new Error(`amount "${s}" has sub-cent precision; a bank movement cannot`);
  }
  const cents = BigInt(whole) * 100n + BigInt((frac + "00").slice(0, 2));
  return sign === "-" ? -cents : cents;
}

/** "12.34" / "-0.05" — the shape sevDesk returns and the shape humans read. */
export function formatCents(cents: bigint): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

/** The float sevDesk's POST wants. Exact for any amount under 2^53 cents. */
export function centsToNumber(cents: bigint): number {
  return Number(cents) / 100;
}

/**
 * Raw token units (18 decimals for EURe) to cents. Bank books hold cents,
 * so a sub-cent on-chain amount is rounded half-up and the exact figure is
 * returned beside it for the purpose text — the rounding is shown, not
 * hidden, and the drift check tolerates it.
 */
export function unitsToCents(value: bigint, decimals: number): { cents: bigint; exact: string; rounded: boolean } {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = value % base;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  const exact = fracStr ? `${whole}.${fracStr}` : `${whole}`;
  if (decimals <= 2) return { cents: value * 10n ** BigInt(2 - decimals), exact, rounded: false };
  const scale = 10n ** BigInt(decimals - 2);
  const centsFloor = value / scale;
  const remainder = value % scale;
  const roundedUp = remainder * 2n >= scale ? centsFloor + 1n : centsFloor;
  return { cents: roundedUp, exact, rounded: remainder !== 0n };
}

/** A decimal string with any precision, rounded half-up to cents. */
export function roundToCents(amount: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) throw new Error(`not a decimal amount: "${amount}"`);
  const [, sign, whole, frac = ""] = m;
  const { cents } = unitsToCents(BigInt(whole + frac), frac.length);
  return sign === "-" ? -cents : cents;
}
