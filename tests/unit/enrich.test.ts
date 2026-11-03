import { describe, expect, it } from 'vitest';
import { crawlWebsite, isPublicWebUrl } from '@/enrich/crawl';
import { cleanEmail, isEmailRelated, isFreeEmail, isOwnDomain, isRoleEmail } from '@/enrich/emails';
import { isSharedHost, isSocialHost } from '@/enrich/hosts';
import { extractPage, isParkedPage, siteMatchesBusiness } from '@/enrich/extract';
import { interpretMxAnswer, lookupMx } from '@/enrich/mx';
import { normalizePhone } from '@/enrich/phone';
import { isPathAllowed, parseRobots } from '@/enrich/robots';
import { buildEvidence, rankEmails, scoreEvidence, tierFor } from '@/enrich/score';
import type { EmailRecord } from '@/lib/types';

describe('cleanEmail', () => {
  it('normalizes real addresses', () => {
    expect(cleanEmail(' Info@Acme.Example ')).toBe('info@acme.example');
    expect(cleanEmail('mailto:sales@acme.example?subject=Hi')).toBe('sales@acme.example');
  });

  it.each([
    'your@email.com',
    'logo@2x.png',
    'user@example.com',
    'noreply@acme.example',
    '8f3a9c1d2e4b5a6f7c8d9e0f@sentry.io',
    'a1b2c3d4e5f6a7b8c9@acme.example',
    'not-an-email',
    'dummytext@gmail.com',
    'service@publicse721stg.wpenginepowered.com',
    'hello@acme.netlify.app',
    'mymail@mailservice.com',
  ])('rejects %s', (raw) => {
    expect(cleanEmail(raw)).toBeNull();
  });

  it('classifies addresses', () => {
    expect(isFreeEmail('a@gmail.com')).toBe(true);
    expect(isFreeEmail('a@acme.example')).toBe(false);
    expect(isRoleEmail('info@acme.example')).toBe(true);
    expect(isRoleEmail('jane@acme.example')).toBe(false);
    expect(isOwnDomain('a@acme.example', 'www.acme.example')).toBe(true);
    expect(isOwnDomain('a@mail.acme.example', 'acme.example')).toBe(true);
    expect(isOwnDomain('a@other.example', 'acme.example')).toBe(false);
    expect(isOwnDomain('a@acme.example', null)).toBe(false);
  });
});

describe('isEmailRelated', () => {
  it.each([
    ['spokanerooter@gmail.com', 'Spokane Rooter', 'spokanerooter.com'],
    ['qstopplumbing@gmail.com', 'Quick Stop Plumbing', 'quickstop-plumbing.com'],
    ['info@htpidaho.com', 'High-Ten Plumbing', 'high-tenplumbing.com'],
    ['spp7248392@gmail.com', "Scotty's Potty's Plumbing, LLC", 'scottyspottysplumbing.com'],
    ['ard@idahosplumber.com', 'American Rooter & Drain', 'americanrooterdrain.com'],
    ['service@acme.example', 'Whatever', 'acme.example'],
  ])('accepts %s for %s', (address, name, domain) => {
    expect(isEmailRelated(address, name, domain)).toBe(true);
  });

  it.each([
    ['dharangaonacsc@gmail.com', "Todd Waker's Plumbing Repair", 'toddwakersplumbingrepair.com'],
    ['nxbusiness@gmail.com', 'Korrect Plumbing, Heating & Air Conditioning, Inc.', 'korrectplumbing.com'],
    ['someone@gmail.com', 'Acme', null],
  ])('flags %s for %s', (address, name, domain) => {
    expect(isEmailRelated(address, name, domain)).toBe(false);
  });
});

describe('hosts', () => {
  it('separates social profiles and shared builders from real sites', () => {
    expect(isSocialHost('www.facebook.com')).toBe(true);
    expect(isSocialHost('m.facebook.com')).toBe(true);
    expect(isSocialHost('notfacebook.com')).toBe(false);
    expect(isSharedHost('b12sites.com')).toBe(true);
    expect(isSharedHost('acme.wixsite.com')).toBe(false);
    expect(isSharedHost('acme.example')).toBe(false);
  });
});

