import { describe, expect, it } from 'vitest';
import { leadsToCsv, leadsToJson, neutralizeFormula } from '@/delivery/exportFile';
import { toPayload } from '@/delivery/payload';
import { companyKeysFor, onePerCompany, searchAreaFrom } from '@/lib/company';
import { applyFilters, categoryOptions, DEFAULT_FILTERS, matchesFilters } from '@/lib/filters';
import { computeMetrics, isPartialSearch } from '@/lib/metrics';
import { migrateLead } from '@/lib/migrate';
import {
  afterBlock,
  afterClean,
  afterSlow,
  CLEAN_SEARCHES_TO_RECOVER,
  MAX_MULTIPLIER,
  nextDelayMs,
  parseSuccessTooLow,
} from '@/lib/pacing';
import { isAllowedWebhookUrl } from '@/lib/settings';
import type { Lead, Run } from '@/lib/types';

function lead(over: Partial<Lead> = {}): Lead {
  return {
    placeId: 'ChIJ1', name: 'Acme', fullAddress: '1 Main', street: '1 Main', city: 'Dallas', postalCode: '75201',
    state: 'Texas', country: 'US', categories: ['Plumber'], phoneRaw: '214', phone: '+12133734253',
    website: 'https://acme.example', domain: 'acme.example', rating: 4.5, reviewCount: 10, claimed: true,
    businessStatus: 'open', latitude: 1, longitude: 2, mapsUrl: null, hours: null, runId: 1, keyword: 'plumber in Dallas, TX', searchArea: 'Dallas, TX', companyKeys: [],
    collectedAt: 0, emails: [], sitePhones: [], socials: {}, metaDescription: null, context: null, enrichStatus: 'done',
    enrichError: null,
    evidence: {
      activeListing: true, websiteLive: true, websiteParked: false, websiteMatch: true, phoneValid: true,
      phoneMatch: false, emailVerified: false, emailRelated: false, emailSource: null, mxValid: null,
    },
    score: 50, tier: 'medium', deliveryStatus: 'pending', deliveryAttempts: 0, nextDeliveryAt: 0,
    ...over,
  };
}

