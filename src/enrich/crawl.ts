import type { BusinessContext, Socials } from '@/lib/types';
import { extractPageContext, mergeContext, type PageContext } from './context';
import { extractPage, isParkedPage, siteMatchesBusiness } from './extract';
import { isPathAllowed, parseRobots } from './robots';

const PAGE_TIMEOUT_MS = 10_000;
const MAX_HTML_BYTES = 2_000_000;
const MAX_EXTRA_PAGES = 3;
const MIN_READABLE_TEXT = 100;

export interface FoundEmail {
  address: string;
  source: string;
}

export interface CrawlResult {
  live: boolean;
  parked: boolean;
  match: boolean;
  blockedByRobots: boolean;
  /** Why the site gave no usable data, or `null` when it did. */
  failure: string | null;
  pagesFetched: number;
  emails: FoundEmail[];
  phones: string[];
  socials: Socials;
  metaDescription: string | null;
  context: BusinessContext | null;
}

const EMPTY: CrawlResult = {
  live: false,
  parked: false,
  match: false,
  blockedByRobots: false,
  failure: null,
  pagesFetched: 0,
  emails: [],
  phones: [],
  socials: {},
  metaDescription: null,
  context: null,
};

/** Website values come from third parties, so local and private addresses are refused. */
export function isPublicWebUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
      return false;
    }
    if (!host.includes('.') && !host.includes(':')) return false;
    if (host.includes(':')) return !/^(::1?$|fc|fd|fe8|fe9|fea|feb)/.test(host);
    const octets = host.split('.').map(Number);
    if (octets.length === 4 && octets.every((o) => Number.isInteger(o))) {
      const [a = 0, b = 0] = octets;
      return !(
        a === 0 || a === 10 || a === 127 || a >= 224 ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 100 && b >= 64 && b <= 127)
      );
    }
    return true;
  } catch {
    return false;
  }
}

type FetchedPage = { html: string; finalUrl: string; failure?: undefined } | { failure: string };

function describeError(error: unknown): string {
  return error instanceof Error && error.name === 'TimeoutError' ? 'Website timed out' : 'Could not connect to website';
}

async function fetchHtml(url: string, fetcher: typeof fetch): Promise<FetchedPage> {
  const response = await fetcher(url, {
    credentials: 'omit',
    redirect: 'follow',
    referrerPolicy: 'no-referrer',
    headers: { accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
  });
  if (!response.ok) return { failure: `Website returned ${response.status}` };
  if (!isPublicWebUrl(response.url || url)) return { failure: 'Website redirected to a private address' };
  if (!(response.headers.get('content-type') ?? '').includes('html')) return { failure: 'Website is not an HTML page' };
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_HTML_BYTES) return { failure: 'Website page is too large' };
  const html = await response.text();
  return { html: html.slice(0, MAX_HTML_BYTES), finalUrl: response.url || url };
}

type RobotsCheck = (path: string) => boolean;

async function loadRobots(origin: string, fetcher: typeof fetch): Promise<RobotsCheck> {
  try {
    const response = await fetcher(`${origin}/robots.txt`, {
      credentials: 'omit',
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
    if (response.status >= 500) return () => false;
    if (!response.ok) return () => true;
    const rules = parseRobots(await response.text());
    return (path) => isPathAllowed(rules, path);
  } catch {
    // An unreachable robots.txt usually means the site is down, and the page fetch will show it.
    return () => true;
  }
}

export async function crawlWebsite(
  website: string,
  businessName: string,
  domain: string | null,
  fetcher: typeof fetch = fetch,
): Promise<CrawlResult> {
  if (!isPublicWebUrl(website)) return { ...EMPTY, failure: 'Website address is not public' };
  const allowed = await loadRobots(new URL(website).origin, fetcher);
  const start = new URL(website);
  if (!allowed(start.pathname + start.search)) {
    return { ...EMPTY, blockedByRobots: true, failure: 'Blocked by robots.txt' };
  }

  let fetched: FetchedPage;
  try {
    fetched = await fetchHtml(website, fetcher);
  } catch (error) {
    fetched = { failure: describeError(error) };
  }
  if (fetched.failure !== undefined) return { ...EMPTY, failure: fetched.failure };
  const home = fetched;

  const homePage = extractPage(home.html, home.finalUrl);
  const result: CrawlResult = {
    ...EMPTY,
    live: true,
    parked: isParkedPage(homePage),
    match: siteMatchesBusiness(businessName, domain, homePage),
    pagesFetched: 1,
    phones: [...homePage.phones],
    socials: { ...homePage.socials },
    metaDescription: homePage.metaDescription,
    emails: homePage.emails.map((address) => ({
      address,
      source: new URL(home.finalUrl).pathname,
    })),
  };
  if (result.parked) {
    return { ...result, emails: [], phones: [], socials: {}, match: false, failure: 'Website is parked or for sale' };
  }
  if (homePage.text.length < MIN_READABLE_TEXT && !homePage.emails.length) {
    result.failure = 'Website has little readable text, and may need JavaScript';
  }

  const pageOrder = ['contact', 'about', 'services'];
  const extraPages = homePage.pageLinks
    .filter((link) => {
      const url = new URL(link.url);
      return link.url !== home.finalUrl && allowed(url.pathname + url.search);
    })
    .sort((a, b) => pageOrder.indexOf(a.kind) - pageOrder.indexOf(b.kind))
    .slice(0, MAX_EXTRA_PAGES);

  const pageContexts: PageContext[] = [extractPageContext(home.html, home.finalUrl, 'home')];
  for (const link of extraPages) {
    try {
      const page = await fetchHtml(link.url, fetcher);
      if (page.failure !== undefined) continue;
      const extract = extractPage(page.html, page.finalUrl);
      result.pagesFetched += 1;
      pageContexts.push(extractPageContext(page.html, page.finalUrl, link.kind));
      result.phones.push(...extract.phones);
      result.socials = { ...extract.socials, ...result.socials };
      const source = new URL(page.finalUrl).pathname;
      for (const address of extract.emails) {
        if (!result.emails.some((email) => email.address === address)) {
          result.emails.push({ address, source });
        }
      }
      result.match ||= siteMatchesBusiness(businessName, domain, extract);
    } catch {
      // One failed page should not lose what the others found.
    }
  }

  result.phones = [...new Set(result.phones)];
  result.context = mergeContext(pageContexts, result.emails.map((email) => email.address), businessName);
  return result;
}
