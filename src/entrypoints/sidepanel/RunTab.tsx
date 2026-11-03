import { useEffect, useState } from 'react';
import { db, getLatestRun } from '@/lib/db';
import { generateQueries, parseLines } from '@/lib/jobs';
import type { ControlMessage, ControlResult } from '@/lib/messages';
import { computeMetrics, isPartialSearch, type RunMetrics } from '@/lib/metrics';
import { getSettings, saveSettings } from '@/lib/settings';
import type { Job, Run, SearchOutcome } from '@/lib/types';

const POLL_MS = 2_000;
const WEBSITE_ORIGINS = ['http://*/*', 'https://*/*'];
const MAX_SEARCH_ROWS = 200;

const OUTCOME_LABEL: Record<SearchOutcome, string> = {
  end_of_list: 'Reached end',
  stalled: 'Stalled',
  no_results: 'No results',
  single_place: 'Single result, not collected',
  timeout: 'Timed out',
};

interface Snapshot {
  run: Run | undefined;
  total: number;
  finished: number;
  enrichWaiting: number;
  metrics: RunMetrics | null;
  searches: Job[];
}

async function loadSnapshot(): Promise<Snapshot> {
  const run = await getLatestRun();
  if (!run) return { run, total: 0, finished: 0, enrichWaiting: 0, metrics: null, searches: [] };
  const [total, finished, leads, jobs] = await Promise.all([
    db.jobs.where('runId').equals(run.id!).count(),
    db.jobs.where('runId').equals(run.id!).filter((j) => j.status === 'done' || j.status === 'failed').count(),
    db.leads.where('runId').equals(run.id!).toArray(),
    db.jobs.where('runId').equals(run.id!).filter((j) => j.status === 'done' || j.status === 'failed').toArray(),
  ]);
  const enrichWaiting = leads.filter((l) => l.enrichStatus === 'pending' || l.enrichStatus === 'running').length;
  const searches = jobs.slice(-MAX_SEARCH_ROWS).reverse();
  return { run, total, finished, enrichWaiting, metrics: computeMetrics(run, leads), searches };
}

export function send(message: ControlMessage): Promise<ControlResult> {
  return chrome.runtime.sendMessage(message) as Promise<ControlResult>;
}

const percent = (value: number | null) => (value === null ? '–' : `${(value * 100).toFixed(1)}%`);
const whole = (value: number | null) => (value === null ? '–' : Math.round(value).toLocaleString());

const STATUS_LABEL: Record<Run['status'], string> = {
  running: 'Running',
  paused: 'Paused',
  paused_blocked: 'Waiting for CAPTCHA',
  completed: 'Finished',
  stopped: 'Stopped',
  stopped_parse: 'Stopped: format problem',
};

function Metric({ label, value, target }: { label: string; value: string; target?: string }) {
  return (
    <div className="rounded-md border border-[var(--line)] p-2">
      <div className="muted text-[11px]">{label}</div>
      <div className="text-base font-semibold tabular-nums">{value}</div>
      {target && <div className="muted text-[11px]">Target {target}</div>}
    </div>
  );
}

