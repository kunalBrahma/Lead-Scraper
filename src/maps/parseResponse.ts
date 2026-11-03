import { z } from 'zod';
import type { BusinessStatus, MapsBusiness } from '@/lib/types';
import { CLOSED_MARKER_VALUE, FIELDS, RESPONSE } from './fieldMap';

function at(source: unknown, path: readonly number[]): unknown {
  let current = source;
  for (const index of path) {
    if (!Array.isArray(current)) return undefined;
    current = current[index];
  }
  return current;
}

function text(source: unknown, path: readonly number[]): string | null {
  const value = at(source, path);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function num(source: unknown, path: readonly number[]): number | null {
  const value = at(source, path);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Drops anything but real web links, because this value is shown and fetched later. */
export function safeWebUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function formatHours(rows: unknown): string | null {
  if (!Array.isArray(rows)) return null;
  const days = rows.flatMap((row) => {
    const day = at(row, [0]);
    const slots = at(row, [3]);
    if (typeof day !== 'string' || !Array.isArray(slots)) return [];
    const hours = slots.map((slot) => at(slot, [0])).filter((slot) => typeof slot === 'string');
    return [`${day}: ${hours.join(', ')}`];
  });
  return days.length ? days.join('; ') : null;
}

function mapsUrlFor(placeId: string): string | null {
  return placeId.startsWith('ChIJ')
    ? `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}`
    : null;
}

const businessSchema = z.object({
  placeId: z.string().min(1),
  name: z.string().min(1),
  rating: z.number().min(0).max(5).nullable(),
  reviewCount: z.number().int().min(0),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
});

/** Returns `null` when required fields are missing or out of range. */
export function parseBusiness(row: unknown): MapsBusiness | null {
  const placeId = text(row, FIELDS.placeId) ?? text(row, FIELDS.fallbackIdA) ?? text(row, FIELDS.fallbackIdB);
  const categories = at(row, FIELDS.categories);
  const status: BusinessStatus =
    at(row, FIELDS.closedMarker) === CLOSED_MARKER_VALUE ? 'permanently_closed' : 'open';

  const business: MapsBusiness = {
    placeId: placeId ?? '',
    name: text(row, FIELDS.name) ?? '',
    fullAddress: text(row, FIELDS.fullAddress),
    street: text(row, FIELDS.street),
    city: text(row, FIELDS.city),
    postalCode: text(row, FIELDS.postalCode),
    state: text(row, FIELDS.state),
    country: text(row, FIELDS.country),
    categories: Array.isArray(categories)
      ? categories.filter((c): c is string => typeof c === 'string')
      : [],
    phoneRaw: text(row, FIELDS.phone),
    website: safeWebUrl(text(row, FIELDS.website)),
    domain: text(row, FIELDS.domain)?.toLowerCase().replace(/^www\./, '') ?? null,
    rating: num(row, FIELDS.rating),
    reviewCount: num(row, FIELDS.reviewCount) ?? 0,
    claimed: at(row, FIELDS.unclaimedMarker) == null,
    businessStatus: status,
    latitude: num(row, FIELDS.latitude),
    longitude: num(row, FIELDS.longitude),
    mapsUrl: placeId ? mapsUrlFor(placeId) : null,
    hours: formatHours(at(row, FIELDS.hours)),
  };

  return businessSchema.safeParse(business).success ? business : null;
}

export interface ParsedResponse {
  /** False when the body could not be decoded at all, which suggests a format change. */
  readable: boolean;
  rowsAttempted: number;
  businesses: MapsBusiness[];
}

function decodeBody(body: string): unknown {
  let content = body.trim();
  if (content.endsWith(RESPONSE.trailer)) content = content.slice(0, -RESPONSE.trailer.length);
  if (content.startsWith('{')) {
    const inner = (JSON.parse(content) as { d?: unknown }).d;
    if (typeof inner !== 'string') throw new Error('Missing inner payload');
    content = inner;
  }
  if (content.startsWith(RESPONSE.innerPrefix)) content = content.slice(RESPONSE.innerPrefix.length);
  return JSON.parse(content);
}

export function parseSearchResponse(body: string): ParsedResponse {
  let decoded: unknown;
  try {
    decoded = decodeBody(body);
  } catch {
    return { readable: false, rowsAttempted: 0, businesses: [] };
  }

  for (const layout of RESPONSE.listLayouts) {
    const list = at(decoded, layout.list);
    if (!Array.isArray(list)) continue;
    const rows = list.map((entry) => at(entry, layout.row)).filter((row) => Array.isArray(row));
    if (!rows.length) continue;
    const businesses = rows.map(parseBusiness).filter((b): b is MapsBusiness => b !== null);
    return { readable: true, rowsAttempted: rows.length, businesses };
  }
  // A readable response with no rows is normal, such as the end of a result list.
  return { readable: true, rowsAttempted: 0, businesses: [] };
}
