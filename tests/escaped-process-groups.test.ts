import { describe, expect, it } from 'vitest';
import { escapedProcessGroups, reapEscapedProcessGroups, type ProcessRow } from '../src/tools/sandbox.js';

/**
 * Run 9e134e49 (2026-10-24): inside the Compute worker (`docker run --init`,
 * 256-task limit), test runners launched Chromium in its own process group;
 * run_shell timeouts killed the runner's group and the browsers survived as
 * orphans of the container's init until every later build aborted.
 *
 * Process table of that container, simplified: 1 docker-init, 7 the worker.
 */
const INIT = { pid: 1, ppid: 0, pgid: 1 };
const WORKER = { pid: 7, ppid: 1, pgid: 7 };

describe('escapedProcessGroups', () => {
  it('selects a browser left behind by a killed test runner, with its whole group', () => {
    const table: ProcessRow[] = [INIT, WORKER,
      { pid: 500, ppid: 1, pgid: 500 },   // leaked Chromium, reparented to init
      { pid: 501, ppid: 500, pgid: 500 }, // its zygote
      { pid: 502, ppid: 1, pgid: 500 },   // its crash handler, double-forked
    ];
    expect(escapedProcessGroups(table, 7)).toEqual([500]);
  });

  it('keeps everything the worker still holds, including a crash handler of its own browser', () => {
    const table: ProcessRow[] = [INIT, WORKER,
      { pid: 20, ppid: 7, pgid: 20 },   // shared validate_html browser
      { pid: 21, ppid: 20, pgid: 20 },
      { pid: 22, ppid: 1, pgid: 20 },   // its crash handler: orphan, but its group is live
      { pid: 30, ppid: 7, pgid: 30 },   // start_node_server server
      { pid: 40, ppid: 7, pgid: 40 },   // another lane's command still running
      { pid: 41, ppid: 40, pgid: 40 },  // its test runner
      { pid: 42, ppid: 41, pgid: 42 },  // the browser that runner launched detached
    ];
    expect(escapedProcessGroups(table, 7)).toEqual([]);
  });

  it('never selects the init, the worker, an ancestor, or a group numbered 0 or 1', () => {
    const table: ProcessRow[] = [INIT,
      { pid: 5, ppid: 1, pgid: 5 },     // an entrypoint shell that did not exec
      { pid: 7, ppid: 5, pgid: 5 },     // the worker under it
      { pid: 60, ppid: 1, pgid: 1 },    // orphan in init's own group
      { pid: 61, ppid: 1, pgid: 0 },
    ];
    expect(escapedProcessGroups(table, 7)).toEqual([]);
  });

  it('selects each escaped group once, in order', () => {
    const table: ProcessRow[] = [INIT, WORKER,
      { pid: 900, ppid: 1, pgid: 900 }, { pid: 901, ppid: 1, pgid: 900 },
      { pid: 800, ppid: 1, pgid: 800 },
    ];
    expect(escapedProcessGroups(table, 7)).toEqual([800, 900]);
  });
});

it('does nothing outside a container whose init the worker does not own', () => {
  // On a developer machine or a host, ppid 1 is the whole system's orphans.
  expect(reapEscapedProcessGroups()).toEqual([]);
});
