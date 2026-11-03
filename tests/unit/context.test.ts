import { describe, expect, it } from 'vitest';
import { cleanText, extractPageContext, mergeContext } from '@/enrich/context';
import { crawlWebsite } from '@/enrich/crawl';
import { toPayload } from '@/delivery/payload';
import { leadsToCsv } from '@/delivery/exportFile';
import type { Lead } from '@/lib/types';

const HOME = `<html><head><title>Acme Plumbing</title>
<meta name="description" content="Family-owned plumbers serving Dayton.">
<meta name="viewport" content="width=device-width">
<script src="https://embed.tawk.to/abc"></script>
<script src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>
<link href="/wp-content/themes/x.css" rel="stylesheet">
<script type="application/ld+json">{"@type":"Plumber","founder":{"@type":"Person","name":"Dana Reed"},
"hasOfferCatalog":{"itemListElement":[{"@type":"Offer","itemOffered":{"@type":"Service","name":"Tankless Water Heaters"}}]}}</script>
</head><body>
<nav><a href="/services/drain-cleaning/">Drain Cleaning</a><a href="/services/leak-repair/">Leak Repair</a>
<a href="/services/">Services</a><a href="/book">Book Online</a><a href="/about">About</a></nav>
<p>We have been family-owned since 1985, with same-day service for every neighbor in town.</p>
<p>We offer free estimates on all jobs across the Dayton region and nearby suburbs.</p>
<form><input type="email" name="email"><textarea></textarea></form>
<footer>© 2019-2024 Acme Plumbing. All rights reserved.</footer></body></html>`;

const ABOUT = `<html><body><h1>About us</h1>
<p>Acme Plumbing was started by Dana Reed after twenty years working for larger companies in Ohio.</p>
<p>We use cookies to improve your experience on this website, please read our privacy policy.</p>
<p>Our crews are licensed and insured, and every repair comes with a two-year warranty on parts.</p></body></html>`;

const home = () => extractPageContext(HOME, 'https://acme.example/', 'home');
const about = () => extractPageContext(ABOUT, 'https://acme.example/about', 'about');

