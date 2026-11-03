import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import { fakeResponse, fakeRow } from '../fixtures/mapsResponse';

/**
 * Runs the built extension in Chromium against a fake Maps page. All google.com traffic
 * is intercepted, so these tests never reach Google. They prove the extension's own
 * flow works, and cannot prove the real Maps page still behaves like this fake.
 */

const EXTENSION = path.resolve('output-e2e/chrome-mv3');
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

const CRM_KEY = 'slk_import_e2e_test_key';

interface CrmRequest {
  authorization: string | undefined;
  body: { client_batch_id: string; label: string | null; leads: { place_id: string; name: string }[] };
}

/** A stand-in CRM that records every request it receives. */
async function startFakeCrm() {
  const requests: CrmRequest[] = [];
  const state = { key: CRM_KEY, stored: new Set<string>() };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      requests.push({ authorization: req.headers.authorization, body });
      const reply = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.headers.authorization !== `Bearer ${state.key}`) return reply(401, { error: 'Unauthorized' });
      if (!body.leads?.length) return reply(400, { error: 'Invalid import request' });
      const created: string[] = [];
      const duplicates: unknown[] = [];
      for (const lead of body.leads) {
        if (state.stored.has(lead.place_id)) duplicates.push({ place_id: lead.place_id, reason: 'place_id', matched_place_id: lead.place_id });
        else {
          state.stored.add(lead.place_id);
          created.push(lead.place_id);
        }
      }
      reply(200, { batch_id: 'crm-batch', created, already_imported: [], duplicates, invalid: [], suppressed: [] });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://localhost:${port}`,
    requests,
    state,
    leadRequests: () => requests.filter((request) => request.body.leads?.length),
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function collectLeads(panel: Page) {
  await startRun(panel, 'plumber');
  await expect(status(panel)).toHaveText('Finished', { timeout: 90_000 });
  await panel.getByRole('tab', { name: 'Leads' }).click();
  await panel.getByRole('checkbox', { name: 'One per company' }).uncheck();
  await expect(panel.getByTestId('lead-count')).toHaveText('10 of 10 leads', { timeout: 10_000 });
}

async function saveCrmSettings(panel: Page, origin: string, key = CRM_KEY) {
  await panel.getByRole('tab', { name: 'Settings' }).click();
  await panel.getByLabel('CRM address').fill(origin);
  await panel.getByLabel('Import key').fill(key);
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(panel.getByRole('status')).toHaveText('Saved.');
}

test('sends nothing until clicked, then exactly the chosen leads', async () => {
  const crm = await startFakeCrm();
  const { panel, cleanup } = await launch();
  try {
    await collectLeads(panel);
    await expect(panel.getByText('Add your CRM address and import key in Settings')).toBeVisible();

    await saveCrmSettings(panel, crm.origin);
    // Long enough for the 30-second alarm to pass, proving a wake-up doesn't send.
    await panel.waitForTimeout(35_000);
    expect(crm.requests).toEqual([]);

    await panel.getByRole('button', { name: 'Test connection' }).click();
    await expect(panel.getByRole('status')).toContainText('Connected');
    expect(crm.requests).toHaveLength(1);
    expect(crm.leadRequests()).toEqual([]);

    await panel.getByRole('tab', { name: 'Leads' }).click();
    await panel.getByRole('checkbox', { name: 'One per company' }).uncheck();
    await panel.getByRole('button', { name: 'Send 10 leads to CRM' }).waitFor();

    // Filters decide what is sent when nothing is ticked.
    await panel.getByLabel('Search name, city, or category').fill('Business 0-');
    await panel.getByRole('button', { name: 'Send 5 leads to CRM' }).waitFor();
    expect(crm.leadRequests()).toEqual([]);

    // Ticks override the filters.
    await panel.getByRole('checkbox', { name: 'Business 0-1', exact: true }).check();
    await panel.getByRole('checkbox', { name: 'Business 0-3', exact: true }).check();
    await panel.getByLabel('Batch name (optional)').fill('Ticked leads');
    await panel.getByRole('button', { name: 'Send 2 leads to CRM' }).click();
    await expect(panel.getByTestId('send-status')).toHaveText('Send finished', { timeout: 15_000 });
    await expect(panel.getByTestId('send-results')).toContainText('2 added');

    expect(crm.leadRequests()).toHaveLength(1);
    const [first] = crm.leadRequests();
    expect(first!.authorization).toBe(`Bearer ${CRM_KEY}`);
    expect(first!.body.label).toBe('Ticked leads');
    expect(first!.body.leads.map((lead) => lead.name).sort()).toEqual(['Business 0-1', 'Business 0-3']);

    // Already sent leads are skipped, and the rest of the filter can follow.
    await panel.getByRole('button', { name: 'Send 3 leads to CRM' }).click();
    await expect(panel.getByTestId('send-results')).toContainText('3 added', { timeout: 15_000 });
    await expect(panel.getByRole('button', { name: 'Send 0 leads to CRM' })).toBeDisabled();
    const sentIds = crm.leadRequests().flatMap((request) => request.body.leads.map((lead) => lead.place_id));
    expect(new Set(sentIds).size).toBe(5);
    expect(sentIds).toHaveLength(5);

    // Sent status survives reopening the panel.
    await panel.reload();
    await panel.getByRole('tab', { name: 'Leads' }).click();
    await panel.getByRole('checkbox', { name: 'One per company' }).uncheck();
    await panel.getByLabel('CRM status').selectOption('sent');
    await expect(panel.getByTestId('lead-count')).toHaveText('5 of 10 leads');
    await expect(panel.getByTestId('crm-status').first()).toHaveText('Sent to CRM');
  } finally {
    await cleanup();
    await crm.stop();
  }
});

