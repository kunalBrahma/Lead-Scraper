import { isSocialHost } from '@/enrich/hosts';
import { normalizePhone } from '@/enrich/phone';
import { buildEvidence, scoreEvidence, tierFor } from '@/enrich/score';
import { companyKeysFor, searchAreaFrom } from '@/lib/company';
import { db, getActiveRun } from '@/lib/db';
import { buildSearchUrl, generateQueries, MAX_QUERIES } from '@/lib/jobs';
import type { Assignment } from '@/lib/messages';
import {
  afterBlock,
  afterClean,
  afterSlow,
  COVERAGE_MISS_LIMIT,
  nextDelayMs,
  parseSuccessTooLow,
} from '@/lib/pacing';
import type { Job, Lead, MapsBusiness, Run, RunStatus, SearchOutcome } from '@/lib/types';
import { isBlockedUrl, PLACE_ID_IN_URL } from '@/maps/fieldMap';
import { parseSearchResponse } from '@/maps/parseResponse';

const STALE_JOB_MS = 6 * 60_000;
const MAX_JOB_ATTEMPTS = 3;
const MAX_UNREADABLE_RESPONSES = 5;

export interface EngineHooks {
  onLeadsAdded: () => void;
}

let hooks: EngineHooks = { onLeadsAdded: () => {} };
let dispatchTimer: ReturnType<typeof setTimeout> | undefined;

export function configureEngine(next: EngineHooks): void {
  hooks = next;
}

function notify(title: string, message: string): void {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icon/128.png'),
    title,
    message,
    priority: 2,
  });
}

/** Closes the open timing segment so pauses are excluded from leads per hour. */
function closeSegment(run: Run, now = Date.now()): Pick<Run, 'activeMs' | 'segmentStartedAt'> {
  return {
    activeMs: run.activeMs + (run.segmentStartedAt ? now - run.segmentStartedAt : 0),
    segmentStartedAt: null,
  };
}

async function requeueCurrentJob(run: Run): Promise<void> {
  if (run.currentJobId) {
    await db.jobs.update(run.currentJobId, { status: 'pending', startedAt: null });
  }
}

async function haltRun(run: Run, status: RunStatus, reason: string | null): Promise<void> {
  clearTimeout(dispatchTimer);
  const terminal = status === 'completed' || status === 'stopped' || status === 'stopped_parse';
  await requeueCurrentJob(run);
  await db.runs.update(run.id!, {
    ...closeSegment(run),
    status,
    statusReason: reason,
    currentJobId: null,
    finishedAt: terminal ? Date.now() : null,
  });
}

async function openScrapeTab(): Promise<number> {
  const window = await chrome.windows.create({ url: 'about:blank', focused: true, type: 'normal' });
  const tabId = window?.tabs?.[0]?.id;
  if (tabId === undefined) throw new Error('Could not open the scraping window');
  return tabId;
}

async function navigate(run: Run, url: string): Promise<void> {
  if (run.tabId !== null) {
    try {
      await chrome.tabs.update(run.tabId, { url });
      return;
    } catch {
      // The tab is gone, so a new window takes its place.
    }
  }
  // Save the tab first, because the page asks for its job as soon as it loads.
  const tabId = await openScrapeTab();
  await db.runs.update(run.id!, { tabId });
  await chrome.tabs.update(tabId, { url });
}

/** Claims the next job atomically, so a timer and an alarm cannot both dispatch it. */
async function dispatchNext(): Promise<void> {
  const claim = await db.transaction('rw', db.runs, db.jobs, async () => {
    const run = await db.runs.where('status').equals('running').first();
    if (!run || run.currentJobId !== null || Date.now() < run.nextDispatchAt) return null;
    const job = await db.jobs.where('[runId+status]').equals([run.id!, 'pending']).first();
    if (!job) {
      await db.runs.update(run.id!, {
        ...closeSegment(run),
        status: 'completed',
        statusReason: 'All searches finished.',
        finishedAt: Date.now(),
      });
      return { done: true as const };
    }
    await db.jobs.update(job.id!, { status: 'running', startedAt: Date.now(), attempts: job.attempts + 1 });
    await db.runs.update(run.id!, { currentJobId: job.id! });
    return { done: false as const, run: { ...run, currentJobId: job.id! }, job };
  });

  if (!claim) return;
  if (claim.done) {
    notify('Lead Scraper finished', 'All searches are done.');
    return;
  }
  await navigate(claim.run, buildSearchUrl(claim.job.query));
}

function scheduleDispatch(delayMs: number): void {
  clearTimeout(dispatchTimer);
  dispatchTimer = setTimeout(() => void dispatchNext(), delayMs);
}

