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

const { pumpEnrichment, queueMissingContext, recoverEnrichment, retryFailedWebsites } = await import('@/background/enrichQueue');
const engine = await import('@/background/engine');
const { db } = await import('@/lib/db');
const { isSendRunning, resetAfterCrmChange } = await import('@/lib/crmAddress');

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
    expect(await db.leads.get('ChIJ1')).toMatchObject({ enrichError: 'Could not connect to website', deliveryStatus: 'unsent', score: 25 });
  });

  it('rechecks failed websites without resending delivered leads', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    const { runId, jobId } = await createRun();
    await engine.storeBusinesses(runId, jobId, [business()], 1, false);
    await pumpEnrichment(() => {});
    await flush(async () => (await db.leads.get('ChIJ1'))?.enrichStatus === 'failed');
    await db.leads.update('ChIJ1', { deliveryStatus: 'sent' });

    siteFetch();
    expect(await retryFailedWebsites()).toBe(1);
    await pumpEnrichment(() => {});
    await flush(async () => (await db.leads.get('ChIJ1'))?.enrichStatus === 'done');
    expect(await db.leads.get('ChIJ1')).toMatchObject({ score: 100, enrichError: null, deliveryStatus: 'sent' });
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
      score: 70, tier: 'medium', deliveryStatus: 'delivered', deliveryAttempts: 1, nextDeliveryAt: 0,
    });
    await old.table('leads').add({
      ...business({ placeId: 'ChIJfail', name: 'Other Co', domain: 'other.example' }),
      phone: null, sitePhones: [], runId: 1, keyword: 'plumber', collectedAt: 1, emails: [
        { address: 'service@acme721stg.wpenginepowered.com', source: '/', kind: 'business', role: false, ownDomain: false, mx: true },
      ], socials: {}, metaDescription: null, enrichStatus: 'done', enrichError: null,
      evidence: { activeListing: true, websiteLive: true, websiteParked: false, websiteMatch: true, phoneValid: false, phoneMatch: false, emailVerified: false, emailSource: '/', mxValid: true },
      score: 50, tier: 'medium', deliveryStatus: 'pending', deliveryAttempts: 3, nextDeliveryAt: 9,
    });
    old.close();

    await db.open();
    const lead = await db.leads.get('ChIJold');
    expect(lead?.emails.map((e) => e.address)).toEqual(['spokanerooter@gmail.com']);
    expect(lead).toMatchObject({ score: 85, tier: 'high', searchArea: 'Spokane, WA' });
    expect(await db.leads.where('companyKeys').equals('d:spokanerooter.com').count()).toBe(1);
    expect(lead?.context).toBeNull();
    expect(lead).toMatchObject({ deliveryStatus: 'unsent', crmNote: null, crmSentAt: null });
    expect(lead).not.toHaveProperty('deliveryAttempts');
    const pending = await db.leads.get('ChIJfail');
    expect(pending).toMatchObject({ deliveryStatus: 'unsent', emails: [] });
    expect(pending).not.toHaveProperty('nextDeliveryAt');
    expect(await queueMissingContext()).toBe(2);
  });

  it('frees leads marked sent by the previous version, without knowing which CRM they went to', async () => {
    db.close();
    await Dexie.delete('lead-scraper');
    const old = new Dexie('lead-scraper');
    old.version(5).stores({
      leads: 'placeId, runId, domain, [domain+phone], enrichStatus, deliveryStatus, tier, score, collectedAt, *companyKeys',
      jobs: '++id, runId, [runId+status], status',
      runs: '++id, status, createdAt',
      mx: 'domain',
      sendJobs: '++id, status, createdAt',
    });
    await old.open();
    await old.table('leads').bulkAdd(
      ['sent', 'duplicate', 'rejected', 'unsent'].map((deliveryStatus) => ({
        ...business({ placeId: `ChIJ${deliveryStatus}`, website: null, domain: null }),
        deliveryStatus, crmNote: 'old note', crmSentAt: 5, emails: [{ address: 'keep@acme.example' }], score: 70,
      })),
    );
    await old.table('sendJobs').add({ status: 'done', createdAt: 1, placeIds: [] });
    old.close();

    await db.open();
    const leads = await db.leads.toArray();
    expect(leads.map((lead) => lead.deliveryStatus)).toEqual(['unsent', 'unsent', 'unsent', 'unsent']);
    expect(leads.every((lead) => lead.crmNote === null && lead.crmSentAt === null)).toBe(true);
    expect(leads[0]?.emails).toHaveLength(1);
    expect(leads[0]?.score).toBe(70);
    expect(await db.sendJobs.count()).toBe(0);
  });
});

describe('changing the CRM address', () => {
  const LOCAL = 'http://localhost:3000';
  const LIVE = 'https://crm.example';

  beforeEach(async () => {
    await db.leads.bulkAdd(
      (['sent', 'duplicate', 'rejected', 'unsent'] as const).map((deliveryStatus) => ({
        ...business({ placeId: `ChIJ${deliveryStatus}`, website: null, domain: null }),
        phone: null, sitePhones: [], runId: 1, keyword: 'x', searchArea: null, companyKeys: [], collectedAt: 0, emails: [],
        socials: {}, metaDescription: null, context: null, enrichStatus: 'done' as const, enrichError: null, score: 25, tier: 'low' as const, crmSentAt: null,
        evidence: { activeListing: true, websiteLive: false, websiteParked: false, websiteMatch: false, phoneValid: false, phoneMatch: false, emailVerified: false, emailRelated: false, emailSource: null, mxValid: null },
        deliveryStatus,
        crmNote: 'note',
      })),
    );
    await db.sendJobs.add({
      clientBatchId: 'old', crmBatchId: null, label: null, status: 'done', placeIds: [], cursor: 0, created: 1,
      alreadyImported: 0, duplicates: 0, rejected: 0, attempts: 0, nextAttemptAt: 0, error: null, createdAt: 1, updatedAt: 1,
    });
  });

  it('frees every handled lead and clears old results for a new address', async () => {
    expect(await resetAfterCrmChange(LOCAL, LIVE)).toBe(3);
    expect(await db.leads.where('deliveryStatus').equals('unsent').count()).toBe(4);
    expect((await db.leads.get('ChIJsent'))?.crmNote).toBeNull();
    expect(await db.sendJobs.count()).toBe(0);
  });

  it.each([
    ['the same address', LIVE, LIVE],
    ['the same address written differently', `${LIVE}/admin/leads`, LIVE],
    ['a first-time setup', '', LIVE],
    ['clearing the address', LIVE, null],
  ])('changes nothing for %s', async (_label, previous, next) => {
    expect(await resetAfterCrmChange(previous, next)).toBe(0);
    expect((await db.leads.get('ChIJsent'))?.deliveryStatus).toBe('sent');
    expect(await db.sendJobs.count()).toBe(1);
  });

  it('knows when a send is running', async () => {
    expect(await isSendRunning()).toBe(false);
    await db.sendJobs.toCollection().modify({ status: 'running' });
    expect(await isSendRunning()).toBe(true);
  });
});
