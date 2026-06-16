"use client";

import React, { useEffect, useState, useMemo } from "react";
import { Table } from "@/components/ui/table";
import { ShowMore } from "@/components/ui/show-more";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import type { VampRow } from "@/app/api/vamp/route";

const PAGE_SIZE = 25;

const pctFmt = new Intl.NumberFormat("en-US", {
  style: "percent",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// VAMP thresholds (Visa programme limits)
const THRESHOLD_RATIO = 0.009;  // 0.9% — Early Warning
const BREACH_RATIO   = 0.018;  // 1.8% — VAMP breach
const THRESHOLD_COUNT = 750;
const BREACH_COUNT    = 1000;

function statusLevel(row: VampRow): "breach" | "warning" | "ok" {
  const ratioBreach  = row.vamp_ratio  >= BREACH_RATIO;
  const countBreach  = row.vamp_count  >= BREACH_COUNT;
  const ratioWarning = row.vamp_ratio  >= THRESHOLD_RATIO;
  const countWarning = row.vamp_count  >= THRESHOLD_COUNT;
  if (ratioBreach || countBreach) return "breach";
  if (ratioWarning || countWarning) return "warning";
  return "ok";
}

function StatusBadge({ row }: { row: VampRow }) {
  const level = statusLevel(row);
  const base = "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap";
  if (level === "breach")
    return (
      <span className={`${base} bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300`}>
        <span className="w-1.5 h-1.5 rounded-full bg-red-500 inline-block shrink-0" />
        Breach
      </span>
    );
  if (level === "warning")
    return (
      <span className={`${base} bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300`}>
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block shrink-0" />
        Warning
      </span>
    );
  return (
    <span className={`${base} bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300`}>
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block shrink-0" />
      OK
    </span>
  );
}

function VampRatioCell({ row }: { row: VampRow }) {
  const level = statusLevel(row);
  const dotColor =
    level === "breach" ? "bg-red-500" :
    level === "warning" ? "bg-amber-500" :
    "bg-emerald-500";
  const textColor =
    level === "breach" ? "text-red-600 dark:text-red-400" :
    level === "warning" ? "text-amber-600 dark:text-amber-400" :
    "text-gray-900";

  return (
    <div className="flex items-center gap-2">
      <span className={`w-2 h-2 rounded-full inline-block shrink-0 ${dotColor}`} />
      <span className={`tabular-nums text-xs font-medium ${textColor}`}>
        {pctFmt.format(row.vamp_ratio)}
      </span>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="text-gray-900">
      <path d="M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10ZM14 14l-3-3"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
      className={`text-gray-900 transition-transform ${spinning ? "animate-spin" : ""}`}>
      <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5a5.48 5.48 0 0 1 3.9 1.6L13.5 5.6"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.5 2.5v3h-3"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function Dashboard() {
  const [rows, setRows] = useState<VampRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  async function loadData() {
    try {
      setRefreshing(true);
      const res = await fetch("/api/vamp", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: VampRow[] = await res.json();
      setRows(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load data");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => { loadData(); }, []);

  const filtered = useMemo(() => {
    if (!search.trim()) return rows;
    const q = search.toLowerCase();
    return rows.filter((r) =>
      [r.statement_descriptor, r.product_name, r.account_id,
       pctFmt.format(r.vamp_ratio), String(r.vamp_count)]
        .join(" ").toLowerCase().includes(q)
    );
  }, [rows, search]);

  const visible = expanded ? filtered : filtered.slice(0, PAGE_SIZE);

  const reportLabel = rows[0]
    ? new Date(rows[0].report_month).toLocaleDateString("en-GB", { month: "long", year: "numeric" })
    : null;
  const asOfLabel = rows[0]
    ? new Date(rows[0].as_of).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
    : null;

  const breachCount  = rows.filter((r) => statusLevel(r) === "breach").length;
  const warningCount = rows.filter((r) => statusLevel(r) === "warning").length;
  const totalEfw     = rows.reduce((s, r) => s + r.efw_count, 0);
  const totalDisp    = rows.reduce((s, r) => s + r.disputes_count, 0);

  return (
    <div className="min-h-screen bg-[var(--ds-background-200)]">
      {/* Header */}
      <header className="bg-background-100 border-b border-gray-alpha-400 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 rounded-md bg-gray-1000 flex items-center justify-center shrink-0">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M8 2L2 5.5V10.5L8 14L14 10.5V5.5L8 2Z"
                  stroke="white" strokeWidth="1.2" strokeLinejoin="round" />
                <path d="M8 2V14M2 5.5L14 10.5M14 5.5L2 10.5"
                  stroke="white" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </div>
            <span className="font-semibold text-sm text-gray-1000 tracking-tight">
              Progress Partners Risk
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs text-gray-900">
            {reportLabel && (
              <span className="hidden sm:inline">
                Report: <strong className="text-gray-1000">{reportLabel}</strong>
              </span>
            )}
            {asOfLabel && (
              <>
                <span className="hidden sm:inline text-gray-alpha-400">·</span>
                <span className="hidden sm:inline">
                  As of <strong className="text-gray-1000">{asOfLabel}</strong>
                </span>
              </>
            )}
            <ThemeToggle />
            <button onClick={loadData} disabled={refreshing}
              className="p-1.5 rounded-md hover:bg-background-200 transition-colors" title="Refresh">
              <RefreshIcon spinning={refreshing} />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-1000 mb-1">VAMP Risk Monitor</h1>
          <p className="text-sm text-gray-900">
            Visa Acquirer Monitoring Programme — Radar EFW + disputes by descriptor.{" "}
            <span className="text-amber-600 dark:text-amber-400">
              Note: counts use Radar EFWs, not Visa TC40; may differ from Stripe dashboard.
            </span>
          </p>
        </div>

        {!loading && !error && rows.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
            <StatCard label="Descriptors" value={rows.length.toString()} />
            <StatCard label="In Breach" value={breachCount.toString()} highlight={breachCount > 0} />
            <StatCard label="Warnings" value={warningCount.toString()} warn={warningCount > 0} />
            <StatCard label="Total EFWs + Disputes" value={(totalEfw + totalDisp).toLocaleString()} />
          </div>
        )}

        {/* Search */}
        <div className="relative mb-4">
          <div className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">
            <SearchIcon />
          </div>
          <input type="text" value={search}
            onChange={(e) => { setSearch(e.target.value); setExpanded(false); }}
            placeholder="Search descriptor, product, status…"
            className="w-full h-10 pl-9 pr-4 text-sm rounded-lg border border-gray-alpha-400 bg-background-100 text-gray-1000 placeholder:text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-1000/20 transition-shadow"
          />
          {search && (
            <button onClick={() => setSearch("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-900 hover:text-gray-1000">✕</button>
          )}
        </div>

        {search && (
          <p className="text-xs text-gray-900 mb-3">
            {filtered.length === 0 ? "No results" : `${filtered.length} result${filtered.length !== 1 ? "s" : ""} for "${search}"`}
          </p>
        )}

        {loading ? (
          <div className="flex items-center justify-center h-48 text-gray-900 text-sm">Loading…</div>
        ) : error ? (
          <div className="flex items-center justify-center h-48 text-red-500 text-sm">{error}</div>
        ) : (
          <div className="relative">
            <Table>
              <Table.Colgroup>
                <Table.Col className="w-[24%]" />
                <Table.Col className="w-[9%]" />
                <Table.Col className="w-[8%]" />
                <Table.Col className="w-[8%]" />
                <Table.Col className="w-[9%]" />
                <Table.Col className="w-[14%]" />
                <Table.Col className="w-[14%]" />
                <Table.Col className="w-[14%]" />
              </Table.Colgroup>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Descriptor</Table.Head>
                  <Table.Head>Product</Table.Head>
                  <Table.Head>EFWs</Table.Head>
                  <Table.Head>Disputes</Table.Head>
                  <Table.Head>VAMP Count</Table.Head>
                  <Table.Head>VAMP Ratio</Table.Head>
                  <Table.Head>Visa Sales</Table.Head>
                  <Table.Head>Status</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body interactive striped>
                {visible.map((row, i) => {
                  const level = statusLevel(row);
                  const countColor =
                    level === "breach" ? "text-red-600 dark:text-red-400" :
                    level === "warning" ? "text-amber-600 dark:text-amber-400" :
                    "text-emerald-600 dark:text-emerald-400";
                  return (
                    <Table.Row key={`${row.account_id}-${row.statement_descriptor}-${i}`}>
                      <Table.Cell>
                        <span className="font-mono text-xs">{row.statement_descriptor}</span>
                      </Table.Cell>
                      <Table.Cell>
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-background-200 border border-gray-alpha-400 text-gray-1000">
                          {row.product_name}
                        </span>
                      </Table.Cell>
                      <Table.Cell className="tabular-nums">{row.efw_count.toLocaleString()}</Table.Cell>
                      <Table.Cell className="tabular-nums">{row.disputes_count.toLocaleString()}</Table.Cell>
                      <Table.Cell className={`tabular-nums font-medium ${countColor}`}>
                        {row.vamp_count.toLocaleString()}
                      </Table.Cell>
                      <Table.Cell><VampRatioCell row={row} /></Table.Cell>
                      <Table.Cell className="tabular-nums text-gray-900">
                        {row.visa_sales.toLocaleString()}
                        {row.sales_capped && <span className="text-amber-500 ml-1" title="Sales count capped at 20 000">+</span>}
                      </Table.Cell>
                      <Table.Cell><StatusBadge row={row} /></Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
              {!search && (
                <Table.Footer>
                  <Table.Row>
                    <Table.Cell className="text-gray-1000 font-medium" colSpan={2}>
                      Totals ({rows.length} descriptors)
                    </Table.Cell>
                    <Table.Cell className="tabular-nums font-medium text-gray-1000">
                      {totalEfw.toLocaleString()}
                    </Table.Cell>
                    <Table.Cell className="tabular-nums font-medium text-gray-1000">
                      {totalDisp.toLocaleString()}
                    </Table.Cell>
                    <Table.Cell className="tabular-nums font-medium text-gray-1000">
                      {(totalEfw + totalDisp).toLocaleString()}
                    </Table.Cell>
                    <Table.Cell colSpan={3} />
                  </Table.Row>
                </Table.Footer>
              )}
            </Table>

            {filtered.length > PAGE_SIZE && (
              <>
                {!expanded && (
                  <div className="pointer-events-none absolute bottom-12 left-0 h-20 w-full rounded-b-lg bg-gradient-to-t from-[var(--ds-background-200)] to-transparent" />
                )}
                <div className="h-4" />
                <ShowMore expanded={expanded} onClick={setExpanded} className="mx-auto" />
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function StatCard({ label, value, highlight, warn }: {
  label: string; value: string; highlight?: boolean; warn?: boolean;
}) {
  const border = highlight ? "border-red-200 bg-red-50 dark:border-red-900/40 dark:bg-red-900/10"
    : warn ? "border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-900/10"
    : "border-gray-alpha-400 bg-background-100";
  const text = highlight ? "text-red-600 dark:text-red-400"
    : warn ? "text-amber-600 dark:text-amber-400"
    : "text-gray-1000";
  return (
    <div className={`rounded-lg border p-4 ${border}`}>
      <p className="text-xs text-gray-900 mb-1">{label}</p>
      <p className={`text-xl font-bold tabular-nums ${text}`}>{value}</p>
    </div>
  );
}
