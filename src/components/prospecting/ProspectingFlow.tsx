"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Campaign, EmailDraft, Evidence, ProspectingState, StepEvent, StepId } from "@/lib/prospecting/types";
import { STEP_LABELS, STEP_ORDER } from "@/lib/prospecting/types";

interface Capabilities {
  search: boolean;
  model: boolean;
  contactProvider: string | null;
}

interface Props {
  authedFetch: (path: string, init?: RequestInit) => Promise<any>;
  getToken: () => Promise<string>;
  brand: { name: string; domain: string; logoDataUrl?: string };
  onOpenTab?: (tab: "outreach" | "enterprise") => void;
  // Snapshot from the /api/app-shell mount request, when it resolved before
  // this tab first opened. Avoids a duplicate /api/prospecting fetch on mount;
  // "error" mirrors a failed load, null/undefined loads as usual.
  seed?: { state: ProspectingState; capabilities: Capabilities } | "error" | null;
}

const card = "ui-card";
const primaryBtn = "ui-btn-primary";
const secondaryBtn = "ui-btn-secondary";
const inputCls = "ui-input w-full";
const label = "ui-label";

function done(state: ProspectingState | null, step: StepId): boolean {
  return Boolean(state?.[step]);
}

function firstOpenStep(state: ProspectingState | null): StepId {
  return STEP_ORDER.find((s) => !done(state, s)) ?? "emails";
}

function Initial({ name, size = "h-8 w-8" }: { name: string; size?: string }) {
  return (
    <span aria-hidden className={`flex ${size} shrink-0 items-center justify-center rounded-md bg-violet-500/20 text-xs font-semibold text-violet-300`}>
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

function ExternalLink({ href, children, className = "" }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`hover:underline ${className}`}>
      {children}
    </a>
  );
}

function evidenceText(e: Evidence): string {
  const parts = [e.quote, e.query ? `search: "${e.query}"` : null, e.url].filter(Boolean);
  return parts.join(" · ");
}

function Sources({ items }: { items: Evidence[] }) {
  const urls = items.filter((e) => e.url);
  if (!urls.length) return null;
  return (
    <ul className="space-y-1">
      {urls.map((e, i) => (
        <li key={`${e.url}-${i}`} className="truncate text-[11px] text-zinc-500">
          <ExternalLink href={e.url as string}>{e.url}</ExternalLink>
          {e.quote ? <span className="text-zinc-600"> · {e.quote}</span> : null}
        </li>
      ))}
    </ul>
  );
}