describe('extractPage', () => {
  const html = `<html><head><title>Acme Plumbing</title>
    <meta name="description" content="Pipes.">
    <script type="application/ld+json">{"@type":"Plumber","email":"ld@acme.example","telephone":"+1 214 555 0100",
      "sameAs":["https://www.instagram.com/acme"]}</script>
    <script type="application/ld+json">{ broken</script>
    <script>var hidden = "script@acme.example";</script></head>
    <body><p>Write to text@acme.example</p><p>Call now</p>
    <img src="logo@2x.png">
    <a href="mailto:Mail%40acme.example?subject=x">Mail</a>
    <a href="tel:+12145550101">Call</a>
    <a href="/contact-us#top">Contact</a><a href="/pricing">Pricing</a>
    <a href="https://other.example/contact">Partner</a>
    <a href="https://www.facebook.com/sharer/sharer.php?u=x">Share</a>
    <a href="https://www.facebook.com/acme">FB</a>
    </body></html>`;
  const page = extractPage(html, 'https://acme.example/');

  it('finds emails from JSON-LD, mailto, and text, but not scripts', () => {
    expect(page.emails.sort()).toEqual(['ld@acme.example', 'mail@acme.example', 'text@acme.example']);
  });

  it('finds phones and meta tags', () => {
    expect(page.phones).toEqual(expect.arrayContaining(['+1 214 555 0100', '+12145550101']));
    expect(page.metaDescription).toBe('Pipes.');
  });

  it('keeps profile links and skips share links', () => {
    expect(page.socials.facebook).toBe('https://www.facebook.com/acme');
    expect(page.socials.instagram).toBe('https://www.instagram.com/acme');
  });

  it('follows only same-origin contact links', () => {
    expect(page.pageLinks).toEqual([{ kind: 'contact', url: 'https://acme.example/contact-us' }]);
  });
});

describe('website checks', () => {
  it('detects parked pages', () => {
    expect(isParkedPage({ title: 'x', text: 'This domain is for sale!' })).toBe(true);
    expect(isParkedPage({ title: 'Acme', text: 'We fix pipes.' })).toBe(false);
  });

  it('matches a site to the business name', () => {
    expect(siteMatchesBusiness('Acme Plumbing LLC', null, { title: 'Acme Plumbing', text: '' })).toBe(true);
    expect(siteMatchesBusiness('Acme Plumbing', 'acmeplumbing.example', { title: 'Home', text: '' })).toBe(true);
    expect(siteMatchesBusiness('Acme Plumbing', 'zzz.example', { title: 'Bakery', text: 'Fresh bread' })).toBe(false);
  });

  it('refuses local and private addresses', () => {
    for (const url of [
      'http://localhost/', 'http://127.0.0.1/', 'http://10.0.0.1/', 'http://192.168.1.1/',
      'http://172.16.0.1/', 'http://169.254.169.254/', 'http://printer.local/', 'http://intranet/',
      'http://[::1]/', 'file:///etc/passwd', 'javascript:alert(1)',
    ]) {
      expect(isPublicWebUrl(url), url).toBe(false);
    }
    expect(isPublicWebUrl('https://acme.example/')).toBe(true);
    expect(isPublicWebUrl('http://8.8.8.8/')).toBe(true);
  });
});

