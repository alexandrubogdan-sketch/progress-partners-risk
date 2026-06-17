import { NextResponse } from "next/server";
import type { Snapshot, VampRow } from "@/lib/vamp";

export const dynamic = "force-dynamic";
export type { VampRow };

// Public blob URL — no Vercel Blob API calls needed for reads.
// Set BLOB_BASE_URL = https://<store>.public.blob.vercel-storage.com
const SNAPSHOT_URL = `${process.env.BLOB_BASE_URL}/vamp/latest.json`;

export async function GET() {
  if (!process.env.BLOB_BASE_URL) {
    return NextResponse.json(
      { error: "BLOB_BASE_URL env var not set." },
      { status: 500 }
    );
  }
  try {
    const res = await fetch(SNAPSHOT_URL, { cache: "no-store" });
    if (res.status === 404) {
      return NextResponse.json(
        { error: "No snapshot yet — run /api/cron/refresh first." },
        { status: 404 }
      );
    }
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
