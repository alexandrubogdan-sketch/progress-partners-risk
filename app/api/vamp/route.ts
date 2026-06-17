import { NextResponse } from "next/server";

// Vercel Pro: allow up to 5 min for background revalidation
export const maxDuration = 300;

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VampRow = {
  statement_descriptor: string;
  product_name: string;
  account_id: string;
  report_month: string;
  as_of: string;
  disputes_count: number;
  efw_count: number;
  vamp_count: number;
  vamp_ratio: number;
  visa_sales: number;
  sales_capped: boolean; // true if sales count hit the 20 000-charge cap
};

interface Account {
  id: string;
  name: string;
  key: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function monthBounds() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return {
    since: Math.floor(start.getTime() / 1000),
    until: Math.floor(now.getTime() / 1000),
    reportMonth: start.toISOString().slice(0, 10),
  };
}

function normalizeDesc(raw: string | null | undefined): string {
  return (raw || "").replace(/\/+$/, "").toUpperCase().trim() || "UNKNOWN";
}

/**
 * Paginate a Stripe list endpoint up to maxPages × 100 items.
 * Returns { items, capped } — capped=true if has_more was still true at the limit.
 */
async function stripePaginate(
  baseUrl: string,
  key: string,
  maxPages = 500
): Promise<{ items: unknown[]; capped: boolean }> {
  const items: unknown[] = [];
  let cursor: string | null = null;
  let capped = false;

  for (let p = 0; p < maxPages; p++) {
    const url = cursor ? `${baseUrl}&starting_after=${cursor}` : baseUrl;
    try {
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${key}` },
        cache: "no-store",
      });
      if (!r.ok) break;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await r.json();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const page: any[] = body.data ?? [];
      items.push(...page);
      if (!body.has_more || page.length === 0) break;
      if (p === maxPages - 1) { capped = true; break; }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cursor = (page[page.length - 1] as any).id;
    } catch {
      break;
    }
  }

  return { items, capped };
}

// ---------------------------------------------------------------------------
// Per-account VAMP computation
// ---------------------------------------------------------------------------

interface DescBucket {
  visa_sales: number;
  efw_ids: Set<string>;
  dispute_ids: Set<string>;
  sales_capped: boolean;
}

async function computeAccount(
  acc: Account,
  since: number,
  until: number
): Promise<VampRow[]> {
  // EFWs: wider window (±60 days) because EFW may be filed after charge date.
  // We filter by charge.created inside [since, until] using the expanded charge.
  const efwSince = since - 60 * 86400;
  const efwUntil = until + 60 * 86400;

  const efwBase =
    `https://api.stripe.com/v1/radar/early_fraud_warnings` +
    `?created[gte]=${efwSince}&created[lte]=${efwUntil}` +
    `&limit=100&expand[]=data.charge`;

  const dispBase =
    `https://api.stripe.com/v1/disputes` +
    `?created[gte]=${efwSince}&created[lte]=${efwUntil}` +
    `&limit=100&expand[]=data.charge`;

  // Charges: 200 pages max (20 000 charges). Flagged as capped if exceeded.
  const chargeBase =
    `https://api.stripe.com/v1/charges` +
    `?created[gte]=${since}&created[lte]=${until}&limit=100`;

  const [efwResult, dispResult, chargeResult] = await Promise.all([
    stripePaginate(efwBase, acc.key, 100),
    stripePaginate(dispBase, acc.key, 100),
    stripePaginate(chargeBase, acc.key, 200),
  ]);

  // Build charge lookup from charges endpoint
  const chargeMap = new Map<string, { desc: string; brand: string; ok: boolean }>();
  for (const raw of chargeResult.items) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c: any = raw;
    const desc = normalizeDesc(c.calculated_statement_descriptor ?? c.statement_descriptor);
    const brand = ((c.payment_method_details?.card?.brand as string) ?? "").toLowerCase();
    chargeMap.set(c.id as string, { desc, brand, ok: c.status === "succeeded" });
  }

  // Descriptor buckets
  const buckets = new Map<string, DescBucket>();
  const getBucket = (desc: string): DescBucket => {
    if (!buckets.has(desc)) {
      buckets.set(desc, { visa_sales: 0, efw_ids: new Set(), dispute_ids: new Set(), sales_capped: false });
    }
    return buckets.get(desc)!;
  };

  // Sales: Visa succeeded charges within [since, until]
  for (const c of Array.from(chargeMap.values())) {
    if (c.brand === "visa" && c.ok) getBucket(c.desc).visa_sales++;
  }
  if (chargeResult.capped) {
    for (const b of Array.from(buckets.values())) b.sales_capped = true;
  }

  // EFWs — filter by charge.created in [since, until] and card brand = visa
  for (const raw of efwResult.items) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const efw: any = raw;
    const charge = efw.charge;
    if (!charge || typeof charge !== "object") continue;
    if ((charge.created as number) < since || (charge.created as number) > until) continue;
    const brand = ((charge.payment_method_details?.card?.brand as string) ?? "").toLowerCase();
    if (brand !== "visa") continue;
    const desc = normalizeDesc(charge.calculated_statement_descriptor ?? charge.statement_descriptor);
    getBucket(desc).efw_ids.add(charge.id as string);
  }

  // Disputes — filter by charge.created in [since, until] and card brand = visa
  for (const raw of dispResult.items) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d: any = raw;
    const charge = d.charge;
    if (!charge || typeof charge !== "object") continue;
    if ((charge.created as number) < since || (charge.created as number) > until) continue;
    const brand = ((charge.payment_method_details?.card?.brand as string) ?? "").toLowerCase();
    if (brand !== "visa") continue;
    const desc = normalizeDesc(charge.calculated_statement_descriptor ?? charge.statement_descriptor);
    getBucket(desc).dispute_ids.add(charge.id as string);
  }

  const rows: VampRow[] = [];
  for (const [desc, b] of Array.from(buckets.entries())) {
    if (b.visa_sales === 0 && b.efw_ids.size === 0 && b.dispute_ids.size === 0) continue;
    const vamp_count = b.efw_ids.size + b.dispute_ids.size;
    const vamp_ratio = b.visa_sales > 0 ? vamp_count / b.visa_sales : 0;
    rows.push({
      statement_descriptor: desc,
      product_name: acc.name,
      account_id: acc.id,
      report_month: "",
      as_of: "",
      disputes_count: b.dispute_ids.size,
      efw_count: b.efw_ids.size,
      vamp_count,
      vamp_ratio,
      visa_sales: b.visa_sales,
      sales_capped: b.sales_capped,
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET() {
  const accountsJson = process.env.STRIPE_ACCOUNTS;
  if (!accountsJson) {
    return NextResponse.json(
      { error: "STRIPE_ACCOUNTS environment variable is not set." },
      { status: 500 }
    );
  }

  let accounts: Account[];
  try {
    accounts = JSON.parse(accountsJson);
  } catch {
    return NextResponse.json(
      { error: "STRIPE_ACCOUNTS is not valid JSON." },
      { status: 500 }
    );
  }

  const { since, until, reportMonth } = monthBounds();
  const asOf = new Date().toISOString().slice(0, 10);

  const settled = await Promise.allSettled(
    accounts.map((acc) => computeAccount(acc, since, until))
  );

  const rows: VampRow[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") {
      for (const row of result.value) {
        rows.push({ ...row, report_month: reportMonth, as_of: asOf });
      }
    }
  }

  rows.sort((a, b) => b.vamp_ratio - a.vamp_ratio || b.vamp_count - a.vamp_count);

  return NextResponse.json(rows);
}
