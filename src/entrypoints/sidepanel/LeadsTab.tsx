import { useEffect, useMemo, useState } from 'react';
import { COLUMNS, leadsToCsv, leadsToJson, neutralizeFormula } from '@/delivery/exportFile';
import { isSocialHost } from '@/enrich/hosts';
import { db } from '@/lib/db';
import { applyFilters, bestEmail, categoryOptions, DEFAULT_FILTERS, type LeadFilters } from '@/lib/filters';
import { saveSettings } from '@/lib/settings';
import type { Lead } from '@/lib/types';
import { send } from './RunTab';

const POLL_MS = 3_000;
const SHOWN_ROWS = 100;

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function exportXlsx(leads: Lead[], filename: string): Promise<void> {
  // This build runs in-thread, since extension pages restrict blob workers.
  const { default: writeExcelFile } = await import('write-excel-file/universal');
  const toCell = (value: string | number | boolean | null) =>
    value === null ? null : { value: typeof value === 'string' ? neutralizeFormula(value) : value };
  const rows = [
    COLUMNS.map((column) => ({ value: column.header, fontWeight: 'bold' as const })),
    ...leads.map((lead) => COLUMNS.map((column) => toCell(column.value(lead)))),
  ];
  download(await writeExcelFile(rows).toBlob(), filename);
}

