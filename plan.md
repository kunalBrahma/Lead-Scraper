# Lead Scraper: Project Plan

A Chrome extension that collects business leads from Google Maps with no API and no fees, finds emails on business websites, scores each lead, and sends the results to another agent.

Status: Phases 1, 2, 4, 5, and 6 are built, and automatic webhook delivery has been replaced by manual **Send to CRM**. CRM work is planned in `sitemakerlab/docs/lead-import/`. The first live test ran on 2026-11-02 (results below). Accuracy has not been checked by hand, and sustained speed has not been measured.

## Goals

- Collect thousands of leads per run with no limit set by the extension.
- Use only the user's own browser, with no paid API or server.
- Show how much evidence supports each lead through a confidence score.
- Resume after a crash, browser restart, or CAPTCHA pause without losing data.
- Deliver leads to an agent by webhook and by file export.

## Non-goals

- Automated CAPTCHA solving. The extension pauses and the user solves it manually.
- Fingerprint spoofing, proxy rotation, or other block evasion.
- Scraping behind a login.
- Copying Leads Sniper code. It informed the architecture only.
- Confirming that a specific mailbox exists. Browsers cannot open SMTP connections.

## Tech stack

| Area | Choice | Reason |
|---|---|---|
| Platform | Chrome extension, Manifest V3 | Required by the project; also loads in Edge |
| Framework | WXT | Handles the MV3 build, manifest, and hot reload |
| Language | TypeScript (strict) | The parser and message contracts need types |
| UI | React, Tailwind CSS | Side panel with live metrics |
| Storage | IndexedDB via Dexie | Large datasets; `chrome.storage` for settings only |
| Validation | Zod | Parser output and webhook payload contracts |
| HTML parsing | Cheerio | Works in a service worker, which has no `DOMParser` |
| Phone numbers | libphonenumber-js | Country-aware format validation |
| Email domains | DNS-over-HTTPS | Free MX lookups from the browser |
| File export | CSV and JSON by hand; XLSX with `write-excel-file` | Avoids the outdated `xlsx` package on npm |
| Tests | Vitest, Playwright | Fixture-based unit tests; end-to-end extension tests |
| Package manager | pnpm | Already installed |

## Architecture

```
Side panel (React)         keywords, filters, live metrics, export
      |
Service worker             job queue, pacing, enrichment, webhook delivery
      |
Maps content script        runs searches, scrolls results, detects blocks
      |
Page-world capture hook    reads the responses Maps already loaded
      |
IndexedDB                  jobs, leads, run reports
```

### Pipeline

1. **Generate:** combine keywords and locations into search jobs.
2. **Search:** open one Maps search in a dedicated tab or window.
3. **Scroll:** scroll the results list until it ends or stalls.
4. **Capture:** read Maps' own search responses from a page-world hook. Leads Sniper fetches each response a second time, which doubles traffic. This design avoids that.
5. **Parse:** convert response arrays into validated leads.
6. **Deduplicate:** match on Place ID, then domain and phone.
7. **Enrich:** crawl the homepage, contact, and about pages, reading JSON-LD, `mailto:`, `tel:`, and social links. Respect `robots.txt`.
8. **Verify and score:** run the checks below and record the reasons.
9. **Deliver:** send to the webhook with retries, and allow file export.

### Key design rules

- **One parser file:** all Maps array positions and CSS selectors live in `src/maps/fieldMap.ts`, so a Google change means one fix.
- **Persist before acting:** MV3 service workers can stop at any time, so all queue state lives in IndexedDB and `chrome.alarms` wakes the worker.
- **Separate queues:** website crawling runs independently, so slow sites do not hold up Maps collection.
- **Fail loudly:** falling parse success stops the run instead of saving bad data.
- **Least privilege:** website and webhook access use optional host permissions requested at runtime.

## Pacing and blocks

| Signal | Response |
|---|---|
| CAPTCHA or `/sorry` page | Stop at once, notify the user, resume at half speed after they solve it |
| Slow or empty results | Add longer pauses between searches |
| Parse success under 90% | Stop the run and flag a possible format change |
| Sustained clean run | Speed back up gradually to the configured maximum |

## Verification and scoring

| Evidence | Points |
|---|---|
| Active Maps listing with reviews | 25 |
| Website is live, not parked, and matches the business | 25 |
| Phone is valid and matches the website | 20 |
| Email is on the business's own site and domain, with an MX record | 30 |
| Or: email looks like the business's on another domain, such as Gmail, with an MX record | 15 |

| Score | Rating | Suggested use |
|---|---|---|
| 80-100 | High | Send straight to the agent |
| 50-79 | Medium | Verify further or use for calls |
| Under 50 | Low | Keep out of outreach |

These weights are a starting point. Change them based on audit results. The score measures evidence that a lead is real, not whether it fits your target, so use filters for fit.

## Filters

- **Business:** category, location, open or closed
- **Reputation:** minimum rating and review count, claimed or unclaimed
- **Contact:** must have phone, website, or email
- **Email:** business or free domain, role or named address
- **Quality:** minimum confidence score

## Metrics and targets

