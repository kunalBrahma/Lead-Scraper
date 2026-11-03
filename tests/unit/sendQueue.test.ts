import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lead, Settings } from '@/lib/types';

const KEY = 'slk_import_send_queue_test';
const ORIGIN = 'https://crm.example';
const storage: Record<string, unknown> = {};
let permissionGranted = true;

vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: async (key: string) => ({ [key]: storage[key] }),
      set: async (values: Record<string, unknown>) => Object.assign(storage, values),
    },
  },
  permissions: { contains: async () => permissionGranted },
});

const queue = await import('@/background/sendQueue');
const { db } = await import('@/lib/db');

function lead(placeId: string, over: Partial<Lead> = {}): Lead {
  return {
    placeId, name: `Lead ${placeId}`, fullAddress: null, street: null, city: null, postalCode: null, state: null, country: 'US',
    categories: [], phoneRaw: null, phone: null, website: null, domain: null, rating: null, reviewCount: 0, claimed: true,
    businessStatus: 'open', latitude: null, longitude: null, mapsUrl: null, hours: null, runId: 1, keyword: 'x', searchArea: null,
    companyKeys: [], collectedAt: 0, emails: [], sitePhones: [], socials: {}, metaDescription: null, context: null,
    enrichStatus: 'skipped', enrichError: null, score: 25, tier: 'low', deliveryStatus: 'unsent', crmNote: null, crmSentAt: null,
    evidence: {
      activeListing: true, websiteLive: false, websiteParked: false, websiteMatch: false, phoneValid: false, phoneMatch: false,
      emailVerified: false, emailRelated: false, emailSource: null, mxValid: null,
    },
    ...over,
  };
}

const ids = (count: number, prefix = 'p') => Array.from({ length: count }, (_, i) => `${prefix}${i}`);
const seed = (placeIds: string[], over: Partial<Lead> = {}) => db.leads.bulkAdd(placeIds.map((id) => lead(id, over)));
const bodyOf = (call: number) => JSON.parse(vi.mocked(fetch).mock.calls[call]![1]!.body as string);
const latestJob = async () => (await db.sendJobs.orderBy('createdAt').last())!;

function accept(body: { leads: { place_id: string }[] }, over: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({ batch_id: 'crm-batch', created: body.leads.map((l) => l.place_id), already_imported: [], duplicates: [], invalid: [], suppressed: [], ...over }),
    { status: 200 },
  );
}

/** A CRM that accepts everything sent to it. */
function acceptAll() {
  vi.mocked(fetch).mockImplementation(async (_url, init) => accept(JSON.parse(init!.body as string)));
}

const settle = () => vi.waitFor(async () => {
  const job = await latestJob();
  expect(job.status === 'running' && job.nextAttemptAt === 0).toBe(false);
}, { timeout: 2000, interval: 5 });

