import { load, type CheerioAPI } from 'cheerio/slim';
import type {
  BusinessContext,
  ContactName,
  ContextHighlight,
  ContextLevel,
  WebsiteSignals,
} from '@/lib/types';

export type PageKind = 'home' | 'contact' | 'about' | 'services';

export interface PageContext {
  source: string;
  kind: PageKind;
  https: boolean;
  description: string | null;
  paragraphs: string[];
  services: string[];
  highlights: ContextHighlight[];
  names: ContactName[];
  signals: WebsiteSignals;
}

const MAX_SERVICES = 12;
const MAX_HIGHLIGHTS = 6;
const MAX_SUMMARY = 300;
const MAX_ABOUT = 700;
const MAX_HIGHLIGHT_TEXT = 200;
const MIN_HIGHLIGHT_WORDS = 3;

const CHAT_WIDGETS: [string, RegExp][] = [
  ['Tawk.to', /tawk\.to/i],
  ['Intercom', /widget\.intercom\.io|intercomcdn/i],
  ['Drift', /js\.driftt\.com|drift\.com\/include/i],
  ['Crisp', /client\.crisp\.chat/i],
  ['Tidio', /code\.tidio\.co/i],
  ['LiveChat', /cdn\.livechatinc\.com/i],
  ['Zendesk', /static\.zdassets\.com/i],
  ['Podium', /connect\.podium\.com|podium\.com\/widget/i],
  ['Birdeye', /birdeye\.com\/embed|birdeye-widgets/i],
  ['Freshchat', /wchat\.freshchat\.com/i],
  ['Olark', /static\.olark\.com/i],
  ['Smartsupp', /smartsuppchat\.com/i],
  ['Ngage', /engage\.ngagelive|ngagelive\.com/i],
  ['Apex Chat', /apexchat\.(com|net)/i],
  ['LeadConnector chat', /widgets\.leadconnectorhq\.com/i],
];

const BOOKING_TOOLS: [string, RegExp][] = [
  ['ServiceTitan', /servicetitan|st-scheduler|scheduler\.st\.dev/i],
  ['Housecall Pro', /housecallpro/i],
  ['Jobber', /getjobber\.com/i],
  ['Calendly', /calendly\.com/i],
  ['Acuity', /acuityscheduling\.com/i],
  ['Square Appointments', /squareup\.com\/appointments|square\.site\/book/i],
  ['Setmore', /setmore\.com/i],
  ['Vagaro', /vagaro\.com/i],
  ['Schedule Engine', /scheduleengine/i],
];

