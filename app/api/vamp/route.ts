import { NextResponse } from "next/server";
import type { VampRow } from "@/lib/vamp";

export const dynamic = "force-dynamic";
export type { VampRow };

export async function GET() {
  const snapshotUrl = process.env.BLOB_SNAPSHOT_URL;
  if (!snapshotUrl) {
    return NextResponse.json({ error: "BLOB_SNAPSHOT_URL not set" }, { status: 500 });
  }
  try {
    // Always fetch the latest blob — cron refreshes it every few minutes.
    const res = await fetch(snapshotUrl, { cache: "no-store" });
    if (!res.ok) {
      return NextResponse.json(
        { error: `Snapshot fetch failed: ${res.status}` },
        { status: 502 }
      );
    }
    const data = await res.json();
    return NextResponse.json(data, {
      headers: {
        // Allow edge CDN to serve fresh for 30s, then revalidate.
        "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
