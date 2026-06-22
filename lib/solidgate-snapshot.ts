// Solidgate snapshot builder — sibling to buildSnapshotIncremental in lib/vamp.ts.
// Same time-budgeted, resumable pattern; one entry per channel.

import { fetchSolidgateChannelVamp, parseSolidgateChannels, type SolidgateChannel } from "./solidgate-vamp";
import type { AccountState, Snapshot, StateMap } from "./vamp";

const REFRESH_IF_OLDER_MS = 6 * 60 * 60 * 1000;

export async function buildSolidgateSnapshotIncremental(
  channels: SolidgateChannel[],
  prevState: StateMap,
  deadline: number,
  concurrency = 4,
  onProgress?: (state: StateMap) => Promise<void>
): Promise<{ state: StateMap; snapshot: Snapshot; refreshed: number; remaining: number }> {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const fmt = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
  const fromIso = fmt(monthStart);
  const toIso = fmt(now);
  const reportMonth = monthStart.toISOString().slice(0, 10);
  const asOf = now.toISOString();

  const state: StateMap = { ...prevState };
  for (const [name, st] of Object.entries(state)) {
    if (st.rows.length > 0 && st.rows[0].report_month !== reportMonth) {
      delete state[name];
    }
  }

  const needs = channels.filter((c) => {
    const st = state[c.name];
    if (!st || !st.ok) return true;
    return Date.now() - new Date(st.refreshed_at).getTime() > REFRESH_IF_OLDER_MS;
  });
  needs.sort((a, b) => {
    const ta = state[a.name] ? new Date(state[a.name].refreshed_at).getTime() : 0;
    const tb = state[b.name] ? new Date(state[b.name].refreshed_at).getTime() : 0;
    return ta - tb;
  });

  let refreshed = 0;
  let i = 0;
  async function worker() {
    while (i < needs.length) {
      if (deadline - Date.now() < 30_000) return;
      const c = needs[i++];
      const prevWin = state[c.name]?.charge_windows ?? {};
      const res = await fetchSolidgateChannelVamp(
        c,
        fromIso,
        toIso,
        reportMonth,
        asOf,
        prevWin,
        deadline
      );
      const hadOk = state[c.name]?.ok ?? false;
      state[c.name] = {
        account: c.name,
        ok: res.ok || hadOk,
        error: res.ok ? undefined : res.error,
        rows: res.ok ? res.rows : state[c.name]?.rows ?? [],
        charge_windows: res.charge_windows ?? prevWin,
        refreshed_at: res.ok
          ? new Date().toISOString()
          : state[c.name]?.refreshed_at ?? new Date(0).toISOString(),
      } as AccountState;
      if (res.ok) refreshed++;
      if (onProgress) {
        try { await onProgress(state); } catch {}
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(needs.length, 1)) }, worker)
  );

  const rows = Object.values(state).flatMap((r) => r.rows);
  rows.sort((a, b) => b.vamp_count - a.vamp_count || b.vamp_ratio - a.vamp_ratio);
  rows.forEach((r, idx) => (r.id = idx + 1));

  const okCount = channels.filter((c) => state[c.name]?.ok).length;
  const snapshot: Snapshot = {
    generated_at: asOf,
    report_month: reportMonth,
    window: { from: monthStart.toISOString(), to: asOf },
    accounts_total: channels.length,
    accounts_ok: okCount,
    errors: channels
      .filter((c) => state[c.name] && !state[c.name].ok && state[c.name].error)
      .map((c) => ({ account: c.name, error: state[c.name].error || "unknown" })),
    rows,
  };
  return { state, snapshot, refreshed, remaining: channels.length - okCount };
}

export { parseSolidgateChannels };
