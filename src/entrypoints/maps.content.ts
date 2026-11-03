import { HOOK_SOURCE, type Assignment, type HookMessage, type WorkerMessage } from '@/lib/messages';
import type { SearchOutcome } from '@/lib/types';
import { PLACE_ID_IN_URL, SELECTORS, TEXT } from '@/maps/fieldMap';

const FEED_TIMEOUT_MS = 15_000;
const STALL_MS = 20_000;
const SEARCH_TIMEOUT_MS = 5 * 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const randomBetween = (min: number, max: number) => min + Math.random() * (max - min);

function send(message: WorkerMessage): Promise<unknown> {
  return chrome.runtime.sendMessage(message);
}

function reachedEnd(feed: Element): boolean {
  return Boolean(document.querySelector(SELECTORS.endOfList)) || (feed.textContent ?? '').includes(TEXT.endOfList);
}

function visibleCards(): number {
  return document.querySelectorAll(SELECTORS.resultLink).length;
}

function temporarilyClosedPlaceIds(): string[] {
  const ids: string[] = [];
  document.querySelectorAll<HTMLElement>(SELECTORS.resultCard).forEach((card) => {
    if (!card.textContent?.includes(TEXT.temporarilyClosed)) return;
    const href = card.querySelector<HTMLAnchorElement>(SELECTORS.resultLink)?.href ?? '';
    const id = href.match(PLACE_ID_IN_URL)?.[0];
    if (id) ids.push(id);
  });
  return ids;
}

async function waitForFeed(): Promise<Element | null> {
  const deadline = Date.now() + FEED_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const feed = document.querySelector(SELECTORS.feed);
    if (feed) return feed;
    if (location.pathname.includes('/maps/place/')) return null;
    await sleep(250);
  }
  return null;
}

/** The first results are embedded in the page, so re-running the search makes Maps request them. */
function clickSearchButton(): void {
  for (const selector of SELECTORS.searchButton) {
    const button = document.querySelector<HTMLElement>(selector);
    if (button) {
      button.click();
      return;
    }
  }
}

async function scrollFeed(initialFeed: Element): Promise<SearchOutcome> {
  const startedAt = Date.now();
  let lastCount = visibleCards();
  let lastProgressAt = Date.now();

  while (Date.now() - startedAt < SEARCH_TIMEOUT_MS) {
    // Re-running the search can replace the list element.
    const feed = document.querySelector(SELECTORS.feed) ?? initialFeed;
    if (reachedEnd(feed)) return 'end_of_list';
    feed.scrollBy({ top: randomBetween(500, 900), behavior: 'auto' });
    await sleep(randomBetween(400, 800));

    const count = visibleCards();
    if (count > lastCount) {
      lastCount = count;
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt > STALL_MS) {
      return 'stalled';
    }
  }
  return 'timeout';
}

export default defineContentScript({
  matches: ['https://www.google.com/maps/*'],
  runAt: 'document_start',
  async main() {
    let assignment: Assignment | null | undefined;
    const buffered: string[] = [];

    window.addEventListener('message', (event: MessageEvent<HookMessage>) => {
      if (event.source !== window || event.origin !== location.origin) return;
      if (event.data?.source !== HOOK_SOURCE || typeof event.data.body !== 'string') return;
      if (assignment === undefined) buffered.push(event.data.body);
      else if (assignment) void send({ type: 'CAPTURED', jobId: assignment.jobId, body: event.data.body });
    });

    assignment = (await send({ type: 'GET_ASSIGNMENT' })) as Assignment | null;
    // Normal Maps use is not assigned a job, so nothing is captured or kept.
    if (!assignment) {
      buffered.length = 0;
      return;
    }
    const jobId = assignment.jobId;
    await Promise.all(buffered.splice(0).map((body) => send({ type: 'CAPTURED', jobId, body })));

    if (document.readyState === 'loading') {
      await new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
    }

    const feed = await waitForFeed();
    if (!feed) {
      const outcome: SearchOutcome = location.pathname.includes('/maps/place/') ? 'single_place' : 'no_results';
      await send({ type: 'SEARCH_DONE', jobId, outcome, visibleCards: 0, temporarilyClosedPlaceIds: [] });
      return;
    }

    clickSearchButton();
    await sleep(randomBetween(1_000, 2_000));
    const outcome = await scrollFeed(feed);
    // Late responses need a moment to reach the service worker.
    await sleep(1_500);
    await send({
      type: 'SEARCH_DONE',
      jobId,
      outcome,
      visibleCards: visibleCards(),
      temporarilyClosedPlaceIds: temporarilyClosedPlaceIds(),
    });
  },
});
