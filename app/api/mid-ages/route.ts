// GET /api/mid-ages
//
// Read-only audit: for each configured Stripe account, return
//   { account, stripe_account_id, account_created_at, first_charge_at, months_old_days_old }
//
// - "account_created_at" comes from /v1/account (definitive Stripe account creation date)
// - "first_charge_at" pages /v1/charges to the tail using starting_after (may be slow
//   for high-volume accounts; capped at 30 pages to keep the endpoint within
//   maxDuration, then falls back to the last-seen created timestamp)
//
// Restricted keys must have "Account: Read" and "Charges: Read" permissions.
// If a call 401s, that account is returned with error="restricted_key_no_permission".
//
// Auth: pass ?secret=<CRON_SECRET>. Same pattern as /api/cashapp-check.

import { NextRequest, NextResponse } from "next/server";
import { parseAccounts } from "@/lib/vamp";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type StripeAccount = {
  id: string;
  created: number;
  business_profile?: { name?: string | null } | null;
  settings?: { dashboard?: { display_name?: string | null } | null } | null;
  email?: string | null;
};

type StripeChargeMini = {
  id: string;
  created: number;
};

async function getAccount(key: string): Promise<StripeAccount> {
  const res = await fetch("https://api.stripe.com/v1/account", {
    headers: { Authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Stripe /account ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function chargesPage(
  key: string,
  startingAfter?: string,
  limit = 100
): Promise<{ data: StripeChargeMini[]; has_more: boolean }> {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (startingAfter) qs.set("starting_after", startingAfter);
  const res = await fetch(
    `https://api.stripe.com/v1/charges?${qs.toString()}`,
    { headers: { Authorization: `Bearer ${key}` }, cache: "no-store" }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Stripe /charges ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function findFirstCharge(
  key: string,
  maxPages = 30
): Promise<{ first_charge_at?: string; pages_scanned: number; truncated: boolean }> {
  // Stripe returns charges sorted by created DESC. Walk toward oldest via
  // starting_after (which is the id of the last item of the previous page).
  let startingAfter: string | undefined;
  let lastCreated: number | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await chargesPage(key, startingAfter, 100);
    if (res.data.length === 0) {
      break;
    }
    lastCreated = res.data[res.data.length - 1].created;
    if (!res.has_more) {
      return {
        first_charge_at: new Date(lastCreated * 1000).toISOString(),
        pages_scanned: page + 1,
        truncated: false,
      };
    }
    startingAfter = res.data[res.data.length - 1].id;
  }
  // Ran out of budget: return the oldest we saw, marked truncated
  return {
    first_charge_at: lastCreated
      ? new Date(lastCreated * 1000).toISOString()
      : undefined,
    pages_scanned: maxPages,
    truncated: true,
  };
}

function daysSince(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = req.headers.get("authorization");
  if (auth === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get("secret") === secret) return true;
  return false;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const includeFirstCharge = req.nextUrl.searchParams.get("first_charge") === "1";

  let accounts: { name: string; key: string }[];
  try {
    accounts = parseAccounts();
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }

  const results: Array<Record<string, unknown>> = [];
  const CONCURRENCY = 5;
  let i = 0;
  async function worker() {
    while (i < accounts.length) {
      const a = accounts[i++];
      const entry: Record<string, unknown> = { account: a.name };
      try {
        const acct = await getAccount(a.key);
        entry.stripe_account_id = acct.id;
        entry.business_name =
          acct.business_profile?.name ??
          acct.settings?.dashboard?.display_name ??
          null;
        entry.email = acct.email ?? null;
        entry.account_created_at = new Date(acct.created * 1000).toISOString();
        entry.account_age_days = daysSince(entry.account_created_at as string);
        entry.account_older_than_6mo =
          (entry.account_age_days as number) >= 180;
      } catch (e) {
        entry.error = e instanceof Error ? e.message : String(e);
      }
      if (includeFirstCharge && !entry.error) {
        try {
          const first = await findFirstCharge(a.key);
          entry.first_charge_at = first.first_charge_at ?? null;
          entry.first_charge_pages_scanned = first.pages_scanned;
          entry.first_charge_truncated = first.truncated;
          if (entry.first_charge_at) {
            entry.first_charge_age_days = daysSince(entry.first_charge_at as string);
          }
        } catch (e) {
          entry.first_charge_error = e instanceof Error ? e.message : String(e);
        }
      }
      results.push(entry);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Sort youngest first â the "affected by <6mo phase-in" list
  results.sort(
    (a, b) =>
      ((a.account_age_days as number) ?? Number.POSITIVE_INFINITY) -
      ((b.account_age_days as number) ?? Number.POSITIVE_INFINITY)
  );

  const under6mo = results.filter((r) => r.account_older_than_6mo === false);
  return NextResponse.json({
    generated_at: new Date().toISOString(),
    total_accounts: accounts.length,
    under_6_months_count: under6mo.length,
    under_6_months: under6mo.map((r) => r.account),
    all_accounts: results,
  });
}
