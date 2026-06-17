import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { buildSnapshotIncremental, parseAccounts, StateMap } from "@/lib/vamp";

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

async function loadState(): Promise<StateMap> {
  try {
    const snapshotUrl = process.env.BLOB_SNAPSHOT_URL;
    if (!snapshotUrl) return {};
    const stateUrl = snapshotUrl.replace(/\/latest\.json$/, "/state.json");
    const res = await fetch(stateUrl, { cache: "no-store" });
    if (!res.ok) return {};
    return (await res.json()) as StateMap;
  } catch {
    return {};
  }
}

/** Returns true if another cron run started less than BUDGET_MS ms ago. */
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

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Prevent concurrent cron runs from racing on the same state.
  if (await isLocked()) {
    return NextResponse.json({ ok: false, skipped: "concurrent run in progress — try again shortly" });
  }
  await writeLock();

  try {
    const accounts = parseAccounts();
    const prevState = await loadState();
    const deadline = Date.now() + BUDGET_MS;
    const { state, snapshot, refreshed, remaining } =
      await buildSnapshotIncremental(accounts, prevState, deadline, 10);

    await Promise.all([
      put("vamp/state.json", JSON.stringify(state), {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
      }),
      put("vamp/latest.json", JSON.stringify(snapshot), {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
      }),
    ]);

    return NextResponse.json({
      ok: true,
      report_month: snapshot.report_month,
      rows: snapshot.rows.length,
      accounts_ok: snapshot.accounts_ok,
      accounts_total: snapshot.accounts_total,
      refreshed_this_run: refreshed,
      remaining,
      note:
        remaining > 0
          ? "Run again to refresh the remaining accounts."
          : "All accounts refreshed.",
      errors: snapshot.errors,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
