import { NextResponse } from "next/server";

export const revalidate = 300; // cache for 5 minutes

export type VampRow = {
  statement_descriptor: string;
  report_month: string;
  as_of: string;
  product_name: string;
  disputes_count: number;
  efw_count: number;
  vamp_count: number;
  vamp_ratio: number; // decimal, e.g. 0.2 = 20%
  dispute_volume: number;
  efw_volume: number;
  vamp_volume: number;
  status: string;
};

// Fallback mock data used when no data source is configured
const MOCK_DATA: VampRow[] = [
  {
    statement_descriptor: "PDFBILLING.COM",
    report_month: "2026-06-01",
    as_of: "2026-06-10",
    product_name: "FE-03",
    disputes_count: 100,
    efw_count: 100,
    vamp_count: 200,
    vamp_ratio: 0.2,
    dispute_volume: 347655.61,
    efw_volume: 289663.85,
    vamp_volume: 637319.46,
    status: "ACTIVE",
  },
  {
    statement_descriptor: "PDFCHARGES.COM",
    report_month: "2026-06-01",
    as_of: "2026-06-10",
    product_name: "FE-07",
    disputes_count: 100,
    efw_count: 100,
    vamp_count: 200,
    vamp_ratio: 0.2,
    dispute_volume: 47201.32,
    efw_volume: 197649.79,
    vamp_volume: 244851.11,
    status: "ACTIVE",
  },
  {
    statement_descriptor: "PDFCUSTOMERS.COM",
    report_month: "2026-06-01",
    as_of: "2026-06-10",
    product_name: "Files-Editor",
    disputes_count: 100,
    efw_count: 93,
    vamp_count: 193,
    vamp_ratio: 0.193,
    dispute_volume: 160623.56,
    efw_volume: 53526.38,
    vamp_volume: 214149.94,
    status: "ACTIVE",
  },
  {
    statement_descriptor: "QR-CODE.IO",
    report_month: "2026-06-01",
    as_of: "2026-06-10",
    product_name: "QCI",
    disputes_count: 75,
    efw_count: 72,
    vamp_count: 147,
    vamp_ratio: 0.147,
    dispute_volume: 109465.54,
    efw_volume: 222078.34,
    vamp_volume: 331543.88,
    status: "ACTIVE",
  },
  {
    statement_descriptor: "TRACELO.COM* AYASIHT",
    report_month: "2026-06-01",
    as_of: "2026-06-10",
    product_name: "TRC",
    disputes_count: 1,
    efw_count: 0,
    vamp_count: 1,
    vamp_ratio: 0.001,
    dispute_volume: 3399,
    efw_volume: 0,
    vamp_volume: 3399,
    status: "ACTIVE",
  },
];

export async function GET() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  // Primary: read from Supabase vamp_cache table
  if (supabaseUrl && supabaseKey) {
    try {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/vamp_cache?select=*&order=vamp_ratio.desc`,
        {
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
            "Content-Type": "application/json",
          },
          next: { revalidate: 300 },
        }
      );

      if (!res.ok) throw new Error(`Supabase returned ${res.status}`);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any[] = await res.json();
      const rows: VampRow[] = data.map((item) => ({
        statement_descriptor: item.statement_descriptor ?? "",
        report_month: item.report_month ?? "",
        as_of: item.as_of ?? "",
        product_name: item.product_name ?? "",
        disputes_count: Number(item.disputes_count ?? 0),
        efw_count: Number(item.efw_count ?? 0),
        vamp_count: Number(item.vamp_count ?? 0),
        vamp_ratio: parseFloat(item.vamp_ratio ?? 0),
        dispute_volume: parseFloat(item.dispute_volume ?? 0),
        efw_volume: parseFloat(item.efw_volume ?? 0),
        vamp_volume: parseFloat(item.vamp_volume ?? 0),
        status: item.status ?? "ACTIVE",
      }));

      return NextResponse.json(rows);
    } catch (err) {
      console.error("Failed to fetch from Supabase:", err);
      return NextResponse.json(
        { error: "Failed to fetch VAMP data" },
        { status: 502 }
      );
    }
  }

  // Fallback: n8n webhook
  const webhookUrl = process.env.N8N_WEBHOOK_URL;
  if (!webhookUrl) {
    return NextResponse.json(MOCK_DATA);
  }

  try {
    const res = await fetch(webhookUrl, {
      headers: { Accept: "application/json" },
      next: { revalidate: 300 },
    });

    if (!res.ok) throw new Error(`n8n webhook returned ${res.status}`);

    const data = await res.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: VampRow[] = (Array.isArray(data) ? data : [data]).map((item: any) => ({
      statement_descriptor: item["Statement Descriptor"] ?? item.statement_descriptor ?? "",
      report_month: item["Report Month"] ?? item.report_month ?? "",
      as_of: item["As Of"] ?? item.as_of ?? "",
      product_name: item["Product Name"] ?? item.product_name ?? "",
      disputes_count: Number(item["Disputes Count"] ?? item.disputes_count ?? 0),
      efw_count: Number(item["EFW Count"] ?? item.efw_count ?? 0),
      vamp_count: Number(item["VAMP Count"] ?? item.vamp_count ?? 0),
      vamp_ratio: parseVampRatio(item["VAMP Ratio"] ?? item.vamp_ratio),
      dispute_volume: Number(item["Dispute Volume ($)"] ?? item.dispute_volume ?? 0),
      efw_volume: Number(item["EFW Volume ($)"] ?? item.efw_volume ?? 0),
      vamp_volume: Number(item["VAMP Volume ($)"] ?? item.vamp_volume ?? 0),
      status: item["Status"] ?? item.status ?? "",
    }));

    return NextResponse.json(rows);
  } catch (err) {
    console.error("Failed to fetch from n8n webhook:", err);
    return NextResponse.json(
      { error: "Failed to fetch VAMP data" },
      { status: 502 }
    );
  }
}

function parseVampRatio(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const cleaned = raw.replace("%", "").trim();
    const n = parseFloat(cleaned);
    return isNaN(n) ? 0 : n / 100;
  }
  return 0;
}
