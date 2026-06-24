import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { buildSnapshotIncremental, parseAccounts, type Snapshot, type StateMap, type VampRow } from "@/lib/vamp";
import { buildSolidgateSnapshotIncremental, parseSolidgateChannels } from "@/lib/solidgate-snapshot";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BUDGET_MS = 260_000;

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  if (req.headers.get("x-vercel-cron")) return true;
  const auth = req.headers.get("authorization");
  if (auth === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get("secret") === secret) return true;
  return false;
}

async function loadStateFor(blobKey: string): Promise<StateMap> {
  try {
    const snapshotUrl = process.env.BLOB_SNAPSHOT_URL;
    if (!snapshotUrl) return {};
    const url = snapshotUrl.replace(/\/latest\.json$/, `/${blobKey}.json`);
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return {};
    return (await res.json()) as StateMap;
  } catch {
    return {};
  }
}

async function isLocked(): Promise<boolean> {
  try {
    const snapshotUrl = process.env.BLOB_SNAPSHOT_URL;
    if (!snapshotUrl) return false;
    const lockUrl = snapshotUrl.replace(/\/latest\.json$/, "/lock.json");
    const res = await fetch(lockUrl, { cache: "no-store" });
    if (!res.ok) return false;
    const { ts } = (await res.json()) as { ts: number };
    return Date.now() - ts < BUDGET_MS;
  } catch {
    return false;
  }
}

async function writeLock(): Promise<void> {
  await put("vamp/lock.json", JSON.stringify({ ts: Date.now() }), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

/** Merge two source snapshots into one combined snapshot for the UI. */
function mergeSnapshots(stripe: Snapshot | null, solidgate: Snapshot | null): Snapshot {
  const rows: VampRow[] = [
    ...(stripe?.rows ?? []),
    ...(solidgate?.rows ?? []),
  ];
  rows.sort((a, b) => b.vamp_count - a.vamp_count || b.vamp_ratio - a.vamp_ratio);
  rows.forEach((r, idx) => (r.id = idx + 1));
  const generated_at = new Date().toISOString();
  const reportMonth = stripe?.report_month ?? solidgate?.report_month ?? generated_at.slice(0, 10);
  return {
    generated_at,
    report_month: reportMonth,
    window: stripe?.window ?? solidgate?.window ?? { from: generated_at, to: generated_at },
    accounts_total: (stripe?.accounts_total ?? 0) + (solidgate?.accounts_total ?? 0),
    accounts_ok: (stripe?.accounts_ok ?? 0) + (solidgate?.accounts_ok ?? 0),
    errors: [...(stripe?.errors ?? []), ...(solidgate?.errors ?? [])],
    rows,
  };
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const forceUnlock = req.nextUrl.searchParams.get("force") === "1";
  if (!forceUnlock && await isLocked()) {
    return NextResponse.json({ ok: false, skipped: "concurrent run in progress — try again shortly" });
  }
  await writeLock();

  try {
    const deadline = Date.now() + BUDGET_MS;

    // ── Stripe pipeline ──
    let stripeSnap: Snapshot | null = null;
    let stripeState: StateMap = {};
    let stripeRefreshed = 0;
    let stripeRemaining = 0;
    try {
      const stripeAccounts = parseAccounts();
      const prev = await loadStateFor("state");
      // Split the budget in two so neither side starves the other.
      const stripeDeadline = Math.min(deadline, Date.now() + BUDGET_MS / 2);
      const res = await buildSnapshotIncremental(stripeAccounts, prev, stripeDeadline, 10);
      stripeSnap = res.snapshot;
      stripeState = res.state;
      stripeRefreshed = res.refreshed;
      stripeRemaining = res.remaining;
    } catch (e) {
      // STRIPE_ACCOUNTS missing or parse error: keep going with just Solidgate.
      console.warn("Stripe pipeline skipped:", e instanceof Error ? e.message : e);
    }

    // ── Solidgate pipeline ──
    let solidSnap: Snapshot | null = null;
    let solidState: StateMap = {};
    let solidRefreshed = 0;
    let solidRemaining = 0;
    try {
      const channels = parseSolidgateChannels();
      if (channels.length > 0) {
        const prev = await loadStateFor("state-solidgate");
        const res = await buildSolidgateSnapshotIncremental(channels, prev, deadline, 4);
        solidSnap = res.snapshot;
        solidState = res.state;
        solidRefreshed = res.refreshed;
        solidRemaining = res.remaining;
      }
    } catch (e) {
      console.warn("Solidgate pipeline failed:", e instanceof Error ? e.message : e);
    }

    const combined = mergeSnapshots(stripeSnap, solidSnap);

    await Promise.all([
      put("vamp/state.json", JSON.stringify(stripeState), {
        access: "public", addRandomSuffix: false, allowOverwrite: true,
      }),
      put("vamp/state-solidgate.json", JSON.stringify(solidState), {
        access: "public", addRandomSuffix: false, allowOverwrite: true,
      }),
      put("vamp/latest.json", JSON.stringify(combined), {
        access: "public", addRandomSuffix: false, allowOverwrite: true,
      }),
    ]);

    return NextResponse.json({
      ok: true,
      report_month: combined.report_month,
      rows: combined.rows.length,
      stripe: stripeSnap
        ? { accounts_ok: stripeSnap.accounts_ok, accounts_total: stripeSnap.accounts_total, refreshed: stripeRefreshed, remaining: stripeRemaining }
        : { skipped: "STRIPE_ACCOUNTS not set or parse error" },
      solidgate: solidSnap
        ? { channels_ok: solidSnap.accounts_ok, channels_total: solidSnap.accounts_total, refreshed: solidRefreshed, remaining: solidRemaining }
        : { skipped: "SOLIDGATE_ACCOUNTS not set" },
      errors: combined.errors,
      note:
        stripeRemaining + solidRemaining > 0
          ? "Run again to refresh the remaining accounts/channels."
          : "All accounts refreshed.",
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
