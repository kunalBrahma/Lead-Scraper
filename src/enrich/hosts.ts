const SOCIAL_HOSTS = [
  'facebook.com', 'fb.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com', 'tiktok.com',
  'youtube.com', 'yelp.com', 'nextdoor.com', 'linktr.ee', 'pinterest.com', 'angi.com', 'thumbtack.com',
];

/** Site builders where unrelated businesses can report the same bare domain. */
const SHARED_BUILDERS = ['b12sites.com', 'wixsite.com', 'godaddysites.com', 'business.site', 'weebly.com', 'square.site'];

function matches(domain: string, host: string): boolean {
  return domain === host || domain.endsWith(`.${host}`);
}

function clean(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, '');
}

/** True when the listed "website" is a profile on another platform, not the business's own site. */
export function isSocialHost(domain: string | null): boolean {
  if (!domain) return false;
  const host = clean(domain);
  return SOCIAL_HOSTS.some((social) => matches(host, social));
}

/** True when a domain cannot identify one company, so it must not be used to group listings. */
export function isSharedHost(domain: string | null): boolean {
  if (!domain) return false;
  const host = clean(domain);
  return isSocialHost(host) || SHARED_BUILDERS.includes(host);
}
