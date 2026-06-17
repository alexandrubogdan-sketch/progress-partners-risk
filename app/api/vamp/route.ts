import { NextResponse } from "next/server";
import { list } from "@vercel/blob";
import type { Snapshot, VampRow } from "@/lib/vamp";

export const dynamic = "force-dynamic";
export type { VampRow };

export async function GET() {
  try {
    const { blobs } = await list({ prefix: "vamp/latest.json", limit: 1 });
    if (blobs.length === 0) {
      return NextResponse.json(
        { error: "No snapshot yet — run /api/cron/refresh first." },
        { status: 404 }
      );
    }
    const res = await fetch(blobs[0].url, { cache: "no-store" });
    if (!res.ok) {
      return NextResponse.json(
        { error: `Blob fetch failed: ${res.status}` },
        { status: 500 }
      );
    }
    const snapshot: Snapshot = await res.json();
    return NextResponse.json(snapshot);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