export async function startRun(keywords: string[], locations: string[]): Promise<void> {
  if (await getActiveRun()) throw new Error('A run is already active. Stop it first.');
  const queries = generateQueries(keywords, locations);
  if (!queries.length) throw new Error('Add at least one keyword.');
  if (queries.length > MAX_QUERIES) {
    throw new Error(`That creates ${queries.length} searches. The maximum per run is ${MAX_QUERIES}.`);
  }
  const now = Date.now();
  await db.transaction('rw', db.runs, db.jobs, async () => {
    const runId = await db.runs.add({
      status: 'running',
      statusReason: null,
      createdAt: now,
      finishedAt: null,
      activeMs: 0,
      segmentStartedAt: now,
      tabId: null,
      currentJobId: null,
      nextDispatchAt: 0,
      delayMultiplier: 1,
      cleanStreak: 0,
      coverageMisses: 0,
      rowsAttempted: 0,
      rowsParsed: 0,
      responsesUnreadable: 0,
      uniqueLeads: 0,
      duplicates: 0,
      searchesFinished: 0,
      captchas: 0,
    });
    await db.jobs.bulkAdd(
      queries.map(
        (query): Job => ({
          runId,
          query,
          status: 'pending',
          attempts: 0,
          startedAt: null,
          finishedAt: null,
          outcome: null,
          rows: 0,
          newLeads: 0,
          visibleCards: 0,
        }),
      ),
    );
  });
  await dispatchNext();
}

export async function pauseRun(): Promise<void> {
  const run = await getActiveRun();
  if (run?.status === 'running') await haltRun(run, 'paused', 'Paused by you.');
}

export async function resumeRun(): Promise<void> {
  const run = await getActiveRun();
  if (!run || run.status === 'running') return;
  await db.runs.update(run.id!, {
    status: 'running',
    statusReason: null,
    segmentStartedAt: Date.now(),
    nextDispatchAt: 0,
    currentJobId: null,
  });
  await dispatchNext();
}

export async function stopRun(): Promise<void> {
  const run = await getActiveRun();
  if (run) await haltRun(run, 'stopped', 'Stopped by you.');
}

export async function getAssignment(tabId: number | undefined): Promise<Assignment | null> {
  const run = await db.runs.where('status').equals('running').first();
  if (!run || run.tabId === null || run.tabId !== tabId || run.currentJobId === null) return null;
  const job = await db.jobs.get(run.currentJobId);
  return job?.status === 'running' ? { jobId: job.id!, query: job.query } : null;
}

function buildLead(business: MapsBusiness, run: Run, job: Job, now: number): Lead {
  const phone = normalizePhone(business.phoneRaw, business.country);
  const evidence = buildEvidence({
    business,
    phone,
    sitePhones: [],
    websiteLive: false,
    websiteParked: false,
    websiteMatch: false,
    emails: [],
  });
  const score = scoreEvidence(evidence);
  const social = isSocialHost(business.domain);
  return {
    ...business,
    phone,
    runId: run.id!,
    keyword: job.query,
    searchArea: searchAreaFrom(job.query),
    companyKeys: companyKeysFor({ domain: business.domain, phone, emails: [] }),
    collectedAt: now,
    emails: [],
    sitePhones: [],
    socials: social && business.domain?.includes('facebook') && business.website ? { facebook: business.website } : {},
    metaDescription: null,
    context: null,
    enrichStatus: business.website && !social ? 'pending' : 'skipped',
    enrichError: social ? 'Listed website is a social page' : null,
    evidence,
    score,
    tier: tierFor(score),
    deliveryStatus: 'pending',
    deliveryAttempts: 0,
    nextDeliveryAt: now,
  };
}

/** Stores new leads inside one transaction, so counters never drift from the data. */
export async function storeBusinesses(
  runId: number,
  jobId: number,
  businesses: MapsBusiness[],
  rowsAttempted: number,
  unreadable: boolean,
): Promise<void> {
  const added = await db.transaction('rw', db.runs, db.jobs, db.leads, async () => {
    const run = await db.runs.get(runId);
    const job = await db.jobs.get(jobId);
    if (!run || !job) return 0;
    const now = Date.now();
    let unique = 0;
    let duplicates = 0;
    for (const business of businesses) {
      const lead = buildLead(business, run, job, now);
      const samePlace = await db.leads.get(lead.placeId);
      const sameContact =
        !samePlace && lead.domain && lead.phone
          ? await db.leads.where('[domain+phone]').equals([lead.domain, lead.phone]).first()
          : undefined;
      if (samePlace || sameContact) {
        duplicates += 1;
        continue;
      }
      await db.leads.add(lead);
      unique += 1;
    }
    await db.jobs.update(jobId, {
      rows: job.rows + rowsAttempted,
      newLeads: job.newLeads + unique,
    });
    await db.runs.update(runId, {
      rowsAttempted: run.rowsAttempted + rowsAttempted,
      rowsParsed: run.rowsParsed + businesses.length,
      responsesUnreadable: run.responsesUnreadable + (unreadable ? 1 : 0),
      uniqueLeads: run.uniqueLeads + unique,
      duplicates: run.duplicates + duplicates,
      coverageMisses: rowsAttempted > 0 ? 0 : run.coverageMisses,
    });
    return unique;
  });
  if (added > 0) hooks.onLeadsAdded();
}

