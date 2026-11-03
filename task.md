# Tasks

Mark items `[x]` when done and verified. See `plan.md` for the design.

Verified means unit tests, or browser tests against a fake Maps page, unless a task says live. The first live run was on 2026-11-02.

## Phase 1: Foundation

- [x] Scaffold a WXT project with React, TypeScript (strict), and Tailwind
- [x] Set up Vitest and Playwright
- [x] Write the MV3 manifest with minimal permissions
- [x] Define the Dexie schema for jobs, leads, and run reports
- [x] Define typed message contracts between extension contexts
- [x] Build the side panel shell
- [x] Confirm the extension loads in Chromium
- [ ] Set up ESLint and Prettier

## Phase 2: Maps collection

- [x] Build the page-world hook that reads Maps search responses
- [x] Build `src/maps/fieldMap.ts` and the response parser
- [x] Validate parser output with Zod and count failures
- [x] Build scrolling with end-of-list and stall detection
- [x] Deduplicate by Place ID
- [x] Add a basic CSV export
- [x] Write parser unit tests against synthetic fixtures
- [ ] Save real Maps responses as test fixtures, with no personal test data

## Phase 3: Test run (live)

- [x] Choose the test niche and city
- [x] Run 5 real searches
- [x] Confirm `fieldMap.ts` matches the real format, by location and area-code checks on 448 leads
- [x] Record leads per hour and field fill rates
- [ ] Record parse success and CAPTCHAs from the Run tab
- [ ] Find out why Little Rock returned only 20 leads
- [ ] Measure sustained speed on a longer run

## Phase 4: Job queue and pacing

- [x] Build the keyword and location generator
- [x] Build a persistent job queue
- [x] Wake the service worker with `chrome.alarms`
- [x] Detect `/sorry` pages and pause with a notification
- [x] Build adaptive pacing from `plan.md`
- [x] Stop the run when parse success drops under 90%
- [x] Stop the run when results show on screen but none are captured
- [x] Show live metrics in the side panel
- [x] Keep each run's counters in the database
- [x] Test pause and resume
- [ ] Test resume after closing the tab and restarting the browser

## Phase 5: Enrichment and scoring

- [x] Request optional host permissions at runtime
- [x] Build a separate crawl queue with limited concurrency
- [x] Check `robots.txt` before crawling
- [x] Crawl homepage, contact, and about pages with a 10-second timeout
- [x] Extract JSON-LD, `mailto:`, `tel:`, text emails, and social links
- [x] Remove placeholder and junk emails
- [x] Keep both free and business emails, labeled by type
- [x] Validate phones with libphonenumber-js and compare them with the website
- [x] Detect parked and for-sale websites
- [x] Check MX records over DNS-over-HTTPS, with caching by domain
- [x] Deduplicate by place, then by domain and phone
- [x] Build the confidence score with recorded reasons
- [x] Build filters in the side panel
- [x] Write unit tests for extraction and scoring
- [x] Refuse private and local addresses when crawling
- [x] Run enrichment against real business websites (live)

## Phase 5b: Quality fixes from the first live run

- [x] Keep valid phone numbers free of a leading apostrophe in exports
- [x] Remove more placeholder emails
- [x] Check whether each email matches the business, with partial score credit
- [x] Group listings by company in filters, and send one per company to the webhook
- [x] Skip social pages listed as websites
- [x] Record why a website check failed, and allow rechecks
- [x] Add a search area field for businesses with no address
- [x] Add maximum reviews, main category, and multi-location filters
- [x] Show how each search ended in the Run tab
- [x] Upgrade leads already stored in the browser
- [ ] Confirm these fixes on a new live export

## Phase 5c: Business context for personalized email

- [x] Read one contact, about, and services page per website
- [x] Save summary, about text, services, highlights, and contact name with sources
- [x] Detect chat widgets, booking tools, contact forms, other tools, and platform
- [x] Rate each lead's context as rich, basic, or none
- [x] Add context to exports, the webhook payload, and the side panel
- [x] Collect context for leads already stored
- [x] Test extraction on 15 real websites and fix the errors found
- [x] Confirm collection inside Chrome (live, Dallas export: 78 of 101 sites rich)
- [x] Stop reading service-area pages and city links as services
- [x] Accept page headings as services only when they name a kind of work
- [x] Clean contact names, and raise confidence when a name matches the business name
- [x] Reject title-like summaries and repeated highlights
- [ ] Confirm these extraction fixes on a new Chrome export
- [ ] Test the older-lead upgrade and the Collect button, untested since a reinstall cleared stored leads

## Phase 6: Delivery

- [x] Choose an XLSX library
- [x] Add XLSX and JSON export
- [x] Neutralize spreadsheet formulas in exports
- [x] Define the webhook payload with Zod
- [x] Build webhook delivery with retries and idempotency keys
- [x] Track delivery status and allow resending failures
- [x] Add a test-webhook button
- [ ] Test delivery against your real agent or a local server

## Phase 7: Accuracy audit (needs live data)

- [ ] Audit 100 random leads by hand across cities and niches
- [ ] Record per-field accuracy and missed emails
- [ ] Confirm high-score leads beat medium ones, and tune weights if not
- [ ] Save the checked leads as a regression set
- [ ] Run a full test of 1,000+ leads and record the report

## Waiting on the user

- [ ] Test niche and city
- [ ] Agent webhook URL and tool
