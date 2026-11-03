import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MapsBusiness } from '@/lib/types';

const storage: Record<string, unknown> = {};
let permissionGranted = true;
const tabUrls = new Map<number, string>();

vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: async (key: string) => ({ [key]: storage[key] }),
      set: async (values: Record<string, unknown>) => Object.assign(storage, values),
    },
  },
  permissions: { contains: async () => permissionGranted },
  notifications: { create: vi.fn() },
  runtime: { getURL: (path: string) => path },
  tabs: {
    get: async (id: number) => {
      if (!tabUrls.has(id)) throw new Error('No tab');
      return { id, url: tabUrls.get(id) };
    },
    update: async (id: number, change: { url: string }) => {
      tabUrls.set(id, change.url);
      return { id };
    },
  },
  windows: {
    create: async () => {
      tabUrls.set(7, 'about:blank');
      return { tabs: [{ id: 7 }] };
    },
  },
});

const { backoffMs, MAX_ATTEMPTS, pumpDelivery } = await import('@/background/deliveryQueue');
const { pumpEnrichment, queueMissingContext, recoverEnrichment, retryFailedWebsites } = await import('@/background/enrichQueue');
const engine = await import('@/background/engine');
const { db } = await import('@/lib/db');

function business(over: Partial<MapsBusiness> = {}): MapsBusiness {
  return {
    placeId: 'ChIJ1', name: 'Acme Plumbing', fullAddress: null, street: null, city: 'Dallas', postalCode: null,
    state: null, country: 'US', categories: [], phoneRaw: '(213) 373-4253', website: 'https://acme.example/',
    domain: 'acme.example', rating: 4.5, reviewCount: 10, claimed: true, businessStatus: 'open', latitude: null,
    longitude: null, mapsUrl: null, hours: null, ...over,
  };
}

async function createRun(queries = ['plumber']): Promise<{ runId: number; jobId: number }> {
  await engine.startRun(queries, []);
  const run = (await db.runs.toArray())[0]!;
  return { runId: run.id!, jobId: run.currentJobId! };
}

const flush = async (check: () => Promise<boolean>) => {
  await vi.waitFor(async () => expect(await check()).toBe(true), { timeout: 2000, interval: 10 });
};

beforeEach(async () => {
  await db.delete();
  await db.open();
  Object.keys(storage).forEach((key) => delete storage[key]);
  tabUrls.clear();
  permissionGranted = true;
  vi.stubGlobal('fetch', vi.fn());
});

describe('storing leads', () => {
  it('removes duplicates by place, and by domain plus phone', async () => {
    const { runId, jobId } = await createRun();
    await engine.storeBusinesses(runId, jobId, [
      business(),
      business(),
      business({ placeId: 'ChIJ2' }),
      business({ placeId: 'ChIJ3', phoneRaw: '(213) 373-4254' }),
      business({ placeId: 'ChIJ4', domain: null, website: null }),
    ], 5, false);
    expect((await db.leads.toArray()).map((l) => l.placeId).sort()).toEqual(['ChIJ1', 'ChIJ3', 'ChIJ4']);
    expect(await db.runs.get(runId)).toMatchObject({ uniqueLeads: 3, duplicates: 2, rowsAttempted: 5, rowsParsed: 5 });
  });

  it('scores a Maps-only lead from its listing alone', async () => {
    const { runId, jobId } = await createRun();
    await engine.storeBusinesses(runId, jobId, [business({ website: null })], 1, false);
    expect(await db.leads.get('ChIJ1')).toMatchObject({ score: 25, tier: 'low', enrichStatus: 'skipped' });
  });
});

