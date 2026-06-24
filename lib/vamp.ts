import {
  listAll,
  forEachPage,
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
  sales_count: number; // all card brands, succeeded
  sales_volume: number;
  visa_sales_count: number; // VAMP denominator
  disputes_count: number;
  efw_count: number;
  vamp_count: number; // |EFW charges ∪ disputed charges| (deduped)
  vamp_ratio: number; // vamp_count / visa_sales_count, capped at 1
  dispute_volume: number;
  efw_volume: number;
  vamp_volume: number;
  status: string;
  refreshed_at: string;
  source?: "stripe" | "solidgate";
};

export type DescAgg = { s: number; v: number; vs: number }; // sales, volume(cents), visa sales

export type AccountResult = {
  account: string;
  ok: boolean;
  error?: string;
  rows: VampRow[];
  // Per-window charge aggregates; lets a huge account resume across runs and
  // makes daily refreshes incremental (closed windows never change).
  charge_windows?: Record<string, Record<string, DescAgg>>;
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

// Merge descriptor variants that differ only in punctuation/spacing
// (e.g. "INFOCHECK-HELP.COM" vs "INFOCHECKHELP.COM" after a mid-month
// rename are the same merchant; Visa rates them together).
function normDesc(d: string): string {
  const n = d.replace(/[^a-z0-9]/gi, "").toUpperCase();
  return n || d.toUpperCase();
}

type Bucket = {
  nameSales: Record<string, number>; // raw spelling -> sales (pick display name)
  sales_count: number;
  sales_volume: number;
  visa_sales_count: number;
  disputes_count: number;
  dispute_volume: number;
  efw_count: number;
  efw_volume: number;
  vampCharges: Map<string, number>; // chargeId -> charge amount (for dedup + volume)
};

function emptyBucket(): Bucket {
  return {
    nameSales: {},
    sales_count: 0,
    sales_volume: 0,
    visa_sales_count: 0,
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
  asOf: string,
  prevWindows: Record<string, Record<string, DescAgg>> = {},
  deadline: number = Date.now() + 600_000
): Promise<AccountResult> {
  // Hoist done before try so the catch block can reference it
  let done: Record<string, Record<string, DescAgg>> = { ...prevWindows };
  try {
    const created = { "created[gte]": fromUnix, "created[lte]": toUnix };

    // 8h windows; closed windows are cached across runs, the open (current)
    // window is always re-fetched.
    const WINDOW = 28_800;
    const windows: [number, number][] = [];
    for (let t = fromUnix; t <= toUnix; t += WINDOW) {
      windows.push([t, Math.min(t + WINDOW - 1, toUnix)]);
    }
    // done is initialized above; add completed windows here
    const pending = windows.filter(
      ([wf, wt]) =>
        !(String(wf) in done) || // not yet fetched
        wt >= toUnix || // open window: always redo
        "__cursor__" in (done[String(wf)] ?? {}) // partial: resume from cursor
    );

    const WINDOW_CONCURRENCY = 4; // one window at a time avoids rate-limit contention
    let wi = 0;
    let incomplete = false;
    const windowWorker = async () => {
      while (wi < pending.length) {
        if (deadline - Date.now() < 25_000) {
          incomplete = true;
          return;
        }
        const [wFrom, wTo] = pending[wi++];
        // Resume from cursor if we have a partial window from a prior run
        const partialEntry = done[String(wFrom)];
        const resumeCursor: string | undefined =
          partialEntry && "__cursor__" in partialEntry
            ? (partialEntry.__cursor__ as unknown as string)
            : undefined;
        // Start with any already-aggregated data for this window
        const agg: Record<string, DescAgg> =
          partialEntry && !("__cursor__" in partialEntry)
            ? { ...partialEntry }
            : partialEntry && "__cursor__" in partialEntry
            ? Object.fromEntries(
                Object.entries(partialEntry).filter(([k]) => k !== "__cursor__")
              ) as Record<string, DescAgg>
            : {};
        const result = await forEachPage<StripeCharge>(
          key,
          "/charges",
          { "created[gte]": wFrom, "created[lte]": wTo },
          (items) => {
            for (const c of items) {
              if (c.status !== "succeeded") continue;
              if (c.refunded === true) continue;
              const d = descriptorOf(c, accountName);
              const a = (agg[d] ??= { s: 0, v: 0, vs: 0 });
              a.s += 1;
              a.v += c.amount;
              if (isVisa(c)) a.vs += 1;
            }
          },
          1000,
          deadline - 15_000,
          resumeCursor
        );
        if (!result.ok) {
          // Save partial progress with cursor so next run can resume
          if (result.cursor) {
            done[String(wFrom)] = {
              ...agg,
              __cursor__: result.cursor as unknown as DescAgg,
            };
          }
          incomplete = true;
          return;
        }
        done[String(wFrom)] = agg;
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(WINDOW_CONCURRENCY, Math.max(pending.length, 1)) },
        windowWorker
      )
    );

    if (incomplete || deadline - Date.now() < 30_000) {
      return {
        account: accountName,
        ok: false,
        error: `partial: ${Object.keys(done).length}/${windows.length} windows fetched — continues next run`,
        rows: [],
        charge_windows: done,
      };
    }

    const [disputes, efws] = await Promise.all([
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

    for (const aggMap of Object.values(done)) {
      for (const [d, a] of Object.entries(aggMap)) {
        const b = bucket(normDesc(d));
        b.nameSales[d] = (b.nameSales[d] ?? 0) + a.s;
        b.sales_count += a.s;
        b.sales_volume += a.v;
        b.visa_sales_count += a.vs;
      }
    }

    // Disputes on Visa charges (all reasons — VAMP counts fraud + non-fraud)
    for (const d of disputes) {
      const ch = d.charge;
      if (!ch || typeof ch === "string" || !isVisa(ch)) continue;
      const raw = descriptorOf(ch, accountName);
      const b = bucket(normDesc(raw));
      b.nameSales[raw] = b.nameSales[raw] ?? 0;
      b.disputes_count += 1;
      b.dispute_volume += d.amount;
      b.vampCharges.set(ch.id, ch.amount);
    }

    // Early fraud warnings (TC40) on Visa charges
    for (const e of efws) {
      const ch = e.charge;
      if (!ch || typeof ch === "string" || !isVisa(ch)) continue;
      const raw = descriptorOf(ch, accountName);
      const b = bucket(normDesc(raw));
      b.nameSales[raw] = b.nameSales[raw] ?? 0;
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
      // Cap at 100% — a descriptor can't exceed all of its own sales.
      // No sales this month -> ratio is not meaningful (0 + "no_sales" status).
      const noSales = b.visa_sales_count === 0 && vampCount > 0;
      const ratio = b.visa_sales_count > 0
        ? Math.min(1, vampCount / b.visa_sales_count)
        : 0;
      // Display under the spelling that carries the sales (most recent/active)
      const names = Object.entries(b.nameSales);
      names.sort((x, y) => y[1] - x[1]);
      const displayDesc = names.length > 0 ? names[0][0] : desc;
      rows.push({
        id: 0, // assigned after merge
        account_name: accountName,
        statement_descriptor: displayDesc,
        report_month: reportMonth,
        as_of: asOf,
        product_name: accountName,
        sales_count: b.sales_count,
        sales_volume: b.sales_volume / 100,
        visa_sales_count: b.visa_sales_count,
        disputes_count: b.disputes_count,
        dispute_volume: b.dispute_volume / 100,
        efw_count: b.efw_count,
        efw_volume: b.efw_volume / 100,
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
        refreshed_at: refreshedAt,
        source: "stripe",
      });
    }
    return { account: accountName, ok: true, rows, charge_windows: done };
  } catch (err) {
    return {
      account: accountName,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      rows: [],
      charge_windows: done,
    };
  }
}

export type AccountState = AccountResult & { refreshed_at: string };
export type StateMap = Record<string, AccountState>;

const REFRESH_IF_OLDER_MS = 6 * 60 * 60 * 1000;

// Bump to invalidate cached per-window aggregates after a filter-logic change.
const STATE_VERSION = "v2-sales-non-refunded"; // don't redo accounts done <6h ago (cron is daily)

/**
 * Incremental snapshot builder. Processes accounts that are missing, errored,
 * or older than 6 hours, under a time budget so the function never hits
 * Vercel's max duration. Huge accounts resume from cached charge windows.
 * Run it repeatedly until remaining === 0.
 */
export async function buildSnapshotIncremental(
  accounts: { name: string; key: string }[],
  prevState: StateMap,
  deadline: number,
  concurrency = 10,
  onProgress?: (state: StateMap) => Promise<void>
): Promise<{ state: StateMap; snapshot: Snapshot; refreshed: number; remaining: number }> {
  const now = new Date();
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  );
  const fromUnix = Math.floor(monthStart.getTime() / 1000);
  const toUnix = Math.floor(now.getTime() / 1000);
  const reportMonth = monthStart.toISOString().slice(0, 10);
  const asOf = now.toISOString();

  const state: StateMap = { ...prevState };
  // Drop state from a previous month or saved under an older filter version
  for (const [name, st] of Object.entries(state)) {
    const ver = (st as unknown as { state_version?: string }).state_version;
    if ((st.rows.length > 0 && st.rows[0].report_month !== reportMonth) || ver !== STATE_VERSION) {
      delete state[name];
    }
  }

  const needs = accounts.filter((a) => {
    const st = state[a.name];
    if (!st || !st.ok) return true;
    return Date.now() - new Date(st.refreshed_at).getTime() > REFRESH_IF_OLDER_MS;
  });
  // Oldest data first
  needs.sort((a, b) => {
    const ta = state[a.name] ? new Date(state[a.name].refreshed_at).getTime() : 0;
    const tb = state[b.name] ? new Date(state[b.name].refreshed_at).getTime() : 0;
    return ta - tb;
  });

  let refreshed = 0;
  let i = 0;
  async function worker() {
    while (i < needs.length) {
      const msLeft = deadline - Date.now();
      if (msLeft < 30_000) return; // not enough budget to start another account
      const a = needs[i++];
      const prevWin = state[a.name]?.charge_windows ?? {};
      const res = await fetchAccountVamp(
        a.name,
        a.key,
        fromUnix,
        toUnix,
        reportMonth,
        asOf,
        prevWin,
        deadline
      );
      // Always keep accumulated window progress; keep previous good rows if
      // this attempt failed.
      const hadOk = state[a.name]?.ok ?? false;
      state[a.name] = {
        account: a.name,
        ok: res.ok || hadOk,
        error: res.ok ? undefined : res.error,
        rows: res.ok ? res.rows : state[a.name]?.rows ?? [],
        charge_windows: res.charge_windows ?? prevWin,
        refreshed_at: res.ok
          ? new Date().toISOString()
          : state[a.name]?.refreshed_at ?? new Date(0).toISOString(),
        state_version: STATE_VERSION,
      } as AccountState & { state_version: string };
      if (res.ok) refreshed++;
      if (onProgress) {
        try {
          await onProgress(state); // bank progress in case the run is killed
        } catch {}
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(needs.length, 1)) }, worker)
  );

  const rows = Object.values(state).flatMap((r) => r.rows);
  // Highest VAMP count first; ratio as tie-breaker
  rows.sort((a, b) => b.vamp_count - a.vamp_count || b.vamp_ratio - a.vamp_ratio);
  rows.forEach((r, idx) => (r.id = idx + 1));

  const okCount = accounts.filter((a) => state[a.name]?.ok).length;
  const snapshot: Snapshot = {
    generated_at: asOf,
    report_month: reportMonth,
    window: { from: monthStart.toISOString(), to: asOf },
    accounts_total: accounts.length,
    accounts_ok: okCount,
    errors: accounts
      .filter((a) => state[a.name] && !state[a.name].ok && state[a.name].error)
      .map((a) => ({ account: a.name, error: state[a.name].error || "unknown" })),
    rows,
  };
  return { state, snapshot, refreshed, remaining: accounts.length - okCount };
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
  // Apply per-account key overrides (STRIPE_ACCOUNT_OVERRIDES env var).
  // Format: {"Account Name":"rk_live_...", ...}
  // Useful for rotating a single key without re-entering the full STRIPE_ACCOUNTS.
  const overridesRaw = process.env.STRIPE_ACCOUNT_OVERRIDES;
  if (overridesRaw) {
    try {
      const overrides = JSON.parse(overridesRaw) as Record<string, string>;
      for (const entry of out) {
        if (overrides[entry.name]) {
          entry.key = overrides[entry.name].trim();
        }
      }
    } catch {
      // malformed STRIPE_ACCOUNT_OVERRIDES: ignore, use base keys
    }
  }

  return out;
}
