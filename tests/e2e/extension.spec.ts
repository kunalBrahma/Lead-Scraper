import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import { fakeResponse, fakeRow } from '../fixtures/mapsResponse';

/**
 * Runs the built extension in Chromium against a fake Maps page. All google.com traffic
 * is intercepted, so these tests never reach Google. They prove the extension's own
 * flow works, and cannot prove the real Maps page still behaves like this fake.
 */

const EXTENSION = path.resolve('output/chrome-mv3');
const PER_PAGE = 5;
const PAGES = 2;

const FAKE_MAPS = String.raw`<!doctype html><title>Fake Maps</title>
<button id="searchbox-searchbutton">Search</button>
<div role="feed" style="height:300px;overflow:auto"></div>
<script>
  const feed = document.querySelector('[role=feed]');
  const pages = ${PAGES};
  let page = 0, loading = false;
  const load = () => {
    if (loading || page >= pages) return;
    loading = true;
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/search?tbm=map&pb=' + page + '&q=' + encodeURIComponent(location.pathname));
    xhr.onload = () => {
      for (let i = 0; i < ${PER_PAGE}; i++) {
        const card = document.createElement('div');
        card.setAttribute('jsaction', 'x');
        card.style.height = '120px';
        card.innerHTML = '<a class="hfpxzc" href="https://www.google.com/maps/place/x">Card</a>';
        feed.append(card);
      }
      page += 1;
      loading = false;
      if (page >= pages) {
        const end = document.createElement('div');
        end.className = 'HlvSq';
        end.textContent = "You've reached the end of the list.";
        feed.append(end);
      }
    };
    xhr.send();
  };
  document.querySelector('#searchbox-searchbutton').addEventListener('click', load);
  feed.addEventListener('scroll', load);
</script>`;

interface Scenario {
  /** Replaces every search response, to simulate a Google format change. */
  searchBody?: () => string;
  /** Sends this search's first visit to the block page. */
  blockQuery?: string;
}