describe('enrichment queue', () => {
  function siteFetch() {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://cloudflare-dns.com/')) {
        return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 15, data: '10 mail.acme.example.' }] }));
      }
      if (url === 'https://acme.example/') {
        const response = new Response(
          '<title>Acme Plumbing</title>jane@acme.example <a href="tel:+12133734253">Call</a>',
          { headers: { 'content-type': 'text/html' } },
        );
        Object.defineProperty(response, 'url', { value: url });
        return response;
      }
      return new Response('', { status: 404 });
    });
  }

  it('crawls, verifies, and scores a lead to 100', async () => {
    siteFetch();
    const { runId, jobId } = await createRun();
    await engine.storeBusinesses(runId, jobId, [business()], 1, false);
    await pumpEnrichment(() => {});
    await flush(async () => (await db.leads.get('ChIJ1'))?.enrichStatus === 'done');
    const lead = (await db.leads.get('ChIJ1'))!;
    expect(lead).toMatchObject({ score: 100, tier: 'high', sitePhones: ['+12133734253'] });
    expect(lead.emails[0]).toMatchObject({ address: 'jane@acme.example', ownDomain: true, mx: true, role: false, kind: 'business' });
    for (const call of vi.mocked(fetch).mock.calls) {
      expect((call[1] as RequestInit).credentials).toBe('omit');
    }
    expect(await db.mx.get('acme.example')).toMatchObject({ valid: true });
  });

  it('marks an unreachable website as failed but still deliverable', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    const { runId, jobId } = await createRun();
    await engine.storeBusinesses(runId, jobId, [business()], 1, false);
    await pumpEnrichment(() => {});
    await flush(async () => (await db.leads.get('ChIJ1'))?.enrichStatus === 'failed');
    expect(await db.leads.get('ChIJ1')).toMatchObject({ enrichError: 'Could not connect to website', deliveryStatus: 'pending', score: 25 });
  });

  it('rechecks failed websites without resending delivered leads', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    const { runId, jobId } = await createRun();
    await engine.storeBusinesses(runId, jobId, [business()], 1, false);
    await pumpEnrichment(() => {});
    await flush(async () => (await db.leads.get('ChIJ1'))?.enrichStatus === 'failed');
    await db.leads.update('ChIJ1', { deliveryStatus: 'delivered' });

    siteFetch();
    expect(await retryFailedWebsites()).toBe(1);
    await pumpEnrichment(() => {});
    await flush(async () => (await db.leads.get('ChIJ1'))?.enrichStatus === 'done');
    expect(await db.leads.get('ChIJ1')).toMatchObject({ score: 100, enrichError: null, deliveryStatus: 'delivered' });
  });

  it('does not crawl a social page listed as a website', async () => {
    const { runId, jobId } = await createRun();
    await engine.storeBusinesses(runId, jobId, [business({ website: 'https://www.facebook.com/acme', domain: 'facebook.com' })], 1, false);
    expect(await db.leads.get('ChIJ1')).toMatchObject({
      enrichStatus: 'skipped',
      enrichError: 'Listed website is a social page',
      socials: { facebook: 'https://www.facebook.com/acme' },
    });
    await pumpEnrichment(() => {});
    expect(fetch).not.toHaveBeenCalled();
  });

  it('queues older leads for context, but not social pages or leads already queued', async () => {
    permissionGranted = false;
    const { runId, jobId } = await createRun();
    await engine.storeBusinesses(runId, jobId, [
      business({ placeId: 'ChIJold', domain: 'old.example', website: 'https://old.example/' }),
      business({ placeId: 'ChIJhas', domain: 'has.example', website: 'https://has.example/' }),
      business({ placeId: 'ChIJnone', domain: null, website: null, phoneRaw: '(213) 373-4256' }),
      business({ placeId: 'ChIJface', domain: 'facebook.com', website: 'https://facebook.com/x', phoneRaw: '(213) 373-4257' }),
    ], 4, false);
    await db.leads.update('ChIJold', { enrichStatus: 'done' });
    await db.leads.update('ChIJhas', { enrichStatus: 'done', context: { level: 'basic' } as never });
    expect(await queueMissingContext()).toBe(1);
    expect((await db.leads.get('ChIJold'))?.enrichStatus).toBe('pending');
  });

  it('skips leads without website access and never fetches', async () => {
    permissionGranted = false;
    const { runId, jobId } = await createRun();
    await engine.storeBusinesses(runId, jobId, [business()], 1, false);
    await pumpEnrichment(() => {});
    expect((await db.leads.get('ChIJ1'))?.enrichStatus).toBe('skipped');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requeues crawls lost when the service worker stopped', async () => {
    permissionGranted = false;
    const { runId, jobId } = await createRun();
    await engine.storeBusinesses(runId, jobId, [business()], 1, false);
    await db.leads.update('ChIJ1', { enrichStatus: 'running' });
    await recoverEnrichment();
    expect((await db.leads.get('ChIJ1'))?.enrichStatus).toBe('pending');
  });
});

