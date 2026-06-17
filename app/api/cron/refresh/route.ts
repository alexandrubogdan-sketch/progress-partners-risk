import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { buildSnapshotIncremental, parseAccounts } from "@/lib/vamp";

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

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const accounts = parseAccounts();
    const deadline = Date.now() + BUDGET_MS;
    const { snapshot, refreshed, remaining } = await buildSnapshotIncremental(
      accounts,
      {},
      deadline,
      10
    );

    // Single put() per cron run — 1 Advanced Operation regardless of account count
    await put("vamp/latest.json", JSON.stringify(snapshot), {
      access: "public",
      addRandomSuffix: false,
    });

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