describe('robots.txt', () => {
  it('uses the longest matching rule', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/contact\n');
    expect(isPathAllowed(rules, '/private/x')).toBe(false);
    expect(isPathAllowed(rules, '/private/contact')).toBe(true);
    expect(isPathAllowed(rules, '/')).toBe(true);
  });

  it('supports wildcards, end anchors, and blocking everything', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /*.pdf$\n');
    expect(isPathAllowed(rules, '/a/b.pdf')).toBe(false);
    expect(isPathAllowed(rules, '/a/b.pdf.html')).toBe(true);
    expect(isPathAllowed(parseRobots('User-agent: *\nDisallow: /'), '/contact')).toBe(false);
  });

  it('ignores rules for other agents and empty disallow', () => {
    expect(isPathAllowed(parseRobots('User-agent: BadBot\nDisallow: /'), '/')).toBe(true);
    expect(isPathAllowed(parseRobots('User-agent: *\nDisallow:'), '/')).toBe(true);
  });

  it('shares rules across stacked user agents', () => {
    expect(isPathAllowed(parseRobots('User-agent: a\nUser-agent: *\nDisallow: /x'), '/x')).toBe(false);
  });
});

describe('MX', () => {
  it('reads DNS answers', () => {
    expect(interpretMxAnswer({ Status: 0, Answer: [{ type: 15, data: '10 mail.acme.example.' }] })).toBe(true);
    expect(interpretMxAnswer({ Status: 0 })).toBe(false);
    expect(interpretMxAnswer({ Status: 0, Answer: [{ type: 15, data: '0 .' }] })).toBe(false);
    expect(interpretMxAnswer({ Status: 3 })).toBe(false);
    expect(interpretMxAnswer({ Status: 2 })).toBeNull();
  });

  it('reports a failed lookup as unknown', async () => {
    const failing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await lookupMx('acme.example', failing)).toBeNull();
  });
});

describe('normalizePhone', () => {
  it('validates by country', () => {
    expect(normalizePhone('(213) 373-4253', 'US')).toBe('+12133734253');
    expect(normalizePhone('123', 'US')).toBeNull();
    expect(normalizePhone(null, 'US')).toBeNull();
    expect(normalizePhone('(213) 373-4253', 'not-a-code')).toBeNull();
  });
});

const email = (over: Partial<EmailRecord>): EmailRecord => ({
  address: 'a@acme.example',
  source: '/contact',
  kind: 'business',
  role: false,
  ownDomain: true,
  related: true,
  mx: true,
  ...over,
});

const OPEN = { businessStatus: 'open' as const, reviewCount: 10 };
const PHONE = '+12133734253';

describe('scoring', () => {
  it('awards the full 100 only with all evidence', () => {
    const evidence = buildEvidence({
      business: OPEN,
      phone: PHONE,
      sitePhones: [PHONE],
      websiteLive: true,
      websiteParked: false,
      websiteMatch: true,
      emails: [email({})],
    });
    expect(scoreEvidence(evidence)).toBe(100);
    expect(evidence.emailSource).toBe('/contact');
  });

  it.each([
    ['closed business loses listing points', { business: { ...OPEN, businessStatus: 'permanently_closed' as const } }, 75],
    ['no reviews loses listing points', { business: { ...OPEN, reviewCount: 0 } }, 75],
    ['parked site loses website points', { websiteParked: true }, 75],
    ['site phone mismatch loses phone points', { sitePhones: ['+12133734254'] }, 80],
    ['unrelated free email earns no email points', { emails: [email({ kind: 'free', ownDomain: false, related: false })] }, 70],
    ['related free email earns partial points', { emails: [email({ kind: 'free', ownDomain: false })] }, 85],
    ['unknown MX earns no email points', { emails: [email({ mx: null })] }, 70],
    ['failed MX earns no email points', { emails: [email({ mx: false })] }, 70],
  ])('%s', (_name, change, expected) => {
    const evidence = buildEvidence({
      business: OPEN,
      phone: PHONE,
      sitePhones: [PHONE],
      websiteLive: true,
      websiteParked: false,
      websiteMatch: true,
      emails: [email({})],
      ...change,
    });
    expect(scoreEvidence(evidence)).toBe(expected);
  });

  it('assigns tiers at the boundaries', () => {
    expect([tierFor(100), tierFor(80), tierFor(79), tierFor(50), tierFor(49)]).toEqual([
      'high', 'high', 'medium', 'medium', 'low',
    ]);
  });

  it('prefers verified own-domain emails', () => {
    const ranked = rankEmails([
      email({ address: 'a@gmail.com', kind: 'free', ownDomain: false }),
      email({ address: 'info@acme.example', role: true }),
      email({ address: 'jane@acme.example' }),
    ]);
    expect(ranked.map((e) => e.address)).toEqual(['jane@acme.example', 'info@acme.example', 'a@gmail.com']);
  });
});

describe('crawlWebsite', () => {
  function site(pages: Record<string, { status?: number; body: string; type?: string }>): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      const url = String(input);
      const page = pages[url];
      if (!page) return new Response('missing', { status: 404 });
      const response = new Response(page.body, {
        status: page.status ?? 200,
        headers: { 'content-type': page.type ?? 'text/html' },
      });
      Object.defineProperty(response, 'url', { value: url });
      return response;
    }) as typeof fetch;
  }

  const HOME = '<title>Acme Plumbing</title><a href="/contact">Contact</a><a href="/about">About</a>';

  it('follows contact pages and records where each email was found', async () => {
    const result = await crawlWebsite('https://acme.example/', 'Acme Plumbing', 'acme.example', site({
      'https://acme.example/': { body: HOME },
      'https://acme.example/contact': { body: '<a href="tel:+12133734253">x</a> jane@acme.example' },
      'https://acme.example/about': { body: 'jane@acme.example team@acme.example' },
    }));
    expect(result).toMatchObject({ live: true, match: true, parked: false, pagesFetched: 3 });
    expect(result.emails).toEqual([
      { address: 'jane@acme.example', source: '/contact' },
      { address: 'team@acme.example', source: '/about' },
    ]);
    expect(result.phones).toEqual(['+12133734253']);
  });

  it('respects robots.txt on the homepage and on contact pages', async () => {
    const blocked = await crawlWebsite('https://acme.example/', 'Acme', null, site({
      'https://acme.example/robots.txt': { body: 'User-agent: *\nDisallow: /', type: 'text/plain' },
      'https://acme.example/': { body: HOME },
    }));
    expect(blocked).toMatchObject({ blockedByRobots: true, pagesFetched: 0 });

    const partial = await crawlWebsite('https://acme.example/', 'Acme', null, site({
      'https://acme.example/robots.txt': { body: 'User-agent: *\nDisallow: /contact', type: 'text/plain' },
      'https://acme.example/': { body: HOME },
      'https://acme.example/contact': { body: 'secret@acme.example' },
      'https://acme.example/about': { body: 'ok@acme.example' },
    }));
    expect(partial.emails.map((e) => e.address)).toEqual(['ok@acme.example']);
  });

  it('discards data from parked sites', async () => {
    const result = await crawlWebsite('https://acme.example/', 'Acme', null, site({
      'https://acme.example/': { body: 'This domain is for sale. sales@acme.example' },
    }));
    expect(result).toMatchObject({ live: true, parked: true, match: false, emails: [] });
  });

  it('explains why a website gave no data', async () => {
    const forbidden = site({ 'https://acme.example/': { status: 403, body: 'no' } });
    expect((await crawlWebsite('https://acme.example/', 'Acme', null, forbidden)).failure).toBe('Website returned 403');

    const offline = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect((await crawlWebsite('https://acme.example/', 'Acme', null, offline)).failure).toBe('Could not connect to website');

    const timeout = (async () => {
      throw Object.assign(new Error('slow'), { name: 'TimeoutError' });
    }) as unknown as typeof fetch;
    expect((await crawlWebsite('https://acme.example/', 'Acme', null, timeout)).failure).toBe('Website timed out');

    const empty = site({ 'https://acme.example/': { body: '<div id="root"></div>' } });
    expect(await crawlWebsite('https://acme.example/', 'Acme', null, empty)).toMatchObject({
      live: true,
      failure: 'Website has little readable text, and may need JavaScript',
    });
  });

  it('never contacts private addresses', async () => {
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response('');
    }) as unknown as typeof fetch;
    expect((await crawlWebsite('http://192.168.0.1/', 'Acme', null, spy)).live).toBe(false);
    expect(called).toBe(false);
  });

  it('reports unreachable and non-HTML sites as not live', async () => {
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect((await crawlWebsite('https://acme.example/', 'Acme', null, down)).live).toBe(false);
    const pdf = site({ 'https://acme.example/': { body: '%PDF', type: 'application/pdf' } });
    expect((await crawlWebsite('https://acme.example/', 'Acme', null, pdf)).live).toBe(false);
  });
});
