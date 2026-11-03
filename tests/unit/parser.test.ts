import { describe, expect, it } from 'vitest';
import { buildSearchUrl, generateQueries, parseLines } from '@/lib/jobs';
import { isBlockedUrl, isMapsSearchRequest } from '@/maps/fieldMap';
import { parseBusiness, parseSearchResponse, safeWebUrl } from '@/maps/parseResponse';
import { fakeResponse, fakeRow } from '../fixtures/mapsResponse';

const FULL = {
  placeId: 'ChIJabc123',
  name: 'Acme Plumbing',
  phone: '(214) 555-0100',
  website: 'https://acmeplumbing.example/',
  domain: 'www.acmeplumbing.example',
};

describe('parseBusiness', () => {
  it('reads all mapped fields', () => {
    const lead = parseBusiness(fakeRow(FULL))!;
    expect(lead).toMatchObject({
      placeId: 'ChIJabc123',
      name: 'Acme Plumbing',
      city: 'Dallas',
      postalCode: '75201',
      state: 'Texas',
      country: 'US',
      phoneRaw: '(214) 555-0100',
      domain: 'acmeplumbing.example',
      rating: 4.5,
      reviewCount: 25,
      claimed: true,
      businessStatus: 'open',
      latitude: 32.78,
      longitude: -96.8,
      categories: ['Plumber', 'Contractor'],
      hours: 'Monday: 9 AM–5 PM',
    });
    expect(lead.mapsUrl).toContain('place_id:ChIJabc123');
  });

  it('marks closed and unclaimed businesses', () => {
    const lead = parseBusiness(fakeRow({ ...FULL, closed: true, unclaimed: true }))!;
    expect(lead.businessStatus).toBe('permanently_closed');
    expect(lead.claimed).toBe(false);
  });

  it('rejects rows with no name or no ID', () => {
    expect(parseBusiness(fakeRow({ placeId: 'ChIJx' }))).toBeNull();
    expect(parseBusiness(fakeRow({ name: 'No ID' }))).toBeNull();
    expect(parseBusiness('not a row')).toBeNull();
  });

  it('rejects out-of-range values, which signal shifted positions', () => {
    expect(parseBusiness(fakeRow({ ...FULL, rating: 45 }))).toBeNull();
  });

  it('drops websites that are not http or https', () => {
    expect(safeWebUrl('javascript:alert(1)')).toBeNull();
    expect(parseBusiness(fakeRow({ ...FULL, website: 'javascript:alert(1)' }))?.website).toBeNull();
  });
});

describe('parseSearchResponse', () => {
  it.each(['list64', 'list0'] as const)('reads the %s layout', (layout) => {
    const result = parseSearchResponse(fakeResponse([fakeRow(FULL)], layout));
    expect(result).toMatchObject({ readable: true, rowsAttempted: 1 });
    expect(result.businesses[0]?.name).toBe('Acme Plumbing');
  });

  it('counts unusable rows as attempted but not parsed', () => {
    const result = parseSearchResponse(fakeResponse([fakeRow(FULL), fakeRow({ placeId: 'ChIJy' })]));
    expect(result.rowsAttempted).toBe(2);
    expect(result.businesses).toHaveLength(1);
  });

  it('treats a readable response with no rows as normal', () => {
    expect(parseSearchResponse(fakeResponse([]))).toEqual({ readable: true, rowsAttempted: 0, businesses: [] });
  });

  it('flags undecodable bodies', () => {
    expect(parseSearchResponse('<html>nope</html>').readable).toBe(false);
    expect(parseSearchResponse('{"c":0}').readable).toBe(false);
  });
});

describe('URL rules', () => {
  it('recognizes Maps search requests only', () => {
    expect(isMapsSearchRequest('https://www.google.com/search?tbm=map&pb=1')).toBe(true);
    expect(isMapsSearchRequest('/search?tbm=map&pb=1')).toBe(true);
    expect(isMapsSearchRequest('https://www.google.com/search?q=hello')).toBe(false);
    expect(isMapsSearchRequest('https://evil.example/search?tbm=map')).toBe(false);
  });

  it('recognizes the block page', () => {
    expect(isBlockedUrl('https://www.google.com/sorry/index?continue=x')).toBe(true);
    expect(isBlockedUrl('https://www.google.com/maps/search/x')).toBe(false);
    expect(isBlockedUrl('https://evil.example/sorry/index')).toBe(false);
    expect(isBlockedUrl(undefined)).toBe(false);
  });
});

describe('job generation', () => {
  it('crosses keywords and locations and removes duplicates', () => {
    expect(generateQueries(parseLines('plumber\n PLUMBER \nroofer\n'), parseLines('Dallas\nAustin'))).toEqual([
      'plumber in Dallas',
      'plumber in Austin',
      'roofer in Dallas',
      'roofer in Austin',
    ]);
  });

  it('uses keywords as written without locations', () => {
    expect(generateQueries(['plumbers near Dallas'], [])).toEqual(['plumbers near Dallas']);
  });

  it('encodes queries so they cannot change the URL path', () => {
    expect(buildSearchUrl('a/b?c')).toBe('https://www.google.com/maps/search/a%2Fb%3Fc/?hl=en');
  });
});
