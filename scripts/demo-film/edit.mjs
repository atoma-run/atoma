/**
 * The edit list. Each clip is a list of BEATS on one shot:
 *   { play: [from, to], speed? }   show that stretch of the shot
 *   { say: 'line', kicker? }       start a narration line (after the previous one)
 *   { hold: seconds | 'fit' }      freeze the frame; 'fit' = until the line ends
 * and any beat may carry a `label`, so camera moves, highlights and cards can
 * be timed as '@label+1s'. Other times are shot times: frames, or cues such as
 * 'typeCriteria+0.5s'. Camera targets name marks recorded during the shoot.
 */
export const CHAPTERS = ['Describe', 'Watch it build', 'Check the result', 'Keep and continue', 'Choose and learn'];

const NOW_BANNER = { rect: { x: 82, y: 190, width: 1256, height: 56 } };
const TIERS = { rect: { x: 1392, y: 305, width: 228, height: 165 } };

export const EDIT = [
  {
    shot: 'arrival',
    kicker: 'atoma',
    captionPos: 'top',
    start: { cx: 960, cy: 500, z: 1.35 },
    camera: [{ at: 0, dur: 12, to: { cx: 960, cy: 530, z: 1.04 } }],
    transition: { type: 'dip', seconds: 0.8 },
    beats: [
      { hold: 0.5 },
      { say: 'intro1' },
      { say: 'intro2' },
      { play: [0, 'entered'] },
      { hold: 'fit' },
    ],
  },
  {
    shot: 'arrival',
    in: 'entered',
    chapter: 0,
    beats: [
      { say: 'projects', kicker: 'Projects' },
      { play: ['entered', 'end'] },
    ],
  },
  {
    shot: 'projects',
    chapter: 0,
    camera: [
      { at: 30, dur: 1.4, to: { cx: 1055, cy: 330, z: 1.2 } },
      { at: 'importMode+0.4s', dur: 1.2, to: { cx: 1060, cy: 250, z: 1.45 } },
      { at: 'resetMode-0.1s', dur: 1.2, to: 'full' },
    ],
    highlights: [
      { mark: 'createFormImport', from: 'importMode+1.4s', to: 'resetMode-0.2s', label: 'Existing repository · a pull request per run', labelPos: 'below', pad: 6 },
    ],
    beats: [
      { play: [0, 'resetMode-0.2s'] },
      { hold: 'fit', min: 0.6 },
      { play: ['resetMode-0.2s', 'end'] },
    ],
  },
  {
    shot: 'compose',
    chapter: 0,
    camera: [
      { at: 'typeGoal-0.6s', dur: 1.2, to: { mark: 'goal', pad: 36 } },
      { at: 'typeCriteria-1.2s', dur: 1.3, to: { mark: 'criteria', pad: 30, maxZoom: 2.1 } },
      { at: 'started-1.6s', dur: 1.3, to: { cx: 960, cy: 330, z: 1.2 } },
    ],
    highlights: [
      { mark: 'criteriaFilled', from: '@readCriteria', to: 'started-1.7s', label: '4 HTTP checks · 2 review items', labelPos: 'below', pad: 6, dim: false },
      { mark: 'runRow', from: 'started+0.8s', to: '@end', label: 'Running', labelPos: 'below', pad: 6 },
    ],
    beats: [
      { play: [0, 'typeGoal'] },
      { say: 'goal', kicker: 'Describe the outcome' },
      { play: ['typeGoal', 'goalTyped'] },
      { hold: 'fit', min: 0.8 },
      { play: ['goalTyped', 'typeCriteria'] },
      { say: 'criteria', kicker: 'Acceptance criteria' },
      { play: ['typeCriteria', 'criteriaTyped'] },
      { hold: 'fit', min: 1, label: 'readCriteria' },
      { play: ['criteriaTyped', 'started+0.2s'] },
      { say: 'locked', kicker: 'Start the run' },
      { play: ['started+0.2s', 'end'] },
      { hold: 'fit', pad: 0.4 },
    ],
  },
  {
    shot: 'live',
    chapter: 1,
    camera: [
      { at: 'opened+1.4s', dur: 1.4, to: { cx: 600, cy: 430, z: 1.6 } },
      { at: '@tiers', dur: 1.4, to: { cx: 1600, cy: 320, z: 1.7 } },
    ],
    highlights: [
      { ...NOW_BANNER, from: 'opened+2.4s', to: 'opened+6.5s', label: 'What the run is doing right now', labelPos: 'below', pad: 4, dim: false },
      { ...TIERS, from: '@tiers+1.4s', to: '@end', label: 'Tissue → cell → molecule', labelPos: 'right', pad: 6 },
    ],
    beats: [
      { play: [0, 'opened'] },
      { say: 'live1', kicker: 'Live' },
      { play: ['opened', 'end'] },
      { say: 'live2', kicker: 'Three tiers', label: 'tiers' },
      { hold: 'fit', pad: 0.4 },
    ],
  },
  {
    shot: 'delivered',
    chapter: 2,
    camera: [
      { at: 6, dur: 1.4, to: { cx: 470, cy: 420, z: 1.85 } },
      { at: 'acceptanceOpen+0.2s', dur: 1.4, to: { cx: 1640, cy: 640, z: 1.75 } },
    ],
    highlights: [
      { mark: 'acceptanceCard', from: 30, to: 'acceptanceOpen', label: 'Final acceptance · approved', labelPos: 'below', pad: 5 },
    ],
    beats: [
      { say: 'delivered', kicker: 'Delivered' },
      { play: [0, 'acceptanceOpen-1.4s'] },
      { hold: 'fit' },
      { play: ['acceptanceOpen-1.4s', 'acceptanceOpen+0.8s'] },
      { say: 'acceptance', kicker: 'Checked against evidence' },
      { play: ['acceptanceOpen+0.8s', 'scrollChecklist'] },
      { hold: 'fit' },
      { say: 'checklist', kicker: 'Evidence per criterion' },
      { play: ['scrollChecklist', 'end'] },
      { hold: 'fit', min: 1, pad: 0.4 },
    ],
  },
  {
    shot: 'llm',
    chapter: 2,
    camera: [
      { at: 10, dur: 1.3, to: { cx: 470, cy: 330, z: 1.75 } },
      { at: 'executeOpen+0.2s', dur: 1.4, to: { cx: 1640, cy: 600, z: 1.75 } },
    ],
    highlights: [
      { mark: 'llmChip', from: 'filtered-0.6s', to: 'filtered+1.6s', label: 'LLM calls only', labelPos: 'right', pad: 5 },
      { mark: 'executeCard', from: '@readModels+4.5s', to: 'executeOpen', label: 'The worker’s call', labelPos: 'below', pad: 5 },
    ],
    beats: [
      { play: [0, 'filtered+0.3s'] },
      { say: 'models', kicker: 'Model calls' },
      { play: ['filtered+0.3s', 'executeOpen-0.6s'] },
      { hold: 'fit', label: 'readModels' },
      { play: ['executeOpen-0.6s', 'executeOpen+0.8s'] },
      { say: 'call', kicker: 'Every call, itemised' },
      { play: ['executeOpen+0.8s', 'end'] },
      { hold: 'fit', pad: 0.4 },
    ],
  },
  {
    shot: 'published',
    chapter: 3,
    camera: [{ at: 'end-2.6s', dur: 1.4, to: { cx: 1560, cy: 425, z: 2.3 } }],
    beats: [
      { play: [0, 'end-2.2s'] },
      { say: 'published', kicker: 'Published' },
      { play: ['end-2.2s', 'end'] },
      { hold: 'fit', pad: 0.4 },
    ],
  },
  {
    shot: 'partial',
    chapter: 3,
    camera: [
      { at: 60, dur: 1.3, to: { cx: 820, cy: 450, z: 1.45 } },
      { at: 'runOpen+0.3s', dur: 1.4, to: { cx: 1640, cy: 330, z: 1.8 } },
      { at: 'continued+0.3s', dur: 1.3, to: { mark: 'prefilled', pad: 40, maxZoom: 1.6 } },
    ],
    highlights: [
      { mark: 'partialRow', from: 95, to: 'runOpen-0.4s', label: 'Incomplete · work kept', labelPos: 'below', pad: 4, dim: false },
      { mark: 'continue', from: 'runOpen+3s', to: 'continued', label: 'Continue this project', labelPos: 'right', pad: 5 },
    ],
    beats: [
      { play: [0, 90] },
      { say: 'partial1', kicker: 'Incomplete, not lost' },
      { play: [90, 'runOpen-0.3s'] },
      { hold: 'fit' },
      { play: ['runOpen-0.3s', 'runOpen+1.2s'] },
      { say: 'partial2', kicker: 'In plain words' },
      { play: ['runOpen+1.2s', 'continued-1s'] },
      { hold: 'fit' },
      { play: ['continued-1s', 'continued+0.8s'] },
      { say: 'partial3', kicker: 'Continue' },
      { play: ['continued+0.8s', 'end'] },
      { hold: 'fit', pad: 0.4 },
    ],
  },
  {
    shot: 'settings',
    chapter: 4,
    camera: [
      { at: 'models+0.3s', dur: 1.3, to: { cx: 990, cy: 420, z: 1.9 } },
      { at: 'mcp+0.2s', dur: 1.0, to: { cx: 990, cy: 420, z: 1.9 } },
    ],
    beats: [
      { play: [0, 'models+0.4s'] },
      { say: 'tiers', kicker: 'Choose the models' },
      { play: ['models+0.4s', 'mcp-1s'] },
      { hold: 'fit' },
      { say: 'rerun', kicker: 'Compare' },
      { hold: 'fit' },
      { play: ['mcp-1s', 'mcp+0.6s'] },
      { say: 'mcp', kicker: 'Atoma MCP' },
      { play: ['mcp+0.6s', 'end'] },
      { hold: 'fit', pad: 0.4 },
    ],
  },
  {
    shot: 'learning',
    chapter: 4,
    camera: [
      { at: 50, dur: 1.3, to: { cx: 720, cy: 260, z: 1.6 } },
      { at: 200, dur: 1.3, to: { cx: 640, cy: 330, z: 1.55 } },
    ],
    highlights: [
      { mark: 'skillRow', from: 100, to: 190, label: 'Successes / failures', labelPos: 'below', pad: 4, dim: false },
      { mark: 'agentList', from: 275, to: '@end', pad: 6, dim: false },
    ],
    beats: [
      { play: [0, 100] },
      { say: 'skills', kicker: 'Shared learning' },
      { play: [100, 190] },
      { hold: 'fit' },
      { play: [190, 270] },
      { say: 'trust', kicker: 'Earned trust' },
      { play: [270, 'end'] },
      { hold: 'fit', pad: 0.5 },
    ],
  },
  {
    shot: 'arrival',
    in: 20,
    blur: 10,
    ripples: false,
    captions: false,
    transition: { type: 'dip', seconds: 0.7 },
    card: {
      from: '@start+0.3s', to: '@end', y: 400,
      lines: [
        { text: 'atoma', size: 110, weight: 700, gap: 120 },
        { text: 'Open source (AGPL-3.0) · self-hostable · 13 languages · 39 MCP tools', size: 34, weight: 500, color: '#cbd5e1', gap: 80 },
        { text: 'atoma.run   ·   github.com/atoma-run/atoma', size: 40, weight: 600, color: '#5eead4', gap: 110 },
        { text: 'Recorded on the atoma console, with sample data.', size: 22, weight: 400, color: '#94a3b8' },
      ],
    },
    beats: [
      { hold: 0.4, label: 'start' },
      { say: 'outro' },
      { play: [20, 190] },
      { hold: 'fit', pad: 1.4 },
    ],
    fadeOut: 1.2,
  },
];
