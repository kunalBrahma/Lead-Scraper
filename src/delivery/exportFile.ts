import { bestEmail } from '@/lib/filters';
import type { Lead } from '@/lib/types';
import { toPayload } from './payload';

interface Column {
  header: string;
  value: (lead: Lead) => string | number | boolean | null;
}

/** Says what happened when the website was checked, so empty results can be explained. */
export function websiteCheck(lead: Lead): string {
  if (!lead.website) return 'No website';
  if (lead.enrichError) return lead.enrichError;
  if (lead.enrichStatus === 'done') return 'OK';
  return lead.enrichStatus === 'skipped' ? 'Not checked' : 'Waiting';
}

export const COLUMNS: Column[] = [
  { header: 'Name', value: (l) => l.name },
  { header: 'Score', value: (l) => l.score },
  { header: 'Rating', value: (l) => l.tier },
  { header: 'Phone', value: (l) => l.phone ?? l.phoneRaw },
  { header: 'Email', value: (l) => bestEmail(l)?.address ?? null },
  { header: 'All Emails', value: (l) => l.emails.map((e) => e.address).join('; ') },
  { header: 'Email Source', value: (l) => bestEmail(l)?.source ?? null },
  { header: 'Email Matches Business', value: (l) => bestEmail(l)?.related ?? null },
  { header: 'Website', value: (l) => l.website },
  { header: 'Domain', value: (l) => l.domain },
  { header: 'Website Check', value: websiteCheck },
  { header: 'Full Address', value: (l) => l.fullAddress },
  { header: 'Street', value: (l) => l.street },
  { header: 'City', value: (l) => l.city },
  { header: 'State', value: (l) => l.state },
  { header: 'Postal Code', value: (l) => l.postalCode },
  { header: 'Country', value: (l) => l.country },
  { header: 'Search Area', value: (l) => l.searchArea },
  { header: 'Categories', value: (l) => l.categories.join('; ') },
  { header: 'Google Rating', value: (l) => l.rating },
  { header: 'Reviews', value: (l) => l.reviewCount },
  { header: 'Claimed', value: (l) => l.claimed },
  { header: 'Status', value: (l) => l.businessStatus },
  { header: 'Hours', value: (l) => l.hours },
  { header: 'Facebook', value: (l) => l.socials.facebook ?? null },
  { header: 'Instagram', value: (l) => l.socials.instagram ?? null },
  { header: 'LinkedIn', value: (l) => l.socials.linkedin ?? null },
  { header: 'Twitter', value: (l) => l.socials.twitter ?? null },
  { header: 'YouTube', value: (l) => l.socials.youtube ?? null },
  { header: 'Latitude', value: (l) => l.latitude },
  { header: 'Longitude', value: (l) => l.longitude },
  { header: 'Maps URL', value: (l) => l.mapsUrl },
  { header: 'Place ID', value: (l) => l.placeId },
  { header: 'Keyword', value: (l) => l.keyword },
  { header: 'Context Level', value: (l) => l.context?.level ?? null },
  { header: 'Contact Name', value: (l) => l.context?.contactName?.name ?? null },
  { header: 'Contact Name Confidence', value: (l) => l.context?.contactName?.confidence ?? null },
  { header: 'Business Summary', value: (l) => l.context?.summary ?? null },
  { header: 'About', value: (l) => l.context?.about ?? null },
  { header: 'Services', value: (l) => l.context?.services.join('; ') ?? null },
  { header: 'Highlights', value: (l) => l.context?.highlights.map((h) => h.text).join(' | ') ?? null },
  { header: 'Chat Widget Detected', value: (l) => l.context?.signals.chatWidgets.join('; ') ?? null },
  { header: 'Booking Tool Detected', value: (l) => l.context?.signals.bookingTools.join('; ') ?? null },
  { header: 'Booking Link Detected', value: (l) => l.context?.signals.bookingLink ?? null },
  { header: 'Contact Form Detected', value: (l) => l.context?.signals.contactForm ?? null },
  { header: 'Other Tools Detected', value: (l) => l.context?.signals.otherTools.join('; ') ?? null },
  { header: 'Website Platform', value: (l) => l.context?.signals.platform ?? null },
  { header: 'Mobile Viewport Detected', value: (l) => l.context?.signals.mobileViewport ?? null },
  { header: 'Copyright Year', value: (l) => l.context?.signals.copyrightYear ?? null },
  { header: 'Collected At', value: (l) => new Date(l.collectedAt).toISOString() },
];

/** Scraped text can begin with `=` or similar, which spreadsheets would run as a formula. */
export function neutralizeFormula(value: string): string {
  // A plain international phone number holds only digits, so it cannot run as a formula.
  if (/^\+\d{7,15}$/.test(value)) return value;
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function csvCell(value: string | number | boolean | null): string {
  if (value === null) return '';
  if (typeof value !== 'string') return String(value);
  const safe = neutralizeFormula(value);
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function leadsToCsv(leads: Lead[]): string {
  const header = COLUMNS.map((column) => csvCell(column.header)).join(',');
  const rows = leads.map((lead) => COLUMNS.map((column) => csvCell(column.value(lead))).join(','));
  // The byte order mark tells Excel to read the file as UTF-8.
  return `﻿${[header, ...rows].join('\r\n')}\r\n`;
}

export function leadsToJson(leads: Lead[]): string {
  return JSON.stringify(leads.map(toPayload), null, 2);
}
