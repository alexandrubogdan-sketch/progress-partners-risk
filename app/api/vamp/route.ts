import { NextResponse } from "next/server";
import { buildSnapshotIncremental, parseAccounts } from "@/lib/vamp";
import type { VampRow } from "@/lib/vamp";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
export type { VampRow };

const BUDGET_MS = 260_000;

export async function GET() {
  try {
    const accounts = parseAccounts();
    const deadline = Date.now() + BUDGET_MS;
    const { snapshot } = await buildSnapshotIncremental(accounts, {}, deadline, 10);
    return NextResponse.json(snapshot, {
      headers: {
        // Cache at CDN for 1 hour; serve stale for up to 24h while revalidating
        "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
