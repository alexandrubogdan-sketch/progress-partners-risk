// Minimal fetch-based Solidgate Reports client (no SDK dependency).
//
// Auth (validated against reports.solidgate.com 2026-06-22):
//   signature = base64( hex( HMAC-SHA512(publicKey + body + publicKey, secretKey) ) )
//   Sent as headers:  merchant: <publicKey>,  signature: <computed>
//
// Endpoints used:
//   POST /api/v1/card-orders                       (settled orders; paginated)
//   POST /api/v1/card-orders/chargebacks           (orders w/ .chargebacks[])
//   POST /api/v1/card-orders/fraud-alerts          (.alerts[])
//
// We deliberately do NOT use /api/v1/finance/financial_entries here — it's
// async (kick off → poll a report URL → download CSV) and not friendly to
// Vercel's 5-min function ceiling for daily refresh. /card-orders gives us
// the same denominator data synchronously.

import crypto from "node:crypto";

export const SOLIDGATE_API = "https://reports.solidgate.com";
export const EXCLUDED_CHARGEBACK_STATUSES = new Set(["resolved", "prevented"]);

export type SolidgateOrder = {
  order_id: string;
  status: string;
  type: string;
  amount: number;       // minor units
  currency: string;
  order_description: string | null;
  customer_account_id: string | null;
  geo_country: string | null;
  ip_address: string | null;
  platform: string | null;
  fraudulent: boolean;
  is_secured: boolean;
  created_at: string;
  updated_at: string;
  // Present on /card-orders/chargebacks responses:
  chargebacks?: SolidgateChargebackEvent[];
  // Channel-level descriptor isn't on the response — we tag it ourselves
  // before storing, using the channel.descriptor from SOLIDGATE_ACCOUNTS.
};

export type SolidgateChargebackEvent = {
  id: string;
  type: string;            // 1st_chb, ...
  status: string;          // accepted, document_sent, resolved, resolved_reversal, reversed
  amount: number;
  currency: string;
  reason_code: string;
  reason_description: string;
  reason_group: string;    // Fraud, ...
  dispute_date: string;
  settlement_date: string;
  created_at: string;
  updated_at: string;
};

export type SolidgateFraudAlert = {
  order_id: string;
  card_scheme: string;     // VISA, MASTERCARD, ...
  fraud_amount: number;
  fraud_currency: string;
  fraud_amount_usd: number;
  fraud_type: string | null;
  fraud_report_date: string;
  reason_code_description: string | null;
  created_at: string;
  updated_at: string;
};

type ReportPage<T> = {
  // Different endpoints use different wrapper keys
  orders?: T[];
  alerts?: T[];
  data?: T[];
  metadata?: {
    count: number;
    next_page_iterator: string | null;
  };
  error?: { code: string; messages: string[] };
};

function sign(publicKey: string, body: string, secretKey: string): string {
  // Solidgate docs: "concatenate publicKey + jsonString + publicKey, HMAC-SHA512 with secretKey,
  // hex-encode, then base64-encode the hex string."
  const hex = crypto
    .createHmac("sha512", secretKey)
    .update(publicKey + body + publicKey, "utf8")
    .digest("hex");
  return Buffer.from(hex, "utf8").toString("base64");
}

async function postReport<T>(
  publicKey: string,
  secretKey: string,
  path: string,
  payload: Record<string, unknown>
): Promise<ReportPage<T>> {
  const body = JSON.stringify(payload);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${SOLIDGATE_API}${path}`, {
      method: "POST",
      headers: {
        merchant: publicKey,
        signature: sign(publicKey, body, secretKey),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
      cache: "no-store",
    });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      const backoff = Math.max(retryAfter * 1000, 500 * 2 ** Math.min(attempt, 5));
      await new Promise((r) => setTimeout(r, backoff + Math.random() * 250));
      continue;
    }
    const text = await res.text();
    throw new Error(`Solidgate ${path} ${res.status}: ${text.slice(0, 300)}`);
  }
}

/** Stream pages through a handler. Returns ok:false + cursor when the
 *  caller's deadline expires, so the next cron run can resume. */
export async function forEachReportPage<T>(
  publicKey: string,
  secretKey: string,
  path: string,
  payload: Record<string, unknown>,
  itemKey: "orders" | "alerts" | "data",
  onPage: (items: T[]) => void,
  deadline?: number,
  resumeCursor?: string,
  maxPages = 400
): Promise<{ ok: boolean; cursor: string | null }> {
  let cursor: string | undefined = resumeCursor;
  let lastCursor: string | null = resumeCursor ?? null;
  for (let page = 0; page < maxPages; page++) {
    if (deadline && Date.now() > deadline) return { ok: false, cursor: lastCursor };
    const body: Record<string, unknown> = { ...payload, limit: 500 };
    if (cursor) body.next_page_iterator = cursor;
    const res = await postReport<T>(publicKey, secretKey, path, body);
    if (res.error) {
      throw new Error(`Solidgate ${path}: ${res.error.code} ${res.error.messages.join("; ")}`);
    }
    const items = (res[itemKey] as T[] | undefined) ?? [];
    onPage(items);
    const next = res.metadata?.next_page_iterator;
    if (!next || items.length === 0) return { ok: true, cursor: null };
    cursor = next;
    lastCursor = next;
  }
  return { ok: true, cursor: null };
}

/** Convenience helper to accumulate everything. */
export async function listAllReport<T>(
  publicKey: string,
  secretKey: string,
  path: string,
  payload: Record<string, unknown>,
  itemKey: "orders" | "alerts" | "data"
): Promise<T[]> {
  const out: T[] = [];
  await forEachReportPage<T>(publicKey, secretKey, path, payload, itemKey, (items) =>
    out.push(...items)
  );
  return out;
}
