import { NextRequest, NextResponse } from "next/server";
import { put, list } from "@vercel/blob";
import { buildSnapshot, parseAccounts } from "@/lib/vamp";
import type { Snapshot } from "@/lib/vamp";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // seconds

const SNAPSHOT_PATH = "vamp/latest.json";
const STALE_MS = 30 * 60 * 1000; // unauthenticated refresh allowed if older

async function isAuthorized(req: NextRequest): Promise<boolean> {
  // 1. Explicit secret (Vercel Cron sends Authorization: Bearer <CRON_SECRET>;
  //    manual: /api/cron/refresh?secret=<CRON_SECRET>)
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  const qsSecret = req.nextUrl.searchParams.get("secret");
  if (secret && (auth === `Bearer ${secret}` || qsSecret === secret)) {
    return true;
  }
  // 2. Vercel Cron system header (stripped from external requests by Vercel,
  //    so it cannot be spoofed)
  if (req.headers.get("x-vercel-cron")) return true;
  // 3. No snapshot yet, or snapshot stale -> allow a bootstrap/manual refresh.
  //    Once fresh, this endpoint locks again, so it cannot be hammered.
  try {
    const { blobs } = await list({ prefix: SNAPSHOT_PATH, limit: 1 });
    if (blobs.length === 0) return true;
    const res = await fetch(blobs[0].url, { cache: "no-store" });
    if (!res.ok) return true;
    const snap: Snapshot = await res.json();
    // Empty/broken snapshots don't lock the endpoint
    if (!snap.rows || snap.rows.length === 0 || snap.accounts_ok === 0) return true;
    return Date.now() - new Date(snap.generated_at).getTime() > STALE_MS;
  } catch {
    return true;
  }
}

export async function GET(req: NextRequest) {
  if (!(await isAuthorized(req))) {
    return NextResponse.json(
      { error: "Unauthorized — snapshot is fresh. Use CRON_SECRET to force a refresh." },
      { status: 401 }
    );
  }

  try {
    const accounts = parseAccounts();
    const snapshot = await buildSnapshot(accounts);

    const blob = await put(SNAPSHOT_PATH, JSON.stringify(snapshot), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 0,
    });

    return NextResponse.json({
      ok: true,
      url: blob.url,
      report_month: snapshot.report_month,
      rows: snapshot.rows.length,
      accounts_ok: snapshot.accounts_ok,
      accounts_total: snapshot.accounts_total,
      errors: snapshot.errors,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
