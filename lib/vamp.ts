import {
  listAll,
  StripeCharge,
  StripeDispute,
  StripeEFW,
} from "./stripe";

export type VampRow = {
  id: number;
  account_name: string;
  statement_descriptor: string;
  report_month: string; // YYYY-MM-01
  as_of: string; // ISO date of the data window end
  product_name: string; // kept for UI compat = account_name
  sales_count: number;
  sales_volume: number;
  disputes_count: number;
  efw_count: number;
  vamp_count: number; // |EFW charges ∪ disputed charges| (deduped)
  vamp_ratio: number; // vamp_count / sales_count
  dispute_volume: number;
  efw_volume: number;
  vamp_volume: number;
  status: string;
  refreshed_at: string;
};

export type AccountResult = {
  account: string;
  ok: boolean;
  error?: string;
  rows: VampRow[];
};

export type Snapshot = {
  generated_at: string;
  report_month: string;
  window: { from: string; to: string };
  accounts_total: number;
  accounts_ok: number;
  errors: { account: string; error: string }[];
  rows: VampRow[];
};

function isVisa(charge: StripeCharge | string | null | undefined): boolean {
  if (!charge || typeof charge === "string") return false;
  const brand =
    charge.payment_method_details?.card?.brand ??
    charge.payment_method_details?.card_present?.brand;
  return brand === "visa";
}

function descriptorOf(charge: StripeCharge, fallback: string): string {
  return (
    charge.calculated_statement_descriptor ||
    charge.statement_descriptor ||
    fallback
  ).trim();
}

type Bucket = {
  sales_count: number;
  sales_volume: number;
  disputes_count: number;
  dispute_volume: number;
  efw_count: number;
  efw_volume: number;
  vampCharges: Map<string, number>; // chargeId -> charge amount (for dedup + volume)
};

function emptyBucket(): Bucket {
  return {
    sales_count: 0,
    sales_volume: 0,
    disputes_count: 0,
    dispute_volume: 0,
    efw_count: 0,
    efw_volume: 0,
    vampCharges: new Map(),
  };
}

export async function fetchAccountVamp(
  accountName: string,
  key: string,
  fromUnix: number,
  toUnix: number,
  reportMonth: string,
  asOf: string
): Promise<AccountResult> {
  try {
    const created = { "created[gte]": fromUnix, "created[lte]": toUnix };

    const [charges, disputes, efws] = await Promise.all([
      listAll<StripeCharge>(key, "/charges", { ...created }),
      listAll<StripeDispute>(key, "/disputes", {
        ...created,
        "expand[]": ["data.charge"],
      }),
      listAll<StripeEFW>(key, "/radar/early_fraud_warnings", {
        ...created,
        "expand[]": ["data.charge"],
      }),
    ]);

    const buckets = new Map<string, Bucket>();
    const bucket = (desc: string): Bucket => {
      let b = buckets.get(desc);
      if (!b) {
        b = emptyBucket();
        buckets.set(desc, b);
      }
      return b;
    };

    // Sales: succeeded Visa charges, grouped by descriptor
    for (const c of charges) {
      if (c.status !== "succeeded") continue;
      if (!isVisa(c)) continue;
      const b = bucket(descriptorOf(c, accountName));
      b.sales_count += 1;
      b.sales_volume += c.amount;
    }

    // Disputes on Visa charges (all reasons — VAMP counts fraud + non-fraud)
    for (const d of disputes) {
      const ch = d.charge;
      if (!ch || typeof ch === "string" || !isVisa(ch)) continue;
      const b = bucket(descriptorOf(ch, accountName));
      b.disputes_count += 1;
      b.dispute_volume += d.amount;
      b.vampCharges.set(ch.id, ch.amount);
    }

    // Early fraud warnings (TC40) on Visa charges
    for (const e of efws) {
      const ch = e.charge;
      if (!ch || typeof ch === "string" || !isVisa(ch)) continue;
      const b = bucket(descriptorOf(ch, accountName));
      b.efw_count += 1;
      b.efw_volume += ch.amount;
      b.vampCharges.set(ch.id, ch.amount); // dedup: same charge counted once
    }

    const refreshedAt = new Date().toISOString();
    const rows: VampRow[] = [];
    for (const [desc, b] of Array.from(buckets.entries())) {
      const vampCount = b.vampCharges.size;
      let vampVolume = 0;
      b.vampCharges.forEach((amt) => (vampVolume += amt));
      const ratio = b.sales_count > 0 ? vampCount / b.sales_count : 0;
      rows.push({
        id: 0, // assigned after merge
        account_name: accountName,
        statement_descriptor: desc,
        report_month: reportMonth,
        as_of: asOf,
        product_name: accountName,
        sales_count: b.sales_count,
        sales_volume: b.sales_volume / 100,
        disputes_count: b.disputes_count,
        dispute_volume: b.dispute_volume / 100,
        efw_count: b.efw_count,
        efw_volume: b.efw_volume / 100,
        vamp_count: vampCount,
        vamp_volume: vampVolume / 100,
        vamp_ratio: ratio,
        status:
          ratio > 0.015 || vampCount > 1000
            ? "breach"
            : ratio > 0.009
            ? "warning"
            : "ok",
        refreshed_at: refreshedAt,
      });
    }
    return { account: accountName, ok: true, rows };
  } catch (err) {
    return {
      account: accountName,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      rows: [],
    };
  }
}