async function launch(scenario: Scenario = {}) {
  const profile = mkdtempSync(path.join(tmpdir(), 'lead-scraper-e2e-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  let blocked = false;
  const seenQueries: string[] = [];

  await context.route('https://www.google.com/**', async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/maps/search/')) {
      const query = decodeURIComponent(url.pathname.split('/')[3] ?? '');
      seenQueries.push(query);
      if (scenario.blockQuery === query && !blocked) {
        blocked = true;
        // A page redirect, because Playwright stalls on fulfilled 302s in new windows.
        await route.fulfill({
          contentType: 'text/html',
          body: "<script>location.replace('https://www.google.com/sorry/index')</script>",
        });
        return;
      }
      await route.fulfill({ contentType: 'text/html', body: FAKE_MAPS });
    } else if (url.pathname === '/search') {
      const query = url.searchParams.get('q') ?? '';
      const page = url.searchParams.get('pb') ?? '0';
      const rows = Array.from({ length: PER_PAGE }, (_, i) =>
        fakeRow({
          placeId: `ChIJ${encodeURIComponent(query)}-${page}-${i}`,
          name: `Business ${page}-${i}`,
          phone: '(213) 373-4253',
        }),
      );
      await route.fulfill({ contentType: 'application/json', body: scenario.searchBody?.() ?? fakeResponse(rows) });
    } else if (url.pathname.startsWith('/sorry')) {
      await route.fulfill({ contentType: 'text/html', body: '<title>Sorry</title><div data-sitekey="x"></div>' });
    } else {
      await route.fulfill({ contentType: 'text/html', body: '<title>Google</title>' });
    }
  });

  let worker = context.serviceWorkers()[0];
  worker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  return {
    context,
    panel,
    seenQueries,
    cleanup: async () => {
      await context.close();
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

async function startRun(panel: Page, keywords: string) {
  await panel.getByLabel('Keywords, one per line').fill(keywords);
  await panel.getByRole('checkbox', { name: /Find emails/ }).uncheck();
  await panel.getByRole('button', { name: 'Start' }).click();
}

const status = (panel: Page) => panel.getByTestId('run-status');

function tabWithUrl(context: BrowserContext, fragment: string): Page | undefined {
  return context.pages().find((page) => page.url().includes(fragment));
}

test('collects leads across searches, deduplicates, and exports CSV', async () => {
  const { panel, seenQueries, cleanup } = await launch();
  try {
    await startRun(panel, 'plumber\nroofer');
    await expect(status(panel)).toHaveText('Finished', { timeout: 90_000 });
    expect(seenQueries).toEqual(['plumber', 'roofer']);

    await panel.getByText('Search details').click();
    await expect(panel.getByTestId('search-row')).toHaveCount(2);
    await expect(panel.getByTestId('search-row').first()).toContainText('Reached end · 10 captured of 10 shown');

    await panel.getByRole('tab', { name: 'Leads' }).click();
    // 2 searches × 2 pages × 5 rows. All share one phone, so they group as one company by default.
    await expect(panel.getByTestId('lead-count')).toHaveText('1 of 20 leads', { timeout: 10_000 });
    await panel.getByRole('checkbox', { name: 'One per company' }).uncheck();
    await expect(panel.getByTestId('lead-count')).toHaveText('20 of 20 leads');

    const [download] = await Promise.all([
      panel.waitForEvent('download'),
      panel.getByRole('button', { name: 'csv' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^leads-.*\.csv$/);

    const [xlsx] = await Promise.all([
      panel.waitForEvent('download'),
      panel.getByRole('button', { name: 'xlsx' }).click(),
    ]);
    expect(xlsx.suggestedFilename()).toMatch(/\.xlsx$/);
  } finally {
    await cleanup();
  }
});

test('pauses on a CAPTCHA page and resumes once it is cleared', async () => {
  const { context, panel, seenQueries, cleanup } = await launch({ blockQuery: 'blocked' });
  try {
    await startRun(panel, 'blocked\nafter');
    await expect(status(panel)).toHaveText('Waiting for CAPTCHA', { timeout: 30_000 });
    // Pausing means no further searches run while blocked.
    expect(seenQueries).toEqual(['blocked']);

    // Stands in for the user solving the challenge, which redirects back to Maps.
    const sorry = tabWithUrl(context, '/sorry');
    expect(sorry).toBeDefined();
    await sorry!.goto('https://www.google.com/');

    await expect(status(panel)).toHaveText('Finished', { timeout: 90_000 });
    expect(seenQueries).toEqual(['blocked', 'blocked', 'after']);
    await expect(panel.getByLabel('Current run').getByText('CAPTCHAs per 100 searches')).toBeVisible();
  } finally {
    await cleanup();
  }
});

test('stops instead of saving bad data when the format changes', async () => {
  // Rows that no longer have names, as if Google moved the fields.
  const broken = fakeResponse(Array.from({ length: 25 }, (_, i) => fakeRow({ placeId: `ChIJ${i}` })));
  const { panel, cleanup } = await launch({ searchBody: () => broken });
  try {
    await startRun(panel, 'plumber');
    await expect(status(panel)).toHaveText('Stopped: format problem', { timeout: 30_000 });
    await panel.getByRole('tab', { name: 'Leads' }).click();
    await expect(panel.getByTestId('lead-count')).toHaveText('0 of 0 leads');
  } finally {
    await cleanup();
  }
});

test('stops when results show on screen but none are captured', async () => {
  // Readable but empty responses, as if Google moved the result list.
  const empty = fakeResponse([]);
  const { panel, cleanup } = await launch({ searchBody: () => empty });
  try {
    await startRun(panel, 'one\ntwo\nthree\nfour');
    await expect(status(panel)).toHaveText('Stopped: format problem', { timeout: 90_000 });
    await expect(panel.getByLabel('Current run')).toContainText('could not be captured');
  } finally {
    await cleanup();
  }
});

test('pause stops new searches, and resume finishes the run', async () => {
  const { panel, seenQueries, cleanup } = await launch();
  try {
    await startRun(panel, 'first\nsecond');
    await expect(status(panel)).toHaveText('Running');
    await panel.getByRole('button', { name: 'Pause' }).click();
    await expect(status(panel)).toHaveText('Paused');
    await panel.getByRole('button', { name: 'Resume' }).click();
    await expect(status(panel)).toHaveText('Finished', { timeout: 90_000 });
    expect(new Set(seenQueries)).toEqual(new Set(['first', 'second']));
  } finally {
    await cleanup();
  }
});

test('normal Maps browsing is not captured when no run is active', async () => {
  const { context, panel, cleanup } = await launch();
  try {
    const maps = await context.newPage();
    await maps.goto('https://www.google.com/maps/search/coffee/');
    await maps.locator('#searchbox-searchbutton').click();
    await maps.waitForTimeout(1_500);
    await panel.getByRole('tab', { name: 'Leads' }).click();
    await expect(panel.getByTestId('lead-count')).toHaveText('0 of 0 leads');
  } finally {
    await cleanup();
  }
});
