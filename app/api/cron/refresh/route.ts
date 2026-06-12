import { NextRequest, NextResponse } from "next/server";
import { put, list } from "@vercel/blob";
import { buildSnapshotIncremental, parseAccounts } from "@/lib/vamp";
import type { Snapshot, StateMap } from "@/lib/vamp";

export const dynamic = "force-dynamic";
export const maxDuration = 800; // seconds (Pro plan)

const SNAPSHOT_PATH = "vamp/latest.json";
const STATE_PATH = "vamp/state-v2.json";
const STALE_MS = 30 * 60 * 1000;
const BUDGET_MS = 660_000; // stop new work after 11 min (800s hard kill)

async function readBlobJson<T>(path: string): Promise<T | null> {
  try {
    const { blobs } = await list({ prefix: path, limit: 1 });
    if (blobs.length === 0) return null;
    const res = await fetch(blobs[0].url, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function isAuthorized(req: NextRequest, snap: Snapshot | null): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  const qsSecret = req.nextUrl.searchParams.get("secret");
  if (secret && (auth === `Bearer ${secret}` || qsSecret === secret)) return true;
  // Vercel Cron system header (stripped from external requests, can't be spoofed)
  if (req.headers.get("x-vercel-cron")) return true;
  // Unauthenticated refresh allowed while data is missing, incomplete or stale —
  // once complete and fresh, the endpoint locks again.
  if (!snap || !snap.rows || snap.rows.length === 0) return true;
  if (snap.accounts_ok < snap.accounts_total) return true;
  return Date.now() - new Date(snap.generated_at).getTime() > STALE_MS;
}

export async function GET(req: NextRequest) {
  const deadline = Date.now() + BUDGET_MS;
  const prevSnap = await readBlobJson<Snapshot>(SNAPSHOT_PATH);

  if (!(await isAuthorized(req, prevSnap))) {
    return NextResponse.json(
      { error: "Unauthorized — data is fresh and complete. Use CRON_SECRET to force." },
      { status: 401 }
    );
  }

  try {
    const accounts = parseAccounts();
    let prevState = (await readBlobJson<StateMap>(STATE_PATH)) ?? {};
    // ?force=1 re-rates every account now (cached charge windows are kept,
    // so this only refetches the open window + disputes/EFWs).
    if (req.nextUrl.searchParams.get("force")) {
      prevState = Object.fromEntries(
        Object.entries(prevState).map(([k, st]) => [
          k,
          { ...st, refreshed_at: new Date(0).toISOString() },
        ])
      );
    }

    const blobOpts = {
      access: "public" as const,
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 0,
    };

    const { state, snapshot, refreshed, remaining } =
      await buildSnapshotIncremental(accounts, prevState, deadline, 10, async (st) => {
        await put(STATE_PATH, JSON.stringify(st), blobOpts);
      });
    await put(STATE_PATH, JSON.stringify(state), blobOpts);
    await put(SNAPSHOT_PATH, JSON.stringify(snapshot), blobOpts);

    return NextResponse.json({
      ok: true,
      report_month: snapshot.report_month,
      rows: snapshot.rows.length,
      accounts_ok: snapshot.accounts_ok,
      accounts_total: snapshot.accounts_total,
      refreshed_this_run: refreshed,
      remaining,
      note: remaining > 0 ? "Run again to refresh the remaining accounts." : "All accounts refreshed.",
      errors: snapshot.errors,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
