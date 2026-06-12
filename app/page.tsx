"use client";

import React, { useEffect, useState, useMemo } from "react";
import { Table } from "@/components/ui/table";
import { ShowMore } from "@/components/ui/show-more";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import type { VampRow } from "@/lib/vamp";

const PAGE_SIZE = 25;

const currencyFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const pctFmt = new Intl.NumberFormat("en-US", {
  style: "percent",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function StatusBadge({ vampCount, vampRatio }: { vampCount: number; vampRatio: number }) {
  const base = "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap";
  const countBreached = vampCount > 1000;
  const ratioBreached = vampRatio > 0.015;
  const breaches = (countBreached ? 1 : 0) + (ratioBreached ? 1 : 0);

  if (breaches === 2) {
    return (
      <span className={`${base} bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300`}>
        <span className="w-1.5 h-1.5 rounded-full bg-red-500 inline-block shrink-0" />
        Breach 2/2
      </span>
    );
  }
  if (breaches === 1) {
    return (
      <span className={`${base} bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300`}>
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block shrink-0" />
        Breach 1/2
      </span>
    );
  }
  return (
    <span className={`${base} bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300`}>
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block shrink-0" />
      Below Threshold
    </span>
  );
}

function VampRatioDot({ ratio }: { ratio: number }) {
  const pct = ratio * 100;
  const dotColor =
    pct > 1.5
      ? "bg-red-500"
      : pct > 0.9
      ? "bg-amber-500"
      : "bg-emerald-500";

  return (
    <div className="flex items-center gap-2">
      <span className={`w-2 h-2 rounded-full inline-block shrink-0 ${dotColor}`} />
      <span className="tabular-nums text-xs text-gray-900">
        {pctFmt.format(ratio)}
      </span>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      className="text-gray-900"
    >
      <path
        d="M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10ZM14 14l-3-3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      className={`text-gray-900 transition-transform ${spinning ? "animate-spin" : ""}`}
    >
      <path
        d="M13.5 8A5.5 5.5 0 1 1 8 2.5a5.48 5.48 0 0 1 3.9 1.6L13.5 5.6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M13.5 2.5v3h-3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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
  const [meta, setMeta] = useState<{
    generated_at?: string;
    accounts_ok?: number;
    accounts_total?: number;
    errors: { account: string; error: string }[];
  }>({ errors: [] });

  async function loadData() {
    try {
      setRefreshing(true);
      const res = await fetch("/api/vamp");
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      const data: VampRow[] = body.rows ?? [];
      data.sort((a, b) => b.vamp_ratio - a.vamp_ratio);
      setRows(data);
      setMeta({
        generated_at: body.generated_at,
        accounts_ok: body.accounts_ok,
        accounts_total: body.accounts_total,
        errors: body.errors ?? [],
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load data");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  // While data is missing or incomplete: trigger a background refresh batch
  // (max one per ~4.5 min) and poll for results every 30s. The endpoint only
  // accepts unauthenticated triggers while data is incomplete/stale.
  const lastTrigger = React.useRef(0);
  useEffect(() => {
    if (loading) return;
    const incomplete =
      error !== null ||
      (meta.accounts_total !== undefined &&
        (meta.accounts_ok ?? 0) < meta.accounts_total);
    if (!incomplete) return;
    if (Date.now() - lastTrigger.current > 270_000) {
      lastTrigger.current = Date.now();
      fetch("/api/cron/refresh").catch(() => {});
    }
    const t = setTimeout(() => loadData(), 30_000);
    return () => clearTimeout(t);
  }, [loading, error, meta]);

  const filtered = useMemo(() => {
    if (!search.trim()) return rows;
    const q = search.toLowerCase();
    return rows.filter((r) =>
      [
        r.statement_descriptor,
        r.account_name,
        r.report_month,
        r.as_of,
        r.status,
        String(r.disputes_count),
        String(r.efw_count),
        String(r.vamp_count),
        pctFmt.format(r.vamp_ratio),
      ]
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }, [rows, search]);

  const visible = expanded ? filtered : filtered.slice(0, PAGE_SIZE);

  const asOfDate =
    meta.generated_at || rows.length > 0
      ? new Date(meta.generated_at ?? rows[0].as_of).toLocaleDateString("en-GB", {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : null;

  const reportMonth =
    rows.length > 0
      ? new Date(rows[0].report_month).toLocaleDateString("en-GB", {
          month: "long",
          year: "numeric",
        })
      : null;

  return (
    <div className="min-h-screen bg-[var(--ds-background-200)]">
      {/* Header */}
      <header className="bg-background-100 border-b border-gray-alpha-400 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* Logo mark */}
            <div className="w-7 h-7 rounded-md bg-gray-1000 flex items-center justify-center shrink-0">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M8 2L2 5.5V10.5L8 14L14 10.5V5.5L8 2Z"
                  stroke="white"
                  strokeWidth="1.2"
                  strokeLinejoin="round"
                />
                <path
                  d="M8 2V14M2 5.5L14 10.5M14 5.5L2 10.5"
                  stroke="white"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                />
              </svg>
            </div>
            <span className="font-semibold text-sm text-gray-1000 tracking-tight">
              Progress Partners Risk
            </span>
          </div>

          <div className="flex items-center gap-2 text-xs text-gray-900">
            {reportMonth && (
              <span className="hidden sm:inline">
                Report month: <strong className="text-gray-1000">{reportMonth}</strong>
              </span>
            )}
            {asOfDate && (
              <>
                <span className="hidden sm:inline text-gray-alpha-400">·</span>
                <span className="hidden sm:inline">
                  As of <strong className="text-gray-1000">{asOfDate}</strong>
                </span>
              </>
            )}
            <ThemeToggle />
            <button
              onClick={loadData}
              disabled={refreshing}
              className="p-1.5 rounded-md hover:bg-background-200 transition-colors"
              title="Refresh data"
            >
              <RefreshIcon spinning={refreshing} />
            </button>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
        {/* Page title + stats */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-1000 mb-1">
            VAMP Risk Monitor
          </h1>
          <p className="text-sm text-gray-900">
            Visa Acquirer Monitoring Program — fraud dispute ratios by statement
            descriptor.
          </p>
        </div>

        {/* Account fetch errors */}
        {meta.errors.length > 0 && (
          <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-900/10 p-3 text-xs text-amber-800 dark:text-amber-300">
            <strong>
              {meta.errors.length} of {meta.accounts_total} accounts failed to
              refresh:
            </strong>{" "}
            {meta.errors.map((e) => e.account).join(", ")}
          </div>
        )}

        {/* Stat cards */}
        {!loading && !error && rows.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
            <StatCard
              label="Total Accounts"
              value={`${meta.accounts_ok ?? 0}/${meta.accounts_total ?? 0}`}
            />
            <StatCard
              label="Total Descriptors"
              value={rows.length.toLocaleString()}
            />
            <StatCard
              label="High Risk (≥1.5%)"
              value={rows
                .filter((r) => r.vamp_ratio >= 0.015)
                .length.toString()}
              highlight={rows.some((r) => r.vamp_ratio >= 0.015)}
            />
            <StatCard
              label="Breach 1/2"
              value={rows
                .filter(
                  (r) =>
                    (r.vamp_count > 1000 ? 1 : 0) +
                      (r.vamp_ratio > 0.015 ? 1 : 0) ===
                    1
                )
                .length.toString()}
              highlight={
                rows.filter(
                  (r) =>
                    (r.vamp_count > 1000 ? 1 : 0) +
                      (r.vamp_ratio > 0.015 ? 1 : 0) ===
                    1
                ).length > 0
              }
            />
            <StatCard
              label="Breach 2/2"
              value={rows
                .filter(
                  (r) => r.vamp_count > 1000 && r.vamp_ratio > 0.015
                )
                .length.toString()}
              highlight={rows.some(
                (r) => r.vamp_count > 1000 && r.vamp_ratio > 0.015
              )}
            />
            <StatCard
              label="Portfolio VAMP"
              value={pctFmt.format(
                rows.reduce((s, r) => s + r.visa_sales_count, 0) > 0
                  ? rows.reduce((s, r) => s + r.vamp_count, 0) /
                      rows.reduce((s, r) => s + r.visa_sales_count, 0)
                  : 0
              )}
              highlight={
                rows.reduce((s, r) => s + r.visa_sales_count, 0) > 0 &&
                rows.reduce((s, r) => s + r.vamp_count, 0) /
                  rows.reduce((s, r) => s + r.visa_sales_count, 0) >
                  0.015
              }
            />
          </div>
        )}

        {/* Search bar */}
        <div className="relative mb-4">
          <div className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">
            <SearchIcon />
          </div>
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setExpanded(false);
            }}
            placeholder="Search by descriptor, account, status, ratio…"
            className="w-full h-10 pl-9 pr-4 text-sm rounded-lg border border-gray-alpha-400 bg-background-100 text-gray-1000 placeholder:text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-1000/20 transition-shadow"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-900 hover:text-gray-1000"
            >
              ✕
            </button>
          )}
        </div>

        {/* Result count when searching */}
        {search && (
          <p className="text-xs text-gray-900 mb-3">
            {filtered.length === 0
              ? "No results"
              : `${filtered.length} result${filtered.length !== 1 ? "s" : ""} for "${search}"`}
          </p>
        )}

        {/* Table */}
        {loading ? (
          <div className="flex items-center justify-center h-48 text-gray-900 text-sm">
            Loading data…
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-48 text-red-500 text-sm">
            {error}
          </div>
        ) : (
          <div className="relative">
            <Table>
              <Table.Colgroup>
                <Table.Col className="w-[14%]" />
                <Table.Col className="w-[30%]" />
                <Table.Col className="w-[12%]" />
                <Table.Col className="w-[14%]" />
                <Table.Col className="w-[14%]" />
                <Table.Col className="w-[16%]" />
              </Table.Colgroup>

              <Table.Header>
                <Table.Row>
                  <Table.Head>Account</Table.Head>
                  <Table.Head>Statement Descriptor</Table.Head>
                  <Table.Head>VAMP Count</Table.Head>
                  <Table.Head>VAMP Ratio</Table.Head>
                  <Table.Head>Sales</Table.Head>
                  <Table.Head>Status</Table.Head>
                </Table.Row>
              </Table.Header>

              <Table.Body interactive striped>
                {visible.map((row, i) => (
                  <Table.Row key={`${row.statement_descriptor}-${i}`}>
                    <Table.Cell>
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-background-200 border border-gray-alpha-400 text-gray-1000">
                        {row.account_name}
                      </span>
                    </Table.Cell>
                    <Table.Cell>
                      <span className="font-mono text-xs">
                        {row.statement_descriptor}
                      </span>
                    </Table.Cell>
                    <Table.Cell className={`tabular-nums font-medium ${row.vamp_count > 1000 ? "text-red-500 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}`}>
                      {row.vamp_count.toLocaleString()}
                    </Table.Cell>
                    <Table.Cell>
                      <VampRatioDot ratio={row.vamp_ratio} />
                    </Table.Cell>
                    <Table.Cell className="tabular-nums">
                      {row.sales_count.toLocaleString()}
                    </Table.Cell>
                    <Table.Cell className="text-right">
                      <StatusBadge vampCount={row.vamp_count} vampRatio={row.vamp_ratio} />
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>

              {!search && (
                <Table.Footer>
                  <Table.Row>
                    <Table.Cell
                      className="text-gray-1000 font-medium"
                      colSpan={2}
                    >
                      Totals ({rows.length} descriptors)
                    </Table.Cell>
                    <Table.Cell className="text-gray-1000 font-medium tabular-nums">
                      {rows.reduce((s, r) => s + r.vamp_count, 0).toLocaleString()}
                    </Table.Cell>
                    <Table.Cell />
                    <Table.Cell className="text-gray-1000 font-medium tabular-nums">
                      {rows.reduce((s, r) => s + r.sales_count, 0).toLocaleString()}
                    </Table.Cell>
                    <Table.Cell />
                  </Table.Row>
                </Table.Footer>
              )}
            </Table>

            {/* Show more / less */}
            {filtered.length > PAGE_SIZE && (
              <>
                {!expanded && (
                  <div className="pointer-events-none absolute bottom-12 left-0 h-20 w-full rounded-b-lg bg-gradient-to-t from-[var(--ds-background-200)] to-transparent" />
                )}
                <div className="h-4" />
                <ShowMore
                  expanded={expanded}
                  onClick={setExpanded}
                  className="mx-auto"
                />
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function StatCard({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-4 ${
        highlight
          ? "border-red-200 bg-red-50 dark:border-red-900/40 dark:bg-red-900/10"
          : "border-gray-alpha-400 bg-background-100"
      }`}
    >
      <p className="text-xs text-gray-900 mb-1">{label}</p>
      <p
        className={`text-xl font-bold tabular-nums ${
          highlight ? "text-red-600 dark:text-red-400" : "text-gray-1000"
        }`}
      >
        {value}
      </p>
    </div>
  );
}