export function RunTab() {
  const [keywords, setKeywords] = useState('');
  const [locations, setLocations] = useState('');
  const [enrich, setEnrich] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  useEffect(() => {
    void getSettings().then((settings) => setEnrich(settings.enrichmentEnabled));
    let alive = true;
    const refresh = () =>
      void loadSnapshot()
        .then((next) => alive && setSnapshot(next))
        .catch(console.error);
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const keywordList = parseLines(keywords);
  const locationList = parseLines(locations);
  const queryCount = generateQueries(keywordList, locationList).length;
  const run = snapshot?.run;
  const active = run?.status === 'running' || run?.status === 'paused' || run?.status === 'paused_blocked';
  const progress = snapshot && snapshot.total ? (snapshot.finished / snapshot.total) * 100 : 0;

  async function control(message: ControlMessage) {
    setBusy(true);
    setError(null);
    try {
      const result = await send(message);
      if (!result?.ok) setError(result?.error ?? 'Something went wrong.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    setError(null);
    // Chrome only shows this prompt directly after a click, so it must run first.
    const granted = enrich ? await chrome.permissions.request({ origins: WEBSITE_ORIGINS }) : false;
    await saveSettings({ enrichmentEnabled: enrich && granted });
    if (enrich && !granted) setEnrich(false);
    await control({ type: 'START_RUN', keywords: keywordList, locations: locationList });
  }

  const m = snapshot?.metrics;

  return (
    <>
      {!active && (
        <section className="card flex flex-col gap-3" aria-label="New run">
          <div>
            <label className="label" htmlFor="keywords">Keywords, one per line</label>
            <textarea
              id="keywords"
              className="input"
              rows={4}
              placeholder={'plumber\nelectrician'}
              value={keywords}
              onChange={(event) => setKeywords(event.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="locations">Locations, one per line (optional)</label>
            <textarea
              id="locations"
              className="input"
              rows={4}
              placeholder={'Dallas, TX\nAustin, TX'}
              value={locations}
              onChange={(event) => setLocations(event.target.value)}
            />
          </div>
          <label className="flex items-start gap-2">
            <input
              id="enrich"
              type="checkbox"
              className="mt-0.5"
              checked={enrich}
              onChange={(event) => setEnrich(event.target.checked)}
            />
            <span>
              Find emails on business websites
              <span className="muted block text-xs">
                Chrome will ask for website access. Email domains are checked through Cloudflare DNS.
              </span>
            </span>
          </label>
          <div className="flex items-center justify-between gap-2">
            <span className="muted">
              {queryCount.toLocaleString()} {queryCount === 1 ? 'search' : 'searches'}
            </span>
            <button className="btn btn-primary" disabled={busy || queryCount === 0} onClick={() => void start()}>
              Start
            </button>
          </div>
        </section>
      )}

      {error && <p role="alert" className="notice-danger">{error}</p>}

      {run && (
        <section className="card flex flex-col gap-3" aria-label="Current run">
          <div className="flex items-center justify-between gap-2">
            <strong data-testid="run-status">{STATUS_LABEL[run.status]}</strong>
            <span className="muted tabular-nums">
              {snapshot?.finished.toLocaleString()} of {snapshot?.total.toLocaleString()} searches
            </span>
          </div>
          <div
            className="progress"
            role="progressbar"
            aria-label="Search progress"
            aria-valuenow={Math.round(progress)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div style={{ width: `${progress}%` }} />
          </div>

          {run.status === 'paused_blocked' && <p role="status" className="notice-warn">{run.statusReason}</p>}
          {run.status === 'stopped_parse' && <p role="alert" className="notice-danger">{run.statusReason}</p>}
          {run.status === 'paused' && run.statusReason && <p role="status" className="muted">{run.statusReason}</p>}

          {active && (
            <div className="flex gap-2">
              {run.status === 'running' ? (
                <button className="btn" disabled={busy} onClick={() => void control({ type: 'PAUSE_RUN' })}>
                  Pause
                </button>
              ) : (
                <button className="btn btn-primary" disabled={busy} onClick={() => void control({ type: 'RESUME_RUN' })}>
                  Resume
                </button>
              )}
              <button className="btn" disabled={busy} onClick={() => void control({ type: 'STOP_RUN' })}>
                Stop
              </button>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Metric label="Unique leads" value={run.uniqueLeads.toLocaleString()} />
            <Metric label="Unique leads/hour" value={whole(m?.uniqueLeadsPerHour ?? null)} target="1,000+" />
            <Metric label="Duplicate rate" value={percent(m?.duplicateRate ?? null)} target="<30%" />
            <Metric label="Parse success" value={percent(m?.parseSuccess ?? null)} target=">98%" />
            <Metric label="Phone found" value={percent(m?.phoneFound ?? null)} target=">80%" />
            <Metric label="Website found" value={percent(m?.websiteFound ?? null)} target=">60%" />
            <Metric label="Email found, of sites" value={percent(m?.emailFound ?? null)} target="30–50%" />
            <Metric label="Invalid email rate" value={percent(m?.invalidEmailRate ?? null)} target="<5%" />
            <Metric label="Websites with problems" value={percent(m?.websiteProblems ?? null)} />
            <Metric label="Rich context, of sites" value={percent(m?.richContext ?? null)} />
            <Metric
              label="CAPTCHAs per 100 searches"
              value={m?.captchasPer100 == null ? '–' : m.captchasPer100.toFixed(1)}
              target="<1"
            />
            <Metric label="Accepted by CRM" value={percent(m?.crmAccepted ?? null)} target="100%" />
          </div>
          {!!snapshot?.enrichWaiting && (
            <p role="status" className="muted">
              Checking {snapshot.enrichWaiting.toLocaleString()} websites.
            </p>
          )}
          {!!snapshot?.searches.length && (
            <details>
              <summary className="cursor-pointer font-medium">Search details</summary>
              <ul className="mt-2 flex flex-col divide-y divide-[var(--line)]">
                {snapshot.searches.map((job) => (
                  <li key={job.id} className="py-1.5" data-testid="search-row">
                    <div>{job.query}</div>
                    <div className="muted text-xs tabular-nums">
                      {job.outcome ? OUTCOME_LABEL[job.outcome] : 'Failed'} · {job.rows} captured of {job.visibleCards} shown · {job.newLeads} new
                      {isPartialSearch(job) && <strong className="tier-medium"> · Partial</strong>}
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
    </>
  );
}
