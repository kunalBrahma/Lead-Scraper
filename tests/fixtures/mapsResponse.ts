/**
 * Synthetic Maps data built from the positions in `fieldMap.ts`. It tests our code
 * against our own understanding of the format, so it cannot prove Google still uses it.
 * All businesses, numbers, and domains here are fictional.
 */

export interface FakeBusiness {
  placeId?: string;
  name?: string;
  phone?: string;
  website?: string;
  domain?: string;
  closed?: boolean;
  unclaimed?: boolean;
  rating?: number;
  reviews?: number;
}

function setPath(target: unknown[], path: number[], value: unknown): void {
  let current = target;
  path.slice(0, -1).forEach((index) => {
    current[index] ??= [];
    current = current[index] as unknown[];
  });
  current[path.at(-1)!] = value;
}

export function fakeRow(business: FakeBusiness): unknown[] {
  const row: unknown[] = [];
  if (business.placeId !== undefined) setPath(row, [78], business.placeId);
  if (business.name !== undefined) setPath(row, [11], business.name);
  setPath(row, [39], '100 Main St, Dallas, TX 75201');
  setPath(row, [2], ['100 Main St', 'Dallas, TX 75201']);
  setPath(row, [183, 1], [null, null, null, 'Dallas', '75201', 'Texas', 'US']);
  setPath(row, [13], ['Plumber', 'Contractor']);
  if (business.phone) setPath(row, [178, 0], [business.phone]);
  if (business.website) setPath(row, [7], [business.website, business.domain ?? null]);
  setPath(row, [4, 7], business.rating ?? 4.5);
  setPath(row, [4, 8], business.reviews ?? 25);
  setPath(row, [49], business.unclaimed ? [1] : null);
  if (business.closed) setPath(row, [88], ['CLOSED']);
  setPath(row, [9], [null, null, 32.78, -96.8]);
  setPath(row, [203], [[['Monday', 1, null, [['9 AM–5 PM']]]]]);
  return row;
}

/** Wraps rows the way the Maps search endpoint returns them. */
export function fakeResponse(rows: unknown[], layout: 'list64' | 'list0' = 'list64'): string {
  const inner: unknown[] = [];
  if (layout === 'list64') inner[64] = rows.map((row) => [null, row]);
  else {
    const entries = rows.map((row) => {
      const entry: unknown[] = [];
      entry[14] = row;
      return entry;
    });
    inner[0] = [null, entries];
  }
  return `${JSON.stringify({ c: 0, d: `)]}'\n${JSON.stringify(inner)}`, e: 'x', p: true, u: '' })}/*""*/`;
}
