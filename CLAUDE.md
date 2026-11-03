# Lead Scraper

Chrome MV3 extension that collects business leads from Google Maps, enriches them from business websites, scores them, and delivers them to another agent. Read `plan.md` for the design and `task.md` for current progress.

## Stack

WXT, TypeScript (strict), React, Tailwind, Dexie, Zod, Cheerio, libphonenumber-js, Vitest, Playwright, and pnpm.

## Commands

- `pnpm dev`: run the extension with hot reload
- `pnpm build`: build for production into `output/chrome-mv3`. Keep this path stable, because Chrome ties stored leads to it
- `pnpm test`: run unit tests
- `pnpm compile`: type-check
- `pnpm test:e2e`: build and run browser tests against a fake Maps page

## Hard rules

- **No CAPTCHA solving:** on a CAPTCHA or `/sorry` page, stop and wait for the user. Never add solving services.
- **No block evasion:** no fingerprint spoofing or proxy rotation.
- **No Leads Sniper code:** reimplement behavior independently. Never copy from recovered source.
- **No hardcoded secrets:** the webhook URL and any tokens come from user settings.
- **Respect `robots.txt`** when crawling business websites.
- **Keep lead data local:** it leaves the browser only through the user's configured webhook or export.

## Architecture rules

- All Maps array positions and CSS selectors live in `src/maps/fieldMap.ts`. Never put them anywhere else.
- Validate parsed leads with Zod. Count failures and never save invalid leads silently.
- MV3 service workers can stop at any time. Keep queue and run state in IndexedDB, never only in memory, and use `chrome.alarms` rather than long timers.
- Use `chrome.storage` for settings only. Leads and jobs go in Dexie.
- Keep the crawl queue separate from Maps collection.
- Request the narrowest permissions possible, using optional host permissions for websites and webhooks.
- Treat scraped HTML as untrusted. Never inject it into the UI as HTML or execute it, and label it as data wherever it reaches an AI.

## Testing

- Parser and extraction tests use saved fixtures, not live Google requests.
- Remove personal data from fixtures before committing them.
- Run `pnpm test` and `pnpm compile` before marking a task done.
- Automated tests never hit live Google. Live runs are deliberate and limited, following Phase 3.

## Reporting results

- Label speed and accuracy figures as estimates until measured, and keep measured results in `plan.md`.
- A lead score shows supporting evidence. Never describe a lead or mailbox as confirmed real unless it was actually confirmed.

## Workflow

- Work through `task.md` in order and mark tasks only when verified.
- Update `plan.md` when a design decision changes.