export default function ProspectingFlow({ authedFetch, getToken, brand, onOpenTab, seed = null }: Props) {
  const [state, setState] = useState<ProspectingState | null>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [view, setView] = useState<StepId>("research");
  const [running, setRunning] = useState<StepId | null>(null);
  const [liveLog, setLiveLog] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loadError, setLoadError] = useState("");
  const logRef = useRef<HTMLOListElement>(null);

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const res = await authedFetch("/api/prospecting");
      setState(res.state);
      setCaps(res.capabilities);
      setView(firstOpenStep(res.state));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Prospecting could not be loaded.");
    }
  }, [authedFetch]);

  // Consume the app-shell snapshot captured at mount, if one was provided;
  // otherwise load directly. Later refreshes still go through load().
  const mountSeed = useRef(seed);
  useEffect(() => {
    const initial = mountSeed.current;
    if (!initial) {
      load();
      return;
    }
    if (initial === "error") {
      setLoadError("Prospecting could not be loaded.");
      return;
    }
    setState(initial.state);
    setCaps(initial.capabilities);
    setView(firstOpenStep(initial.state));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    logRef.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
  }, [liveLog]);

  const run = useCallback(async (step: StepId) => {
    setRunning(step);
    setView(step);
    setError("");
    setNotice("");
    setLiveLog([]);
    try {
      const token = await getToken();
      const res = await fetch("/api/prospecting/run", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ step }),
      });
      if (!res.ok || !res.body) {
        const payload = await res.json().catch(() => ({}));
        throw new Error((payload as { error?: string }).error ?? "The step could not start.");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done: finished } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const event = JSON.parse(line) as StepEvent;
          if (event.type === "log") setLiveLog((prev) => [...prev, event.text]);
          else if (event.type === "done") {
            setState(event.state);
            if (event.credits?.charged) setNotice(`${event.credits.charged} credit${event.credits.charged === 1 ? "" : "s"} used. ${event.credits.balance} left.`);
          }
          else if (event.type === "error") setError(event.message);
        }
        if (finished) break;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "The step could not finish. Try again, or contact hello@gothreadly.live.");
    } finally {
      setRunning(null);
    }
  }, [getToken]);

  const patch = useCallback(async (body: Record<string, unknown>, ok?: string) => {
    setError("");
    try {
      const res = await authedFetch("/api/prospecting", { method: "PATCH", body: JSON.stringify(body) });
      setState(res.state);
      if (ok) setNotice(ok);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "The change could not be saved.");
      return false;
    }
  }, [authedFetch]);

  async function reset() {
    if (!confirm("Start over? This clears every step of this prospecting run. Leads already saved are kept.")) return;
    try {
      await authedFetch("/api/prospecting", { method: "DELETE" });
      setState({ version: 1, updatedAt: new Date().toISOString() });
      setView("research");
      setLiveLog([]);
      setNotice("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start over.");
    }
  }

  async function saveLeads() {
    setError("");
    try {
      const res = await authedFetch("/api/prospecting/leads", { method: "POST", body: JSON.stringify({}) });
      setNotice(`${res.created} compan${res.created === 1 ? "y" : "ies"} saved to Leads${res.skipped ? `; ${res.skipped} already there` : ""}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Leads could not be saved.");
    }
  }

  const stepIndex = STEP_ORDER.indexOf(view);
  const nextStep = STEP_ORDER[stepIndex + 1] as StepId | undefined;
  const log = running ? liveLog : state?.logs?.[view] ?? [];

  if (loadError) {
    return (
      <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 p-4 text-sm text-rose-300">
        <p>{loadError}</p>
        <button onClick={load} className={`${secondaryBtn} mt-3`}>Retry</button>
      </div>
    );
  }
  if (!state) return <p className="py-16 text-center text-sm text-zinc-500">Loading prospecting...</p>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="ui-page-title">Prospecting</h2>
          <p className="ui-page-subtitle">
            From your website to researched prospects and draft emails. Every result links to the page or search it came from. Nothing is sent from here.
          </p>
        </div>
        {done(state, "research") && <button onClick={reset} disabled={Boolean(running)} className={secondaryBtn}>Start over</button>}
      </div>

      <Stepper state={state} view={view} running={running} onView={setView} />

      <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start" aria-label="Run summary">
          <Rail state={state} brand={brand} onView={setView} />
          <ActivityLog running={running} view={view} lines={log} listRef={logRef} />
          {caps && <CapabilityNote caps={caps} />}
        </aside>

        <section className="min-w-0 space-y-4" aria-live="polite">
          {error && (
            <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
              {error}
            </div>
          )}
          {notice && <p role="status" className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-zinc-300">{notice}</p>}

          {view === "research" && <ResearchPanel state={state} brand={brand} running={running} onRun={() => run("research")} onSaveSummary={(summary) => patch({ op: "research.summary", summary }, "Description updated.")} />}
          {view === "competitors" && <CompetitorsPanel state={state} running={running} onRun={() => run("competitors")} onToggle={(key, selected) => patch({ op: "select", step: "competitors", key, selected })} />}
          {view === "campaigns" && <CampaignsPanel state={state} running={running} onRun={() => run("campaigns")} patch={patch} />}
          {view === "companies" && <CompaniesPanel state={state} running={running} onRun={() => run("companies")} onToggle={(key, selected) => patch({ op: "select", step: "companies", key, selected })} onSaveLeads={saveLeads} />}
          {view === "contacts" && <ContactsPanel state={state} running={running} onRun={() => run("contacts")} onOpenTab={onOpenTab} />}
          {view === "emails" && <EmailsPanel state={state} running={running} onRun={() => run("emails")} patch={patch} onOpenTab={onOpenTab} />}

          {done(state, view) && nextStep && (
            <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
              {done(state, nextStep) && <button className={secondaryBtn} onClick={() => setView(nextStep)}>View step {stepIndex + 2}</button>}
              <button className={primaryBtn} disabled={Boolean(running) || (view === "campaigns" && !(state.campaigns?.items ?? []).some((c) => c.selected))} onClick={() => run(nextStep)}>
                {done(state, nextStep) ? `Run step ${stepIndex + 2} again` : `Continue: ${STEP_LABELS[nextStep]}`}
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Stepper({ state, view, running, onView }: { state: ProspectingState; view: StepId; running: StepId | null; onView: (s: StepId) => void }) {
  return (
    <ol className="flex items-center gap-2 overflow-x-auto pb-1" aria-label="Steps">
      {STEP_ORDER.map((s, i) => {
        const isDone = done(state, s);
        const active = s === view;
        const reachable = isDone || s === firstOpenStep(state);
        return (
          <li key={s} className={`flex items-center gap-2 ${active ? "shrink-0" : "flex-1"} last:flex-none`}>
            <button
              type="button"
              disabled={!reachable}
              onClick={() => onView(s)}
              aria-current={active ? "step" : undefined}
              aria-label={`Step ${i + 1}: ${STEP_LABELS[s]}${isDone ? " (done)" : ""}`}
              className={`flex shrink-0 items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-semibold transition ${
                active ? "border-violet-400/60 bg-violet-500/15 text-white" : isDone ? "border-white/15 text-zinc-200 hover:bg-white/5" : "border-white/10 text-zinc-500"
              }`}
            >
              <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${isDone ? "bg-zinc-100 text-zinc-900" : "border border-white/20"}`}>{i + 1}</span>
              <span className={active ? "" : "hidden xl:inline"}>{STEP_LABELS[s]}</span>
              {running === s && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-400" aria-label="running" />}
            </button>
            {i < STEP_ORDER.length - 1 && <span aria-hidden className={`h-px min-w-4 flex-1 ${isDone ? "bg-zinc-400" : "bg-white/10"}`} />}
          </li>
        );
      })}
    </ol>
  );
}

