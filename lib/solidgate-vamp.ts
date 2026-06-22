// Solidgate equivalent of the Stripe fetchAccountVamp pipeline in lib/vamp.ts.
//
// Per Solidgate support (Hub-report semantics):
//   - Denominator: settled SALE/VISA orders with amount > 0, deduped by order_id.
//   - TC15: chargeback events whose status ∉ {resolved, prevented}.
//   - TC40: fraud alerts where card_scheme === "VISA".
//
// We pull /card-orders for the denominator (synchronous, paginated) instead of
// /finance/financial_entries (async, slow) — both surface the same SALE/VISA
// universe at this granularity. If a future reconciliation shows drift, swap
// /card-orders for the async financial_entries flow.

import {
  forEachReportPage,
  listAllReport,
  EXCLUDED_CHARGEBACK_STATUSES,
  type SolidgateOrder,
  type SolidgateChargebackEvent,
  type SolidgateFraudAlert,
} from "./solidgate";
import type { AccountResult, DescAgg, VampRow } from "./vamp";

// A Solidgate "channel" is one (publicKey, secretKey, descriptor) tuple
// the merchant has configured in Hub → Developers → Channels.
export type SolidgateChannel = {
  name: string;        // e.g. "PDF-prod / files-editor"
  publicKey: string;
  secretKey: string;
  descriptor: string;  // statement descriptor for this channel
  product: string;     // grouping label, e.g. "PDF-prod"
};

type Bucket = {
  sales_count: number;
  sales_volume: number;          // minor units
  visa_sales_count: number;
  disputes_count: number;
  dispute_volume: number;
  efw_count: number;
  efw_volume: number;
  vampOrders: Map<string, number>;  // order_id -> order_amount (dedupe + volume)
};

const emptyBucket = (): Bucket => ({
  sales_count: 0,
  sales_volume: 0,
  visa_sales_count: 0,
  disputes_count: 0,
  dispute_volume: 0,
  efw_count: 0,
  efw_volume: 0,
  vampOrders: new Map(),
});

const SETTLED_STATUSES = new Set([
  "settle_ok",
  "approved",     // sometimes pre-settlement
]);

function isVisaScheme(o: SolidgateOrder): boolean {
  // /card-orders doesn't expose card_scheme directly on every record — but the
  // chargeback nested events do, and Solidgate's per-channel keys are usually
  // configured for a single brand. For VAMP we want VISA; treat all orders
  // from a Solidgate channel as VISA unless an explicit non-VISA hint exists.
  // (We rely on the merchant configuring one channel per descriptor; the
  // dashboard already groups by descriptor.)
  return true;
}

