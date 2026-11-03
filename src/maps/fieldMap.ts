/**
 * Every Google Maps array position and CSS selector lives here. Google does not
 * document or stabilize these, so a format change should only need a fix in this file.
 */

export const RESPONSE = {
  /** Wrapper appended after the JSON body. */
  trailer: '/*""*/',
  /** Anti-hijacking prefix before the inner JSON. */
  innerPrefix: ")]}'",
  /** Each list path pairs with the path to the business inside a list row. */
  listLayouts: [
    { list: [64], row: [1] },
    { list: [0, 1], row: [14] },
  ],
} as const;

export const FIELDS = {
  placeId: [78],
  /** Used only when `placeId` is empty, so the lead still has a stable key. */
  fallbackIdA: [10],
  fallbackIdB: [1],
  name: [11],
  fullAddress: [39],
  street: [2, 0],
  city: [183, 1, 3],
  postalCode: [183, 1, 4],
  state: [183, 1, 5],
  country: [183, 1, 6],
  categories: [13],
  phone: [178, 0, 0],
  website: [7, 0],
  domain: [7, 1],
  rating: [4, 7],
  reviewCount: [4, 8],
  /** A non-null value here marks a profile that the owner has not claimed. */
  unclaimedMarker: [49],
  closedMarker: [88, 0],
  latitude: [9, 2],
  longitude: [9, 3],
  /** Rows of `[day, _, _, [[hoursText], ...]]`. */
  hours: [203, 0],
} as const;

export const CLOSED_MARKER_VALUE = 'CLOSED';

export const SELECTORS = {
  feed: '[role="feed"]',
  searchButton: ['#searchbox-searchbutton', 'div:has(> form) .mL3xi'],
  endOfList: '.HlvSq',
  resultLink: 'a.hfpxzc',
  resultCard: '[jsaction]:has(a.hfpxzc)',
} as const;

export const TEXT = {
  endOfList: "You've reached the end of the list",
  temporarilyClosed: 'Temporarily closed',
} as const;

export const PLACE_ID_IN_URL = /ChIJ[^?&/!:]+/;

export function isMapsSearchRequest(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl, 'https://www.google.com');
    if (!/(^|\.)google\.[a-z.]+$/.test(url.hostname) || url.pathname !== '/search') return false;
    return url.searchParams.get('tbm') === 'map';
  } catch {
    return false;
  }
}

export function isBlockedUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    return /(^|\.)google\.[a-z.]+$/.test(url.hostname) && url.pathname.startsWith('/sorry');
  } catch {
    return false;
  }
}
