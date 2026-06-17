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
    const res = await fetch(snapshotUrl, { next: { revalidate: 3600 } });
    if (!res.ok) {
      return NextResponse.json(
        { error: `Snapshot fetch failed: ${res.status}` },
        { status: 502 }
      );
    }
    const data = await res.json();
    return NextResponse.json(data, {
      headers: {
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