describe('webhook queue', () => {
  async function queuedLead(score = 25) {
    const { runId, jobId } = await createRun();
    await engine.storeBusinesses(runId, jobId, [business({ website: null })], 1, false);
    await db.leads.update('ChIJ1', { score });
    storage.settings = { webhookUrl: 'https://agent.example/leads', webhookSecret: 's3cret', webhookMinScore: 0 };
    vi.mocked(fetch).mockReset();
  }

  it('sends each lead once with its key and token', async () => {
    await queuedLead();
    vi.mocked(fetch).mockResolvedValue(new Response('ok'));
    await pumpDelivery();
    await pumpDelivery();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('https://agent.example/leads');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      headers: { 'idempotency-key': 'ChIJ1', authorization: 'Bearer s3cret' },
    });
    expect(JSON.parse(init!.body as string)).toMatchObject({ place_id: 'ChIJ1', name: 'Acme Plumbing' });
    expect((await db.leads.get('ChIJ1'))?.deliveryStatus).toBe('delivered');
  });

  it('sends only the strongest listing of a company', async () => {
    const { runId, jobId } = await createRun();
    await engine.storeBusinesses(runId, jobId, [
      business({ placeId: 'ChIJweak', website: null, domain: 'chain.example', phoneRaw: '(213) 373-4254' }),
      business({ placeId: 'ChIJstrong', website: null, domain: 'chain.example', phoneRaw: '(213) 373-4255' }),
    ], 2, false);
    await db.leads.update('ChIJstrong', { score: 90 });
    storage.settings = { webhookUrl: 'https://agent.example/leads' };
    vi.mocked(fetch).mockReset();
    vi.mocked(fetch).mockImplementation(async () => new Response('ok'));
    await pumpDelivery();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await db.leads.get('ChIJstrong'))?.deliveryStatus).toBe('delivered');
    expect((await db.leads.get('ChIJweak'))?.deliveryStatus).toBe('duplicate');
  });

  it.each([[500], [429]])('retries later after a %i', async (status) => {
    await queuedLead();
    vi.mocked(fetch).mockResolvedValue(new Response('', { status }));
    const before = Date.now();
    await pumpDelivery();
    const lead = (await db.leads.get('ChIJ1'))!;
    expect(lead).toMatchObject({ deliveryStatus: 'pending', deliveryAttempts: 1 });
    expect(lead.nextDeliveryAt).toBeGreaterThanOrEqual(before + 30_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries after a network error', async () => {
    await queuedLead();
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    await pumpDelivery();
    expect(await db.leads.get('ChIJ1')).toMatchObject({ deliveryStatus: 'pending', deliveryAttempts: 1 });
  });

  it('gives up at once on a permanent rejection', async () => {
    await queuedLead();
    vi.mocked(fetch).mockResolvedValue(new Response('', { status: 401 }));
    await pumpDelivery();
    expect((await db.leads.get('ChIJ1'))?.deliveryStatus).toBe('failed');
  });

  it('gives up after the maximum attempts', async () => {
    await queuedLead();
    await db.leads.update('ChIJ1', { deliveryAttempts: MAX_ATTEMPTS - 1 });
    vi.mocked(fetch).mockResolvedValue(new Response('', { status: 500 }));
    await pumpDelivery();
    expect((await db.leads.get('ChIJ1'))?.deliveryStatus).toBe('failed');
  });

  it('holds back low scores and leads still being checked', async () => {
    await queuedLead(10);
    storage.settings = { webhookUrl: 'https://agent.example/leads', webhookMinScore: 50 };
    await pumpDelivery();
    expect((await db.leads.get('ChIJ1'))?.deliveryStatus).toBe('filtered');

    await db.leads.update('ChIJ1', { deliveryStatus: 'pending', enrichStatus: 'running', score: 90 });
    await pumpDelivery();
    expect(fetch).not.toHaveBeenCalled();
    expect((await db.leads.get('ChIJ1'))?.deliveryStatus).toBe('pending');
  });

  it('sends nothing to an insecure remote webhook or without permission', async () => {
    await queuedLead();
    storage.settings = { webhookUrl: 'http://agent.example/leads' };
    await pumpDelivery();
    storage.settings = { webhookUrl: 'https://agent.example/leads' };
    permissionGranted = false;
    await pumpDelivery();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('backs off exponentially with a cap', () => {
    expect([backoffMs(1), backoffMs(2), backoffMs(3), backoffMs(20)]).toEqual([30_000, 60_000, 120_000, 1_800_000]);
  });
});

describe('run recovery', () => {
  it('pauses from the watchdog when a block event was missed, without losing the search', async () => {
    const { runId, jobId } = await createRun(['a', 'b']);
    tabUrls.set(7, 'https://www.google.com/sorry/index');
    await engine.watchdog();
    expect(await db.runs.get(runId)).toMatchObject({ status: 'paused_blocked', captchas: 1, delayMultiplier: 2, currentJobId: null });
    expect(await db.jobs.get(jobId)).toMatchObject({ status: 'pending' });
  });

  it('resumes from the watchdog once the block page is gone', async () => {
    const { runId } = await createRun(['a']);
    tabUrls.set(7, 'https://www.google.com/sorry/index');
    await engine.watchdog();
    tabUrls.set(7, 'https://www.google.com/');
    await engine.watchdog();
    const run = await db.runs.get(runId);
    expect(run?.status).toBe('running');
    expect(tabUrls.get(7)).toContain('/maps/search/a/');
    expect(run?.delayMultiplier).toBe(2);
  });

  it('retries a stuck search, then fails it and moves on', async () => {
    const { runId, jobId } = await createRun(['a', 'b']);
    tabUrls.set(7, 'https://www.google.com/maps/search/a/');
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await db.jobs.update(jobId, { startedAt: Date.now() - 7 * 60_000 });
      await engine.watchdog();
    }
    expect(await db.jobs.get(jobId)).toMatchObject({ status: 'failed', outcome: 'timeout', attempts: 3 });
    const run = await db.runs.get(runId);
    expect((await db.jobs.get(run!.currentJobId!))?.query).toBe('b');
  });

  it('ignores captures from other tabs and old jobs', async () => {
    const { runId, jobId } = await createRun();
    await engine.handleCapture(99, jobId, 'x');
    await engine.handleCapture(7, jobId + 1, 'x');
    expect(await db.runs.get(runId)).toMatchObject({ responsesUnreadable: 0 });
  });

  it('refuses a second active run', async () => {
    await createRun();
    await expect(engine.startRun(['b'], [])).rejects.toThrow('already active');
  });
});

