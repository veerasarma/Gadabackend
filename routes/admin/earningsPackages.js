// src/pages/admin/EarningsPackages.tsx
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useAuthHeader } from "@/hooks/useAuthHeader";
import { getPackagesSummary, getPackagesTable } from "@/services/adminEarningsPackages";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import { format } from "date-fns";

const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const fmtN = (n: number) => `₦${(n || 0).toLocaleString()}`;

// ---------- Color mapping (matches screenshot) ----------
const COLOR_BY_PACKAGE: Record<string, string> = {
  "GADA VIP": "#27A5FF",   // blue
  "GADA VVIP": "#6B5DE7",  // purple
};
const FALLBACK_PALETTE = [
  "#00C49F", "#FFBB28", "#FF8042", "#A78BFA", "#34D399", "#F472B6", "#60A5FA",
];
const normalize = (s: string) => s.trim().toLowerCase();
const colorFor = (name: string, idx: number) => {
  // exact match first
  if (COLOR_BY_PACKAGE[name]) return COLOR_BY_PACKAGE[name];
  // fuzzy helper (in case the name varies slightly)
  const n = normalize(name);
  if (n.includes("vvip")) return "#6B5DE7";
  if (n.includes("vip")) return "#27A5FF";
  return FALLBACK_PALETTE[idx % FALLBACK_PALETTE.length];
};
// -------------------------------------------------------