| Metric | Starting target |
|---|---|
| Unique leads per hour | 1,000+ |
| Duplicate rate | Under 30% |
| Parse success | Over 98% |
| Phone found | Over 80% |
| Website found | Over 60% |
| Email found, of leads with websites | 30-50% |
| Invalid email rate | Under 5% |
| CAPTCHAs per 100 searches | Under 1 |
| Webhook delivery | 100%, with retries |

### First live test (2026-11-02)

One keyword across 5 cities, in a 3.8-minute run. These figures are from the exported CSV, before the fixes that followed.

| Metric | Result |
|---|---|
| Unique leads | 448 |
| Burst speed | About 7,000 leads per hour, too short a run to treat as sustained |
| Phone found | 99.1% |
| Website found | 83.9% |
| Email found, of leads with websites | 47.3% |
| Phone area code fits the searched area | 98.6% |
| Within 100 km of the searched city | 98.9% |
| Main category matches the keyword | 95.5% |

Little Rock returned only 20 leads against 80-120 elsewhere, and the cause is unknown. **Search details** in the Run tab now shows how each search ended.

### Business context check (2026-11-02)

The crawler ran on 15 of those leads' websites, from a script rather than Chrome, so website failures may differ in the extension. Of the 15, 11 gave rich context, 1 had almost no readable text, and 3 did not load. Of the 11, 10 listed services, all had highlights, and 3 gave a contact name, only 1 of them high confidence.

### Dallas export (2026-11-02)

The first context run inside Chrome returned 116 leads with "One per company" on. Of 101 websites, 78 gave rich context, 19 gave none (8 returned 403), and 36.6% gave an email. Services and contact names had errors, which were then fixed and retested from a script on 32 of those sites.

### Accuracy audit

1. Check 100 random leads by hand across different cities and niches.
2. Target 95%+ for name and address, 90%+ for phone and website, and 85%+ for high-score emails.
3. Confirm high-score leads are clearly more accurate than medium ones.
4. Count emails the crawler missed.
5. Keep the checked leads as a regression set and rerun it after scraper changes.
6. Feed the agent's bounce and wrong-number results back into the scoring weights.

## Business context

For each website, the crawler reads the homepage and up to one contact, about, and services page. It saves a summary, about text, services, quoted highlights, a contact name, and website signals, each with its source page where possible.

- **Detected, never absent:** a missing chat widget means "not detected", since tools can load in ways this check cannot see.
- **Names:** only `high` confidence names are safe to greet by. A name reaches `high` when two sources agree, or when it matches the business name. A single founder mention can be historic, so it stays `medium`.
- **Services favor accuracy:** page headings and single-word labels are often dropped, so a real service can be missing. Don't treat a missing service as one the business doesn't offer.
- **Untrusted text:** website text is third-party content, so an AI writer must treat it as data and ignore any instructions in it.

## Agent integration

- **Webhook (primary):** POST each lead as JSON to a configured URL, including `localhost`, with retries and an idempotency key.
- **File export:** CSV, XLSX, and JSON.
- **Local server (later):** lets an agent start searches and read results.

Example lead payload:

```json
{
  "place_id": "ChIJ...",
  "name": "Example Plumbing",
  "phone": "+12145550100",
  "website": "https://example.com",
  "email": "info@example.com",
  "score": 85,
  "rating": "high",
  "evidence": { "website_match": true, "phone_match": true, "email_source": "/contact", "mx_valid": true }
}
```

## Phases

1. **Foundation:** WXT project, side panel shell, database schema, message contracts.
2. **Maps collection:** capture hook, parser, scrolling, deduplication, basic CSV export.
3. **Test run:** 5 real searches to measure speed, parse success, and blocking. Update this plan with the results.
4. **Job queue and pacing:** keyword and location generator, resume support, block handling, live metrics.
5. **Enrichment and scoring:** crawler, verification, confidence score, filters.
6. **Delivery:** webhook with retries, XLSX and JSON export.
7. **Accuracy audit:** 100-lead audit, regression set, and weight tuning.

## Risks

| Risk | Mitigation |
|---|---|
| Google changes its format | Single parser file, saved fixtures, automatic stop on parse failure |
| Google blocks or challenges the session | Conservative pacing, immediate pause, and a separate browser profile |
| Scraping breaks Google's terms | User accepts this risk; use a separate account or stay logged out |
| Service worker stops mid-run | Queue state in IndexedDB, wake-ups through alarms |
| Outreach law (CAN-SPAM, GDPR) | Keep each lead's data source and leave outreach compliance to the agent's operator |

## Known limits

- **Unverified Maps format:** the array positions, selectors, and `tbm=map` request filter have not been tested on live Google. Phase 3 checks them.
- **Single-result searches:** when Maps jumps straight to one business page, that business is not collected.
- **Mailboxes:** an MX record shows a domain can receive mail, not that a mailbox exists.
- **Email matching:** the check compares text, so it can flag a real owner's personal address, and can pass another franchise's address, such as a different region's.
- **Company grouping:** franchises on one domain count as one company, even when locally owned.
- **Temporarily closed:** this status comes from English card text, which is why searches request `hl=en`.

## Open decisions

- Test niche and city for Phase 3.
- The agent's webhook URL and tool.