export async function handleCapture(tabId: number | undefined, jobId: number, body: string): Promise<void> {
  const run = await db.runs.where('status').equals('running').first();
  if (!run || run.tabId !== tabId || run.currentJobId !== jobId) return;

  const parsed = parseSearchResponse(body);
  await storeBusinesses(run.id!, jobId, parsed.businesses, parsed.rowsAttempted, !parsed.readable);

  const fresh = await db.runs.get(run.id!);
  if (!fresh) return;
  if (parseSuccessTooLow(fresh.rowsAttempted, fresh.rowsParsed)) {
    await stopForFormatChange(fresh, `Only ${fresh.rowsParsed} of ${fresh.rowsAttempted} results could be read.`);
  } else if (fresh.responsesUnreadable >= MAX_UNREADABLE_RESPONSES && fresh.rowsParsed === 0) {
    await stopForFormatChange(fresh, 'Google responses could not be decoded.');
  }
}

async function stopForFormatChange(run: Run, detail: string): Promise<void> {
  const message = `${detail} Google's format may have changed. Stopped to avoid saving bad data.`;
  await haltRun(run, 'stopped_parse', message);
  notify('Lead Scraper stopped', message);
}

export async function handleSearchDone(
  tabId: number | undefined,
  jobId: number,
  outcome: SearchOutcome,
  visibleCards: number,
  temporarilyClosedPlaceIds: string[],
): Promise<void> {
  const run = await db.runs.where('status').equals('running').first();
  if (!run || run.tabId !== tabId || run.currentJobId !== jobId) return;
  const job = await db.jobs.get(jobId);
  if (!job) return;

  for (const placeId of temporarilyClosedPlaceIds) {
    if (PLACE_ID_IN_URL.test(placeId)) {
      await db.leads.update(placeId, { businessStatus: 'temporarily_closed' });
    }
  }

  // Results on screen with none captured means the capture or parser has broken.
  const missed = visibleCards > 0 && job.rows === 0;
  const coverageMisses = missed ? run.coverageMisses + 1 : 0;
  await db.jobs.update(jobId, { status: 'done', outcome, visibleCards, finishedAt: Date.now() });

  if (coverageMisses >= COVERAGE_MISS_LIMIT) {
    await db.runs.update(run.id!, { coverageMisses, currentJobId: null });
    await stopForFormatChange(
      { ...run, coverageMisses, currentJobId: null },
      `${coverageMisses} searches in a row showed results that could not be captured.`,
    );
    return;
  }

  const slow = outcome === 'stalled' || outcome === 'timeout';
  const pace = slow ? afterSlow(run) : afterClean(run);
  const delay = nextDelayMs(pace.delayMultiplier);
  await db.runs.update(run.id!, {
    ...pace,
    coverageMisses,
    currentJobId: null,
    searchesFinished: run.searchesFinished + 1,
    nextDispatchAt: Date.now() + delay,
  });
  scheduleDispatch(delay);
}

export async function handleBlocked(run: Run): Promise<void> {
  if (run.status !== 'running') return;
  const pace = afterBlock(run);
  await haltRun(run, 'paused_blocked', 'Google is asking for a CAPTCHA. Solve it in the scraping window to continue.');
  await db.runs.update(run.id!, { ...pace, captchas: run.captchas + 1 });
  notify('Lead Scraper paused', 'Google is asking for a CAPTCHA. Solve it in the scraping window to continue.');
}

export async function handleTabUpdated(tabId: number, url: string | undefined): Promise<void> {
  if (!url) return;
  const run = await getActiveRun();
  if (!run || run.tabId !== tabId) return;
  if (isBlockedUrl(url)) {
    await handleBlocked(run);
  } else if (run.status === 'paused_blocked' && new URL(url).hostname.endsWith('google.com')) {
    await resumeRun();
  }
}

export async function handleTabRemoved(tabId: number): Promise<void> {
  const run = await getActiveRun();
  if (!run || run.tabId !== tabId) return;
  await db.runs.update(run.id!, { tabId: null });
  if (run.status === 'running') {
    await haltRun({ ...run, tabId: null }, 'paused', 'The scraping window was closed. Resume to continue.');
  }
}

/** Runs on an alarm, so progress continues after the service worker restarts. */
export async function watchdog(): Promise<void> {
  const active = await getActiveRun();
  if (!active) return;

  // Tab events can be missed while the worker restarts, so check the tab directly too.
  if (active.tabId !== null && active.status !== 'paused') {
    const tab = await chrome.tabs.get(active.tabId).catch(() => null);
    if (tab?.url) await handleTabUpdated(active.tabId, tab.url);
  }

  const run = await db.runs.where('status').equals('running').first();
  if (!run) return;
  if (run.currentJobId === null) {
    await dispatchNext();
    return;
  }
  const job = await db.jobs.get(run.currentJobId);
  if (!job?.startedAt || Date.now() - job.startedAt < STALE_JOB_MS) return;

  const failed = job.attempts >= MAX_JOB_ATTEMPTS;
  await db.jobs.update(job.id!, {
    status: failed ? 'failed' : 'pending',
    startedAt: null,
    finishedAt: failed ? Date.now() : null,
    outcome: failed ? 'timeout' : null,
  });
  await db.runs.update(run.id!, { currentJobId: null, nextDispatchAt: 0 });
  await dispatchNext();
}
