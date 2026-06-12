// Minimal fetch-based Stripe client (no SDK dependency).
// Works with restricted keys (rk_live_...) that have read access to
// Charges, Disputes and Radar Early Fraud Warnings.

const STRIPE_API = "https://api.stripe.com/v1";

export type StripeCharge = {
  id: string;
  amount: number;
  currency: string;
  created: number;
  paid: boolean;
  status: string; // succeeded | pending | failed
  calculated_statement_descriptor: string | null;
  statement_descriptor: string | null;
  payment_method_details?: {
    card?: { brand?: string | null } | null;
    card_present?: { brand?: string | null } | null;
  } | null;
};

export type StripeDispute = {
  id: string;
  amount: number;
  created: number;
  reason: string;
  charge: StripeCharge | string;
};

export type StripeEFW = {
  id: string;
  created: number;
  fraud_type: string;
  charge: StripeCharge | string;
};

async function stripeGet<T>(
  key: string,
  path: string,
  params: Record<string, string | number | string[]>
): Promise<{ data: T[]; has_more: boolean }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((item) => qs.append(k, item));
    else qs.append(k, String(v));
  }
  const url = `${STRIPE_API}${path}?${qs.toString()}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
    });
    if (res.ok) return res.json();
    // Back off and retry on rate limits / transient server errors
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    const body = await res.text();
    throw new Error(`Stripe ${path} ${res.status}: ${body.slice(0, 300)}`);
  }
}

/** Paginate through a Stripe list endpoint. */
export async function listAll<T extends { id: string }>(
  key: string,
  path: string,
  params: Record<string, string | number | string[]>,
  maxPages = 400 // 400 * 100 = 40k objects safety cap per account
): Promise<T[]> {
  const out: T[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const p: Record<string, string | number | string[]> = {
      ...params,
      limit: 100,
    };
    if (startingAfter) p.starting_after = startingAfter;
    const res = await stripeGet<T>(key, path, p);
    out.push(...res.data);
    if (!res.has_more || res.data.length === 0) break;
    startingAfter = res.data[res.data.length - 1].id;
  }
  return out;
}

/** Stream pages through a handler instead of accumulating (memory-safe for
 *  very large charge lists). */
export async function forEachPage<T extends { id: string }>(
  key: string,
  path: string,
  params: Record<string, string | number | string[]>,
  onPage: (items: T[]) => void,
  maxPages = 1000
): Promise<void> {
  let startingAfter: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const p: Record<string, string | number | string[]> = {
      ...params,
      limit: 100,
    };
    if (startingAfter) p.starting_after = startingAfter;
    const res = await stripeGet<T>(key, path, p);
    onPage(res.data);
    if (!res.has_more || res.data.length === 0) break;
    startingAfter = res.data[res.data.length - 1].id;
  }
}