describe('extractPageContext', () => {
  it('finds services from links and structured data, without generic labels', () => {
    expect(home().services).toEqual(expect.arrayContaining(['Tankless Water Heaters', 'Drain Cleaning', 'Leak Repair']));
    expect(home().services).not.toContain('Services');
  });

  it('reads website signals', () => {
    expect(home().signals).toMatchObject({
      chatWidgets: ['Tawk.to'],
      otherTools: ['Google Analytics'],
      platform: 'WordPress',
      bookingLink: true,
      contactForm: true,
      mobileViewport: true,
      copyrightYear: 2024,
    });
  });

  it('reports no signals on a plain page', () => {
    const page = extractPageContext('<p>Hello</p>', 'http://acme.example/', 'home');
    expect(page.https).toBe(false);
    expect(page.signals).toMatchObject({
      chatWidgets: [], bookingTools: [], platform: null, bookingLink: false, contactForm: false, mobileViewport: false, copyrightYear: null,
    });
  });

  it('quotes highlights with their source and skips boilerplate', () => {
    const labels = about().highlights.map((h) => h.label);
    expect(labels).toEqual(['licensed_insured']);
    expect(about().highlights[0]?.source).toBe('/about');
    expect(about().paragraphs.join(' ')).not.toContain('cookies');
  });

  it('finds an owner in structured data and in text', () => {
    expect(home().names[0]).toMatchObject({ name: 'Dana Reed', confidence: 'medium', basis: 'structured data' });
    expect(about().names[0]).toMatchObject({ name: 'Dana Reed', confidence: 'medium', source: '/about' });
  });

  it.each([
    'Our Owner Is Always Available',
    'Proudly serving our family owners with care and attention to detail.',
    'Call The Owner today to learn more about what we do.',
  ])('does not invent a name from "%s"', (text) => {
    const page = extractPageContext(`<p>${text}</p>`, 'https://acme.example/', 'home');
    expect(page.names).toEqual([]);
  });

  it('finds a founder named after a role', () => {
    const page = extractPageContext('<p>Our founder and senior plumber, Eric Silvey, has worked here for years.</p>', 'https://a.example/', 'home');
    expect(page.names[0]?.name).toBe('Eric Silvey');
  });

  it.each([
    ['years_experience', 'If your water heater is over 10 years old, it may be time to replace it.'],
    ['family_owned', 'Whether servicing a small family-owned convenience store or a large site.'],
    ['same_day', 'They showed up same day and gave me a fair price for the job.'],
  ])('does not count %s from: %s', (label, text) => {
    const page = extractPageContext(`<p>${text}</p>`, 'https://a.example/', 'home');
    expect(page.highlights.map((h) => h.label)).not.toContain(label);
  });

  it('skips quoted reviews', () => {
    const page = extractPageContext('<blockquote><p>Great crew with free estimates for every customer around.</p></blockquote>', 'https://a.example/', 'home');
    expect(page.highlights).toEqual([]);
  });

  it('keeps a sentence whole after a company suffix', () => {
    const page = extractPageContext('<p>Since 1950, Keefe Plumbing Company Inc. has served this town.</p>', 'https://a.example/', 'home');
    expect(page.highlights[0]?.text).toBe('Since 1950, Keefe Plumbing Company Inc. has served this town.');
  });

  it('skips navigation menus that look like list items', () => {
    const page = extractPageContext('<li>About Us Service Areas Maintenance Plans Coupons Financing Meet Our Team Reviews</li>', 'https://a.example/', 'home');
    expect(page.highlights).toEqual([]);
  });

  it('keeps words apart when adjacent elements have no space', () => {
    const page = extractPageContext('<p><b>TRUSTED FOR YEARS</b><span>Founded in 1935, we serve every home in the county.</span></p>', 'https://a.example/', 'home');
    expect(page.paragraphs[0]).toBe('TRUSTED FOR YEARS Founded in 1935, we serve every home in the county.');
  });

  it.each([
    'https://en.wikipedia.org/wiki/Roto-Rooter', 'Hours', 'Connect', 'Mailing Address', 'Our Companies', '1. Flooring and Finishes', 'Plumber Near Cleveland TN',
    'Dallas', 'Plano, TX', 'Dallas, TX Services', 'Footer', 'Contacts', 'Review Us On Google', 'Texas Plumbing License #38188', 'View All Service Areas',
    'Where We Work', 'More Cities', 'Family Owned', 'Services We Offer', 'Trane', 'Consider A Preventive Maintenance Agreement',
  ])('rejects "%s" as a service', (label) => {
    const page = extractPageContext(`<h2>${label}</h2>`, 'https://a.example/services', 'services');
    expect(page.services).toEqual([]);
  });

  it('keeps real multi-word services', () => {
    const page = extractPageContext('<h2>Slab Leak Detection</h2><h3>Water Heater Repair</h3>', 'https://a.example/services', 'services');
    expect(page.services).toEqual(['Slab Leak Detection', 'Water Heater Repair']);
  });

  it.each(['$800 Off', 'Make a Payment', 'Opening Times', 'Service Questions, Answered', 'Cities We Service', 'Signs Your Home Needs Repiping', 'Most Recent Pins (1251)', 'Dallas Society', 'Faces of Humanity'])(
    'rejects the page heading "%s"',
    (heading) => {
      const page = extractPageContext(`<h2>${heading}</h2>`, 'https://a.example/services', 'services');
      expect(page.services).toEqual([]);
    },
  );

  it('keeps links under a services path even without a service word', () => {
    const page = extractPageContext('<a href="/services/water-heaters/">Water Heaters</a>', 'https://a.example/', 'home');
    expect(page.services).toEqual(['Water Heaters']);
  });

  it('keeps single-word services a site declares in structured data', () => {
    const page = extractPageContext('<script type="application/ld+json">{"@type":"Plumber","serviceType":"Excavation"}</script>', 'https://a.example/', 'home');
    expect(page.services).toEqual(['Excavation']);
  });

  it('does not read service-area links as services', () => {
    const page = extractPageContext(
      '<a href="/service-areas/fort-worth/">Fort Worth</a><a href="/service-area/deer-park">Deer Park</a><a href="/services/fort-worth-tx">Fort Worth, TX</a><a href="/services/slab-leak-repair/">Slab Leak Repair</a>',
      'https://a.example/', 'home',
    );
    expect(page.services).toEqual(['Slab Leak Repair']);
  });

  it.each([
    ['President I’m Scott Riddell and I run this company.', 'Scott Riddell'],
    ['Jane Doe, Owner of this company.', 'Jane Doe'],
  ])('reads a clean name from: %s', (text, name) => {
    const page = extractPageContext(`<p>${text}</p>`, 'https://a.example/', 'home');
    expect(page.names[0]?.name).toBe(name);
  });

  it.each([
    'Maria Lopez is our Executive Vice President of sales here.',
    'Executive Vice President of the company speaks here.',
    'Contact our Owner: Dispatch handles all of the calls.',
  ])('does not read a job title as a name: %s', (text) => {
    const page = extractPageContext(`<p>${text}</p>`, 'https://a.example/', 'home');
    expect(page.names.map((n) => n.name).join()).not.toMatch(/Executive|Vice|Dispatch/);
  });

  it('rejects a one-word description and falls back to the first paragraph', () => {
    const page = extractPageContext(
      '<meta name="description" content="Home"><p>We repair pipes and water heaters for homes across the whole Dallas region.</p>',
      'https://a.example/', 'home',
    );
    expect(page.description).toBeNull();
    expect(mergeContext([page], [], 'A').summary).toContain('We repair pipes');
  });

  it('uses a sentence once, even when it fits two highlights', () => {
    const page = extractPageContext('<p>Family owned since 2011 and proud to serve this town.</p>', 'https://a.example/', 'home');
    expect(page.highlights.map((h) => h.text)).toEqual(['Family owned since 2011 and proud to serve this town.']);
  });

  it('skips short headings as highlights', () => {
    const page = extractPageContext('<h2>Emergency Plumbing</h2>', 'https://a.example/', 'home');
    expect(page.highlights).toEqual([]);
  });

  it('ignores scripts and malformed structured data', () => {
    const page = extractPageContext(
      '<script type="application/ld+json">{ broken</script><script>var x="family-owned since 1990 and more words"</script><p>Hi</p>',
      'https://acme.example/',
      'home',
    );
    expect(page.highlights).toEqual([]);
  });
});