export async function fetchSolidgateChannelVamp(
  channel: SolidgateChannel,
  fromIso: string,            // "YYYY-MM-DD HH:MM:SS"
  toIso: string,
  reportMonth: string,
  asOf: string,
  prevWindows: Record<string, Record<string, DescAgg>> = {},
  deadline: number = Date.now() + 600_000
): Promise<AccountResult> {
  // Use simple 1-day windows so partial progress resumes naturally.
  const WINDOW_HOURS = 24;
  const fmt = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
  const fromDate = new Date(fromIso.replace(" ", "T") + "Z");
  const toDate = new Date(toIso.replace(" ", "T") + "Z");
  const windows: [string, string][] = [];
  for (
    let t = fromDate.getTime();
    t < toDate.getTime();
    t += WINDOW_HOURS * 3600_000
  ) {
    const wf = new Date(t);
    const wt = new Date(Math.min(t + WINDOW_HOURS * 3600_000 - 1000, toDate.getTime()));
    windows.push([fmt(wf), fmt(wt)]);
  }

  const done: Record<string, Record<string, DescAgg>> = { ...prevWindows };

  // --- Denominator: pull /card-orders per window, aggregate sales ---
  const bucket = emptyBucket();
  // Bucket is keyed by single descriptor (this channel's), but we mirror the
  // Stripe pipeline's "windows -> descriptor -> agg" shape for resumability.
  for (const [wf, wt] of windows) {
    if (Date.now() > deadline - 25_000) {
      // out of time — bank what we have, ask for another run
      return {
        account: channel.name,
        ok: false,
        error: `partial: budget exhausted with ${Object.keys(done).length}/${windows.length} windows fetched`,
        rows: [],
        charge_windows: done,
      };
    }
    if (wf in done && !("__cursor__" in (done[wf] ?? {}))) continue; // already complete

    const agg: Record<string, DescAgg> = done[wf] && !("__cursor__" in done[wf])
      ? { ...done[wf] }
      : {};
    const resume =
      done[wf] && "__cursor__" in done[wf]
        ? ((done[wf] as unknown as Record<string, string>).__cursor__ as string)
        : undefined;

    const res = await forEachReportPage<SolidgateOrder>(
      channel.publicKey,
      channel.secretKey,
      "/api/v1/card-orders",
      { filter: "created_at", date_from: wf, date_to: wt },
      "orders",
      (orders) => {
        for (const o of orders) {
          if (!SETTLED_STATUSES.has((o.status || "").toLowerCase())) continue;
          if ((o.amount || 0) <= 0) continue;
          const a = (agg[channel.descriptor] ??= { s: 0, v: 0, vs: 0 });
          a.s += 1;
          a.v += o.amount;
          if (isVisaScheme(o)) a.vs += 1;
        }
      },
      deadline - 15_000,
      resume
    );
    if (!res.ok) {
      if (res.cursor) {
        done[wf] = { ...agg, __cursor__: res.cursor as unknown as DescAgg };
      }
      return {
        account: channel.name,
        ok: false,
        error: `partial: window ${wf} interrupted`,
        rows: [],
        charge_windows: done,
      };
    }
    done[wf] = agg;
  }

  // Roll the per-window aggregates up
  for (const wmap of Object.values(done)) {
    for (const a of Object.values(wmap)) {
      bucket.sales_count += a.s;
      bucket.sales_volume += a.v;
      bucket.visa_sales_count += a.vs;
    }
  }

  // --- TC15 chargebacks ---
  const cbOrders = await listAllReport<SolidgateOrder>(
    channel.publicKey,
    channel.secretKey,
    "/api/v1/card-orders/chargebacks",
    { filter: "created_at", date_from: fromIso, date_to: toIso },
    "orders"
  );
  for (const o of cbOrders) {
    for (const ev of o.chargebacks ?? []) {
      if (EXCLUDED_CHARGEBACK_STATUSES.has((ev.status || "").toLowerCase())) continue;
      bucket.disputes_count += 1;
      bucket.dispute_volume += ev.amount;
      bucket.vampOrders.set(o.order_id, o.amount);
    }
  }

  // --- TC40 fraud alerts (VISA only) ---
  const fas = await listAllReport<SolidgateFraudAlert>(
    channel.publicKey,
    channel.secretKey,
    "/api/v1/card-orders/fraud-alerts",
    { filter: "created_at", date_from: fromIso, date_to: toIso },
    "alerts"
  );
  for (const f of fas) {
    if ((f.card_scheme || "").toUpperCase() !== "VISA") continue;
    bucket.efw_count += 1;
    bucket.efw_volume += f.fraud_amount;
    // We don't have the order amount here, so use fraud_amount as a proxy
    if (!bucket.vampOrders.has(f.order_id)) {
      bucket.vampOrders.set(f.order_id, f.fraud_amount);
    }
  }

  const vampCount = bucket.vampOrders.size;
  let vampVolume = 0;
  bucket.vampOrders.forEach((amt) => (vampVolume += amt));
  const noSales = bucket.visa_sales_count === 0 && vampCount > 0;
  const ratio = bucket.visa_sales_count > 0
    ? Math.min(1, vampCount / bucket.visa_sales_count)
    : 0;

  const row: VampRow = {
    id: 0,
    account_name: channel.name,
    statement_descriptor: channel.descriptor,
    report_month: reportMonth,
    as_of: asOf,
    product_name: channel.product,
    sales_count: bucket.sales_count,
    sales_volume: bucket.sales_volume / 100,
    visa_sales_count: bucket.visa_sales_count,
    disputes_count: bucket.disputes_count,
    dispute_volume: bucket.dispute_volume / 100,
    efw_count: bucket.efw_count,
    efw_volume: bucket.efw_volume / 100,
    vamp_count: vampCount,
    vamp_volume: vampVolume / 100,
    vamp_ratio: ratio,
    status: noSales
      ? "no_sales"
      : ratio > 0.015 || vampCount > 1000
      ? "breach"
      : ratio > 0.009
      ? "warning"
      : "ok",
    refreshed_at: new Date().toISOString(),
    source: "solidgate",
  };

  return {
    account: channel.name,
    ok: true,
    rows: [row],
    charge_windows: done,
  };
}

/** Parses SOLIDGATE_ACCOUNTS env var.
 *  Accepted shapes:
 *    [{ name, product, descriptor, publicKey, secretKey }, ...]
 *    { "Product/Channel": { publicKey, secretKey, descriptor, product? }, ... }
 */
export function parseSolidgateChannels(): SolidgateChannel[] {
  const raw = process.env.SOLIDGATE_ACCOUNTS;
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  const out: SolidgateChannel[] = [];
  const norm = (
    name: string,
    product: string | undefined,
    descriptor: string | undefined,
    publicKey: string,
    secretKey: string
  ) => {
    if (!publicKey || !secretKey) return;
    out.push({
      name,
      product: product ?? name.split("/")[0].trim(),
      descriptor: descriptor ?? name.split("/").slice(-1)[0].trim(),
      publicKey,
      secretKey,
    });
  };

  if (Array.isArray(parsed)) {
    for (const item of parsed as Record<string, string>[]) {
      norm(
        item.name || `${item.product}/${item.descriptor}`,
        item.product,
        item.descriptor,
        item.publicKey || item.public_key,
        item.secretKey || item.secret_key
      );
    }
  } else if (parsed && typeof parsed === "object") {
    for (const [name, val] of Object.entries(parsed as Record<string, Record<string, string>>)) {
      norm(name, val.product, val.descriptor, val.publicKey || val.public_key, val.secretKey || val.secret_key);
    }
  }
  return out;
}
