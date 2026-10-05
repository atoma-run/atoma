import { describe, expect, it } from 'vitest';
import {
  focusRailChromeLayout,
  sidebarLayout,
} from '../src/viz/client-gl/renderer/views/sidebar.js';
import type { ViewName } from '../src/viz/client-gl/store.js';

const destinations: ViewName[] = [
  'projects', 'runs', 'registry', 'skills', 'docs', 'burnin',
  'admin', 'journal', 'ledger', 'sentinel', 'announce',
];

describe('collapsed rail theme control', () => {
  it.each([600, 720, 900])('keeps the palette visible above the profile at %ipx', (bottom) => {
    const layout = focusRailChromeLayout(208, bottom, true);
    const rows = sidebarLayout(destinations, layout.navigationBottom, layout.navigationTop, true);
    const last = rows.at(-1);
    expect(layout.theme).not.toBeNull();
    expect(last!.y + last!.height).toBeLessThan(layout.theme!.y);
    expect(layout.theme!.y + layout.theme!.height).toBeLessThan(layout.profile!.y);
    expect(layout.profile!.y + layout.profile!.height).toBeLessThan(layout.bell!.y);
  });

  it('does not offer an account theme menu without an account', () => {
    expect(focusRailChromeLayout(208, 720, false).theme).toBeNull();
  });
});
