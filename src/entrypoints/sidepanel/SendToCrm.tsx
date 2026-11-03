import { useEffect, useMemo, useState } from 'react';
import { db } from '@/lib/db';
import { isSendable, parseCrmOrigin } from '@/lib/crm';
import { getSettings } from '@/lib/settings';
import type { Lead, SendJob } from '@/lib/types';
import { send } from './RunTab';

const POLL_MS = 1_000;

interface Props {
  selection: Lead[];
  /** Above zero when specific leads are ticked, rather than following the filters. */
  tickedCount: number;
  onSent: () => void;
}

export function SendToCrm({ selection, tickedCount, onSent }: Props) {
  const [job, setJob] = useState<SendJob | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getSettings().then((settings) => setConfigured(Boolean(parseCrmOrigin(settings.crmUrl) && settings.crmKey)));
    let alive = true;
    const refresh = () =>
      void db.sendJobs
        .orderBy('createdAt')
        .last()
        .then((latest) => alive && setJob(latest ?? null))
        .catch(console.error);
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const sendable = useMemo(() => selection.filter(isSendable), [selection]);
  const checking = useMemo(
    () => selection.filter((lead) => lead.enrichStatus === 'pending' || lead.enrichStatus === 'running').length,
    [selection],
  );
  const alreadySent = selection.length - sendable.length - checking;
  const running = job?.status === 'running';

  async function control(action: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (!result.ok) setError(result.error ?? 'Something went wrong.');
      return result.ok;
    } catch {
      setError('Something went wrong. Try again.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    const started = await control(() =>
      send({ type: 'START_SEND', placeIds: sendable.map((lead) => lead.placeId), label: label.trim() || null }),
    );
    if (started) {
      setLabel('');
      onSent();
    }
  }

  const total = job?.placeIds.length ?? 0;
  const handled = job ? Math.min(job.cursor, total) : 0;

  return (
    <section className="card flex flex-col gap-2" aria-label="Send to CRM">
      {configured === false && <p className="muted">Add your CRM address and import key in Settings to send leads.</p>}
      {configured && (
        <>
          <div>
            <label className="label" htmlFor="batchLabel">Batch name (optional)</label>
            <input id="batchLabel" className="input" maxLength={200} placeholder="Dallas plumbers"
              value={label} onChange={(event) => setLabel(event.target.value)} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="muted text-xs" data-testid="send-summary">
              {tickedCount > 0 ? `${tickedCount.toLocaleString()} ticked` : 'Following your filters'}
              {alreadySent > 0 && ` · ${alreadySent.toLocaleString()} already handled`}
              {checking > 0 && ` · ${checking.toLocaleString()} still being checked`}
            </span>
            <button className="btn btn-primary" disabled={busy || running || sendable.length === 0} onClick={() => void start()}>
              Send {sendable.length.toLocaleString()} {sendable.length === 1 ? 'lead' : 'leads'} to CRM
            </button>
          </div>
        </>
      )}

      {error && <p role="alert" className="notice-danger">{error}</p>}

      {job && (
        <div className="flex flex-col gap-2 border-t border-[var(--line)] pt-2" data-testid="send-job">
          <div className="flex items-center justify-between gap-2">
            <strong data-testid="send-status">
              {job.status === 'running' && 'Sending'}
              {job.status === 'done' && 'Send finished'}
              {job.status === 'failed' && 'Send stopped'}
              {job.status === 'stopped' && 'Send paused'}
            </strong>
            <span className="muted tabular-nums">{handled.toLocaleString()} of {total.toLocaleString()}</span>
          </div>
          {job.status === 'running' && (
            <div className="progress" role="progressbar" aria-label="Send progress"
              aria-valuenow={total ? Math.round((handled / total) * 100) : 0} aria-valuemin={0} aria-valuemax={100}>
              <div style={{ width: `${total ? (handled / total) * 100 : 0}%` }} />
            </div>
          )}
          <p className="muted text-xs tabular-nums" data-testid="send-results">
            {(job.created + job.alreadyImported).toLocaleString()} added · {job.duplicates.toLocaleString()} already in CRM · {job.rejected.toLocaleString()} rejected
          </p>
          {job.error && (
            <p role={job.status === 'failed' ? 'alert' : 'status'} className={job.status === 'failed' ? 'notice-danger' : 'muted text-xs'}>
              {job.error}
            </p>
          )}
          <div className="flex gap-2">
            {job.status === 'running' && (
              <button className="btn" disabled={busy} onClick={() => void control(() => send({ type: 'STOP_SEND' }))}>Pause</button>
            )}
            {(job.status === 'failed' || job.status === 'stopped') && (
              <button className="btn btn-primary" disabled={busy} onClick={() => void control(() => send({ type: 'RESUME_SEND' }))}>Resume</button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
