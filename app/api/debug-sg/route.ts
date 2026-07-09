import { NextRequest, NextResponse } from "next/server";
import { parseSolidgateChannels } from "@/lib/solidgate-vamp";
import { forEachReportPage, type SolidgateOrder } from "@/lib/solidgate";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Debug: run a live /card-orders fetch and tally by status. Use
// ?channel=<name>&days=<n> to pick channel and date range.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.nextUrl.searchParams.get("secret") !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const wantChannel = req.nextUrl.searchParams.get("channel") ?? "infochecker";
  const days = Number(req.nextUrl.searchParams.get("days") || "1");

  const channels = parseSolidgateChannels();
  const ch = channels.find((c) => c.name.includes(wantChannel));
  if (!ch) return NextResponse.json({
    error: "channel not found",
    wanted: wantChannel,
    available: channels.map((c) => c.name),
  });

  const toIso = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
  const now = new Date();
  const start = new Date(now.valueOf() - days * 24 * 3600_000);
  const date_from = toIso(start);
  const date_to = toIso(now);

  const statusCounts: Record<string, number> = {};
  let totalReturned = 0;
  let kept_settle_ok = 0;
  let amountSum = 0;
  let sample: SolidgateOrder | null = null;

  const res = await forEachReportPage<SolidgateOrder>(
    ch.publicKey,
    ch.secretKey,
    "/api/v1/card-orders",
    { filter: "created_at", date_from, date_to },
    "orders",
    (orders) => {
      for (const o of orders) {
        totalReturned++;
        const s = (o.status || "").toLowerCase();
        statusCounts[s] = (statusCounts[s] || 0) + 1;
        if (s === "settle_ok" && (o.amount || 0) > 0) {
          kept_settle_ok++;
          amountSum += o.amount;
          if (!sample) sample = o;
        }
      }
    },
    Date.now() + 50_000,
    undefined,
    50,
  );

  return NextResponse.json({
    channel: ch.name,
    descriptor: ch.descriptor,
    date_from,
    date_to,
    fetch_complete: res.ok,
    orders_returned: totalReturned,
    status_counts: statusCounts,
    kept_settle_ok: kept_settle_ok,
    sum_amount: amountSum,
    sample_status: sample?.status,
    sample_amount: sample?.amount,
    sample_type: sample?.type,
  });
}