export default function EarningsPackages() {
  const { accessToken } = useAuth();
  const headers = useAuthHeader(accessToken);
  const ready = useMemo(() => "Authorization" in headers, [headers]);

  const [year, setYear] = useState(new Date().getFullYear());

  // summary
  const [summary, setSummary] = useState<{
    totalAll: number;
    totalThisMonth: number;
    chart: any[];
    seriesNames: string[];
  }>({ totalAll: 0, totalThisMonth: 0, chart: [], seriesNames: [] });

  // table
  const [rows, setRows] = useState<{ package_id:number; package:string; total_sales:number; total_earnings:number }[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState("");
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");
  const [sort, setSort] = useState<"earnings"|"sales"|"name">("earnings");
  const [order, setOrder] = useState<"asc"|"desc">("desc");

  // load summary
  const loadSummary = async () => {
    try {
      const s = await getPackagesSummary(headers, { year });
      // turn series into recharts data
      const seriesNames = s.series.map(sx => sx.package_name);
      const chart = monthNames.map((m, idx) => {
        const obj: any = { month: m };
        for (const sx of s.series) obj[sx.package_name] = sx.data[idx] || 0;
        return obj;
      });
      setSummary({ totalAll: s.totalAll, totalThisMonth: s.totalThisMonth, chart, seriesNames });
    } catch (e: any) {
      toast.error("Failed to load summary", { description: e?.message });
    }
  };

  // load table
  const loadTable = async () => {
    try {
      const t = await getPackagesTable(headers, { search, page, pageSize, startDate, endDate, sort, order });
      setRows(t.items);
      setTotal(t.total);
      setTotalPages(t.totalPages);
    } catch (e: any) {
      toast.error("Failed to load table", { description: e?.message });
    }
  };

  useEffect(() => { if (ready) loadSummary(); }, [ready, year]);
  useEffect(() => { if (ready) loadTable(); }, [ready, page, pageSize, sort, order, startDate, endDate]);

  const pages = useMemo(() => {
    const arr: (number | "…")[] = [];
    if (totalPages <= 7) { for (let i=1;i<=totalPages;i++) arr.push(i); return arr; }
    arr.push(1);
    if (page > 3) arr.push("…");
    const s = Math.max(2, page-1), e = Math.min(totalPages-1, page+1);
    for (let i=s;i<=e;i++) arr.push(i);
    if (page < totalPages-2) arr.push("…");
    arr.push(totalPages);
    return arr;
  }, [page, totalPages]);

  return (
    <div className="space-y-6">
      {/* Chart Card */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Packages</CardTitle>
          <div className="flex items-center gap-2">
            <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
              <SelectTrigger className="w-28"><SelectValue placeholder="Year" /></SelectTrigger>
              <SelectContent>
                {[0,1,2,3].map(offset => {
                  const y = new Date().getFullYear() - offset;
                  return <SelectItem key={y} value={String(y)}>{y}</SelectItem>;
                })}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={summary.chart}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="month" />
              <YAxis />
              <Tooltip formatter={(v:number) => fmtN(v)} />
              <Legend />
              {summary.seriesNames.map((name, idx) => (
                <Bar key={name} dataKey={name} fill={colorFor(name, idx)} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* KPI cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card className="bg-gradient-to-r from-indigo-600 to-indigo-500 text-white">
          <CardHeader><CardTitle>Total Earnings</CardTitle></CardHeader>
          <CardContent className="text-3xl font-semibold">{fmtN(summary.totalAll)}</CardContent>
        </Card>
        <Card className="bg-gradient-to-r from-cyan-600 to-cyan-500 text-white">
          <CardHeader><CardTitle>This Month Earnings</CardTitle></CardHeader>
          <CardContent className="text-3xl font-semibold">{fmtN(summary.totalThisMonth)}</CardContent>
        </Card>
      </div>

      {/* Table + controls */}
      <Card>
        <CardHeader className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <CardTitle>Packages</CardTitle>
          <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-500">Show</span>
              <Select value={String(pageSize)} onValueChange={(v) => { setPage(1); setPageSize(Number(v)); }}>
                <SelectTrigger className="w-20"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="10">10</SelectItem>
                  <SelectItem value="25">25</SelectItem>
                  <SelectItem value="50">50</SelectItem>
                </SelectContent>
              </Select>
              <span className="text-sm text-gray-500">entries</span>
            </div>
            <div className="flex items-center gap-2">
              <Input
                placeholder="Search package…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-10 w-56"
              />
              <Button onClick={() => { setPage(1); loadTable(); }}>Search</Button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Extra filters */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Start Date</label>
              <Input type="date" value={startDate} onChange={(e) => { setPage(1); setStartDate(e.target.value); }} max={format(new Date(), "yyyy-MM-dd")} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">End Date</label>
              <Input type="date" value={endDate} onChange={(e) => { setPage(1); setEndDate(e.target.value); }} max={format(new Date(), "yyyy-MM-dd")} />
            </div>
            <div className="flex items-end gap-2">
              <Select value={`${sort}:${order}`} onValueChange={(v) => {
                const [s,o] = v.split(":") as any; setSort(s); setOrder(o);
              }}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Sort" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="earnings:desc">Earnings ↓</SelectItem>
                  <SelectItem value="earnings:asc">Earnings ↑</SelectItem>
                  <SelectItem value="sales:desc">Sales ↓</SelectItem>
                  <SelectItem value="sales:asc">Sales ↑</SelectItem>
                  <SelectItem value="name:asc">Name A–Z</SelectItem>
                  <SelectItem value="name:desc">Name Z–A</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="secondary" onClick={() => { setSearch(""); setStartDate(""); setEndDate(""); setSort("earnings"); setOrder("desc"); setPage(1); }}>Clear</Button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Package</TableHead>
                  <TableHead>Total Sales</TableHead>
                  <TableHead>Total Earnings</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length ? rows.map(r => (
                  <TableRow key={r.package_id}>
                    <TableCell>{r.package}</TableCell>
                    <TableCell>{r.total_sales.toLocaleString()}</TableCell>
                    <TableCell>{fmtN(r.total_earnings)}</TableCell>
                  </TableRow>
                )) : (
                  <TableRow><TableCell colSpan={3} className="text-center text-gray-500">No data</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between text-sm text-gray-500">
            <div>Showing {rows.length ? (page - 1) * pageSize + 1 : 0} to {(page - 1) * pageSize + rows.length} of {total}</div>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(1)}>First</Button>
              <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(p => Math.max(1, p - 1))}>Prev</Button>
              {useMemo(() => {
                const arr: (number | "…")[] = [];
                if (totalPages <= 7) { for (let i=1;i<=totalPages;i++) arr.push(i); }
                else {
                  arr.push(1);
                  if (page > 3) arr.push("…");
                  const s = Math.max(2, page-1), e = Math.min(totalPages-1, page+1);
                  for (let i=s;i<=e;i++) arr.push(i);
                  if (page < totalPages-2) arr.push("…");
                  arr.push(totalPages);
                }
                return arr;
              }, [page, totalPages]).map((p, i) =>
                p === "…" ? <span key={`e${i}`} className="px-2">…</span> :
                <Button key={p as number} variant={p === page ? "default" : "outline"} size="sm" onClick={() => setPage(p as number)}>{p}</Button>
              )}
              <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>Next</Button>
              <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(totalPages)}>Last</Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
