// src/DashboardPage.jsx
import { useEffect, useState } from "react"
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts"

const OWNER_ID = "19053279955"

const MONEY_CLASS = "font-mono text-[#39ff14]"
const PCT_CLASS = "font-mono text-[#39ff14]"

function formatMoneyFromCents(cents) {
  if (cents == null) return "—"
  const n = Number(cents) / 100
  return n.toLocaleString("en-CA", {
    style: "currency",
    currency: "CAD",
    maximumFractionDigits: 2,
  })
}

function formatUnit(value, unit) {
  if (value == null) return "—"
  switch (unit) {
    case "percent":
      return `${Number(value).toFixed(1)}%`
    case "days":
      return `${Math.round(Number(value))} days`
    case "ratio":
      return Number(value).toFixed(2)
    default:
      return String(value)
  }
}

export default function DashboardPage() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [data, setData] = useState(null)
  const [period, setPeriod] = useState("this_month")
  const [askChiefQuery, setAskChiefQuery] = useState("")
  const [receiptQuery, setReceiptQuery] = useState("")
  const [chiefAnswer, setChiefAnswer] = useState("")
const [chiefLoading, setChiefLoading] = useState(false)
const [chiefError, setChiefError] = useState("")


  useEffect(() => {
    async function load() {
      try {
        setLoading(true)
        setError("")
        const resp = await fetch(
          `/api/dashboard?ownerId=${OWNER_ID}&period=${period}`
        )
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}`)
        }
        const json = await resp.json()
        setData(json)
      } catch (e) {
        console.error("Dashboard fetch error:", e)
        setError(e.message || "Failed to load dashboard data")
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [period])

  const tiles = data?.tiles || []
  const kpis = data?.kpis || []
  const jobs = data?.jobs || []

  const plan = data?.plan || {}
  const featureFlags = data?.featureFlags || {}
    const tasks = data?.tasks || []
  const receipts = data?.recentReceipts || []
  const leads = data?.leads || []  // will be empty until you wire it on backend

  const isPro = !!plan.isPro

  const canShowJobLeaks =
    featureFlags.jobLeakSection ?? isPro
  const canShowAdvancedKpis =
    featureFlags.advancedKpis ?? isPro
  const canShowForecast =
    featureFlags.forecast ?? isPro

  const tileMap = Object.fromEntries(tiles.map((t) => [t.code, t]))

  const revenueTile = tileMap["revenue"]
  const netProfitTile = tileMap["net_profit"]
  const grossMarginTile = tileMap["gross_margin_pct"]
  const cashTile = tileMap["cash_in_bank"]
  const arTile = tileMap["ar"]
  const apTile = tileMap["ap"]
  const wcTile = tileMap["working_capital"]

  const profitChartData = [
    { name: "Invoiced", value: revenueTile?.value_cents ?? 0 },
    { name: "Net Profit", value: netProfitTile?.value_cents ?? 0 },
  ]

  const arApChartData = [
    { name: "AR (owed to you)", value: arTile?.value_cents ?? 0 },
    { name: "AP (you owe)", value: apTile?.value_cents ?? 0 },
  ]

  const tileOrder = [
    "revenue",
    "net_profit",
    "cash_in_bank",
    "ar",
    "ap",
    "working_capital",
    "gross_margin_pct",
    "average_debtor_days",
    "working_capital_ratio",
  ]
  const orderedTiles = tileOrder
    .map((code) => tileMap[code])
    .filter(Boolean)

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50">
      <div className="mx-auto max-w-6xl px-4 py-6 space-y-6">
        {/* Header */}
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Chief AI — Job &amp; Cash Dashboard
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              Built for contractors: see what&apos;s invoiced, what&apos;s stuck
              in AR, and how much profit is left after overhead.
            </p>
            {data?.ownerId && (
              <p className="mt-1 text-xs text-slate-500">
                Owner: <span className="font-mono">{data.ownerId}</span>{" "}
                · Period:{" "}
                <span className="font-mono">
                  {data.periodLabel || data.period}
                </span>
                {plan?.tier && (
                  <>
                    {" "}
                    · Plan:{" "}
                    <span className="font-mono uppercase">
                      {plan.tier}
                    </span>
                  </>
                )}
              </p>
            )}
          </div>
          <Button
            variant="outline"
            className="border-slate-700 bg-slate-900 text-slate-100 hover:bg-slate-800"
            onClick={() => window.location.reload()}
          >
            Refresh
          </Button>
        </header>

        {/* Period selector */}
        {!loading && !error && (
          <div className="flex flex-wrap gap-2">
            {[
              ["today", "Today"],
              ["this_week", "This Week"],
              ["this_month", "This Month"],
              ["last_month", "Last Month"],
              ["ytd", "Year-to-Date"],
            ].map(([key, label]) => (
              <button
                key={key}
                onClick={() => setPeriod(key)}
                className={
                  "px-3 py-1 text-xs font-mono uppercase tracking-wide rounded " +
                  (period === key
                    ? "bg-slate-800 text-[#39ff14]"
                    : "bg-slate-900 text-slate-300 hover:text-[#39ff14]")
                }
              >
                {label}
              </button>
            ))}
          </div>
        )}

              {/* Ask Chief + Receipt lookup bars */}
        {!loading && !error && (
          <section className="grid gap-4 md:grid-cols-2">
            {/* Ask Chief */}
            <Card className="border-slate-800 bg-slate-900/60">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-slate-200">
                  Ask Chief about your numbers
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-slate-400 mb-2">
                  Same Chief from WhatsApp, but on desktop. Ask about profit,
                  cash, or jobs (e.g. “How did the Smith roof job perform?”).
                </p>
                <form
                  className="flex gap-2"
                  onSubmit={async (e) => {
                    e.preventDefault()
                    const q = askChiefQuery.trim()
                    if (!q) return
                    try {
                      setChiefLoading(true)
                      setChiefError("")
                      setChiefAnswer("")
                      const resp = await fetch("/deep-dive/dashboard", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          ownerId: OWNER_ID,
                          question: q,
                          period,
                        }),
                      })
                      if (!resp.ok) {
                        throw new Error(`HTTP ${resp.status}`)
                      }
                      const json = await resp.json()
                      if (!json.ok) {
                        throw new Error(json.error || "Deep-dive error")
                      }
                      setChiefAnswer(json.answer || "")
                    } catch (err) {
                      console.error("Ask Chief error:", err)
                      setChiefError(
                        err.message || "Chief had trouble reading your data"
                      )
                    } finally {
                      setChiefLoading(false)
                      setAskChiefQuery("")
                    }
                  }}
                >
                  <input
                    type="text"
                    value={askChiefQuery}
                    onChange={(e) => setAskChiefQuery(e.target.value)}
                    placeholder="Ask anything about your jobs or cash…"
                    className="flex-1 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-[#39ff14]"
                  />
                  <Button
                    type="submit"
                    className="text-xs font-mono uppercase"
                    disabled={chiefLoading}
                  >
                    {chiefLoading ? "Thinking…" : "Ask Chief"}
                  </Button>
                </form>

                {/* Chief says… */}
                {chiefError && (
                  <div className="mt-3 rounded border border-rose-500/40 bg-rose-950/40 px-3 py-2 text-xs text-rose-100">
                    Chief hit a snag: {chiefError}
                  </div>
                )}

                {chiefAnswer && !chiefError && (
                  <div className="mt-3 rounded border border-slate-700 bg-slate-950/60 px-3 py-2 text-xs text-slate-100">
                    <div className="mb-1 text-[11px] font-mono uppercase tracking-wide text-[#39ff14]">
                      Chief says:
                    </div>
                    <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed">
                      {chiefAnswer}
                    </pre>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Receipt lookup */}
            <Card className="border-slate-800 bg-slate-900/60">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-slate-200">
                  Find receipts &amp; photos
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-slate-400 mb-2">
                  Search receipts you&apos;ve sent to Chief (by job, store, or
                  note). For now this filters your latest uploads.
                </p>
                <form
                  className="flex gap-2 mb-3"
                  onSubmit={(e) => {
                    e.preventDefault()
                    // Filtering happens client-side for now
                  }}
                >
                  <input
                    type="text"
                    value={receiptQuery}
                    onChange={(e) => setReceiptQuery(e.target.value)}
                    placeholder="Ex: Home Depot, shingles, Smith job…"
                    className="flex-1 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-[#39ff14]"
                  />
                  <Button type="submit" className="text-xs font-mono uppercase">
                    Search
                  </Button>
                </form>

                {receipts.length === 0 ? (
                  <p className="text-xs text-slate-500">
                    No recent receipt uploads found yet.
                  </p>
                ) : (
                  <div className="max-h-40 overflow-y-auto text-xs">
                    {receipts
                      .filter((r) => {
                        if (!receiptQuery.trim()) return true
                        const q = receiptQuery.toLowerCase()
                        return (
                          (r.description || "").toLowerCase().includes(q) ||
                          (r.job_name || "").toLowerCase().includes(q) ||
                          (r.category || "").toLowerCase().includes(q)
                        )
                      })
                      .map((r) => (
                        <div
                          key={r.id}
                          className="flex justify-between border-b border-slate-800 py-1 last:border-0"
                        >
                          <div>
                            <div className="text-slate-100">
                              {r.description || "Receipt"}
                            </div>
                            <div className="text-[11px] text-slate-500">
                              {r.date} · {r.job_name || "No job"}
                            </div>
                          </div>
                          <div className="text-right">
                            <div className={MONEY_CLASS}>
                              {formatMoneyFromCents(r.amount_cents)}
                            </div>
                            {r.category && (
                              <div className="text-[11px] text-slate-500">
                                {r.category}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </section>
        )}


        {/* Loading / Error */}
        {loading && (
          <div className="text-sm text-slate-400">
            Loading dashboard…
          </div>
        )}

        {error && !loading && (
          <div className="rounded-md border border-rose-500/40 bg-rose-950/40 px-3 py-2 text-sm text-rose-100">
            Couldn&apos;t load dashboard: {error}.<br />
            Make sure your Node server is running on{" "}
            <span className="font-mono">localhost:3000</span> on your PC,
            and that{" "}
            <span className="font-mono">/api/dashboard?ownerId=…</span>{" "}
            works there.
          </div>
        )}

        {!loading && !error && data && (
          <>
            {/* Top tiles: quick health check */}
            <section>
              <h2 className="text-sm font-semibold text-slate-300 mb-2">
                At a glance
              </h2>
              <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-4">
                {orderedTiles.map((tile) => {
                  const isMoney = tile.unit === "currency"
                  const isPercent = tile.unit === "percent"

                  let helper = null
                  switch (tile.code) {
                    case "revenue":
                      helper =
                        "Total invoiced on all jobs in this period."
                      break
                    case "net_profit":
                      helper =
                        "What’s left after materials, subs, and overhead."
                      break
                    case "cash_in_bank":
                      helper =
                        "Cash you have in the business account(s) right now."
                      break
                    case "ar":
                      helper =
                        "Invoices you’ve sent but haven’t been paid yet."
                      break
                    case "ap":
                      helper =
                        "What you owe to suppliers and subs."
                      break
                    case "working_capital":
                      helper =
                        "Fuel in the tank: current assets minus current liabilities."
                      break
                    case "gross_margin_pct":
                      helper =
                        "How much of each dollar invoiced is left after direct job costs."
                      break
                    case "average_debtor_days":
                      helper =
                        "On average, how long it takes customers to pay you."
                      break
                    case "working_capital_ratio":
                      helper =
                        "Current assets divided by current liabilities. Above ~1.2 is healthier."
                      break
                    default:
                      helper = null
                  }

                  return (
                    <Card
                      key={tile.code}
                      className="border-slate-800 bg-slate-900/60"
                    >
                      <CardHeader className="pb-1">
                        <CardTitle className="text-xs font-medium text-slate-400">
                          {tile.label}
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="text-xl font-semibold">
                          {isMoney
                            ? formatMoneyFromCents(tile.value_cents)
                            : isPercent
                            ? formatUnit(tile.value ?? null, "percent")
                            : tile.unit === "days" || tile.unit === "ratio"
                            ? formatUnit(tile.value ?? null, tile.unit)
                            : formatUnit(tile.value ?? null, tile.unit)}
                        </div>
                        {helper && (
                          <p className="mt-1 text-[11px] text-slate-500">
                            {helper}
                          </p>
                        )}
                      </CardContent>
                    </Card>
                  )
                })}
              </div>
            </section>

            {/* Charts */}
            <section className="grid gap-4 md:grid-cols-2">
              {/* Revenue vs Net Profit */}
              <Card className="border-slate-800 bg-slate-900/60">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-medium text-slate-200">
                      Revenue vs Net Profit
                    </CardTitle>
                    {grossMarginTile && (
                      <div className={`text-xs ${PCT_CLASS}`}>
                        Gross margin:{" "}
                        {formatUnit(
                          grossMarginTile.value ?? null,
                          "percent"
                        )}
                      </div>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="h-64">
                  <p className="text-xs text-slate-400 mb-2">
                    The gap between these bars is the cost of doing the
                    work (materials, subs, overhead).
                  </p>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={profitChartData}>
                      <XAxis
                        dataKey="name"
                        tick={{ fontSize: 11, fill: "#9ca3af" }}
                      />
                      <YAxis
                        tick={{ fontSize: 11, fill: "#9ca3af" }}
                        tickFormatter={(v) =>
                          (v / 100).toLocaleString("en-CA", {
                            style: "currency",
                            currency: "CAD",
                            maximumFractionDigits: 0,
                          })
                        }
                      />
                      <Tooltip
                        formatter={(value) =>
                          formatMoneyFromCents(Number(value) || 0)
                        }
                        contentStyle={{
                          backgroundColor: "#020617",
                          borderColor: "#1f2937",
                          borderRadius: "0.5rem",
                        }}
                        labelStyle={{ color: "#e5e7eb" }}
                      />
                      <Bar dataKey="value" radius={[6, 6, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              {/* AR vs AP */}
              <Card className="border-slate-800 bg-slate-900/60">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-slate-200">
                    Money stuck vs money you owe
                  </CardTitle>
                </CardHeader>
                <CardContent className="h-64">
                  <p className="text-xs text-slate-400 mb-2">
                    AR is cash tied up with builders and homeowners. AP is
                    what you owe to suppliers and subs.
                  </p>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={arApChartData}>
                      <XAxis
                        dataKey="name"
                        tick={{ fontSize: 11, fill: "#9ca3af" }}
                      />
                      <YAxis
                        tick={{ fontSize: 11, fill: "#9ca3af" }}
                        tickFormatter={(v) =>
                          (v / 100).toLocaleString("en-CA", {
                            style: "currency",
                            currency: "CAD",
                            maximumFractionDigits: 0,
                          })
                        }
                      />
                      <Tooltip
                        formatter={(value) =>
                          formatMoneyFromCents(Number(value) || 0)
                        }
                        contentStyle={{
                          backgroundColor: "#020617",
                          borderColor: "#1f2937",
                          borderRadius: "0.5rem",
                        }}
                        labelStyle={{ color: "#e5e7eb" }}
                      />
                      <Bar dataKey="value" radius={[6, 6, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            </section>

            {/* Job KPI tiles */}
            <section>
              <h2 className="text-sm font-semibold text-slate-300 mb-2">
                Job Performance (Top 5 Jobs)
              </h2>

              {jobs.length === 0 ? (
                <p className="text-sm text-slate-500">
                  Once you approve time and log revenue/costs to jobs,
                  Chief will show the best and worst jobs here.
                </p>
              ) : (
                <div className="grid gap-4 md:grid-cols-3">
                  {jobs.slice(0, 5).map((job) => (
                    <Card
                      key={job.job_no}
                      className="border-slate-800 bg-slate-900/60"
                    >
                      <CardHeader className="pb-1">
                        <CardTitle className="text-xs font-medium text-slate-400">
                          {job.job_name || `Job #${job.job_no}`}
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="text-xs text-slate-400">
                          Profit
                        </div>
                        <div className="text-xl font-mono text-[#39ff14]">
                          {formatMoneyFromCents(job.gross_profit_cents)}
                        </div>

                        <div className="mt-2 text-xs text-slate-400">
                          Margin
                        </div>
                        <div className="text-lg font-mono text-[#39ff14]">
                          {job.gross_margin_pct != null
                            ? `${job.gross_margin_pct.toFixed(1)}%`
                            : "—"}
                        </div>

                        <div className="mt-2 text-xs text-slate-400">
                          Holdbacks
                        </div>
                        <div className="text-sm font-mono text-amber-300">
                          {formatMoneyFromCents(job.holdback_cents)}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </section>
            {/* Tasks & Leads */}
            <section className="grid gap-4 md:grid-cols-2 mt-4">
              {/* Tasks */}
              <Card className="border-slate-800 bg-slate-900/60">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-slate-200">
                    Tasks
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {tasks.length === 0 ? (
                    <p className="text-sm text-slate-500">
                      Tasks you send Chief in WhatsApp (e.g. “task – call
                      supplier”) will show up here.
                    </p>
                  ) : (
                    <div className="max-h-48 overflow-y-auto text-xs">
                      {tasks.map((t) => (
                        <div
                          key={t.id}
                          className="flex items-center justify-between border-b border-slate-800 py-1 last:border-0"
                        >
                          <div>
                            <div className="text-slate-100">
                              {t.title || t.name || "Task"}
                            </div>
                            <div className="text-[11px] text-slate-500">
                              {t.created_at &&
                                new Date(t.created_at).toLocaleString()}
                            </div>
                          </div>
                          <span
                            className={
                              "rounded-full px-2 py-0.5 text-[11px] uppercase tracking-wide " +
                              (t.status === "done"
                                ? "bg-emerald-900/40 text-emerald-300"
                                : "bg-slate-800 text-slate-300")
                            }
                          >
                            {t.status || "open"}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Leads (placeholder until leads table is wired) */}
              <Card className="border-slate-800 bg-slate-900/60">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-slate-200">
                    Leads (Coming Soon)
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {leads.length === 0 ? (
                    <p className="text-sm text-slate-500">
                      This will show your lead list with{" "}
                      <span className="font-mono">Name</span>,{" "}
                      <span className="font-mono">Status</span>, and{" "}
                      <span className="font-mono">Date created</span>. For
                      now, manage leads in WhatsApp and we&apos;ll backfill
                      this card once the leads table is live.
                    </p>
                  ) : (
                    <div className="max-h-48 overflow-y-auto text-xs">
                      {leads.map((lead) => (
                        <div
                          key={lead.id}
                          className="flex justify-between border-b border-slate-800 py-1 last:border-0"
                        >
                          <div>
                            <div className="text-slate-100">
                              {lead.name || "Lead"}
                            </div>
                            <div className="text-[11px] text-slate-500">
                              {lead.created_at &&
                                new Date(
                                  lead.created_at
                                ).toLocaleDateString()}
                            </div>
                          </div>
                          <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] uppercase tracking-wide text-slate-300">
                            {lead.status || "open"}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </section>

            {/* Jobs leaking profit (Pro / flagged section) */}
            {canShowJobLeaks && (
              <section className="mt-4">
                <h2 className="text-sm font-semibold text-slate-300 mb-2">
                  Jobs leaking profit (below estimate)
                </h2>

                {jobs.filter((j) => (j.slippage_cents ?? 0) < 0).length === 0 ? (
                  <p className="text-sm text-slate-500">
                    No jobs are currently below their estimated profit.
                  </p>
                ) : (
                  <>
                    <p className="mb-2 text-xs text-slate-400">
                      These jobs finished below their target profit. Chief
                      flags them so you can tighten quotes, watch change
                      orders, or adjust crew mix next time.
                    </p>
                    <div className="grid gap-4 md:grid-cols-3">
                      {jobs
                        .filter((j) => (j.slippage_cents ?? 0) < 0)
                        .sort(
                          (a, b) =>
                            (a.slippage_cents ?? 0) - (b.slippage_cents ?? 0)
                        )
                        .slice(0, 5)
                        .map((job) => {
                          const slippage = job.slippage_cents ?? 0
                          const profit = job.gross_profit_cents ?? 0
                          const margin = job.gross_margin_pct ?? null
                          const leak = Math.abs(slippage)

                          let coach
                          if (leak > 200000) {
                            coach =
                              "Heavy leak. Review labour hours, material overruns, and whether all change orders were billed."
                          } else if (leak > 50000) {
                            coach =
                              "Noticeable leak. Check your quote vs actual labour and any unbilled extras."
                          } else {
                            coach =
                              "Small leak. Worth checking notes and time logs to prevent this from creeping up."
                          }

                          return (
                            <Card
                              key={`leaky-${job.job_no}`}
                              className="border-slate-800 bg-slate-900/60"
                            >
                              <CardHeader className="pb-1">
                                <CardTitle className="text-xs font-medium text-slate-400">
                                  {job.job_name || `Job #${job.job_no}`}
                                </CardTitle>
                              </CardHeader>
                              <CardContent>
                                <div className="text-xs text-slate-400">
                                  Below estimate by
                                </div>
                                <div className="text-xl font-mono text-red-400">
                                  {formatMoneyFromCents(slippage)}
                                </div>

                                <div className="mt-2 text-xs text-slate-400">
                                  Actual profit
                                </div>
                                <div className="text-lg font-mono text-[#39ff14]">
                                  {formatMoneyFromCents(profit)}
                                  {margin != null && (
                                    <span className="ml-2 text-xs text-slate-400">
                                      ({margin.toFixed(1)}% margin)
                                    </span>
                                  )}
                                </div>

                                {job.change_order_cents != null && (
                                  <>
                                    <div className="mt-2 text-xs text-slate-400">
                                      Change orders billed
                                    </div>
                                    <div className="text-sm font-mono text-slate-200">
                                      {formatMoneyFromCents(
                                        job.change_order_cents
                                      )}
                                    </div>
                                  </>
                                )}

                                <p className="mt-3 text-[11px] text-slate-500">
                                  Tip: Job #{job.job_no} is below target by{" "}
                                  {formatMoneyFromCents(leak)}. {coach}
                                </p>
                              </CardContent>
                            </Card>
                          )
                        })}
                    </div>
                  </>
                )}
              </section>
            )}

            {/* Forecast (Pro gate) */}
            <section>
              <Card className="border-slate-800 bg-slate-900/60 mt-4">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-slate-200">
                    Forecast (Pro)
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {canShowForecast ? (
                    <p className="text-sm text-slate-400">
                      This will show 30–90 day cash and profit forecasts
                      based on your jobs, AR, and usual pace. Backend
                      wiring is next.
                    </p>
                  ) : (
                    <p className="text-sm text-amber-200">
                      Upgrade to Pro to see 30–90 day cash and profit
                      forecasts based on your jobs and AR.
                    </p>
                  )}
                </CardContent>
              </Card>
            </section>

            {/* KPI table */}
            <section>
              <Card className="border-slate-800 bg-slate-900/60 mt-4">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-slate-200">
                    All KPIs
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {!canShowAdvancedKpis ? (
                    <p className="text-sm text-amber-200">
                      Upgrade to Pro to see the full KPI list Chief tracks
                      (Oracle-style + contractor-specific KPIs).
                    </p>
                  ) : kpis.length === 0 ? (
                    <p className="text-sm text-slate-500">
                      KPIs will appear here once more data flows in.
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="min-w-full text-xs">
                        <thead>
                          <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-wide text-slate-500">
                            <th className="px-2 py-2">KPI</th>
                            <th className="px-2 py-2">Category</th>
                            <th className="px-2 py-2">Value</th>
                          </tr>
                        </thead>
                        <tbody>
                          {kpis.map((kpi) => {
                            const isCurrency = kpi.unit === "currency"
                            return (
                              <tr
                                key={kpi.code}
                                className="border-b border-slate-900/80 last:border-0"
                              >
                                <td className="px-2 py-2">
                                  <div className="text-slate-100">
                                    {kpi.label}
                                  </div>
                                </td>
                                <td className="px-2 py-2 text-slate-400">
                                  {kpi.category}
                                </td>
                                <td className="px-2 py-2">
                                  {isCurrency
                                    ? formatMoneyFromCents(
                                        kpi.value ?? null
                                      )
                                    : formatUnit(kpi.value, kpi.unit)}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>
            </section>
          </>
        )}
      </div>
    </div>
  )
}