export function LeadsTab() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [filters, setFilters] = useState<LeadFilters>(DEFAULT_FILTERS);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const refresh = () =>
      void db.leads
        .orderBy('collectedAt')
        .reverse()
        .toArray()
        .then((rows) => alive && setLeads(rows))
        .catch(console.error);
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const filtered = useMemo(() => applyFilters(leads, filters), [leads, filters]);
  const categories = useMemo(() => categoryOptions(leads), [leads]);
  const missingContext = useMemo(
    () => leads.filter((lead) => lead.website && !lead.context && lead.enrichStatus !== 'pending' && lead.enrichStatus !== 'running' && !isSocialHost(lead.domain)).length,
    [leads],
  );
  const failedWebsites = useMemo(() => leads.filter((lead) => lead.enrichStatus === 'failed').length, [leads]);
  const patch = (next: Partial<LeadFilters>) => setFilters((current) => ({ ...current, ...next }));

  async function collectContext() {
    // Chrome only shows this prompt directly after a click, so it must run first.
    const granted = await chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] });
    if (!granted) {
      setExportError('Website access is needed to collect business context.');
      return;
    }
    await saveSettings({ enrichmentEnabled: true });
    await send({ type: 'COLLECT_CONTEXT' });
  }

  async function runExport(format: 'csv' | 'xlsx' | 'json') {
    setExportError(null);
    const name = `leads-${new Date().toISOString().slice(0, 10)}.${format}`;
    try {
      if (format === 'csv') download(new Blob([leadsToCsv(filtered)], { type: 'text/csv;charset=utf-8' }), name);
      else if (format === 'json') download(new Blob([leadsToJson(filtered)], { type: 'application/json' }), name);
      else await exportXlsx(filtered, name);
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : 'Export failed.');
    }
  }

  return (
    <>
      <section className="card flex flex-col gap-3" aria-label="Filters">
        <div>
          <label className="label" htmlFor="search">Search name, city, or category</label>
          <input id="search" className="input" value={filters.search} onChange={(e) => patch({ search: e.target.value })} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label" htmlFor="minScore">Minimum score</label>
            <input id="minScore" className="input" type="number" min={0} max={100} value={filters.minScore}
              onChange={(e) => patch({ minScore: Number(e.target.value) })} />
          </div>
          <div>
            <label className="label" htmlFor="minRating">Minimum Google rating</label>
            <input id="minRating" className="input" type="number" min={0} max={5} step={0.1} value={filters.minRating}
              onChange={(e) => patch({ minRating: Number(e.target.value) })} />
          </div>
          <div>
            <label className="label" htmlFor="minReviews">Minimum reviews</label>
            <input id="minReviews" className="input" type="number" min={0} value={filters.minReviews}
              onChange={(e) => patch({ minReviews: Number(e.target.value) })} />
          </div>
          <div>
            <label className="label" htmlFor="maxReviews">Maximum reviews</label>
            <input id="maxReviews" className="input" type="number" min={0} placeholder="No limit"
              value={filters.maxReviews ?? ''}
              onChange={(e) => patch({ maxReviews: e.target.value === '' ? null : Number(e.target.value) })} />
          </div>
          <div>
            <label className="label" htmlFor="category">Main category</label>
            <select id="category" className="input" value={filters.category}
              onChange={(e) => patch({ category: e.target.value })}>
              <option value="any">Any</option>
              {categories.map((category) => <option key={category} value={category}>{category}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="status">Business status</label>
            <select id="status" className="input" value={filters.status}
              onChange={(e) => patch({ status: e.target.value as LeadFilters['status'] })}>
              <option value="any">Any</option>
              <option value="open">Open</option>
              <option value="closed">Closed</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="claimed">Profile</label>
            <select id="claimed" className="input" value={filters.claimed}
              onChange={(e) => patch({ claimed: e.target.value as LeadFilters['claimed'] })}>
              <option value="any">Any</option>
              <option value="claimed">Claimed</option>
              <option value="unclaimed">Unclaimed</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="emailKind">Email domain</label>
            <select id="emailKind" className="input" value={filters.emailKind}
              onChange={(e) => patch({ emailKind: e.target.value as LeadFilters['emailKind'] })}>
              <option value="any">Any</option>
              <option value="business">Business</option>
              <option value="free">Free</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="emailRole">Email type</label>
            <select id="emailRole" className="input" value={filters.emailRole}
              onChange={(e) => patch({ emailRole: e.target.value as LeadFilters['emailRole'] })}>
              <option value="any">Any</option>
              <option value="role">Role, like info@</option>
              <option value="named">Named person</option>
            </select>
          </div>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={filters.requirePhone} onChange={(e) => patch({ requirePhone: e.target.checked })} />
            Has phone
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={filters.requireWebsite} onChange={(e) => patch({ requireWebsite: e.target.checked })} />
            Has website
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={filters.requireEmail} onChange={(e) => patch({ requireEmail: e.target.checked })} />
            Has email
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={filters.richContextOnly} onChange={(e) => patch({ richContextOnly: e.target.checked })} />
            Rich business context
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={filters.onePerCompany} onChange={(e) => patch({ onePerCompany: e.target.checked })} />
            One per company
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={filters.hideMultiLocation} onChange={(e) => patch({ hideMultiLocation: e.target.checked })} />
            Hide companies with 3+ listings
          </label>
        </div>
      </section>

      <section className="card flex flex-col gap-2" aria-label="Leads">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <strong className="tabular-nums" data-testid="lead-count">
            {filtered.length.toLocaleString()} of {leads.length.toLocaleString()} leads
          </strong>
          <div className="flex gap-1.5">
            {(['csv', 'xlsx', 'json'] as const).map((format) => (
              <button key={format} className="btn uppercase" disabled={!filtered.length} onClick={() => void runExport(format)}>
                {format}
              </button>
            ))}
          </div>
        </div>
        {exportError && <p role="alert" className="notice-danger">{exportError}</p>}
        {missingContext > 0 && (
          <div className="flex items-center justify-between gap-2">
            <span className="muted text-xs">{missingContext.toLocaleString()} leads have no business context yet.</span>
            <button className="btn" onClick={() => void collectContext()}>Collect</button>
          </div>
        )}
        {failedWebsites > 0 && (
          <div className="flex items-center justify-between gap-2">
            <span className="muted text-xs">{failedWebsites.toLocaleString()} websites could not be read.</span>
            <button className="btn" onClick={() => void send({ type: 'RETRY_WEBSITES' })}>Recheck</button>
          </div>
        )}
        {!leads.length && <p className="muted">Leads appear here once a run starts.</p>}
        {!!leads.length && !filtered.length && <p className="muted">No leads match these filters.</p>}
        <ul className="flex flex-col divide-y divide-[var(--line)]">
          {filtered.slice(0, SHOWN_ROWS).map((lead) => (
            <li key={lead.placeId} className="py-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium">{lead.name}</span>
                <span className={`tabular-nums font-semibold tier-${lead.tier}`} title={`${lead.tier} confidence`}>
                  {lead.score}
                </span>
              </div>
              <div className="muted text-xs">
                {[lead.categories[0], lead.city, lead.state].filter(Boolean).join(' · ')}
              </div>
              <div className="break-all text-xs">
                {[lead.phone ?? lead.phoneRaw, bestEmail(lead)?.address].filter(Boolean).join(' · ')}
              </div>
              {lead.enrichError && <div className="muted text-xs">{lead.enrichError}</div>}
              {lead.context?.summary && <div className="muted mt-1 line-clamp-2 text-xs">{lead.context.summary}</div>}
              {!!lead.context?.services.length && (
                <div className="muted line-clamp-1 text-xs">Services: {lead.context.services.join(', ')}</div>
              )}
            </li>
          ))}
        </ul>
        {filtered.length > SHOWN_ROWS && (
          <p className="muted text-xs">
            Showing the newest {SHOWN_ROWS}. Exports include all {filtered.length.toLocaleString()}.
          </p>
        )}
      </section>
    </>
  );
}