test('lets leads be sent again after switching to a different CRM', async () => {
  const local = await startFakeCrm();
  const live = await startFakeCrm();
  const { panel, cleanup } = await launch();
  try {
    await collectLeads(panel);
    await saveCrmSettings(panel, local.origin);
    await panel.getByRole('tab', { name: 'Leads' }).click();
    await panel.getByRole('checkbox', { name: 'One per company' }).uncheck();
    await panel.getByRole('button', { name: 'Send 10 leads to CRM' }).click();
    await expect(panel.getByTestId('send-status')).toHaveText('Send finished', { timeout: 15_000 });
    await expect(panel.getByRole('button', { name: 'Send 0 leads to CRM' })).toBeDisabled();

    await panel.getByRole('tab', { name: 'Settings' }).click();
    await panel.getByLabel('CRM address').fill(live.origin);
    await panel.getByRole('button', { name: 'Save' }).click();
    await expect(panel.getByRole('status')).toHaveText('Saved. 10 leads can now be sent to this CRM.');
    // Switching address sends nothing by itself.
    expect(live.requests).toEqual([]);

    await panel.getByRole('tab', { name: 'Leads' }).click();
    await panel.getByRole('checkbox', { name: 'One per company' }).uncheck();
    await panel.getByRole('button', { name: 'Send 10 leads to CRM' }).click();
    await expect(panel.getByTestId('send-results')).toContainText('10 added', { timeout: 15_000 });
    expect(live.leadRequests()).toHaveLength(1);
    expect(local.leadRequests()).toHaveLength(1);
  } finally {
    await cleanup();
    await local.stop();
    await live.stop();
  }
});

test('shows a wrong key, then resumes without resending', async () => {
  const crm = await startFakeCrm();
  const { panel, cleanup } = await launch();
  try {
    await collectLeads(panel);
    await saveCrmSettings(panel, crm.origin, 'wrong-key');
    await panel.getByRole('button', { name: 'Test connection' }).click();
    await expect(panel.getByRole('alert')).toContainText('rejected the import key');

    await panel.getByRole('tab', { name: 'Leads' }).click();
    await panel.getByRole('checkbox', { name: 'One per company' }).uncheck();
    await panel.getByRole('button', { name: 'Send 10 leads to CRM' }).click();
    await expect(panel.getByTestId('send-status')).toHaveText('Send stopped', { timeout: 15_000 });
    await expect(panel.getByTestId('send-job').getByRole('alert')).toContainText('rejected the import key');
    const pageText = await panel.locator('body').innerText();
    expect(pageText).not.toContain('wrong-key');

    await saveCrmSettings(panel, crm.origin);
    await panel.getByRole('tab', { name: 'Leads' }).click();
    await panel.getByRole('button', { name: 'Resume' }).click();
    await expect(panel.getByTestId('send-status')).toHaveText('Send finished', { timeout: 15_000 });
    await expect(panel.getByTestId('send-results')).toContainText('10 added');

    await panel.getByRole('checkbox', { name: 'One per company' }).uncheck();
    await expect(panel.getByRole('button', { name: 'Send 0 leads to CRM' })).toBeDisabled();
  } finally {
    await cleanup();
    await crm.stop();
  }
});
