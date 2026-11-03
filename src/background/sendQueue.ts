import { z } from 'zod';
import { toPayload } from '@/delivery/payload';
import { crmImportUrl, crmPermissionPattern, isSendable, parseCrmOrigin } from '@/lib/crm';
import { db } from '@/lib/db';
import type { ControlResult } from '@/lib/messages';
import { getSettings } from '@/lib/settings';
import type { Lead, SendJob, Settings } from '@/lib/types';

export const CHUNK_SIZE = 100;
export const MAX_ATTEMPTS = 6;
const REQUEST_TIMEOUT_MS = 30_000;

const responseSchema = z.object({
  batch_id: z.string(),
  created: z.array(z.string()),
  already_imported: z.array(z.string()),
  duplicates: z.array(z.object({ place_id: z.string(), reason: z.string(), matched_place_id: z.string() })),
  invalid: z.array(z.object({ index: z.number(), place_id: z.string().nullable(), fields: z.array(z.string()) })),
  suppressed: z.array(z.string()),
});

type ImportResponse = z.infer<typeof responseSchema>;

let pumping = false;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Doubles from 5 seconds, capped at 5 minutes. */
export function retryDelayMs(attempt: number): number {
  return Math.min(5 * 60_000, 5_000 * 2 ** Math.max(0, attempt - 1));
}

async function getRunningJob(): Promise<SendJob | undefined> {
  return db.sendJobs.where('status').equals('running').first();
}

