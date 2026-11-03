const FREE_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com', 'live.com',
  'msn.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'gmx.com',
  'gmx.de', 'mail.com', 'yandex.com', 'yandex.ru', 'zoho.com', 'comcast.net', 'verizon.net', 'att.net',
  'sbcglobal.net', 'bellsouth.net', 'cox.net', 'rediffmail.com', 'yahoo.co.in', 'yahoo.co.uk',
]);

const ROLE_LOCAL_PARTS = new Set([
  'info', 'contact', 'hello', 'sales', 'support', 'admin', 'office', 'help', 'service', 'enquiries',
  'enquiry', 'inquiries', 'team', 'billing', 'accounts', 'careers', 'jobs', 'marketing', 'reception',
]);

const PLACEHOLDER_ADDRESSES = new Set([
  'your@email.com', 'email@email.com', 'name@email.com', 'you@yourdomain.com', 'user@domain.com',
  'name@domain.com', 'email@domain.com', 'test@test.com', 'john@doe.com', 'johndoe@example.com',
]);

const PLACEHOLDER_LOCAL_PARTS = new Set([
  'dummy', 'dummytext', 'dummyemail', 'mymail', 'myemail', 'youremail', 'yourname', 'yourmail', 'sampleemail',
  'test', 'testemail', 'username', 'abc', 'xyz', 'emailaddress',
]);

const JUNK_DOMAINS = [
  'mailservice.com', 'wpenginepowered.com', 'wpengine.com', 'kinsta.cloud', 'pantheonsite.io', 'netlify.app', 'vercel.app',
  'herokuapp.com', 'example.com', 'example.org', 'domain.com', 'yourdomain.com', 'yoursite.com', 'sentry.io',
  'sentry-next.wixpress.com', 'wixpress.com', 'godaddy.com', 'squarespace.com', 'schema.org',
];

const NO_REPLY = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster)/;
const FILE_SUFFIX = /\.(png|jpe?g|gif|svg|webp|avif|css|js|ico|woff2?)$/;

export const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,24}/gi;

/** Returns a clean lowercase address, or `null` for placeholders and page-asset false positives. */
export function cleanEmail(raw: string): string | null {
  const address = raw.trim().toLowerCase().replace(/^mailto:/, '').split('?')[0]!.trim();
  const at = address.lastIndexOf('@');
  if (at <= 0 || address.length > 254) return null;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (local.length > 64 || !/^[a-z0-9._%+-]+$/.test(local)) return null;
  if (!/^[a-z0-9.-]+\.[a-z]{2,24}$/.test(domain)) return null;
  if (FILE_SUFFIX.test(address) || NO_REPLY.test(local)) return null;
  if (PLACEHOLDER_ADDRESSES.has(address) || PLACEHOLDER_LOCAL_PARTS.has(local)) return null;
  if (JUNK_DOMAINS.some((junk) => domain === junk || domain.endsWith(`.${junk}`))) return null;
  // Tracking IDs such as 8f3a9c1d2e4b5a6f7c8d9e0f@ are not contact addresses.
  if (/^[a-f0-9]{16,}$/.test(local)) return null;
  return address;
}

export function emailDomain(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1);
}

export function isFreeEmail(address: string): boolean {
  return FREE_DOMAINS.has(emailDomain(address));
}

export function isRoleEmail(address: string): boolean {
  return ROLE_LOCAL_PARTS.has(address.slice(0, address.lastIndexOf('@')));
}

/** True when the address uses the site's domain or a subdomain relationship of it. */
export function isOwnDomain(address: string, siteDomain: string | null): boolean {
  if (!siteDomain) return false;
  const site = siteDomain.toLowerCase().replace(/^www\./, '');
  const domain = emailDomain(address);
  return domain === site || domain.endsWith(`.${site}`) || site.endsWith(`.${domain}`);
}

const NAME_NOISE = new Set(['the', 'and', 'inc', 'llc', 'ltd', 'co', 'corp', 'company', 'group', 'of', 'pllc', 'open']);

function nameWords(name: string): string[] {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/['\u2019]s\b/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word && !NAME_NOISE.has(word));
}

function sharesRun(a: string, b: string, length: number): boolean {
  for (let i = 0; i + length <= a.length; i += 1) {
    if (b.includes(a.slice(i, i + length))) return true;
  }
  return false;
}

/**
 * True when an address plausibly belongs to the business: it uses the site's domain, or
 * contains a word from the name, the name's initials, or a run of the site's domain.
 */
export function isEmailRelated(address: string, businessName: string, siteDomain: string | null): boolean {
  if (isOwnDomain(address, siteDomain)) return true;
  const local = address.slice(0, address.lastIndexOf('@')).replace(/[^a-z0-9]/g, '');
  const domain = emailDomain(address);
  const stem = (value: string) => value.split('.')[0]!.replace(/[^a-z0-9]/g, '');
  const candidate = isFreeEmail(address) ? local : `${local} ${stem(domain)}`;

  const words = nameWords(businessName);
  if (words.some((word) => word.length >= 4 && candidate.includes(word))) return true;
  const initials = words.map((word) => word[0]).join('');
  if (initials.length >= 3 && candidate.split(' ').some((part) => part.startsWith(initials))) return true;
  if (siteDomain && sharesRun(stem(siteDomain.toLowerCase().replace(/^www\./, '')), candidate, 6)) return true;
  return false;
}
