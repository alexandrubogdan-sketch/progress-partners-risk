import { NextResponse } from "next/server";

// Cache for 1 hour; Next.js revalidates in the background.
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

function getReportPeriod() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const since = Math.floor(start.getTime() / 1000);
  const until = Math.floor(now.getTime() / 1000);
  const reportMonth = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-01`;
  return { since, until, reportMonth };
}

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function descFromCharge(charge: any): string {
  if (!charge || typeof charge === "string") return "UNKNOWN";
  const raw = charge.statement_descriptor || charge.calculated_statement_descriptor || "";
  return (raw as string).toUpperCase().trim() || "UNKNOWN";
}

/**
 * Fetch VAMP data for one account.
 * Returns one row per unique statement descriptor.
 *
 * Approach: no charge expansion on disputes/EFWs (keeps payloads small and fast).
 * Instead, build a chargeId→descriptor lookup from charges fetched over a 45-day
 * window (current month + prior 45 days to cover disputes for last month's charges).
 */
async function fetchAccount(acc: StripeAccount, since: number, until: number): Promise<VampRow[]> {
  try {
    const q = `created[gte]=${since}&created[lte]=${until}&limit=100`;
    // 45-day lookback on charges so we can attribute disputes for last-month charges
    const chargeSince = since - 45 * 86400;
    const chargeQ = `created[gte]=${chargeSince}&created[lte]=${until}&limit=100`;

    // All three fetched in parallel, no expansion → small fast payloads
    const [charges, disputes, efws] = await Promise.all([
      stripeFetch(`https://api.stripe.com/v1/charges?${chargeQ}`, acc.key, 10),
      stripeFetch(`https://api.stripe.com/v1/disputes?${q}`, acc.key, 10),
      stripeFetch(`https://api.stripe.com/v1/radar/early_fraud_warnings?${q}`, acc.key, 10),
    ]);

    // Build chargeId → descriptor map; also count Visa CNP for the current period
    const chargeDescMap: Record<string, string> = {};
    const visaCountByDesc: Record<string, number> = {};

    for (const c of charges) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const charge = c as any;
      const desc = descFromCharge(charge);
      if (charge.id && desc !== "UNKNOWN") {
        chargeDescMap[charge.id as string] = desc;
      }
      // Visa CNP denominator counts only the current month's charges
      if ((charge.created as number) >= since) {
        const brand = (charge.payment_method_details?.card?.brand || "").toLowerCase();
        if (brand === "visa" && desc !== "UNKNOWN") {
          visaCountByDesc[desc] = (visaCountByDesc[desc] || 0) + 1;
        }
      }
    }

    // Disputes per descriptor
    const disputeCountByDesc: Record<string, number> = {};
    const disputeVolByDesc: Record<string, number> = {};
    for (const d of disputes) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dispute = d as any;
      const chargeId: string | null =
        typeof dispute.charge === "string"
          ? dispute.charge
          : typeof dispute.charge?.id === "string"
          ? dispute.charge.id
          : null;
      const desc = chargeId ? (chargeDescMap[chargeId] ?? "UNKNOWN") : "UNKNOWN";
      if (desc === "UNKNOWN") continue;
      disputeCountByDesc[desc] = (disputeCountByDesc[desc] || 0) + 1;
      disputeVolByDesc[desc] =
        (disputeVolByDesc[desc] || 0) + ((dispute.amount as number) || 0) / 100;
    }

    // EFWs per descriptor
    const efwCountByDesc: Record<string, number> = {};
    for (const e of efws) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const efw = e as any;
      const chargeId: string | null =
        typeof efw.charge === "string"
          ? efw.charge
          : typeof efw.charge?.id === "string"
          ? efw.charge.id
          : null;
      const desc = chargeId ? (chargeDescMap[chargeId] ?? "UNKNOWN") : "UNKNOWN";
      if (desc === "UNKNOWN") continue;
      efwCountByDesc[desc] = (efwCountByDesc[desc] || 0) + 1;
    }

    // One row per descriptor
    const allDescs = new Set([
      ...Object.keys(visaCountByDesc),
      ...Object.keys(disputeCountByDesc),
      ...Object.keys(efwCountByDesc),
    ]);

    const rows: VampRow[] = [];
    for (const desc of Array.from(allDescs)) {
      const visaCount = visaCountByDesc[desc] || 0;
      const dispCount = disputeCountByDesc[desc] || 0;
      const efwCount = efwCountByDesc[desc] || 0;
      const vampCount = dispCount + efwCount;
      const vampRatio = visaCount > 0 ? vampCount / visaCount : 0;
      const dispVol = disputeVolByDesc[desc] || 0;
      rows.push({
        statement_descriptor: desc,
        product_name: acc.name,
        report_month: "",
        as_of: "",
        disputes_count: dispCount,
        efw_count: efwCount,
        vamp_count: vampCount,
        vamp_ratio: vampRatio,
        dispute_volume: dispVol,
        efw_volume: 0,
        vamp_volume: dispVol,
        status: "ACTIVE",
      });
    }
    return rows;
  } catch (err) {
    console.error(`[vamp] Failed ${acc.name}:`, err);
    return [];
  }
}

export async function GET() {
  const accountsJson = process.env.STRIPE_ACCOUNTS;
  if (!accountsJson) return NextResponse.json([]);

  let accounts: StripeAccount[];
  try {
    accounts = JSON.parse(accountsJson);
  } catch {
    return NextResponse.json({ error: "STRIPE_ACCOUNTS is not valid JSON" }, { status: 500 });
  }

  const { since, until, reportMonth } = getReportPeriod();
  const asOf = new Date().toISOString().split("T")[0];

  const settled = await Promise.allSettled(
    accounts.map((acc) => fetchAccount(acc, since, until))
  );

  const rows: VampRow[] = settled
    .filter((r): r is PromiseFulfilledResult<VampRow[]> => r.status === "fulfilled")
    .flatMap((r) => r.value)
    .map((r) => ({ ...r, report_month: reportMonth, as_of: asOf }));

  rows.sort((a, b) => b.vamp_ratio - a.vamp_ratio);
  return NextResponse.json(rows);
}