describe('database upgrade', () => {
  it('upgrades leads saved by the first version in place', async () => {
    db.close();
    await Dexie.delete('lead-scraper');
    const old = new Dexie('lead-scraper');
    old.version(1).stores({
      leads: 'placeId, runId, domain, [domain+phone], enrichStatus, deliveryStatus, tier, score, collectedAt',
      jobs: '++id, runId, [runId+status], status',
      runs: '++id, status, createdAt',
      mx: 'domain',
    });
    await old.open();
    await old.table('leads').add({
      ...business({ placeId: 'ChIJold', name: 'Spokane Rooter', domain: 'spokanerooter.com' }),
      phone: '+15095550100', sitePhones: ['+15095550100'], runId: 1, keyword: 'plumber in Spokane, WA', collectedAt: 1,
      emails: [
        { address: 'dummytext@gmail.com', source: '/', kind: 'free', role: false, ownDomain: false, mx: true },
        { address: 'spokanerooter@gmail.com', source: '/', kind: 'free', role: false, ownDomain: false, mx: true },
      ],
      socials: {}, metaDescription: null, context: { level: 'rich', services: ['Plano, TX'] }, enrichStatus: 'done', enrichError: null,
      evidence: { activeListing: true, websiteLive: true, websiteParked: false, websiteMatch: true, phoneValid: true, phoneMatch: true, emailVerified: false, emailSource: '/', mxValid: true },
      score: 70, tier: 'medium', deliveryStatus: 'pending', deliveryAttempts: 0, nextDeliveryAt: 0,
    });
    old.close();

    await db.open();
    const lead = await db.leads.get('ChIJold');
    expect(lead?.emails.map((e) => e.address)).toEqual(['spokanerooter@gmail.com']);
    expect(lead).toMatchObject({ score: 85, tier: 'high', searchArea: 'Spokane, WA' });
    expect(await db.leads.where('companyKeys').equals('d:spokanerooter.com').count()).toBe(1);
    expect(lead?.context).toBeNull();
    expect(await queueMissingContext()).toBe(1);
  });
});
