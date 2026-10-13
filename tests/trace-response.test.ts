import { describe, expect, it } from 'vitest';
import { traceEncoding } from '../src/viz/traceResponse.js';

describe('trace response encoding negotiation', () => {
  it.each([
    [undefined, 'identity'], ['', 'identity'], ['identity', 'identity'],
    ['gzip, deflate, br', 'br'], ['gzip', 'gzip'], ['BR;Q=1, GZIP;q=0.5', 'br'],
    ['br;q=0.5,gzip;q=0.8', 'gzip'], ['br;q=0,gzip', 'gzip'],
    ['br;q=0,gzip;q=0', 'identity'], ['zstd', 'identity'],
    ['*', 'br'], ['br;q=0,*;q=1', 'gzip'], ['*;q=0', null],
    ['identity;q=0,*;q=0', null], ['identity;q=0,gzip', 'gzip'],
    ['gzip;q=0.5,identity;q=0.8', 'identity'],
    ['gzip;q=broken,br;q=2', 'identity'], ['br;q=0.000,gzip;q=1.000', 'gzip'],
  ] as const)('negotiates %s as %s', (header, expected) => {
    expect(traceEncoding(header)).toBe(expected);
  });
});