describe('cleanText', () => {
  it('removes control and invisible characters and caps length', () => {
    expect(cleanText('a\u0000b​c\n\n  d', 50)).toBe('a b c d');
    expect(cleanText('word '.repeat(50), 20).length).toBeLessThanOrEqual(21);
    expect(cleanText('word '.repeat(50), 20).endsWith('…')).toBe(true);
  });
});

describe('mergeContext', () => {
  it('builds rich context from several pages', () => {
    const context = mergeContext([home(), about()], ['info@acme.example'], 'Acme Plumbing');
    expect(context).toMatchObject({
      level: 'rich',
      summary: 'Family-owned plumbers serving Dayton.',
      summarySource: '/',
      aboutSource: '/about',
      https: true,
      pagesRead: ['/', '/about'],
      contactName: { name: 'Dana Reed', confidence: 'high', basis: 'structured data and website text' },
    });
    expect(context.about).toContain('started by Dana Reed');
    const labels = context.highlights.map((h) => h.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toContain('family_owned');
  });

  it('trusts a name that matches the business name', () => {
    const page = extractPageContext('<p>Chad Cole is the owner of this shop in town.</p>', 'https://a.example/', 'home');
    expect(mergeContext([page], [], "Cole's Plumbing").contactName).toMatchObject({ name: 'Chad Cole', confidence: 'high', basis: 'website text and business name' });
    expect(mergeContext([page], [], 'Acme Plumbing').contactName).toMatchObject({ confidence: 'medium' });
  });

  it('removes a repeated highlight across pages', () => {
    const a = extractPageContext('<p>We are licensed and insured for all work.</p>', 'https://a.example/', 'home');
    const b = extractPageContext('<p>We are licensed and insured for all work.</p>', 'https://a.example/about', 'about');
    expect(mergeContext([a, b], [], 'A').highlights).toHaveLength(1);
  });

  it('does not trust a founder mentioned only once', () => {
    const page = extractPageContext(
      '<script type="application/ld+json">{"@type":"Plumber","founder":"Samuel Oscar Blanc"}</script><p>Hi</p>',
      'https://a.example/', 'home',
    );
    expect(mergeContext([page], [], 'Roto').contactName).toMatchObject({ name: 'Samuel Oscar Blanc', confidence: 'medium' });
  });

  it('does not list the business itself as a service', () => {
    const page = extractPageContext('<a href="/services/waker">Waker Plumbing</a><a href="/services/sump">Sump Pumps</a>', 'https://a.example/', 'home');
    expect(mergeContext([page], [], 'Waker Plumbing').services).toEqual(['Sump Pumps']);
  });

  it('marks thin and empty sites', () => {
    const thin = extractPageContext('<meta name="description" content="Friendly plumbers in the Dallas area."><p>Hi</p>', 'https://a.example/', 'home');
    expect(mergeContext([thin], [], 'A').level).toBe('basic');
    const empty = extractPageContext('<div id="root"></div>', 'https://a.example/', 'home');
    expect(mergeContext([empty], [], 'A').level).toBe('none');
  });

  const emptyPage = () => extractPageContext('<p>Hi</p>', 'https://a.example/', 'home');

  it.each([
    ['gary@garytheplumber.us', 'Gary The Plumber LLC', 'Gary', 'high'],
    ['jane.smith@acme.example', 'Acme', 'Jane', 'medium'],
  ])('reads a name from %s', (email, business, name, confidence) => {
    expect(mergeContext([emptyPage()], [email], business).contactName).toMatchObject({ name, confidence, source: email });
  });

  it.each([
    ['info@acme.example', 'Info Acme'],
    ['drainman@gmail.com', 'Acme Plumbing'],
    ['sales.team@acme.example', 'Acme'],
  ])('does not treat %s as a person', (email, business) => {
    expect(mergeContext([emptyPage()], [email], business).contactName).toBeNull();
  });
});

describe('crawl with context', () => {
  function site(pages: Record<string, string>): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!(url in pages)) return new Response('missing', { status: 404 });
      const response = new Response(pages[url], { headers: { 'content-type': 'text/html' } });
      Object.defineProperty(response, 'url', { value: url });
      return response;
    }) as typeof fetch;
  }

  it('skips a service-area page when choosing pages to read', async () => {
    const result = await crawlWebsite('https://acme.example/', 'Acme', 'acme.example', site({
      'https://acme.example/': '<title>Acme</title><a href="/service-areas">Service Areas</a><a href="/services">Services</a>',
      'https://acme.example/services': '<h2>Water Heater Repair</h2>',
    }));
    expect(result.context?.pagesRead).toEqual(['/', '/services']);
  });

  it('reads one contact, about, and services page', async () => {
    const result = await crawlWebsite('https://acme.example/', 'Acme Plumbing', 'acme.example', site({
      'https://acme.example/': '<title>Acme Plumbing</title><a href="/about">About</a><a href="/about-2">About</a><a href="/contact">Contact</a><a href="/services">Services</a>',
      'https://acme.example/contact': 'Write to jane@acme.example',
      'https://acme.example/about': ABOUT,
      'https://acme.example/services': '<h2>Water Heater Repair</h2><h3>Sewer Line Repair</h3><h2>Why Choose Us</h2>',
    }));
    expect(result.pagesFetched).toBe(4);
    expect(result.context?.pagesRead).toEqual(['/', '/contact', '/about', '/services']);
    expect(result.context?.services).toEqual(['Water Heater Repair', 'Sewer Line Repair']);
  });

  it('keeps no context for parked sites', async () => {
    const result = await crawlWebsite('https://acme.example/', 'Acme', null, site({
      'https://acme.example/': 'This domain is for sale.',
    }));
    expect(result.context).toBeNull();
  });
});

