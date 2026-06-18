import { NextRequest, NextResponse } from "next/server";
import { listAll, StripeCharge, StripeDispute, StripeEFW } from "@/lib/stripe";
import { parseAccounts } from "@/lib/vamp";

// Temporary export endpoint for Solidgate data request.
// Remove this file after the export is complete.

export const maxDuration = 300;
export const dynamic = "force-dynamic";

function toCSV(rows: Record<string, string | number | boolean | null>[]): string {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const escape = (v: string | number | boolean | null) => {
    const s = v == null ? "" : String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  return [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(",")),
  ].join("\n");
}

function ts(unix: number) {
  return new Date(unix * 1000).toISOString();
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const accountName = searchParams.get("account") ?? "Info-Checker";
  const type = searchParams.get("type") ?? "charges";
  // For charges: how many pages max (100 per page). Default 100 = 10k rows.
  const maxPages = Math.min(parseInt(searchParams.get("pages") ?? "100"), 300);

  const accounts = parseAccounts();
  const account = accounts.find(
    (a) => a.name.toLowerCase() === accountName.toLowerCase()
  );
  if (!account) {
    return NextResponse.json({ error: `Account "${accountName}" not found` }, { status: 404 });
  }

  const key = account.key;
  let csv = "";
  let filename = "";

  if (type === "charges") {
    const june1 = Math.floor(new Date("2026-06-01T00:00:00Z").getTime() / 1000);
    const charges = await listAll<StripeCharge & {
      billing_details?: { email?: string };
      receipt_email?: string;
      outcome?: { risk_level?: string };
      refunded?: boolean;
    }>(key, "/charges", { "created[gte]": june1 }, maxPages);

    const rows = charges.map((c) => ({
      id: c.id,
      created: ts(c.created),
      amount: (c.amount / 100).toFixed(2),
      currency: c.currency.toUpperCase(),
      status: c.status,
      statement_descriptor: c.calculated_statement_descriptor ?? c.statement_descriptor ?? "",
      email: c.billing_details?.email ?? c.receipt_email ?? "",
      card_brand: c.payment_method_details?.card?.brand ?? "",
      risk_level: c.outcome?.risk_level ?? "",
      refunded: c.refunded ? "yes" : "no",
    }));
    csv = toCSV(rows);
    filename = `${accountName}_Charges_June2026_p${maxPages}.csv`;

  } else if (type === "disputes") {
    const disputes = await listAll<StripeDispute & {
      status: string; currency: string; evidence_details?: { due_by?: number };
    }>(key, "/disputes", {}, 2000);

    const rows = disputes.map((d) => ({
      id: d.id,
      created: ts(d.created),
      amount: (d.amount / 100).toFixed(2),
      currency: (d as any).currency?.toUpperCase() ?? "",
      status: (d as any).status ?? "",
      reason: d.reason,
      charge_id: typeof d.charge === "string" ? d.charge : d.charge?.id ?? "",
      due_by: (d as any).evidence_details?.due_by ? ts((d as any).evidence_details.due_by) : "",
    }));
    csv = toCSV(rows);
    filename = `${accountName}_Disputes_AllTime.csv`;

  } else if (type === "efws") {
    const efws = await listAll<StripeEFW & { actionable?: boolean }>(
      key, "/radar/early_fraud_warnings", {}, 2000
    );

    const rows = efws.map((e) => ({
      id: e.id,
      created: ts(e.created),
      fraud_type: e.fraud_type,
      charge_id: typeof e.charge === "string" ? e.charge : e.charge?.id ?? "",
      actionable: (e as any).actionable ? "yes" : "no",
    }));
    csv = toCSV(rows);
    filename = `${accountName}_EarlyFraudWarnings.csv`;

  } else {
    return NextResponse.json({ error: "type must be charges|disputes|efws" }, { status: 400 });
  }

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