function Rail({ state, brand, onView }: { state: ProspectingState; brand: Props["brand"]; onView: (s: StepId) => void }) {
  const companiesByCampaign = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of state.companies?.items ?? []) m.set(c.campaignId, (m.get(c.campaignId) ?? 0) + 1);
    return m;
  }, [state.companies]);
  return (
    <div className={`${card} space-y-4 p-4`}>
      <div className="flex items-center gap-2.5">
        {brand.logoDataUrl ? (
          // eslint-disable-next-line
          <img src={brand.logoDataUrl} alt="" className="h-8 w-8 rounded-md border border-white/10 object-cover" />
        ) : (
          <Initial name={brand.name} />
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-white">{brand.name}</p>
          <p className="truncate text-xs text-zinc-500">{brand.domain}</p>
        </div>
      </div>
      {state.research && <p className="line-clamp-4 text-xs leading-relaxed text-zinc-400">{state.research.summary}</p>}

      {state.competitors && (
        <div>
          <button className={`${label} hover:text-zinc-300`} onClick={() => onView("competitors")}>
            Competitors {state.competitors.items.filter((c) => c.selected).length}
          </button>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {state.competitors.items.filter((c) => c.selected).slice(0, 8).map((c) => (
              <ExternalLink key={c.domain} href={`https://${c.domain}`} className="max-w-[120px] truncate rounded-md border border-white/10 px-2 py-0.5 text-[11px] text-zinc-300">
                {c.domain}
              </ExternalLink>
            ))}
            {state.competitors.items.filter((c) => c.selected).length > 8 && (
              <span className="px-1 py-0.5 text-[11px] text-zinc-500">+{state.competitors.items.filter((c) => c.selected).length - 8} more</span>
            )}
          </div>
        </div>
      )}

      {state.campaigns && (
        <div>
          <button className={`${label} hover:text-zinc-300`} onClick={() => onView("campaigns")}>
            Campaigns {state.campaigns.items.filter((c) => c.selected).length}
          </button>
          <ul className="mt-2 space-y-1">
            {state.campaigns.items.filter((c) => c.selected).map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2 rounded-md border border-white/5 px-2 py-1.5 text-xs">
                <span className="truncate text-zinc-200">{c.name}</span>
                <span className="shrink-0 text-zinc-500">{state.companies ? `${companiesByCampaign.get(c.id) ?? 0} found` : ""}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {state.contacts && (
        <p className="text-xs text-zinc-400">
          <span className={label}>Decision makers</span>{" "}
          {state.contacts.status === "provider_not_configured" ? "provider not connected" : `${state.contacts.items.length} found`}
        </p>
      )}
      {state.emails && (
        <p className="text-xs text-zinc-400">
          <span className={label}>Drafts</span> {state.emails.items.length}
        </p>
      )}
    </div>
  );
}

function ActivityLog({ running, view, lines, listRef }: { running: StepId | null; view: StepId; lines: string[]; listRef: React.RefObject<HTMLOListElement | null> }) {
  if (!running && !lines.length) return null;
  const step = running ?? view;
  return (
    <div className={`${card} p-4`}>
      <p className="flex items-center gap-2 text-xs font-semibold text-zinc-300">
        {running && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" aria-hidden />}
        {running ? `Working on step ${STEP_ORDER.indexOf(step) + 1} of 6` : `Last run of step ${STEP_ORDER.indexOf(step) + 1}`}
      </p>
      <ol ref={listRef} className="mt-2 max-h-64 space-y-1 overflow-y-auto font-mono text-[11px] leading-relaxed text-zinc-400" aria-live="polite">
        {lines.map((l, i) => (
          <li key={i} className={l.startsWith("  ") ? "pl-3 text-zinc-500" : ""}>
            <span aria-hidden className="mr-1.5 text-zinc-600">{running && i === lines.length - 1 ? ">" : "-"}</span>
            {l.trim()}
          </li>
        ))}
        {running && !lines.length && <li className="text-zinc-500">starting...</li>}
      </ol>
    </div>
  );
}

function CapabilityNote({ caps }: { caps: Capabilities }) {
  const items = [
    ["Web search", caps.search ? "connected" : "not configured"],
    ["Contact data", caps.contactProvider ? caps.contactProvider : "not connected"],
    ["Model drafting", caps.model ? "on (capped)" : "off; templates only"],
  ];
  return (
    <dl className="space-y-1 px-1 text-[11px]">
      {items.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-2">
          <dt className="text-zinc-500">{k}</dt>
          <dd className="text-zinc-400">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function StartCard({ title, body, action, running, onRun, disabled }: { title: string; body: string; action: string; running: boolean; onRun: () => void; disabled?: boolean }) {
  return (
    <div className={`${card} p-6`}>
      <h3 className="text-base font-semibold text-white">{title}</h3>
      <p className="mt-1 text-sm text-zinc-400">{body}</p>
      <button className={`${primaryBtn} mt-4`} disabled={running || disabled} onClick={onRun}>{running ? "Working..." : action}</button>
    </div>
  );
}

function ResearchPanel({ state, brand, running, onRun, onSaveSummary }: { state: ProspectingState; brand: Props["brand"]; running: StepId | null; onRun: () => void; onSaveSummary: (s: string) => Promise<boolean> }) {
  const r = state.research;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(r?.summary ?? "");
  useEffect(() => setDraft(r?.summary ?? ""), [r?.summary]);
  if (!r) {
    return (
      <StartCard
        title={`Research ${brand.domain}`}
        body="Threadly reads your homepage to learn what you sell, the words you use and the audiences you name. It respects robots.txt and reads public pages only."
        action="Research my company"
        running={running === "research"}
        onRun={onRun}
      />
    );
  }
  return (
    <div className={`${card} mx-auto max-w-2xl p-6`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Initial name={r.name} size="h-10 w-10" />
          <div>
            <p className="font-semibold text-white">{r.name}</p>
            <ExternalLink href={r.page?.finalUrl ?? `https://${r.domain}`} className="text-sm text-zinc-400">{r.domain}</ExternalLink>
          </div>
        </div>
        <span className="rounded-md border border-white/10 px-2 py-1 text-xs text-zinc-300">
          {r.page ? "Homepage read" : "Profile only"}
        </span>
      </div>
      {r.pageError && <p className="mt-3 text-xs text-amber-300">The homepage {r.pageError}. Results use your brand profile; check the description below.</p>}
      {editing ? (
        <div className="mt-4 space-y-2">
          <textarea aria-label="Company description" rows={4} maxLength={1000} className={inputCls} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="flex justify-end gap-2">
            <button className={secondaryBtn} onClick={() => { setDraft(r.summary); setEditing(false); }}>Cancel</button>
            <button className={primaryBtn} onClick={async () => { if (await onSaveSummary(draft)) setEditing(false); }}>Save</button>
          </div>
        </div>
      ) : (
        <>
          <p className="mt-4 text-sm leading-relaxed text-zinc-300">{r.summary}</p>
          <p className="mt-1 text-[11px] text-zinc-500">
            {r.summarySource === "homepage" ? "From your homepage's own description." : r.summarySource === "model" ? "Summarised by the model from your homepage text." : "Edited by your team or taken from your profile."}
          </p>
          <button className="mt-3 text-xs text-zinc-400 hover:text-white" onClick={() => setEditing(true)}>Details look off? Edit the description</button>
        </>
      )}
      {r.keywords.length > 0 && (
        <div className="mt-5">
          <p className={label}>Keywords from your homepage</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {r.keywords.map((k) => <span key={k} className="rounded-md bg-white/[0.06] px-2.5 py-1 text-xs text-zinc-300">{k}</span>)}
          </div>
        </div>
      )}
      {r.audiencePhrases.length > 0 && (
        <div className="mt-4">
          <p className={label}>Audiences you name</p>
          <p className="mt-1 text-xs text-zinc-400">{r.audiencePhrases.join(", ")}</p>
        </div>
      )}
    </div>
  );
}

function CompetitorsPanel({ state, running, onRun, onToggle }: { state: ProspectingState; running: StepId | null; onRun: () => void; onToggle: (key: string, selected: boolean) => void }) {
  const c = state.competitors;
  const [showAll, setShowAll] = useState(false);
  if (!c) {
    return <StartCard title="Explore competitors" body="Searches the web for your category, reads comparison articles for the companies they link to, and keeps only companies whose own homepage matches your topic." action="Find competitors" running={running === "competitors"} onRun={onRun} />;
  }
  const r = state.research;
  const list = showAll ? c.items : c.items.slice(0, 12);
  return (
    <div className={`${card} grid gap-6 p-6 md:grid-cols-2`}>
      <div className="space-y-5">
        <div>
          <p className={label}>Product</p>
          <p className="mt-2 rounded-lg bg-white/[0.04] px-3 py-2 text-sm font-semibold text-white">{r?.summary.split(/[.:]/)[0]}</p>
          {r && r.keywords.length > 0 && (
            <ul className="mt-2 space-y-1 pl-3 text-sm text-zinc-400">
              {r.keywords.slice(0, 4).map((k) => <li key={k}>{k}</li>)}
            </ul>
          )}
        </div>
        {c.queries.length > 0 && (
          <div>
            <p className={label}>Searches run</p>
            <ul className="mt-2 space-y-1.5">
              {c.queries.map((q) => <li key={q} className="truncate rounded-lg border border-white/10 px-3 py-2 text-sm text-zinc-300">{q}</li>)}
            </ul>
          </div>
        )}
        {!c.searchAvailable && <p className="text-xs text-amber-300">Web search is not configured on this deployment, so only competitors from your brand profile are listed.</p>}
      </div>
      <div>
        <p className={label}>
          Competitors <span className="ml-1 rounded border border-white/10 px-1.5 py-0.5 normal-case tracking-normal text-zinc-300">{c.items.length} found</span>
        </p>
        <ul className="mt-2 space-y-1.5">
          {list.map((comp) => (
            <li key={comp.domain} className="flex items-start gap-2 rounded-lg bg-white/[0.03] px-3 py-2" title={comp.evidence.map(evidenceText).join("\n")}>
              <input type="checkbox" aria-label={`Keep ${comp.domain}`} className="mt-1" checked={comp.selected} onChange={(e) => onToggle(comp.domain, e.target.checked)} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <ExternalLink href={`https://${comp.domain}`} className="truncate text-sm text-zinc-100">{comp.domain}</ExternalLink>
                  {comp.tracked && <span className="text-[10px] text-zinc-500">tracked</span>}
                </div>
                {comp.description && <p className="line-clamp-2 text-[11px] text-zinc-500">{comp.description}</p>}
              </div>
            </li>
          ))}
        </ul>
        {c.items.length > 12 && (
          <button className="mt-2 text-xs text-zinc-400 hover:text-white" onClick={() => setShowAll(!showAll)}>{showAll ? "Show fewer" : `+${c.items.length - 12} more`}</button>
        )}
        <p className="mt-3 text-[11px] text-zinc-500">Hover a competitor to see the searches and pages that found it. Unchecked companies are excluded from prospect results.</p>
      </div>
    </div>
  );
}

function CampaignForm({ initial, onSave, onCancel }: { initial?: Campaign; onSave: (c: { id?: string; name: string; description: string; searchQuery: string; roles: string[] }) => Promise<boolean>; onCancel: () => void }) {
  const [form, setForm] = useState({ name: initial?.name ?? "", description: initial?.description ?? "", searchQuery: initial?.searchQuery ?? "", roles: (initial?.roles ?? ["Founder", "CEO"]).join(", ") });
  return (
    <form
      className={`${card} space-y-3 p-4`}
      onSubmit={async (e) => {
        e.preventDefault();
        if (await onSave({ id: initial?.id, name: form.name, description: form.description, searchQuery: form.searchQuery, roles: form.roles.split(",").map((r) => r.trim()).filter(Boolean) })) onCancel();
      }}
    >
      <label className="block"><span className={label}>Name</span><input required maxLength={80} className={`${inputCls} mt-1`} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="B2B SaaS startups" /></label>
      <label className="block"><span className={label}>Who they are and why they need you</span><textarea rows={2} maxLength={400} className={`${inputCls} mt-1`} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
      <label className="block"><span className={label}>Web search that finds these companies</span><input required maxLength={160} className={`${inputCls} mt-1`} value={form.searchQuery} onChange={(e) => setForm({ ...form, searchQuery: e.target.value })} placeholder="B2B SaaS startup series A" /></label>
      <label className="block"><span className={label}>Roles to contact (comma separated)</span><input className={`${inputCls} mt-1`} value={form.roles} onChange={(e) => setForm({ ...form, roles: e.target.value })} /></label>
      <div className="flex justify-end gap-2">
        <button type="button" className={secondaryBtn} onClick={onCancel}>Cancel</button>
        <button type="submit" className={primaryBtn}>Save campaign</button>
      </div>
    </form>
  );
}

function CampaignsPanel({ state, running, onRun, patch }: { state: ProspectingState; running: StepId | null; onRun: () => void; patch: (b: Record<string, unknown>, ok?: string) => Promise<boolean> }) {
  const c = state.campaigns;
  const [editing, setEditing] = useState<string | "new" | null>(null);
  if (!c) {
    return <StartCard title="Define campaigns" body="A campaign is one audience you want to reach. Threadly proposes campaigns from the audiences your homepage names; you can edit them or add your own." action="Propose campaigns" running={running === "campaigns"} onRun={onRun} />;
  }
  const save = (body: { id?: string; name: string; description: string; searchQuery: string; roles: string[] }) => patch({ op: "campaign.save", ...body }, "Campaign saved.");
  return (
    <div className="space-y-4">
      {c.items.length === 0 && editing !== "new" && (
        <p className={`${card} p-4 text-sm text-zinc-400`}>No campaigns yet. Add one describing who you sell to and a web search that finds those companies.</p>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {c.items.map((camp) =>
          editing === camp.id ? (
            <CampaignForm key={camp.id} initial={camp} onSave={save} onCancel={() => setEditing(null)} />
          ) : (
            <div key={camp.id} className={`${card} space-y-3 p-4 ${camp.selected ? "" : "opacity-60"}`}>
              <div className="flex items-start justify-between gap-2">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={camp.selected} onChange={(e) => patch({ op: "select", step: "campaigns", key: camp.id, selected: e.target.checked })} />
                  <span className="font-semibold text-white">{camp.name}</span>
                </label>
                <span className="text-[10px] text-zinc-500">{camp.source === "homepage" ? "From your homepage" : camp.source === "model" ? "Model draft" : "Added by you"}</span>
              </div>
              {camp.description && <p className="text-sm text-zinc-400">{camp.description}</p>}
              <div>
                <p className={label}>Search</p>
                <p className="mt-1 text-sm text-zinc-300">{camp.searchQuery}</p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {camp.roles.map((r) => <span key={r} className="rounded-md bg-white/[0.06] px-2 py-0.5 text-xs text-zinc-300">{r}</span>)}
              </div>
              <div className="flex gap-3 pt-1 text-xs">
                <button className="text-zinc-400 hover:text-white" onClick={() => setEditing(camp.id)}>Edit</button>
                <button className="text-zinc-400 hover:text-rose-400" onClick={() => patch({ op: "campaign.remove", id: camp.id }, "Campaign removed.")}>Remove</button>
              </div>
            </div>
          ),
        )}
        {editing === "new" ? (
          <CampaignForm onSave={save} onCancel={() => setEditing(null)} />
        ) : (
          <button className={`${card} flex min-h-[140px] items-center justify-center p-4 text-sm text-zinc-400 hover:text-white`} onClick={() => setEditing("new")}>
            Add a campaign
          </button>
        )}
      </div>
    </div>
  );
}

function CompaniesPanel({ state, running, onRun, onToggle, onSaveLeads }: { state: ProspectingState; running: StepId | null; onRun: () => void; onToggle: (k: string, s: boolean) => void; onSaveLeads: () => void }) {
  const c = state.companies;
  if (!c) {
    const selected = (state.campaigns?.items ?? []).filter((x) => x.selected).length;
    return <StartCard title="Find potential customers" body={`Searches the web for each selected campaign (${selected}), then reads every candidate's homepage. Publishers, directories and your competitors are excluded.`} action="Find companies" running={running === "companies"} onRun={onRun} disabled={!selected} />;
  }
  const campaignName = (id: string) => state.campaigns?.items.find((x) => x.id === id)?.name ?? "";
  const selectedCount = c.items.filter((x) => x.selected).length;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-zinc-400">{c.items.length} companies read; {selectedCount} selected{c.skipped.length ? `; ${c.skipped.length} could not be read` : ""}.</p>
        <button className={secondaryBtn} onClick={onSaveLeads} disabled={!selectedCount}>Save selected to Leads</button>
      </div>
      <div className="overflow-x-auto rounded-xl border border-white/10 bg-white/[0.02]">
        <table className="w-full text-left text-sm text-zinc-300">
          <thead className="border-b border-white/10 text-[11px] uppercase tracking-wider text-zinc-500">
            <tr>
              <th scope="col" className="w-8 px-3 py-3"><span className="sr-only">Selected</span></th>
              <th scope="col" className="px-3 py-3">Company</th>
              <th scope="col" className="px-3 py-3">Description</th>
              <th scope="col" className="px-3 py-3">Campaign</th>
              <th scope="col" className="px-3 py-3">Matched</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {c.items.map((co) => (
              <tr key={co.domain} title={co.evidence.map(evidenceText).join("\n")}>
                <td className="px-3 py-3 align-top"><input type="checkbox" aria-label={`Select ${co.name}`} checked={co.selected} onChange={(e) => onToggle(co.domain, e.target.checked)} /></td>
                <td className="px-3 py-3 align-top">
                  <p className="font-semibold text-white">{co.name}</p>
                  <ExternalLink href={`https://${co.domain}`} className="font-mono text-xs text-zinc-500">{co.domain}</ExternalLink>
                </td>
                <td className="max-w-md px-3 py-3 align-top text-xs text-zinc-400"><span className="line-clamp-3">{co.description ?? "No description on the homepage."}</span></td>
                <td className="px-3 py-3 align-top text-xs text-zinc-400">{campaignName(co.campaignId)}</td>
                <td className="px-3 py-3 align-top text-xs text-zinc-400">{co.matchedTerms.length ? co.matchedTerms.join(", ") : "None"}</td>
              </tr>
            ))}
            {c.items.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-10 text-center text-zinc-500">No companies found. Edit the campaign searches in step 3 and run this step again.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-zinc-500">Hover a row to see the search and page it came from. Matched shows campaign terms found on the company's homepage.</p>
    </div>
  );
}

function ContactsPanel({ state, running, onRun, onOpenTab }: { state: ProspectingState; running: StepId | null; onRun: () => void; onOpenTab?: Props["onOpenTab"] }) {
  const c = state.contacts;
  if (!c) {
    return <StartCard title="Find decision makers" body="Looks up people at the selected companies through a licensed contact data provider. Threadly does not scrape social networks or guess email addresses." action="Find decision makers" running={running === "contacts"} onRun={onRun} />;
  }
  if (c.status === "provider_not_configured") {
    return (
      <div className={`${card} space-y-3 p-6`}>
        <h3 className="text-base font-semibold text-white">Connect a contact data provider</h3>
        <p className="text-sm text-zinc-400">
          Decision makers come only from licensed sources, so every contact has a record of where it came from. No provider is connected to this workspace yet.
        </p>
        <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-400">
          <li>A workspace owner can connect Hunter by setting <code className="text-zinc-300">HUNTER_API_KEY</code> on the deployment.</li>
          <li>Or import contacts you already hold, with their source and rights, in Outbound.</li>
          <li>Or continue: drafts are written per company, and you add the recipient yourself.</li>
        </ul>
        {onOpenTab && <button className={secondaryBtn} onClick={() => onOpenTab("enterprise")}>Open Outbound import</button>}
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-white/10 bg-white/[0.02]">
      <table className="w-full text-left text-sm text-zinc-300">
        <caption className="px-4 pt-3 text-left text-[11px] text-zinc-500">{c.items.length} people at {c.searchedDomains} companies, from {c.provider}.</caption>
        <thead className="border-b border-white/10 text-[11px] uppercase tracking-wider text-zinc-500">
          <tr>
            <th scope="col" className="px-4 py-3">Name</th>
            <th scope="col" className="px-3 py-3">Title</th>
            <th scope="col" className="px-3 py-3">Company</th>
            <th scope="col" className="px-3 py-3">Email</th>
            <th scope="col" className="px-3 py-3">Provider check</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {c.items.map((p) => (
            <tr key={p.id}>
              <td className="px-4 py-3">
                {p.linkedinUrl ? <ExternalLink href={p.linkedinUrl} className="text-white">{p.name}</ExternalLink> : <span className="text-white">{p.name}</span>}
              </td>
              <td className="px-3 py-3 text-xs text-zinc-400">{p.title ?? "Not listed"}</td>
              <td className="px-3 py-3 font-mono text-xs text-zinc-400">{p.companyDomain}</td>
              <td className="px-3 py-3 font-mono text-xs">{p.email ?? "None"}</td>
              <td className="px-3 py-3 text-xs text-zinc-400">{[p.verification, p.confidence !== null ? `confidence ${p.confidence}` : null].filter(Boolean).join(", ") || "Not reported"}</td>
            </tr>
          ))}
          {c.items.length === 0 && <tr><td colSpan={5} className="px-4 py-10 text-center text-zinc-500">The provider returned no people with published business addresses for these companies.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function EmailsPanel({ state, running, onRun, patch, onOpenTab }: { state: ProspectingState; running: StepId | null; onRun: () => void; patch: (b: Record<string, unknown>, ok?: string) => Promise<boolean>; onOpenTab?: Props["onOpenTab"] }) {
  const e = state.emails;
  const [activeId, setActiveId] = useState<string | null>(null);
  const active: EmailDraft | undefined = e?.items.find((d) => d.id === activeId) ?? e?.items[0];
  const [form, setForm] = useState({ to: "", subject: "", body: "" });
  useEffect(() => {
    if (active) setForm({ to: active.to ?? "", subject: active.subject, body: active.body });
  }, [active?.id, active?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!e) {
    return <StartCard title="Write emails" body="Drafts one email per selected company using only the facts collected so far, and lists the source of every fact. Drafts are for review; nothing is sent from here." action="Write drafts" running={running === "emails"} onRun={onRun} />;
  }
  if (!e.items.length) return <p className={`${card} p-6 text-sm text-zinc-400`}>No companies were selected, so no drafts were written.</p>;
  const companyName = (d: EmailDraft) => state.companies?.items.find((c) => c.domain === d.companyDomain)?.name ?? d.companyDomain;
  const dirty = active && (form.to !== (active.to ?? "") || form.subject !== active.subject || form.body !== active.body);
  return (
    <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
      <ul className="max-h-[560px] space-y-2 overflow-y-auto pr-1">
        {e.items.map((d) => (
          <li key={d.id}>
            <button onClick={() => setActiveId(d.id)} className={`w-full rounded-lg border px-3 py-2 text-left transition ${active?.id === d.id ? "border-violet-400/50 bg-violet-500/10" : "border-white/10 bg-white/[0.02] hover:bg-white/[0.05]"}`}>
              <p className="truncate text-sm font-semibold text-white">{companyName(d)}</p>
              <p className="truncate text-xs text-zinc-500">{d.to ?? "No recipient yet"}</p>
              {d.missing.length > 0 && <p className="mt-1 text-[10px] text-amber-300">Missing: {d.missing.join(", ")}</p>}
            </button>
          </li>
        ))}
      </ul>
      {active && (
        <div className={`${card} space-y-3 p-4`}>
          <label className="flex items-center gap-3 border-b border-white/10 pb-2">
            <span className="w-10 text-xs text-zinc-500">To</span>
            <input className="flex-1 bg-transparent text-sm text-white focus:outline-none" placeholder="Add a recipient" value={form.to} onChange={(ev) => setForm({ ...form, to: ev.target.value })} />
          </label>
          <label className="flex items-center gap-3 border-b border-white/10 pb-2">
            <span className="w-10 text-xs text-zinc-500">Subject</span>
            <input className="flex-1 bg-transparent text-sm font-semibold text-white focus:outline-none" value={form.subject} onChange={(ev) => setForm({ ...form, subject: ev.target.value })} />
          </label>
          <textarea aria-label="Email body" rows={12} className="w-full resize-y bg-transparent text-sm leading-relaxed text-zinc-200 focus:outline-none" value={form.body} onChange={(ev) => setForm({ ...form, body: ev.target.value })} />
          <div>
            <p className={label}>Sources</p>
            <div className="mt-1"><Sources items={active.sources} /></div>
            <p className="mt-1 text-[11px] text-zinc-500">{active.engine === "model" ? "Written by the model from the sources above." : "Written from a template using the sources above."}</p>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-3">
            <p className="text-[11px] text-zinc-500">To send, approve a campaign in Outbound. Sending there checks suppression, unsubscribe and caps.</p>
            <div className="flex gap-2">
              <button className={secondaryBtn} onClick={() => navigator.clipboard?.writeText(`Subject: ${form.subject}\n\n${form.body}`)}>Copy</button>
              {onOpenTab && <button className={secondaryBtn} onClick={() => onOpenTab("enterprise")}>Open Outbound</button>}
              <button className={primaryBtn} disabled={!dirty} onClick={() => patch({ op: "draft.save", id: active.id, ...form }, "Draft saved.")}>Save draft</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