describe('file export', () => {
  it('neutralizes spreadsheet formulas from scraped text', () => {
    expect(neutralizeFormula('=HYPERLINK("http://x")')).toBe(`'=HYPERLINK("http://x")`);
    expect(neutralizeFormula('@cmd')).toBe(`'@cmd`);
    expect(neutralizeFormula('Acme')).toBe('Acme');
    expect(neutralizeFormula('+1=1')).toBe(`'+1=1`);
    expect(neutralizeFormula('+SUM(1,2)')).toBe(`'+SUM(1,2)`);
  });

  it('leaves valid phone numbers unchanged', () => {
    expect(neutralizeFormula('+19378152006')).toBe('+19378152006');
    expect(leadsToCsv([lead()])).toContain(',+12133734253,');
    expect(leadsToCsv([lead({ name: '=1+1' })])).toContain("'=1+1");
  });

  it('quotes commas, quotes, and newlines in CSV', () => {
    const csv = leadsToCsv([lead({ name: 'Acme, "The Best"\nPlumbing' })]);
    expect(csv).toContain('"Acme, ""The Best""\nPlumbing"');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it('writes valid JSON with the webhook shape', () => {
    const [row] = JSON.parse(leadsToJson([lead()]));
    expect(row).toMatchObject({ place_id: 'ChIJ1', score: 50, rating: 'medium', maps_rating: 4.5 });
  });

  it('builds a valid XLSX blob', async () => {
    const { default: writeExcelFile } = await import('write-excel-file/universal');
    const blob = await writeExcelFile([[{ value: 'Name' }], [{ value: 'Acme' }], [null]]).toBlob();
    expect(blob.size).toBeGreaterThan(1000);
    const header = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    expect(String.fromCharCode(...header)).toBe('PK');
  });
});

describe('payload', () => {
  it('uses the best email and keeps evidence', () => {
    const payload = toPayload(lead({
      emails: [
        { address: 'a@gmail.com', source: '/', kind: 'free', role: false, ownDomain: false, related: false, mx: true },
        { address: 'jane@acme.example', source: '/contact', kind: 'business', role: false, ownDomain: true, related: true, mx: true },
      ],
    }));
    expect(payload.email).toBe('jane@acme.example');
    expect(payload.emails).toHaveLength(2);
    expect(payload.evidence.website_match).toBe(true);
  });
});

describe('filters', () => {
  const match = (l: Lead, over: Partial<typeof DEFAULT_FILTERS>) => matchesFilters(l, { ...DEFAULT_FILTERS, ...over });

  it('filters by score, rating, reviews, and text', () => {
    expect(match(lead(), { minScore: 51 })).toBe(false);
    expect(match(lead(), { minRating: 4.6 })).toBe(false);
    expect(match(lead(), { minReviews: 11 })).toBe(false);
    expect(match(lead(), { search: 'plumb' })).toBe(true);
    expect(match(lead(), { search: 'bakery' })).toBe(false);
  });

  it('filters by status and contact details', () => {
    expect(match(lead({ businessStatus: 'temporarily_closed' }), { status: 'open' })).toBe(false);
    expect(match(lead({ businessStatus: 'temporarily_closed' }), { status: 'closed' })).toBe(true);
    expect(match(lead({ website: null }), { requireWebsite: true })).toBe(false);
    expect(match(lead(), { requireEmail: true })).toBe(false);
  });

  it('filters by email type', () => {
    const role = lead({ emails: [{ address: 'info@a.example', source: '/', kind: 'business', role: true, ownDomain: true, related: true, mx: true }] });
    expect(match(role, { emailRole: 'role' })).toBe(true);
    expect(match(role, { emailRole: 'named' })).toBe(false);
    expect(match(role, { emailKind: 'free' })).toBe(false);
  });
});

describe('company grouping', () => {
  const row = (placeId: string, domain: string | null, phone: string | null, score = 50) => {
    const base = lead({ placeId, domain, phone, score });
    return { ...base, companyKeys: companyKeysFor(base) };
  };

  it('keeps the best listing of a company, in the original order', () => {
    const kept = onePerCompany([row('a', 'master.example', '+1', 25), row('b', 'solo.example', '+2'), row('c', 'master.example', '+3', 70)]);
    expect(kept.map((l) => l.placeId)).toEqual(['b', 'c']);
  });

  it('links listings by a shared phone or email too', () => {
    expect(onePerCompany([row('a', 'one.example', '+1'), row('b', 'two.example', '+1')])).toHaveLength(1);
    const email = { address: 'x@y.example', source: '/', kind: 'business' as const, role: false, ownDomain: false, related: true, mx: true };
    const first = lead({ placeId: 'a', domain: 'one.example', phone: '+1', emails: [email] });
    const second = lead({ placeId: 'b', domain: 'two.example', phone: '+2', emails: [email] });
    const grouped = [first, second].map((l) => ({ ...l, companyKeys: companyKeysFor(l) }));
    expect(onePerCompany(grouped)).toHaveLength(1);
  });

  it('does not group unrelated businesses on a social or builder domain', () => {
    expect(onePerCompany([row('a', 'facebook.com', '+1'), row('b', 'facebook.com', '+2'), row('c', 'b12sites.com', '+3'), row('d', 'b12sites.com', '+4')])).toHaveLength(4);
  });

  it('hides multi-location companies on request', () => {
    const leads = [row('a', 'chain.example', '+1'), row('b', 'chain.example', '+2'), row('c', 'chain.example', '+3'), row('d', 'solo.example', '+4')];
    const ids = (filters: Partial<typeof DEFAULT_FILTERS>) => applyFilters(leads, { ...DEFAULT_FILTERS, ...filters }).map((l) => l.placeId);
    expect(ids({})).toEqual(['a', 'd']);
    expect(ids({ onePerCompany: false })).toEqual(['a', 'b', 'c', 'd']);
    expect(ids({ hideMultiLocation: true })).toEqual(['d']);
  });

  it('reads the search area from a query', () => {
    expect(searchAreaFrom('plumber in Dayton, OH')).toBe('Dayton, OH');
    expect(searchAreaFrom('work in progress in Boise')).toBe('Boise');
    expect(searchAreaFrom('plumbers near me')).toBeNull();
  });
});

describe('small-business filters', () => {
  const match = (l: Lead, over: Partial<typeof DEFAULT_FILTERS>) => matchesFilters(l, { ...DEFAULT_FILTERS, ...over });

  it('limits reviews and category', () => {
    expect(match(lead({ reviewCount: 100 }), { maxReviews: 100 })).toBe(true);
    expect(match(lead({ reviewCount: 101 }), { maxReviews: 100 })).toBe(false);
    expect(match(lead({ reviewCount: 5000 }), {})).toBe(true);
    expect(match(lead(), { category: 'Plumber' })).toBe(true);
    expect(match(lead({ categories: ['Supply store', 'Plumber'] }), { category: 'Plumber' })).toBe(false);
  });

  it('lists categories by how common they are', () => {
    expect(categoryOptions([lead({ categories: ['B'] }), lead({ categories: ['A'] }), lead({ categories: ['A'] }), lead({ categories: [] })])).toEqual(['A', 'B']);
  });
});

describe('migrateLead', () => {
  const email = (address: string, ownDomain = false) => ({ address, source: '/', kind: 'free' as const, role: false, ownDomain, mx: true }) as never;
  const stored = (over: Partial<Lead>) => {
    const old = lead({
      name: 'Spokane Rooter', domain: 'spokanerooter.com', website: 'https://spokanerooter.com/', phone: '+15095550100',
      sitePhones: ['+15095550100'],
      evidence: { activeListing: true, websiteLive: true, websiteParked: false, websiteMatch: true, phoneValid: true, phoneMatch: true, emailVerified: false, emailRelated: false, emailSource: '/', mxValid: true },
      score: 70, tier: 'medium', ...over,
    });
    delete (old as Partial<Lead>).searchArea;
    delete (old as Partial<Lead>).companyKeys;
    return old;
  };

  it('credits a related Gmail address and adds new fields', () => {
    const old = stored({ emails: [email('spokanerooter@gmail.com')] });
    migrateLead(old);
    expect(old).toMatchObject({ score: 85, tier: 'high', searchArea: 'Dallas, TX' });
    expect(old.companyKeys).toEqual(['d:spokanerooter.com', 'e:spokanerooter@gmail.com', 'p:+15095550100']);
  });

  it('removes placeholder emails', () => {
    const old = stored({ emails: [email('dummytext@gmail.com')] });
    migrateLead(old);
    expect(old.emails).toEqual([]);
    expect(old.score).toBe(70);
  });

  it('removes website credit from social pages', () => {
    const old = stored({ domain: 'facebook.com', emails: [] });
    migrateLead(old);
    expect(old.evidence.websiteMatch).toBe(false);
    expect(old.enrichError).toBe('Listed website is a social page');
    expect(old.companyKeys).toEqual(['p:+15095550100']);
  });
});

describe('partial searches', () => {
  it('flags clearly fewer captures than results shown', () => {
    expect(isPartialSearch({ rows: 20, visibleCards: 120 })).toBe(true);
    expect(isPartialSearch({ rows: 120, visibleCards: 120 })).toBe(false);
    expect(isPartialSearch({ rows: 100, visibleCards: 120 })).toBe(false);
    expect(isPartialSearch({ rows: 0, visibleCards: 0 })).toBe(false);
  });
});

describe('pacing', () => {
  const start = { delayMultiplier: 1, cleanStreak: 0 };

  it('halves speed on a block, up to a limit', () => {
    expect(afterBlock(start).delayMultiplier).toBe(2);
    expect(afterBlock({ delayMultiplier: MAX_MULTIPLIER, cleanStreak: 3 })).toEqual({ delayMultiplier: MAX_MULTIPLIER, cleanStreak: 0 });
    expect(afterSlow(start).delayMultiplier).toBe(1.5);
  });

  it('recovers gradually and never exceeds base speed', () => {
    let state = { delayMultiplier: 2, cleanStreak: 0 };
    for (let i = 0; i < CLEAN_SEARCHES_TO_RECOVER; i += 1) state = afterClean(state);
    expect(state).toEqual({ delayMultiplier: 1.6, cleanStreak: 0 });
    let base = start;
    for (let i = 0; i < CLEAN_SEARCHES_TO_RECOVER * 2; i += 1) base = afterClean(base);
    expect(base.delayMultiplier).toBe(1);
  });

  it('scales the delay', () => {
    expect(nextDelayMs(1, 0)).toBe(4000);
    expect(nextDelayMs(2, 1)).toBe(18000);
  });

  it('stops on low parse success only after a real sample', () => {
    expect(parseSuccessTooLow(19, 0)).toBe(false);
    expect(parseSuccessTooLow(20, 17)).toBe(true);
    expect(parseSuccessTooLow(20, 18)).toBe(false);
  });
});

describe('webhook URL rules', () => {
  it('allows https anywhere and http only on this machine', () => {
    expect(isAllowedWebhookUrl('https://agent.example/leads')).toBe(true);
    expect(isAllowedWebhookUrl('http://localhost:3000/leads')).toBe(true);
    expect(isAllowedWebhookUrl('http://127.0.0.1:3000/')).toBe(true);
    expect(isAllowedWebhookUrl('http://agent.example/leads')).toBe(false);
    expect(isAllowedWebhookUrl('ftp://agent.example')).toBe(false);
    expect(isAllowedWebhookUrl('nonsense')).toBe(false);
  });
});

describe('metrics', () => {
  const run: Run = {
    status: 'running', statusReason: null, createdAt: 0, finishedAt: null, activeMs: 3_600_000, segmentStartedAt: null,
    tabId: null, currentJobId: null, nextDispatchAt: 0, delayMultiplier: 1, cleanStreak: 0, coverageMisses: 0,
    rowsAttempted: 100, rowsParsed: 99, responsesUnreadable: 0, uniqueLeads: 2, duplicates: 2, searchesFinished: 200, captchas: 1,
  };

  it('computes each rate from run data and leads', () => {
    const metrics = computeMetrics(run, [
      lead({ emails: [{ address: 'a@a.example', source: '/', kind: 'business', role: false, ownDomain: true, related: true, mx: false }], deliveryStatus: 'delivered' }),
      lead({ placeId: 'ChIJ2', website: null, phoneRaw: null, enrichStatus: 'skipped', deliveryStatus: 'failed' }),
    ]);
    expect(metrics).toEqual({
      uniqueLeadsPerHour: 2,
      duplicateRate: 0.5,
      parseSuccess: 0.99,
      phoneFound: 0.5,
      websiteFound: 0.5,
      emailFound: 1,
      websiteProblems: 0,
      richContext: 0,
      invalidEmailRate: 1,
      captchasPer100: 0.5,
      webhookDelivery: 0.5,
    });
  });

  it('shows no rate until there is data', () => {
    const empty = computeMetrics({ ...run, rowsAttempted: 0, rowsParsed: 0, uniqueLeads: 0, duplicates: 0, searchesFinished: 0 }, []);
    expect(Object.values(empty).every((value) => value === null)).toBe(true);
  });
});