beforeEach(async () => {
  await db.delete();
  await db.open();
  Object.keys(storage).forEach((key) => delete storage[key]);
  const settings: Settings = { enrichmentEnabled: false, crawlConcurrency: 5, crmUrl: ORIGIN, crmKey: KEY };
  storage.settings = settings;
  permissionGranted = true;
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('nothing sends without a click', () => {
  it('makes no request when woken with leads waiting and CRM settings saved', async () => {
    await seed(ids(5));
    await queue.pumpSend();
    await queue.pumpSend();
    expect(fetch).not.toHaveBeenCalled();
    expect(await db.sendJobs.count()).toBe(0);
  });

  it('makes no request after a send finishes and new leads arrive', async () => {
    acceptAll();
    await seed(['one']);
    await queue.startSend(['one'], null);
    await settle();
    vi.mocked(fetch).mockClear();
    await seed(['two']);
    await queue.pumpSend();
    expect(fetch).not.toHaveBeenCalled();
    expect((await db.leads.get('two'))?.deliveryStatus).toBe('unsent');
  });
});

describe('startSend', () => {
  it('splits a large send into chunks of 100 in one batch', async () => {
    acceptAll();
    await seed(ids(250));
    expect(await queue.startSend(ids(250), 'Dallas plumbers')).toEqual({ ok: true });
    await settle();

    expect(fetch).toHaveBeenCalledTimes(3);
    expect([0, 1, 2].map((call) => bodyOf(call).leads.length)).toEqual([100, 100, 50]);
    const batchIds = new Set([0, 1, 2].map((call) => bodyOf(call).client_batch_id));
    expect(batchIds.size).toBe(1);
    expect(bodyOf(0).label).toBe('Dallas plumbers');
    expect(await latestJob()).toMatchObject({ status: 'done', created: 250, crmBatchId: 'crm-batch', error: null });
    expect(await db.leads.where('deliveryStatus').equals('sent').count()).toBe(250);
  });

  it('sends safely to the right address', async () => {
    acceptAll();
    await seed(['one']);
    await queue.startSend(['one'], null);
    await settle();
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/api/leads/import`);
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    });
    expect(bodyOf(0).client_batch_id).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
  });

  it('sends exactly the chosen leads and skips handled or unchecked ones', async () => {
    acceptAll();
    await seed(['chosen', 'not-chosen']);
    await seed(['already-sent'], { deliveryStatus: 'sent' });
    await seed(['already-in-crm'], { deliveryStatus: 'duplicate' });
    await seed(['checking'], { enrichStatus: 'running' });
    await seed(['retry-rejected'], { deliveryStatus: 'rejected' });
    await queue.startSend(['chosen', 'already-sent', 'already-in-crm', 'checking', 'retry-rejected', 'chosen', 'missing'], null);
    await settle();
    expect(bodyOf(0).leads.map((l: { place_id: string }) => l.place_id)).toEqual(['chosen', 'retry-rejected']);
    expect((await db.leads.get('not-chosen'))?.deliveryStatus).toBe('unsent');
  });

  it.each([
    ['no address', { crmUrl: '' }],
    ['no key', { crmKey: '' }],
    ['an insecure remote address', { crmUrl: 'http://crm.example' }],
  ])('refuses to start with %s', async (_label, change) => {
    storage.settings = { ...(storage.settings as Settings), ...change };
    await seed(['one']);
    const result = await queue.startSend(['one'], null);
    expect(result.ok).toBe(false);
    expect(await db.sendJobs.count()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses when nothing can be sent, and while another send runs', async () => {
    await seed(['sent'], { deliveryStatus: 'sent' });
    expect((await queue.startSend(['sent'], null)).ok).toBe(false);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      await gate;
      return accept(JSON.parse(init!.body as string));
    });
    await seed(['one', 'two']);
    expect((await queue.startSend(['one'], null)).ok).toBe(true);
    expect(await queue.startSend(['two'], null)).toMatchObject({ ok: false, error: 'A send is already running.' });
    release();
    await settle();
  });
});

describe('results', () => {
  it('records what happened to each lead', async () => {
    await seed(['new', 'retried', 'dup', 'bad', 'blocked']);
    vi.mocked(fetch).mockImplementation(async (_url, init) =>
      accept(JSON.parse(init!.body as string), {
        created: ['new', 'blocked'],
        already_imported: ['retried'],
        duplicates: [{ place_id: 'dup', reason: 'domain', matched_place_id: 'other' }],
        invalid: [{ index: 3, place_id: 'bad', fields: ['website'] }],
        suppressed: ['blocked'],
      }),
    );
    await queue.startSend(['new', 'retried', 'dup', 'bad', 'blocked'], null);
    await settle();

    expect(await db.leads.get('new')).toMatchObject({ deliveryStatus: 'sent', crmNote: null });
    expect((await db.leads.get('new'))?.crmSentAt).toBeGreaterThan(0);
    expect(await db.leads.get('retried')).toMatchObject({ deliveryStatus: 'sent' });
    expect(await db.leads.get('dup')).toMatchObject({ deliveryStatus: 'duplicate', crmNote: 'Already in CRM (domain)' });
    expect(await db.leads.get('bad')).toMatchObject({ deliveryStatus: 'rejected', crmNote: 'Rejected fields: website' });
    expect(await db.leads.get('blocked')).toMatchObject({ deliveryStatus: 'sent', crmNote: 'On your do-not-contact list' });
    expect(await latestJob()).toMatchObject({ created: 2, alreadyImported: 1, duplicates: 1, rejected: 1, status: 'done' });
  });

  it('finds a rejected lead by position when the CRM could not read its ID', async () => {
    await seed(['one', 'two']);
    vi.mocked(fetch).mockImplementation(async () =>
      accept({ leads: [] }, { created: ['one'], invalid: [{ index: 1, place_id: null, fields: ['lead'] }] }),
    );
    await queue.startSend(['one', 'two'], null);
    await settle();
    expect((await db.leads.get('two'))?.deliveryStatus).toBe('rejected');
  });

  it('marks a lead rejected locally if it fails validation, and still sends the rest', async () => {
    acceptAll();
    await seed(['good']);
    await seed(['broken'], { name: '' });
    await queue.startSend(['good', 'broken'], null);
    await settle();
    expect(bodyOf(0).leads.map((l: { place_id: string }) => l.place_id)).toEqual(['good']);
    expect(await db.leads.get('broken')).toMatchObject({ deliveryStatus: 'rejected', crmNote: 'Failed validation before sending' });
    expect(await latestJob()).toMatchObject({ created: 1, rejected: 1, status: 'done' });
  });
});

describe('failures', () => {
  it.each([
    [401, 'rejected the import key'],
    [403, 'rejected the import key'],
    [404, 'no lead import route'],
    [413, 'too large'],
    [503, 'no import key set up'],
  ])('stops without retrying on %i', async (status, message) => {
    vi.mocked(fetch).mockResolvedValue(new Response('', { status }));
    await seed(['one']);
    await queue.startSend(['one'], null);
    await settle();
    const job = await latestJob();
    expect(job.status).toBe('failed');
    expect(job.error).toContain(message);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await db.leads.get('one'))?.deliveryStatus).toBe('unsent');
  });

  it.each([[500], [502], [429]])('retries the same leads later after %i', async (status) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status }));
    await seed(ids(3));
    const before = Date.now();
    await queue.startSend(ids(3), null);
    await settle();

    const waiting = await latestJob();
    expect(waiting).toMatchObject({ status: 'running', attempts: 1, cursor: 0 });
    expect(waiting.nextAttemptAt).toBeGreaterThanOrEqual(before + 5_000);

    // Too early: an alarm wake-up doesn't retry yet.
    await queue.pumpSend();
    expect(fetch).toHaveBeenCalledTimes(1);

    acceptAll();
    await db.sendJobs.update(waiting.id!, { nextAttemptAt: Date.now() - 1 });
    await queue.pumpSend();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(bodyOf(1).client_batch_id).toBe(bodyOf(0).client_batch_id);
    expect(bodyOf(1).leads).toEqual(bodyOf(0).leads);
    expect(await latestJob()).toMatchObject({ status: 'done', attempts: 0, error: null, created: 3 });
  });

  it('retries a network or redirect failure, and gives up after the limit with a safe message', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError(`failed ${ORIGIN} ${KEY}`));
    await seed(['one']);
    await queue.startSend(['one'], null);
    await settle();
    for (let attempt = 2; attempt <= queue.MAX_ATTEMPTS; attempt += 1) {
      const job = await latestJob();
      await db.sendJobs.update(job.id!, { nextAttemptAt: 0 });
      await queue.pumpSend();
    }
    const job = await latestJob();
    expect(job.status).toBe('failed');
    expect(fetch).toHaveBeenCalledTimes(queue.MAX_ATTEMPTS);
    expect(job.error).toBe('Could not reach the CRM. Retrying.');
    expect(JSON.stringify(job)).not.toContain(KEY);
  });

  it('backs off with a limit', () => {
    expect([1, 2, 3, 20].map(queue.retryDelayMs)).toEqual([5_000, 10_000, 20_000, 300_000]);
  });

  it('fails clearly on an unreadable response or a lost permission', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('<html>', { status: 200 }));
    await seed(['one']);
    await queue.startSend(['one'], null);
    await settle();
    expect((await latestJob()).error).toContain('doesn’t understand');

    vi.mocked(fetch).mockClear();
    permissionGranted = false;
    await seed(['two']);
    await queue.startSend(['two'], null);
    await settle();
    expect((await latestJob()).error).toContain('no longer has access');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('pause, resume, and restart', () => {
  it('keeps a pause clicked while a chunk is in flight', async () => {
    await seed(ids(150));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      await gate;
      return accept(JSON.parse(init!.body as string));
    });
    await queue.startSend(ids(150), null);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await queue.stopSend();
    release();
    await vi.waitFor(async () => expect((await latestJob()).cursor).toBe(100));
    expect((await latestJob()).status).toBe('stopped');
    expect(fetch).toHaveBeenCalledTimes(1);

    acceptAll();
    expect(await queue.resumeSend()).toEqual({ ok: true });
    await settle();
    expect(await latestJob()).toMatchObject({ status: 'done', created: 150 });
    expect(bodyOf(1).leads).toHaveLength(50);
  });

  it('resumes after a failure from the same position', async () => {
    await seed(ids(150));
    vi.mocked(fetch).mockImplementationOnce(async (_url, init) => accept(JSON.parse(init!.body as string)));
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 401 }));
    await queue.startSend(ids(150), null);
    await settle();
    expect(await latestJob()).toMatchObject({ status: 'failed', cursor: 100, created: 100 });

    acceptAll();
    await queue.resumeSend();
    await settle();
    expect(await latestJob()).toMatchObject({ status: 'done', cursor: 200, created: 150 });
  });

  it('continues after the service worker restarts', async () => {
    await seed(ids(150));
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 500 }));
    await queue.startSend(ids(150), null);
    await settle();

    vi.resetModules();
    const restarted = await import('@/background/sendQueue');
    const { db: freshDb } = await import('@/lib/db');
    acceptAll();
    const job = (await freshDb.sendJobs.orderBy('createdAt').last())!;
    await freshDb.sendJobs.update(job.id!, { nextAttemptAt: 0 });
    await restarted.pumpSend();
    const done = (await freshDb.sendJobs.get(job.id!))!;
    expect(done).toMatchObject({ status: 'done', created: 150 });
    expect(await freshDb.leads.where('deliveryStatus').equals('sent').count()).toBe(150);
    freshDb.close();
  });

  it('has nothing to resume when no send is unfinished', async () => {
    expect((await queue.resumeSend()).ok).toBe(false);
  });
});

describe('testCrmConnection', () => {
  it.each([
    [400, true, 'Connected'],
    [401, false, 'rejected the import key'],
    [503, false, 'no import key set up'],
    [404, false, 'no lead import route'],
    [500, false, '500'],
  ])('reports status %i', async (status, ok, text) => {
    vi.mocked(fetch).mockResolvedValue(new Response('', { status }));
    const result = await queue.testCrmConnection();
    expect(result.ok).toBe(ok);
    expect(`${result.detail ?? ''}${result.error ?? ''}`).toContain(text);
  });

  it('sends no lead data, and reports unreachable servers', async () => {
    await seed(['one']);
    vi.mocked(fetch).mockResolvedValue(new Response('', { status: 400 }));
    await queue.testCrmConnection();
    expect(bodyOf(0).leads).toEqual([]);
    vi.mocked(fetch).mockRejectedValue(new TypeError('offline'));
    expect((await queue.testCrmConnection()).ok).toBe(false);
  });
});
