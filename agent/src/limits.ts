/** Subscription rate-limit state, from the CLI's `rate_limit_event` in stream-json. */
export interface RateLimitInfo {
  status: string; // "allowed" | "allowed_warning" | "rejected"
  resetsAt?: number; // unix seconds
}

/** The run was refused because the subscription usage limit is used up. */
export class LimitError extends Error {
  constructor(message: string, readonly resetsAt?: number) {
    super(message);
    this.name = "LimitError";
  }
}

// Subscription-limit wording only. A transient 429 or overload must not match: those aren't worth a long back-off.
const LIMIT_TEXT = /usage limit|hit your (usage )?limit|out of (extra )?usage|(5-hour|five.hour|weekly|session) limit/i;

export function parseRateLimit(raw: any): RateLimitInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  return { status: String(raw.status ?? "unknown"), resetsAt: raw.resetsAt };
}

/**
 * Whether a failed run was a usage-limit refusal. Prefers the structured event; falls back to the
 * error text, which in older CLI versions looked like "Claude AI usage limit reached|1730000000".
 */
export function detectLimit(text: string, rl?: RateLimitInfo): LimitError | undefined {
  const rejected = rl?.status === "rejected";
  if (!rejected && !LIMIT_TEXT.test(text)) return undefined;
  const epoch = text.match(/\|(\d{10})\b/)?.[1];
  return new LimitError(text.trim() || "Usage limit reached", (rejected ? rl?.resetsAt : undefined) ?? (epoch ? Number(epoch) : rl?.resetsAt));
}
