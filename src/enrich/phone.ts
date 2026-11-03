import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

function asCountry(country: string | null): CountryCode | undefined {
  return country && /^[A-Za-z]{2}$/.test(country) ? (country.toUpperCase() as CountryCode) : undefined;
}

/** Returns E.164 when the number has a valid format for the country. It cannot show the line works. */
export function normalizePhone(raw: string | null, country: string | null): string | null {
  if (!raw) return null;
  const parsed = parsePhoneNumberFromString(raw, asCountry(country));
  return parsed?.isValid() ? parsed.number : null;
}