/** Run accounts with limited concurrency (rate limits are per-account, so parallel is safe). */
export async function buildSnapshot(
  accounts: { name: string; key: string }[],
  concurrency = 6
): Promise<Snapshot> {
  const now = new Date();
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  );
  const fromUnix = Math.floor(monthStart.getTime() / 1000);
  const toUnix = Math.floor(now.getTime() / 1000);
  const reportMonth = monthStart.toISOString().slice(0, 10);
  const asOf = now.toISOString();

  const results: AccountResult[] = [];
  let i = 0;
  async function worker() {
    while (i < accounts.length) {
      const idx = i++;
      const a = accounts[idx];
      results[idx] = await fetchAccountVamp(
        a.name,
        a.key,
        fromUnix,
        toUnix,
        reportMonth,
        asOf
      );
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, accounts.length) }, worker)
  );

  const rows = results.flatMap((r) => r.rows);
  rows.sort((a, b) => b.vamp_ratio - a.vamp_ratio);
  rows.forEach((r, idx) => (r.id = idx + 1));

  return {
    generated_at: asOf,
    report_month: reportMonth,
    window: { from: monthStart.toISOString(), to: asOf },
    accounts_total: accounts.length,
    accounts_ok: results.filter((r) => r.ok).length,
    errors: results
      .filter((r) => !r.ok)
      .map((r) => ({ account: r.account, error: r.error || "unknown" })),
    rows,
  };
}

const KEY_RE = /^(rk|sk)_(live|test)_/;

/**
 * Tolerant STRIPE_ACCOUNTS parser. Accepts:
 *  - {"Account Name":"rk_live_...", ...}                    (map)
 *  - [{"name":"Account","key":"rk_live_..."}, ...]          (array of objects,
 *    key field may be name/account/label + key/token/apiKey/secret)
 *  - [{"Account":"rk_live_..."}, ...]                       (array of one-entry maps)
 */
export function parseAccounts(): { name: string; key: string }[] {
  const raw = process.env.STRIPE_ACCOUNTS;
  if (!raw) throw new Error("STRIPE_ACCOUNTS env var not set");
  const data = JSON.parse(raw) as unknown;
  const out: { name: string; key: string }[] = [];

  const pushFromObject = (item: Record<string, unknown>, idx: number) => {
    const strings = Object.entries(item).filter(
      (e): e is [string, string] => typeof e[1] === "string"
    );
    const keyEntry = strings.find(([, v]) => KEY_RE.test(v.trim()));
    if (!keyEntry) return;
    const named =
      strings.find(([k, v]) => !KEY_RE.test(v.trim()) &&
        ["name", "account", "account_name", "label", "title"].includes(k.toLowerCase()));
    const otherString = strings.find(([, v]) => !KEY_RE.test(v.trim()));
    const name =
      named?.[1] ??
      (keyEntry[0] && !["key", "token", "api_key", "apikey", "secret", "value"].includes(keyEntry[0].toLowerCase())
        ? keyEntry[0]
        : otherString?.[1]) ??
      `Account ${idx + 1}`;
    out.push({ name: String(name).trim(), key: keyEntry[1].trim() });
  };

  if (Array.isArray(data)) {
    data.forEach((item, idx) => {
      if (item && typeof item === "object") {
        pushFromObject(item as Record<string, unknown>, idx);
      }
    });
  } else if (data && typeof data === "object") {
    for (const [name, key] of Object.entries(data as Record<string, unknown>)) {
      if (typeof key === "string" && KEY_RE.test(key.trim())) {
        out.push({ name: name.trim(), key: key.trim() });
      }
    }
  }

  if (out.length === 0) {
    throw new Error("STRIPE_ACCOUNTS parsed but contained no rk_/sk_ keys");
  }
  return out;
}
