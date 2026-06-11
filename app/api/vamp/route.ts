import { NextResponse } from "next/server";

// Short ISR cache — data is written by n8n daily at 10am, so 5 min is fine
export const revalidate = 300;

export type VampRow = {
  id: number;
  statement_descriptor: string;
  report_month: string;
  as_of: string;
  product_name: string;
  disputes_count: number;
  efw_count: number;
  vamp_count: number;
  vamp_ratio: number;
  dispute_volume: number;
  efw_volume: number;
  vamp_volume: number;
  status: string;
  refreshed_at: string;
  sales_count: number;
};

export async function GET() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json(
      { error: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set" },
      { status: 500 }
    );
  }

  // Only the most-recent report_month rows, sorted by vamp_ratio descending
  const url =
    `${supabaseUrl}/rest/v1/vamp_cache` +
    `?select=*` +
    `&report_month=eq.(select max(report_month) from vamp_cache)` +
    `&order=vamp_ratio.desc`;

  // Simpler: just fetch all and filter in JS — avoids sub-select quoting issues
  const allUrl = `${supabaseUrl}/rest/v1/vamp_cache?select=*&order=vamp_ratio.desc`;

  try {
    const r = await fetch(allUrl, {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
      cache: "no-store",
    });

    if (!r.ok) {
      const txt = await r.text();
      return NextResponse.json(
        { error: `Supabase error: ${r.status} ${txt}` },
        { status: 500 }
      );
    }

    const rows: VampRow[] = await r.json();

    // Keep only the most recent report_month
    if (rows.length > 0) {
      const maxMonth = rows.reduce(
        (max, r) => (r.report_month > max ? r.report_month : max),
        rows[0].report_month
      );
      return NextResponse.json(rows.filter((r) => r.report_month === maxMonth));
    }

    return NextResponse.json(rows);
  } catch (err) {
    return NextResponse.json(
      { error: `Fetch failed: ${String(err)}` },
      { status: 500 }
    );
  }
}