describe('outputs', () => {
  const context = mergeContext([home(), about()], [], 'Acme Plumbing');
  const lead = {
    placeId: 'ChIJ1', name: 'Acme', fullAddress: null, street: null, city: null, postalCode: null, state: null, country: 'US',
    categories: [], phoneRaw: null, phone: null, website: 'https://acme.example', domain: 'acme.example', rating: 5, reviewCount: 1,
    claimed: true, businessStatus: 'open', latitude: null, longitude: null, mapsUrl: null, hours: null, runId: 1, keyword: 'x',
    searchArea: null, companyKeys: [], collectedAt: 0, emails: [], sitePhones: [], socials: {}, metaDescription: null, context,
    enrichStatus: 'done', enrichError: null, score: 25, tier: 'low', deliveryStatus: 'unsent', crmNote: null, crmSentAt: null,
    evidence: { activeListing: true, websiteLive: true, websiteParked: false, websiteMatch: true, phoneValid: false, phoneMatch: false, emailVerified: false, emailRelated: false, emailSource: null, mxValid: null },
  } as Lead;

  it('sends context in the webhook payload with detected wording', () => {
    const payload = toPayload(lead);
    expect(payload.context).toMatchObject({
      level: 'rich',
      contact_name: { name: 'Dana Reed' },
      website: { chat_widgets_detected: ['Tawk.to'], contact_form_detected: true },
    });
    expect(toPayload({ ...lead, context: null }).context).toBeNull();
  });

  it('exports context and neutralizes formulas in scraped text', () => {
    const csv = leadsToCsv([{ ...lead, context: { ...context, summary: '=HYPERLINK("http://x")' } }]);
    expect(csv).toContain('Business Summary');
    expect(csv).toContain("'=HYPERLINK");
  });
});
