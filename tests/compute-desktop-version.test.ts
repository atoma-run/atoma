import { expect, it } from 'vitest';
import { computeDesktopVersion } from '../scripts/compute-desktop-version.mjs';
it('uses ordered native versions shared by every platform without changing package.json', () => {
  expect(computeDesktopVersion('0.4.0', undefined)).toBe('0.4.0');
  expect(computeDesktopVersion('0.4.0', '42')).toBe('0.4.42');
  expect(computeDesktopVersion('0.4.2', '43')).toBe('0.4.45');
});
it.each(['', '0', '-1', '1.5', '3+abc', '65536', '999999999999999999'])('refuses invalid native build numbers: %s', build => {
  expect(() => computeDesktopVersion('0.4.0', build)).toThrow();
});
