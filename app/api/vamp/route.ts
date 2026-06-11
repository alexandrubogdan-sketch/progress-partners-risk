import { NextResponse } from "next/server";

// Cache the full response for 1 hour; Next.js revalidates in the background
// so users always get a fast response even when the cache is refreshing.
export const revalidate = 3600;

export type VampRow = {
  statement_descriptor: string;
  report_month: string;
  as_of: string;
  product_name: string;
  disputes_count: number;
  efw_count: number;
  vamp_count: number;
  vamp_ratio: number; // decimal, e.g. 0.015 = 1.5%
  dispute_volume: number;
  efw_volume: number;
  vamp_volume: number;
  status: string;
};

interface StripeAccount {
  id: string;
  name: string;
  key: string;
}

// ---------------------------------------------------------------------------
// Fallback mock data (used when STRIPE_ACCOUNTS env var is not set)
// ---------------------------------------------------------------------------
const MOCK_DATA: VampRow[] = [
  {
    statement_descriptor: "PDFBILLING.COM",
    report_month: "2026-06-01",
    as_of: "2026-06-10",
    product_name: "FE-03",
    disputes_count: 100,
    efw_count: 100,
    vamp_count: 200,
    vamp_ratio: 0.2,
    dispute_volume: 347655.61,
    efw_volume: 289663.85,
    vamp_volume: 637319.46,
    status: "ACTIVE",
  },
  {
    statement_descriptor: "PDFCHARGES.COM",
    report_month: "2026-06-01",
    as_of: "2026-06-10",
    product_name: "FE-07",
    disputes_count: 100,
    efw_count: 100,
    vamp_count: 200,
    vamp_ratio: 0.2,
    dispute_volume: 47201.32,
    efw_volume: 197649.79,
    vamp_volume: 244851.11,
    status: "ACTIVE",
  },
  {
    statement_descriptor: "PDFCUSTOMERS.COM",
    report_month: "2026-06-01",
    as_of: "2026-06-10",
    product_name: "Files-Editor",
    disputes_count: 100,
    efw_count: 93,
    vamp_count: 193,
    vamp_ratio: 0.193,
    dispute_volume: 160623.56,
    efw_volume: 53526.38,
    vamp_volume: 214149.94,
    status: "ACTIVE",
  },
  {
    statement_descriptor: "QR-CODE.IO",
    report_month: "2026-06-01",
    as_of: "2026-06-10",
    product_name: "QCI",
    disputes_count: 75,
    efw_count: 72,
    vamp_count: 147,
    vamp_ratio: 0.147,
    dispute_volume: 109465.54,
    efw_volume: 222078.34,
    vamp_volume: 331543.88,
    status: "ACTIVE",
  },
  {
    statement_descriptor: "TRACELO.COM* AYASIHT",
    report_month: "2026-06-01",
    as_of: "2026-06-10",
    product_name: "TRC",
    disputes_count: 1,
    efw_count: 0,
    vamp_count: 1,
    vamp_ratio: 0.001,
    dispute_volume: 3399,
    efw_volume: 0,
    vamp_volume: 3399,
    status: "ACTIVE",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Report period: 1st of current month to now (matches n8n workflow logic) */
function getReportPeriod() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const since = Math.floor(start.getTime() / 1000);
  const until = Math.floor(now.getTime() / 1000);
  const reportMonth = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-01`;
  return { since, until, reportMonth };
}

/** Paginate through a Stripe list endpoint and return all items. */
async function stripeFetch(url: string, key: string, maxPages = 10): Promise<unknown[]> {
  const items: unknown[] = [];
  let after: string | null = null;

  for (let p = 0; p < maxPages; p++) {
    const fullUrl = after ? `${url}&starting_after=${after}` : url;
    try {
      const r = await fetch(fullUrl, {
        headers: { Authorization: `Bearer ${key}` },
        cache: "no-store",
      });
      if (!r.ok) break;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await r.json();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const page: any[] = body.data || [];
      items.push(...page);
      if (!body.has_more || page.length === 0) break;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      after = (page[page.length - 1] as any).id;
    } catch {
      break;
    }
  }

  return items;
}

/** Extract the statement descriptor from a charge object. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function descFromCharge(charge: any): string {
  if (!charge || typeof charge === "string") return "UNKNOWN";
  const raw = charge.statement_descriptor || charge.calculated_statement_descriptor || "";
  return (raw as string).toUpperCase().trim() || "UNKNOWN";
}

/** Fetch all VAMP data for one Stripe account and return a single aggregated row. */
async function fetchAccount(
  acc: StripeAccount,
  since: number,
  until: number
): Promise<VampRow | null> {
  try {
    const q = `created[gte]=${since}&created[lte]=${until}&limit=100`;

    // All three calls run in parallel
    const [disputes, efws, charges] = await Promise.all([
      stripeFetch(`https://api.stripe.com/v1/disputes?${q}`, acc.key),
      stripeFetch(`https://api.stripe.com/v1/radar/early_fraud_warnings?${q}`, acc.key),
      // 3 pages = up to 300 charges (sufficient for Visa CNP count approximation)
      stripeFetch(`https://api.stripe.com/v1/charges?${q}`, acc.key, 3),
    ]);

    // Count Visa charges and find the most-used statement descriptor
    const descCounts: Record<string, number> = {};
    let visaCount = 0;

    for (const c of charges) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const charge = c as any;
      const brand = (charge.payment_method_details?.card?.brand || "").toLowerCase();
      if (brand === "visa") {
        const desc = descFromCharge(charge);
        descCounts[desc] = (descCounts[desc] || 0) + 1;
        visaCount++;
      }
    }

    const primaryDesc =
      Object.entries(descCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ??
      acc.name.toUpperCase();

    const disputeVol =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      disputes.reduce((s, d) => s + (((d as any).amount as number) || 0), 0) / 100;

    const vampCount = disputes.length + efws.length;
    const vampRatio = visaCount > 0 ? vampCount / visaCount : 0;

    return {
      statement_descriptor: primaryDesc,
      product_name: acc.name,
      report_month: "",
      as_of: "",
      disputes_count: disputes.length,
      efw_count: efws.length,
      vamp_count: vampCount,
      vamp_ratio: vampRatio,
      dispute_volume: disputeVol,
      efw_volume: 0,
      vamp_volume: disputeVol,
      status: "ACTIVE",
    };
  } catch (err) {
    console.error(`[vamp] Failed to fetch account ${acc.name}:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET() {
  const accountsJson = process.env.STRIPE_ACCOUNTS;

  if (!accountsJson) {
    return NextResponse.json(MOCK_DATA);
  }

  let accounts: StripeAccount[];
  try {
    accounts = JSON.parse(accountsJson);
  } catch {
    return NextResponse.json(
      { error: "STRIPE_ACCOUNTS env var is not valid JSON" },
      { status: 500 }
    );
  }

  const { since, until, reportMonth } = getReportPeriod();
  const asOf = new Date().toISOString().split("T")[0];

  // Fetch all accounts fully in parallel
  const settled = await Promise.allSettled(
    accounts.map((acc) => fetchAccount(acc, since, until))
  );

  const rows: VampRow[] = settled
    .filter(
      (r): r is PromiseFulfilledResult<VampRow> =>
        r.status === "fulfilled" && r.value !== null
    )
    .map((r) => ({
      ...r.value,
      report_month: reportMonth,
      as_of: asOf,
    }));

  rows.sort((a, b) => b.vamp_ratio - a.vamp_ratio);

  return NextResponse.json(rows);
}
