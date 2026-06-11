import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { buildSnapshot, parseAccounts } from "@/lib/vamp";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // seconds

const SNAPSHOT_PATH = "vamp/latest.json";

export async function GET(req: NextRequest) {
  // Vercel Cron sends Authorization: Bearer <CRON_SECRET>.
  // Manual refresh: GET /api/cron/refresh?secret=<CRON_SECRET>
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  const qsSecret = req.nextUrl.searchParams.get("secret");
  if (!secret || (auth !== `Bearer ${secret}` && qsSecret !== secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