const OTHER_TOOLS: [string, RegExp][] = [
  ['HubSpot', /js\.hs-scripts\.com|hubspot\.com/i],
  ['GoHighLevel', /leadconnectorhq\.com|msgsndr\.com/i],
  ['ActiveCampaign', /trackcmp\.net|activehosted\.com/i],
  ['Mailchimp', /chimpstatic\.com|list-manage\.com/i],
  ['Klaviyo', /klaviyo\.com/i],
  ['Salesforce', /pardot\.com|salesforce\.com/i],
  ['Google Analytics', /googletagmanager\.com\/gtag|google-analytics\.com|gtag\('config'/i],
  ['Google Tag Manager', /googletagmanager\.com\/gtm/i],
  ['Meta Pixel', /connect\.facebook\.net\/[^"']*fbevents/i],
  ['CallRail', /callrail\.com/i],
];

const PLATFORMS: [string, RegExp][] = [
  ['WordPress', /wp-content|wp-includes/i],
  ['Wix', /static\.wixstatic\.com|wix-code/i],
  ['Squarespace', /static1\.squarespace\.com|squarespace-cdn/i],
  ['Weebly', /weebly\.com/i],
  ['GoDaddy', /img1\.wsimg\.com|godaddy website builder/i],
  ['Shopify', /cdn\.shopify\.com/i],
  ['Webflow', /assets\.website-files\.com|cdn\.prod\.website-files\.com/i],
  ['Duda', /multiscreensite\.com|irp\.cdn-website\.com/i],
  ['B12', /b12\.io|b12sites/i],
];

const BOOKING_LABEL = /\b(book|schedule)\s+(now|online|an?\s+appointment|your\s+\w+\s*(appointment|service)?|service|appointment)\b/i;

const HIGHLIGHT_RULES: [string, RegExp][] = [
  ['family_owned', /\bfamily[- ](owned|run|operated)\b/i],
  ['locally_owned', /\blocally[- ](owned|operated)\b/i],
  ['veteran_owned', /\bveteran[- ]owned\b/i],
  ['women_owned', /\bwom[ae]n[- ]owned\b/i],
  ['established', /\b(since|established|founded|serving[^.]{0,40}since)\s+(in\s+)?(19|20)\d{2}\b/i],
  ['years_experience', /\b\d{1,3}\+?\s+years\b(?!\s+old)/i],
  ['emergency_service', /\b24\/7\b|\b24 hours\b|\bemergency\s+(service|plumb|repair|call)/i],
  ['licensed_insured', /\b(licensed|insured|bonded)\b/i],
  ['free_estimates', /\bfree\s+(estimates?|quotes?|consultations?)\b/i],
  ['financing', /\bfinancing\b/i],
  ['guarantee', /\b(guarantee[ds]?|warrant(y|ies))\b/i],
  ['same_day', /\bsame[- ]day\b/i],
  ['awards', /\b(award[- ]winning|a\+ rat|bbb accredited|certified)\b/i],
];

const GENERIC_SERVICE = /^(home|about|contact|blog|news|reviews?|testimonials?|faqs?|gallery|careers?|jobs|our services|services?|all services|service areas?|areas? (we )?serve|locations?|learn more|read more|view (all|more)|see (all|more)|click here|call( us)?( now| today)?|get (a |your )?(free )?(quote|estimate)|request( a)? (service|quote|estimate)|schedule.*|book.*|why (choose|us).*|what we do|who we are|financing|coupons?|specials?|offers?|deals|privacy.*|terms.*|sitemap|menu|search|meet .*|our (team|story|company|work|mission|values)|follow us|connect with us|get in touch|contact us.*|payment.*|quick links|useful links|residential|commercial|more|next|previous|back to top|skip to.*|hours|connect|history|address|mailing address|physical address|our .*|latest .*|industries served|service plan|featured .*|recent .*)$/i;

const NOT_A_SERVICE = /^(contacts?|footer|products?|review us.*|services we offer|view all.*|where we work|more cities|construction types|(family|locally) owned.*|maintenance options|home services|taking .*|consider .*|how .*|tips .*|make a payment|opening times|customer support|let.s talk .*|se habla .*|plumber|client reviews|frequently asked .*|available .*)$/i;

const NOT_A_SERVICE_ANYWHERE = /licen[sc]e|#\d|,\s*[A-Z]{2}\b|servicing the entire|service areas?/i;

/** Page headings mix in promotions and section titles, so one must name a kind of work to count. */
const SERVICE_HEADING = /\b(repairs?|install\w*|replac\w*|clean\w*|inspect\w*|maintenance|removal|detection|testing|treatment|remodel\w*|design|consult\w*|services?)\b/i;

const NOT_A_SERVICE_HEADING = /\b(questions?|answered|faqs?|cities|signs?|benefits?|reviews?|payments?|support|society|plans?)\b|\b\w+ we (service|serve)\b/i;

/** Pages and links about where a business works, which are often built like service pages. */
export const SERVICE_AREA = /service[-_ ]?areas?|areas?[-_ ]?(we[-_ ])?serv|where[-_ ]we[-_ ]work|\/locations?\b|\/cities\b|\/areas?\//i;

const MIN_SUMMARY_LENGTH = 30;

/** Rejects page titles such as "Home" that are stored as descriptions. */
function usableSummary(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = cleanText(value, MAX_SUMMARY);
  return text.length >= MIN_SUMMARY_LENGTH && text.split(/\s+/).length >= 3 ? text : null;
}

/** A sentence written by a customer, or about a customer, says nothing about this business. */
const NOT_ABOUT_BUSINESS = /\b(I|me|my)\b|\b(servicing|customers?|clients?)\s+(a|an|small|like)\b/;

const BOILERPLATE = /\b(cookies?|privacy policy|all rights reserved|javascript|terms of (use|service)|this site is protected|recaptcha|copyright)\b/i;

const NOT_A_NAME = new Set([
  'our', 'the', 'your', 'this', 'that', 'we', 'local', 'family', 'company', 'business', 'plumbing', 'services',
  'service', 'home', 'small', 'proud', 'team', 'staff', 'about', 'contact', 'call', 'today', 'new', 'owner',
  'owners', 'and', 'with', 'for', 'veteran', 'master', 'licensed', 'general', 'operator', 'each', 'every',
  'is', 'are', 'was', 'has', 'have', 'will', 'always', 'available', 'here', 'there', 'at', 'of', 'in', 'on', 'to',
  'a', 'an', 'it', 'he', 'she', 'they', 'you', 'all', 'by', 'from', 'more', 'most', 'operated', 'owned', 'managed',
  'manager', 'president', 'founder', 'partner', 'partners', 'ceo', 'contractor', 'plumber', 'plumbers', 'llc', 'inc',
  'executive', 'vice', 'senior', 'chief', 'regional', 'sales', 'operations', 'dispatch', 'office', 'billing', 'customer',
  'support', 'technician', 'estimator', 'coordinator', 'director', 'lead',
]);

// Control characters, plus zero-width and text-direction marks.
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2060-\u206f]/g;

/** Removes control characters and extra space, and caps length, since this text is shown to an AI writer. */
export function cleanText(value: string, max: number): string {
  const text = value
    .replace(INVISIBLE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = cut.lastIndexOf(' ');
  return `${(end > max * 0.6 ? cut.slice(0, end) : cut).trimEnd()}…`;
}

function detect(rules: [string, RegExp][], html: string): string[] {
  return rules.filter(([, pattern]) => pattern.test(html)).map(([name]) => name);
}

function isName(candidate: string): boolean {
  const words = candidate.trim().split(/\s+/);
  return (
    words.length >= 1 &&
    words.length <= 3 &&
    words.every((word) => /^[A-Z][a-z]+(?:['’-][A-Za-z]+)?$/.test(word) && !NOT_A_NAME.has(word.toLowerCase()) && !/^I['’]/.test(word))
  );
}

/** Single labels are too often cities or brands, unless a site declares them as services. */
function cleanService(raw: string, declared = false): string | null {
  const text = cleanText(raw, 80).replace(/[\s>»›→|:•-]+$/g, '').replace(/^[\s>»›→|:•-]+/g, '');
  if (text.length < 3 || text.length > 60) return null;
  if (/^https?:|^www\.|^\d+[.)]\s|\bnear\b/i.test(text)) return null;
  if (text.split(/\s+/).length > 6 || /[?!]$/.test(text) || /\d{3}.*\d{4}/.test(text)) return null;
  if (!declared && text.split(/\s+/).length === 1) return null;
  if (NOT_A_SERVICE.test(text) || NOT_A_SERVICE_ANYWHERE.test(text)) return null;
  return GENERIC_SERVICE.test(text) ? null : text;
}

interface JsonLdFacts {
  description: string | null;
  founder: string | null;
  services: string[];
}

function walkJsonLd(node: unknown, facts: JsonLdFacts): void {
  if (Array.isArray(node)) {
    node.forEach((child) => walkJsonLd(child, facts));
    return;
  }
  if (!node || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  const type = String(record['@type'] ?? '');

  if (typeof record.description === 'string' && !/WebPage|WebSite|BreadcrumbList|Article/i.test(type)) {
    facts.description ??= record.description;
  }
  const founder = record.founder;
  const founderName = typeof founder === 'string' ? founder : (founder as { name?: unknown } | null)?.name;
  if (typeof founderName === 'string') facts.founder ??= founderName;

  for (const key of ['serviceType', 'knowsAbout']) {
    const value = record[key];
    (Array.isArray(value) ? value : [value]).forEach((item) => {
      if (typeof item === 'string') facts.services.push(item);
    });
  }
  if (/Service|Offer/.test(type) && typeof record.name === 'string') facts.services.push(record.name);
  for (const value of Object.values(record)) {
    if (value && typeof value === 'object') walkJsonLd(value, facts);
  }
}

function readJsonLd($: CheerioAPI): JsonLdFacts {
  const facts: JsonLdFacts = { description: null, founder: null, services: [] };
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      walkJsonLd(JSON.parse($(element).text()), facts);
    } catch {
      // Malformed structured data is common on the web.
    }
  });
  return facts;
}

const NAME_PATTERNS = [
  /\b(?:owned and operated by|founded by|started by)\s+((?:[A-Z][a-z'’-]+\s?){1,3})/,
  /\b(?:[Oo]wner|[Ff]ounder|[Pp]resident|[Cc]o-[Oo]wner)[,:\s–-]+(?:is\s+)?((?:[A-Z][a-z'’-]+\s?){1,4})/,
  /\b((?:[A-Z][a-z'’-]+\s){1,2}[A-Z][a-z'’-]+),?\s+(?:is\s+)?(?:the\s+)?(?:[Oo]wner|[Ff]ounder|[Pp]resident)\b/,
  /\b(?:Hi|Hello),?\s+I[’']m\s+((?:[A-Z][a-z'’-]+\s?){1,2})/,
  /\b[Ff]ounder(?:\s+and\s+[\w ]{1,30})?,\s+((?:[A-Z][a-z'’-]+\s?){1,3})/,
];

function namesFromBlocks(blocks: string[], source: string): ContactName[] {
  const names: ContactName[] = [];
  for (const block of blocks) {
    for (const pattern of NAME_PATTERNS) {
      const name = block.match(pattern)?.[1]?.replace(/^I['’]m\s+/, '').trim();
      if (name && isName(name)) names.push({ name, source, confidence: 'medium', basis: 'website text' });
    }
  }
  return names;
}

/** Menus pulled into a list read as a run of capitalized labels, not a sentence. */
function looksLikeMenu(text: string): boolean {
  const words = text.split(/\s+/);
  return words.length >= 8 && words.filter((word) => /^[A-Z]/.test(word)).length / words.length > 0.7;
}

function highlightsFromBlocks(blocks: string[], source: string): ContextHighlight[] {
  const highlights: ContextHighlight[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    if (BOILERPLATE.test(block)) continue;
    for (const sentence of block.split(/(?<!\b(?:Inc|LLC|Ltd|Co|Corp|St|Dr|Mr|Mrs|Ms)\.)(?<=[.!?])\s+/)) {
      if (sentence.length < 15 || sentence.length > 260 || NOT_ABOUT_BUSINESS.test(sentence) || looksLikeMenu(sentence)) continue;
      // Short headings like "Emergency Plumbing" name a topic rather than make a claim.
      if (sentence.split(/\s+/).length < MIN_HIGHLIGHT_WORDS) continue;
      for (const [label, pattern] of HIGHLIGHT_RULES) {
        if (seen.has(label) || !pattern.test(sentence)) continue;
        seen.add(label);
        highlights.push({ label, text: cleanText(sentence, MAX_HIGHLIGHT_TEXT), source });
        break;
      }
    }
  }
  return highlights;
}

export function extractPageContext(html: string, pageUrl: string, kind: PageKind): PageContext {
  const $ = load(html);
  const url = new URL(pageUrl);
  const source = url.pathname;
  const jsonLd = readJsonLd($);

  const signals: WebsiteSignals = {
    chatWidgets: detect(CHAT_WIDGETS, html),
    bookingTools: detect(BOOKING_TOOLS, html),
    otherTools: detect(OTHER_TOOLS, html),
    platform: detect(PLATFORMS, html)[0] ?? null,
    bookingLink: false,
    contactForm: false,
    mobileViewport: $('meta[name="viewport"]').length > 0,
    copyrightYear: null,
  };

  const copyright = [...html.matchAll(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?((?:19|20)\d{2})/gi)]
    .map((match) => Number(match[1]))
    .sort((a, b) => b - a)[0];
  signals.copyrightYear = copyright ?? null;

  $('form').each((_, form) => {
    const fields = $(form).find('input[type="email"], textarea, input[name*="email" i], input[name*="phone" i]');
    if (fields.length) signals.contactForm = true;
  });

  const services = jsonLd.services.map((service) => cleanService(service, true));
  $('a[href]').each((_, element) => {
    const anchor = $(element);
    const label = anchor.text();
    if (BOOKING_LABEL.test(label)) signals.bookingLink = true;
    try {
      const href = new URL(anchor.attr('href') ?? '', url);
      const isServiceLink = /\/services?\/[^/]+|\/service-[^/]+/i.test(href.pathname);
      if (href.origin === url.origin && isServiceLink && !SERVICE_AREA.test(href.pathname)) {
        services.push(cleanService(label));
      }
    } catch {
      // Unparseable links are ignored.
    }
  });
  if (kind === 'services') {
    $('main h2, main h3, article h2, article h3, section h2, section h3, h2, h3').each((_, element) => {
      const heading = $(element).text();
      if (SERVICE_HEADING.test(heading) && !NOT_A_SERVICE_HEADING.test(heading)) services.push(cleanService(heading));
    });
  }

  const description =
    usableSummary(jsonLd.description) ??
    usableSummary($('meta[name="description"]').attr('content')) ??
    usableSummary($('meta[property="og:description"]').attr('content'));

  // Reviews are often quoted, and they describe a customer's view, not the business's own claims.
  $('script, style, noscript, template, nav, footer, header, form, blockquote').remove();
  // Adjacent elements would otherwise merge, as in `<span>YEARS</span><span>Founded</span>`.
  $('*').each((_, element) => {
    $(element).prepend(' ').append(' ');
  });
  const blocks = $('p, li, h1, h2, h3')
    .map((_, element) => cleanText($(element).text(), 1000))
    .toArray()
    .filter(Boolean);
  const paragraphs = $('p')
    .map((_, element) => cleanText($(element).text(), 1000))
    .toArray()
    .filter((text) => text.length >= 60 && !BOILERPLATE.test(text));

  const names = namesFromBlocks(blocks, source);
  if (jsonLd.founder && isName(jsonLd.founder.trim())) {
    names.unshift({ name: jsonLd.founder.trim(), source, confidence: 'medium', basis: 'structured data' });
  }

  return {
    source,
    kind,
    https: url.protocol === 'https:',
    description,
    paragraphs,
    services: services.filter((service): service is string => service !== null),
    highlights: highlightsFromBlocks(blocks, source),
    names,
    signals,
  };
}

const unique = (values: string[]) => [...new Set(values)];

/** Finds a greeting name in the business name or a named email, which is safer than page text. */
function nameFromEmails(emails: string[], businessName: string): ContactName | null {
  const lowerBusiness = businessName.toLowerCase();
  for (const email of emails) {
    const local = email.slice(0, email.lastIndexOf('@'));
    const firstLast = local.match(/^([a-z]{2,15})\.[a-z]{2,20}$/);
    const single = local.match(/^[a-z]{3,12}$/);
    const first = firstLast?.[1] ?? (single && lowerBusiness.includes(single[0]) ? single[0] : null);
    if (first && !NOT_A_NAME.has(first) && !/^(info|sales|office|admin|support|contact|hello|customer)$/.test(first)) {
      return {
        name: first[0]!.toUpperCase() + first.slice(1),
        source: email,
        confidence: firstLast ? 'medium' : 'high',
        basis: firstLast ? 'email address' : 'business name and email address',
      };
    }
  }
  return null;
}

function levelFor(context: Omit<BusinessContext, 'level'>): ContextLevel {
  const hasStory = Boolean(context.summary || context.about);
  if (hasStory && (context.services.length >= 3 || context.highlights.length >= 2)) return 'rich';
  return hasStory || context.services.length || context.highlights.length ? 'basic' : 'none';
}

const NAME_RANK = { high: 2, medium: 1 } as const;

export function mergeContext(pages: PageContext[], emails: string[], businessName: string): BusinessContext {
  const home = pages.find((page) => page.kind === 'home');
  const about = pages.find((page) => page.kind === 'about');
  const seenLabels = new Set<string>();
  const seenTexts = new Set<string>();
  const highlights = [...pages]
    .sort((a, b) => Number(b.kind === 'about') - Number(a.kind === 'about'))
    .flatMap((page) => page.highlights)
    .filter((highlight) => {
      const text = highlight.text.toLowerCase();
      if (seenLabels.has(highlight.label) || seenTexts.has(text)) return false;
      seenLabels.add(highlight.label);
      seenTexts.add(text);
      return true;
    })
    .slice(0, MAX_HIGHLIGHTS);

  const candidates = pages.flatMap((page) => page.names);
  const emailName = nameFromEmails(emails, businessName);
  if (emailName) candidates.push(emailName);
  // A founder can be historic, so one mention is not enough to greet someone by name.
  const lowerName = businessName.toLowerCase();
  const corroborated = candidates.map((candidate) => {
    const bases = new Set(candidates.filter((c) => c.name === candidate.name).map((c) => c.basis));
    const words = candidate.name.toLowerCase().split(/\s+/);
    if (words.length > 1 && words.some((word) => word.length >= 4 && lowerName.includes(word))) {
      bases.add('business name');
    }
    return bases.size > 1 ? { ...candidate, confidence: 'high' as const, basis: [...bases].join(' and ') } : candidate;
  });
  const contactName = corroborated.sort((a, b) => NAME_RANK[b.confidence] - NAME_RANK[a.confidence])[0] ?? null;

  const aboutText = about?.paragraphs.length
    ? cleanText(about.paragraphs.slice(0, 3).join(' ').replace(/^[\s•·*-]+/, ''), MAX_ABOUT)
    : null;
  const firstParagraph = home?.paragraphs[0];
  const summary = home?.description ?? about?.description ?? (firstParagraph ? cleanText(firstParagraph, MAX_SUMMARY) : null);

  const lowerSeen = new Set<string>();
  const lowerBusiness = businessName.toLowerCase();
  const services = pages
    .flatMap((page) => page.services)
    .filter((service) => {
      const key = service.toLowerCase();
      if (lowerSeen.has(key) || lowerBusiness.includes(key)) return false;
      lowerSeen.add(key);
      return true;
    })
    .slice(0, MAX_SERVICES);

  const signals: WebsiteSignals = {
    chatWidgets: unique(pages.flatMap((page) => page.signals.chatWidgets)),
    bookingTools: unique(pages.flatMap((page) => page.signals.bookingTools)),
    otherTools: unique(pages.flatMap((page) => page.signals.otherTools)),
    platform: pages.map((page) => page.signals.platform).find(Boolean) ?? null,
    bookingLink: pages.some((page) => page.signals.bookingLink),
    contactForm: pages.some((page) => page.signals.contactForm),
    mobileViewport: pages.some((page) => page.signals.mobileViewport),
    copyrightYear: Math.max(0, ...pages.map((page) => page.signals.copyrightYear ?? 0)) || null,
  };

  const base = {
    summary,
    summarySource: summary ? (home?.description || firstParagraph ? (home?.source ?? null) : (about?.source ?? null)) : null,
    about: aboutText,
    aboutSource: aboutText ? (about?.source ?? null) : null,
    services,
    highlights,
    contactName,
    https: pages.every((page) => page.https),
    signals,
    pagesRead: pages.map((page) => page.source),
  };
  return { ...base, level: levelFor(base) };
}
