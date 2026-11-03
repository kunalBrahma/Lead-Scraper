import { load, type CheerioAPI } from 'cheerio/slim';
import type { Socials } from '@/lib/types';
import { SERVICE_AREA } from './context';
import { cleanEmail, EMAIL_PATTERN } from './emails';

export interface PageExtract {
  title: string;
  metaDescription: string | null;
  text: string;
  emails: string[];
  phones: string[];
  socials: Socials;
  /** Same-origin pages worth crawling next, at most one of each kind. */
  pageLinks: { url: string; kind: 'contact' | 'about' | 'services' }[];
}

const LINK_KINDS = [
  { kind: 'contact', pattern: /(contact|kontakt|get-in-touch|reach-us)/i },
  { kind: 'about', pattern: /(about|our-story|who-we-are|our-team|\bteam\b|impressum|meet-)/i },
  { kind: 'services', pattern: /(services?|what-we-do)/i },
] as const;

const SOCIAL_RULES: { key: keyof Socials; host: RegExp; reject: RegExp }[] = [
  { key: 'facebook', host: /(^|\.)facebook\.com$/, reject: /\/(sharer|share|dialog|plugins)/ },
  { key: 'instagram', host: /(^|\.)instagram\.com$/, reject: /\/(p|reel|share)\// },
  { key: 'linkedin', host: /(^|\.)linkedin\.com$/, reject: /\/share/ },
  { key: 'twitter', host: /(^|\.)(twitter|x)\.com$/, reject: /\/(intent|share)/ },
  { key: 'youtube', host: /(^|\.)youtube\.com$/, reject: /\/(watch|embed)/ },
];

function addSocial(socials: Socials, href: string): void {
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
    for (const rule of SOCIAL_RULES) {
      if (rule.host.test(url.hostname) && !rule.reject.test(url.pathname) && url.pathname.length > 1) {
        socials[rule.key] ??= url.href;
      }
    }
  } catch {
    // Unparseable links are ignored.
  }
}

function collectJsonLd(node: unknown, emails: Set<string>, phones: Set<string>, socials: Socials): void {
  if (Array.isArray(node)) {
    node.forEach((child) => collectJsonLd(child, emails, phones, socials));
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    const name = key.toLowerCase();
    if (name === 'email' && typeof value === 'string') {
      const email = cleanEmail(value);
      if (email) emails.add(email);
    } else if (name === 'telephone' && typeof value === 'string') {
      phones.add(value);
    } else if (name === 'sameas') {
      (Array.isArray(value) ? value : [value]).forEach((link) => {
        if (typeof link === 'string') addSocial(socials, link);
      });
    } else if (value && typeof value === 'object') {
      collectJsonLd(value, emails, phones, socials);
    }
  }
}

function bodyText($: CheerioAPI): string {
  $('head, script, style, noscript, template').remove();
  // Adjacent elements would otherwise merge, as in `<p>a@b.com</p><p>Call</p>`.
  $('*').each((_, element) => {
    $(element).prepend(' ').append(' ');
  });
  // This parser adds no implied <body>, and HTML allows pages to omit the tag.
  const body = $('body');
  const content = body.length ? body.text() : $.root().text();
  return content.replace(/\s+/g, ' ').trim();
}

export function extractPage(html: string, pageUrl: string): PageExtract {
  const $ = load(html);
  const emails = new Set<string>();
  const phones = new Set<string>();
  const socials: Socials = {};
  const links = new Map<'contact' | 'about' | 'services', string>();
  const base = new URL(pageUrl);

  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      collectJsonLd(JSON.parse($(element).text()), emails, phones, socials);
    } catch {
      // Malformed structured data is common on the web.
    }
  });

  $('a[href]').each((_, element) => {
    const href = $(element).attr('href')?.trim();
    if (!href) return;
    const lower = href.toLowerCase();
    if (lower.startsWith('mailto:')) {
      let decoded = href;
      try {
        decoded = decodeURIComponent(href);
      } catch {
        // Keep the raw value when it has invalid escapes.
      }
      const email = cleanEmail(decoded);
      if (email) emails.add(email);
    } else if (lower.startsWith('tel:')) {
      phones.add(href.slice(4));
    } else {
      addSocial(socials, href);
      try {
        const url = new URL(href, base);
        url.hash = '';
        const label = $(element).text();
        const isAreaPage = SERVICE_AREA.test(url.pathname) || SERVICE_AREA.test(label);
        if (url.origin === base.origin && url.href !== base.href && !isAreaPage) {
          for (const { kind, pattern } of LINK_KINDS) {
            if (!links.has(kind) && (pattern.test(url.pathname) || pattern.test(label))) {
              links.set(kind, url.href);
              break;
            }
          }
        }
      } catch {
        // Unparseable links are ignored.
      }
    }
  });

  const title = $('title').first().text().trim();
  const metaDescription = $('meta[name="description"]').attr('content')?.trim() || null;
  const text = bodyText($);
  for (const match of text.match(EMAIL_PATTERN) ?? []) {
    const email = cleanEmail(match);
    if (email) emails.add(email);
  }

  return {
    title,
    metaDescription,
    text,
    emails: [...emails],
    phones: [...phones],
    socials,
    pageLinks: [...links].map(([kind, url]) => ({ kind, url })),
  };
}

const PARKED_PATTERNS = [
  /this domain (name )?is for sale/i,
  /buy this domain/i,
  /domain (name )?(may be|is) for sale/i,
  /parked (free,? )?(courtesy of|by|domain)/i,
  /this (web)?site can.?t be reached/i,
  /account (has been )?suspended/i,
  /website coming soon|under construction/i,
  /sedo(parking)?\.com|hugedomains|dan\.com|afternic/i,
];

export function isParkedPage(page: Pick<PageExtract, 'title' | 'text'>): boolean {
  const sample = `${page.title} ${page.text.slice(0, 3000)}`;
  return PARKED_PATTERNS.some((pattern) => pattern.test(sample));
}

const NAME_STOP_WORDS = new Set([
  'the', 'and', 'of', 'inc', 'llc', 'ltd', 'co', 'corp', 'company', 'services', 'service', 'group',
  'in', 'at', 'for', 'pvt', 'limited',
]);

function nameTokens(value: string): string[] {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1 && !NAME_STOP_WORDS.has(token));
}

/** True when most distinctive words of the business name appear in the site's domain, title, or text. */
export function siteMatchesBusiness(
  name: string,
  domain: string | null,
  page: Pick<PageExtract, 'title' | 'text'>,
): boolean {
  const tokens = nameTokens(name);
  if (!tokens.length) return false;
  const haystack = `${domain ?? ''} ${page.title} ${page.text}`
    .toLowerCase()
    .normalize('NFKD');
  const found = tokens.filter((token) => haystack.includes(token)).length;
  return found / tokens.length >= 0.6;
}