async function postToCrm(settings: Settings, origin: string, body: unknown): Promise<Response> {
  return fetch(crmImportUrl(origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.crmKey}` },
    body: JSON.stringify(body),
    credentials: 'omit',
    // A redirect could send the key or the leads somewhere unexpected.
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/** Messages for failures that won't fix themselves, so retrying would only waste time. */
function permanentFailure(status: number): string | null {
  if (status === 401 || status === 403) return 'The CRM rejected the import key. Check it in Settings.';
  if (status === 503) return 'The CRM has no import key set up yet.';
  if (status === 404 || status === 405) return 'This address has no lead import route. Check the CRM address in Settings.';
  if (status === 413) return 'The CRM refused this send as too large.';
  if (status === 400) return 'The CRM refused this request as invalid.';
  return null;
}

async function failJob(job: SendJob, error: string): Promise<void> {
  await db.sendJobs.update(job.id!, { status: 'failed', error, updatedAt: Date.now() });
}

async function scheduleRetry(job: SendJob, error: string): Promise<void> {
  const attempts = job.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await db.sendJobs.update(job.id!, { status: 'failed', attempts, error, updatedAt: Date.now() });
    return;
  }
  const delay = retryDelayMs(attempts);
  await db.sendJobs.update(job.id!, { attempts, error, nextAttemptAt: Date.now() + delay, updatedAt: Date.now() });
  // The alarm covers this too if the service worker stops before the timer fires.
  clearTimeout(timer);
  timer = setTimeout(() => void pumpSend(), delay);
}

/** Saves one chunk's result atomically, so a restart can't lose or double-count it. */
async function applyResult(job: SendJob, sent: Lead[], localRejected: string[], result: ImportResponse): Promise<void> {
  const invalid = result.invalid.map((item) => ({
    placeId: item.place_id ?? sent[item.index]?.placeId,
    note: `Rejected fields: ${item.fields.join(', ')}`,
  }));
  const suppressed = new Set(result.suppressed);
  const now = Date.now();

  await db.transaction('rw', db.leads, db.sendJobs, async () => {
    const mark = (placeId: string | undefined, deliveryStatus: Lead['deliveryStatus'], crmNote: string | null) =>
      placeId ? db.leads.update(placeId, { deliveryStatus, crmNote, crmSentAt: now }) : undefined;
    for (const placeId of [...result.created, ...result.already_imported]) {
      await mark(placeId, 'sent', suppressed.has(placeId) ? 'On your do-not-contact list' : null);
    }
    for (const item of result.duplicates) await mark(item.place_id, 'duplicate', `Already in CRM (${item.reason})`);
    for (const item of invalid) await mark(item.placeId, 'rejected', item.note);
    for (const placeId of localRejected) await mark(placeId, 'rejected', 'Failed validation before sending');

    const cursor = job.cursor + CHUNK_SIZE;
    const finished = cursor >= job.placeIds.length;
    // A pause clicked while this chunk was in flight must stay paused.
    const current = await db.sendJobs.get(job.id!);
    await db.sendJobs.update(job.id!, {
      cursor,
      crmBatchId: result.batch_id,
      created: job.created + result.created.length,
      alreadyImported: job.alreadyImported + result.already_imported.length,
      duplicates: job.duplicates + result.duplicates.length,
      rejected: job.rejected + result.invalid.length + localRejected.length,
      attempts: 0,
      error: null,
      nextAttemptAt: 0,
      status: finished ? 'done' : (current?.status ?? 'running'),
      updatedAt: now,
    });
  });
}

async function sendNextChunk(job: SendJob): Promise<void> {
  const settings = await getSettings();
  const origin = parseCrmOrigin(settings.crmUrl);
  if (!origin || !settings.crmKey) {
    await failJob(job, 'Add your CRM address and import key in Settings.');
    return;
  }
  if (!(await chrome.permissions.contains({ origins: [crmPermissionPattern(origin)] }))) {
    await failJob(job, 'Chrome no longer has access to your CRM. Save Settings again to allow it.');
    return;
  }

  const placeIds = job.placeIds.slice(job.cursor, job.cursor + CHUNK_SIZE);
  const leads = (await db.leads.bulkGet(placeIds)).filter((lead): lead is Lead => lead !== undefined);

  // A retried chunk may include leads an earlier attempt already handled, which the CRM reports safely.
  const payloads: unknown[] = [];
  const sent: Lead[] = [];
  const localRejected: string[] = [];
  for (const lead of leads) {
    try {
      payloads.push(toPayload(lead));
      sent.push(lead);
    } catch {
      localRejected.push(lead.placeId);
    }
  }

  const empty: ImportResponse = { batch_id: job.crmBatchId ?? '', created: [], already_imported: [], duplicates: [], invalid: [], suppressed: [] };
  if (!payloads.length) {
    await applyResult(job, sent, localRejected, empty);
    return;
  }

  let response: Response;
  try {
    response = await postToCrm(settings, origin, { client_batch_id: job.clientBatchId, label: job.label, leads: payloads });
  } catch {
    // Network errors are described in plain words, since their text can hold the URL.
    await scheduleRetry(job, 'Could not reach the CRM. Retrying.');
    return;
  }

  if (!response.ok) {
    const permanent = permanentFailure(response.status);
    if (permanent) await failJob(job, permanent);
    else await scheduleRetry(job, `The CRM responded with an error (${response.status}). Retrying.`);
    return;
  }

  let result: ImportResponse;
  try {
    result = responseSchema.parse(await response.json());
  } catch {
    await failJob(job, 'The CRM sent a response this extension doesn’t understand.');
    return;
  }
  await applyResult(job, sent, localRejected, result);
}

/** Works through the running job, if any. Nothing here starts a send on its own. */
export async function pumpSend(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const job = await getRunningJob();
      if (!job || job.nextAttemptAt > Date.now()) return;
      const before = job.cursor;
      await sendNextChunk(job);
      const after = await db.sendJobs.get(job.id!);
      if (after?.status !== 'running' || after.cursor === before) return;
    }
  } finally {
    pumping = false;
  }
}

export async function startSend(placeIds: string[], label: string | null): Promise<ControlResult> {
  const settings = await getSettings();
  const origin = parseCrmOrigin(settings.crmUrl);
  if (!origin || !settings.crmKey) return { ok: false, error: 'Add your CRM address and import key in Settings.' };
  if (await getRunningJob()) return { ok: false, error: 'A send is already running.' };

  const leads = (await db.leads.bulkGet([...new Set(placeIds)])).filter((lead): lead is Lead => lead !== undefined);
  const sendable = leads.filter(isSendable).map((lead) => lead.placeId);
  if (!sendable.length) return { ok: false, error: 'None of these leads can be sent.' };

  const now = Date.now();
  await db.sendJobs.add({
    clientBatchId: crypto.randomUUID(),
    crmBatchId: null,
    label: label?.trim().slice(0, 200) || null,
    status: 'running',
    placeIds: sendable,
    cursor: 0,
    created: 0,
    alreadyImported: 0,
    duplicates: 0,
    rejected: 0,
    attempts: 0,
    nextAttemptAt: 0,
    error: null,
    createdAt: now,
    updatedAt: now,
  });
  void pumpSend();
  return { ok: true };
}

export async function stopSend(): Promise<void> {
  clearTimeout(timer);
  const job = await getRunningJob();
  if (job) await db.sendJobs.update(job.id!, { status: 'stopped', error: null, updatedAt: Date.now() });
}

/** Continues the latest unfinished send from where it stopped. */
export async function resumeSend(): Promise<ControlResult> {
  if (await getRunningJob()) return { ok: false, error: 'A send is already running.' };
  const job = await db.sendJobs.orderBy('createdAt').last();
  if (!job || (job.status !== 'failed' && job.status !== 'stopped')) return { ok: false, error: 'Nothing to resume.' };
  await db.sendJobs.update(job.id!, { status: 'running', attempts: 0, nextAttemptAt: 0, error: null, updatedAt: Date.now() });
  void pumpSend();
  return { ok: true };
}

/** Checks the address and key without saving anything: an empty request reaches validation only. */
export async function testCrmConnection(): Promise<ControlResult> {
  const settings = await getSettings();
  const origin = parseCrmOrigin(settings.crmUrl);
  if (!origin) return { ok: false, error: 'Use an https:// address, or http:// for localhost.' };
  if (!settings.crmKey) return { ok: false, error: 'Add your import key.' };
  try {
    const response = await postToCrm(settings, origin, { client_batch_id: 'connection_test', label: null, leads: [] });
    if (response.status === 400) return { ok: true, detail: 'Connected. The CRM accepted your key.' };
    return { ok: false, error: permanentFailure(response.status) ?? `The CRM responded with an error (${response.status}).` };
  } catch {
    return { ok: false, error: 'Could not reach the CRM. Check the address, and that it doesn’t redirect.' };
  }
}
