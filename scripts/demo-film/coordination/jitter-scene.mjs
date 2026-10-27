// Unapplied MCP proposal. The actual prototype was created with Jitter's
// integrated design assistant; see jitter-project.json for the editable source.
export const createCoordinationScene = async (conf, actions) => {
  const board = conf.artboards[0].id;
  const c = { bg: '#050A16', panel: '#0B1422', card: '#101D2D', line: '#27384F', text: '#F5FAFF', muted: '#92A6BF', violet: '#A78BFA', amber: '#F6B84C', teal: '#38CDB5', coral: '#FF8A75', green: '#7DDEAB' };
  const ease = { schema: 'v1', name: 'smooth:standard:v1', config: { intensity: 65 } };
  const soft = { schema: 'v1', name: 'slowdown:standard:v1', config: { intensity: 55 } };
  actions.updateObj(board, { name: 'Supervision at every handoff', x: 0, y: 0, width: 1920, height: 1080, duration: 12000, background: true, fillColor: c.bg });
  const layer = (type, name, x, y, width, height, props, parent = board) => {
    const id = actions.createId();
    actions.addObj({ id, item: { type, name, x, y, width, height, angle: 0, scale: 1, opacity: 100, shadowEnabled: false, ...props } }, parent);
    return id;
  };
  const rect = (name, x, y, w, h, color, radius = 0, parent = board, extra = {}) => layer('rect', name, x, y, w, h, { background: true, fillColor: color, cornerRadius: radius, strokeEnabled: false, ...extra }, parent);
  const group = (name, x, y, w, h, parent = board, extra = {}) => layer('layerGrp', name, x, y, w, h, { background: false, cornerRadius: 0, strokeEnabled: false, clipsContent: false, ...extra }, parent);
  const text = (name, value, x, y, w, h, size, color = c.text, weight = 500, parent = board, extra = {}) => layer('text', name, x, y, w, h, { text: value, font: { type: 'googlefont', name: 'Inter', weight }, fontSize: size, lineHeight: 118, letterSpacing: 0, case: 'normal', ligatures: true, kerning: true, background: true, fillColor: color, strokeEnabled: false, verticalAlign: 'middle', textAlign: 'left', autoResize: 'none', characterStyleOverrides: [], styleOverrideTable: {}, ...extra }, parent);
  const circle = (name, x, y, size, color, parent = board, extra = {}) => layer('ellipse', name, x, y, size, size, { startAngle: 0, sweep: 100, ratio: 0, background: true, fillColor: color, strokeEnabled: false, ...extra }, parent);
  const path = (name, points, color, weight = 3, parent = board, extra = {}) => {
    const xs = points.map(p => p[0]);
    const ys = points.map(p => p[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const width = Math.max(1, Math.max(...xs) - x);
    const height = Math.max(1, Math.max(...ys) - y);
    return layer('shape', name, x, y, width, height, { path: { spline: { controls: points.map(p => ({ anchor: [(p[0] - x) / width, (p[1] - y) / height] })), closed: false } }, background: false, strokeEnabled: true, strokeColor: color, strokeWeight: weight, strokePosition: 'centered', strokeCap: 'round', strokeJoin: 'round', ...extra }, parent);
  };
  const polygon = (name, x, y, w, h, points, color, parent = board) => layer('shape', name, x, y, w, h, { path: { spline: { controls: points.map(anchor => ({ anchor })), closed: true } }, background: true, fillColor: color, strokeEnabled: false }, parent);
  const timelineGroup = name => {
    const id = actions.createId();
    actions.addObj({ id, item: { type: 'opGrp', name } }, board);
    return id;
  };
  const timelines = { intro: timelineGroup('01 · Establish three levels'), delegate: timelineGroup('02 · Delegate a task'), execute: timelineGroup('03 · Execute and return a result'), check: timelineGroup('04 · Check the evidence'), improve: timelineGroup('05 · Return for correction'), review: timelineGroup('06 · Review the checked phase') };
  const op = (type, targetId, startTime, endTime, props = {}, parent = timelines.intro) => {
    const id = actions.createId();
    actions.addObj({ id, item: { type, targetId, startTime, endTime, easing: ease, ...props } }, parent);
    return id;
  };
  const reveal = (id, start, end, parent) => op('fadeIn', id, start, end, {}, parent);
  const vanish = (id, start, end, parent) => op('fadeOut', id, start, end, {}, parent);
  const enterText = (id, start, end, parent = timelines.intro) => op('textIn', id, start, end, { effect: 'slideAndFade', nodeDuration: end - start, nodeEasing: soft, offset: 0, split: 'layer', order: 'forward', travelDistance: 14, slideDirection: 'up' }, parent);
  const shift = (id, start, end, dx, dy, parent) => op('move', id, start, end, { fromValue: { moveX: 0, moveY: 0 }, toValue: { moveX: dx, moveY: dy } }, parent);
  const checkMark = (name, x, y, size, color, parent) => path(name, [[x, y + size * 0.5], [x + size * 0.35, y + size * 0.85], [x + size, y]], color, 3.5, parent);
  const mark = group('Atoma crystal', 98, 72, 42, 42);
  polygon('Crystal · upper facet', 0, 0, 42, 42, [[0.5, 0.06], [0.95, 0.5], [0.05, 0.5]], c.amber, mark);
  polygon('Crystal · left facet', 0, 0, 42, 42, [[0.05, 0.5], [0.5, 0.5], [0.5, 0.96]], c.teal, mark);
  polygon('Crystal · right facet', 0, 0, 42, 42, [[0.95, 0.5], [0.5, 0.96], [0.5, 0.5]], c.violet, mark);
  polygon('Crystal · core', 0, 0, 42, 42, [[0.5, 0.37], [0.64, 0.5], [0.5, 0.64], [0.36, 0.5]], c.text, mark);
  text('Atoma wordmark', 'atoma', 160, 66, 200, 56, 38, c.text, 600);
  text('Chapter label', 'COORDINATION', 1380, 77, 442, 36, 20, c.muted, 500, board, { textAlign: 'right', letterSpacing: 2.5 });
  rect('Header divider', 96, 146, 1728, 1, '#213047');
  const headline = text('Main promise', 'Every handoff\nhas a check.', 96, 244, 600, 184, 68, c.text, 600, board, { lineHeight: 110, letterSpacing: -1.8 });
  enterText(headline, 100, 700);
  text('Supporting promise', 'Three levels. One supervision loop.', 100, 449, 570, 68, 27, c.muted, 400);
  rect('Diagram surface', 744, 174, 1080, 810, c.panel, 34, board, { strokeEnabled: true, strokeColor: '#19273A', strokeWeight: 1, strokePosition: 'inside', strokeCap: 'butt', strokeJoin: 'round' });
  text('Planning tier number', 'L3', 788, 238, 80, 40, 22, c.violet, 500);
  text('Supervision tier number', 'L2', 788, 488, 80, 40, 22, c.amber, 500);
  text('Execution tier number', 'L1', 788, 724, 80, 40, 22, c.teal, 500);
  path('Phase handoff', [[1260, 324], [1260, 438]], c.violet, 2.5, board, { opacity: 48 });
  polygon('Phase direction', 1253, 429, 14, 9, [[0, 0], [1, 0], [0.5, 1]], c.violet);
  path('Worker branch · left', [[1260, 578], [1260, 672], [920, 672], [920, 765]], c.line, 2.5);
  path('Worker branch · right', [[1260, 578], [1260, 672], [1600, 672], [1600, 765]], c.line, 2.5);
  path('Selected worker handoff', [[1260, 578], [1260, 764]], c.teal, 2.5, board, { opacity: 58 });
  polygon('Task direction', 1253, 756, 14, 9, [[0, 0], [1, 0], [0.5, 1]], c.teal);
  const route = group('Routing decision checkpoint', 1249, 650, 22, 22);
  rect('Routing decision diamond', 2, 2, 18, 18, c.amber, 3, route, { angle: 45 });
  reveal(route, 1350, 1550, timelines.delegate);
  vanish(route, 1920, 2100, timelines.delegate);
  const routeLabel = text('Routing decision label', 'Route', 1300, 640, 120, 42, 22, c.amber, 500);
  enterText(routeLabel, 1350, 1550, timelines.delegate);
  op('textOut', routeLabel, 1900, 2100, { effect: 'fadeOut', nodeDuration: 200, nodeEasing: ease, offset: 0, split: 'layer', order: 'forward' }, timelines.delegate);
  const packet = (name, label, x, y, width, accent, proof = false) => {
    const g = group(name, x, y, width, 60, board, { background: true, fillColor: '#17283C', cornerRadius: 16, strokeEnabled: true, strokeColor: accent, strokeWeight: 1.5, strokePosition: 'inside', strokeCap: 'round', strokeJoin: 'round', shadowEnabled: true, shadowOffsetX: 0, shadowOffsetY: 6, shadowBlur: 18, shadowColor: '#000000', shadowOpacity: 22 });
    rect(name + ' · file', 16, 17, 20, 26, accent, 4, g);
    rect(name + ' · file line', 20, 24, 11, 2, '#17283C', 1, g);
    rect(name + ' · file line two', 20, 31, 8, 2, '#17283C', 1, g);
    text(name + ' · label', label, 52, 11, width - (proof ? 110 : 65), 38, 23, c.text, 500, g);
    if (proof) {
      circle(name + ' · proof disc', width - 45, 15, 30, '#184838', g);
      checkMark(name + ' · evidence check', width - 38, 23, 17, c.green, g);
    }
    return g;
  };
  const phase = packet('Phase · downward handoff', 'Phase', 1180, 332, 160, c.violet);
  reveal(phase, 650, 850, timelines.delegate);
  shift(phase, 850, 1500, 0, 62, timelines.delegate);
  vanish(phase, 1450, 1650, timelines.delegate);
  const task = packet('Task · downward handoff', 'Task', 1180, 590, 160, c.teal);
  reveal(task, 1900, 2080, timelines.delegate);
  shift(task, 2050, 2800, 0, 116, timelines.delegate);
  vanish(task, 2780, 3000, timelines.delegate);
  const result = packet('Result · first attempt', 'Result', 1150, 710, 220, c.amber);
  reveal(result, 3890, 4100, timelines.execute);
  shift(result, 4100, 4770, 0, -106, timelines.execute);
  vanish(result, 5900, 6150, timelines.check);
  const correction = group('Targeted correction return path', 0, 0, 1920, 1080);
  path('Correction route', [[1394, 510], [1740, 510], [1740, 836], [1400, 836]], c.coral, 2.5, correction);
  polygon('Correction arrow', 1394, 829, 12, 14, [[1, 0], [0, 0.5], [1, 1]], c.coral, correction);
  reveal(correction, 5400, 5750, timelines.improve);
  vanish(correction, 7950, 8300, timelines.improve);
  const correctionPulse = circle('Correction travelling pulse', 1732, 502, 16, c.coral);
  reveal(correctionPulse, 5850, 5960, timelines.improve);
  shift(correctionPulse, 5920, 6720, 0, 326, timelines.improve);
  vanish(correctionPulse, 6700, 6860, timelines.improve);
  const proved = packet('Result with supporting evidence', 'Result', 1143, 710, 234, c.green, true);
  reveal(proved, 7860, 8090, timelines.improve);
  shift(proved, 8070, 8730, 0, -106, timelines.improve);
  vanish(proved, 9100, 9340, timelines.review);
  const phaseResult = packet('Checked phase · upward handoff', 'Checked', 1166, 394, 188, c.green, false);
  reveal(phaseResult, 9350, 9530, timelines.review);
  shift(phaseResult, 9510, 10100, 0, -60, timelines.review);
  vanish(phaseResult, 10050, 10270, timelines.review);
  const actor = (name, title, detail, x, y, w, h, accent, muted = false) => {
    const g = group(name, x, y, w, h, board, { background: true, fillColor: c.card, cornerRadius: 22, strokeEnabled: true, strokeColor: muted ? '#233246' : accent, strokeWeight: muted ? 1 : 1.5, strokePosition: 'inside', strokeCap: 'round', strokeJoin: 'round', opacity: muted ? 45 : 100 });
    rect(name + ' · accent', 0, 25, 4, h - 50, accent, 2, g);
    text(name + ' · title', title, 28, 15, w - 56, 46, 31, c.text, 600, g);
    text(name + ' · detail', detail, 30, 64, w - 60, 28, 19, accent, 500, g);
    return g;
  };
  const planning = actor('Role · L3 planning', 'Plan', 'Tissue', 1120, 214, 280, 106, c.violet);
  const supervision = actor('Role · L2 supervision', 'Supervise', 'Cell', 1120, 454, 280, 116, c.amber);
  const workerLeft = actor('Worker · available left', 'Execute', 'Molecule', 800, 782, 240, 108, c.teal, true);
  const worker = actor('Worker · selected executor', 'Execute', 'Molecule', 1140, 782, 240, 108, c.teal);
  const workerRight = actor('Worker · available right', 'Execute', 'Molecule', 1480, 782, 240, 108, c.teal, true);
  reveal(planning, 150, 500, timelines.intro);
  reveal(supervision, 300, 650, timelines.intro);
  reveal(workerLeft, 450, 750, timelines.intro);
  reveal(worker, 500, 800, timelines.intro);
  reveal(workerRight, 550, 850, timelines.intro);
  const tools = group('Executor-owned tools', 1140, 914, 240, 44);
  rect('Tools badge', 0, 0, 105, 42, '#142E30', 12, tools);
  text('Tools badge label', 'Tools', 0, 2, 105, 36, 20, c.teal, 500, tools, { textAlign: 'center' });
  rect('Files badge', 123, 0, 117, 42, '#142E30', 12, tools);
  text('Files badge label', 'Files', 123, 2, 117, 36, 20, c.teal, 500, tools, { textAlign: 'center' });
  path('Executor tool ownership', [[1260, 896], [1260, 908]], c.teal, 2);
  reveal(tools, 2850, 3120, timelines.execute);
  op('scale', worker, 2960, 3270, { fromValue: 1, toValue: 1.025 }, timelines.execute);
  op('scale', worker, 3500, 3820, { fromValue: 1.025, toValue: 1 }, timelines.execute);
  op('scale', tools, 3050, 3370, { fromValue: 1, toValue: 1.035 }, timelines.execute);
  op('scale', tools, 3500, 3810, { fromValue: 1.035, toValue: 1 }, timelines.execute);
  op('stroke', supervision, 4750, 5000, { fromValue: { strokeColor: c.amber, strokeWeight: 1.5 }, toValue: { strokeColor: c.coral, strokeWeight: 3 } }, timelines.check);
  op('stroke', supervision, 6500, 6750, { fromValue: { strokeColor: c.coral, strokeWeight: 3 }, toValue: { strokeColor: c.amber, strokeWeight: 1.5 } }, timelines.improve);
  op('scale', worker, 6840, 7170, { fromValue: 1, toValue: 1.025 }, timelines.improve);
  op('scale', worker, 7550, 7850, { fromValue: 1.025, toValue: 1 }, timelines.improve);
  op('scale', tools, 6920, 7240, { fromValue: 1, toValue: 1.035 }, timelines.improve);
  op('scale', tools, 7500, 7810, { fromValue: 1.035, toValue: 1 }, timelines.improve);
  op('stroke', supervision, 8760, 9070, { fromValue: { strokeColor: c.amber, strokeWeight: 1.5 }, toValue: { strokeColor: c.green, strokeWeight: 2.5 } }, timelines.review);
  const status = (name, label, x, y, width, accent, fill, start, end, parent, checked = false) => {
    const g = group(name, x, y, width, 62, board, { background: true, fillColor: fill, cornerRadius: 16, strokeEnabled: true, strokeColor: accent, strokeWeight: 1, strokePosition: 'inside', strokeCap: 'round', strokeJoin: 'round' });
    if (checked) checkMark(name + ' · check', 19, 23, 18, accent, g);
    else circle(name + ' · dot', 22, 25, 10, accent, g);
    text(name + ' · label', label, 55, 10, width - 70, 42, 22, accent, 500, g);
    reveal(g, start, start + 220, parent);
    if (end) vanish(g, end - 220, end, parent);
    return g;
  };
  status('Control · missing evidence', 'Evidence missing', 1450, 374, 300, c.coral, '#302329', 4860, 6550, timelines.check);
  status('Control · checked phase', 'Phase checked', 1450, 374, 280, c.green, '#142D28', 8820, 0, timelines.review, true);
  status('Root · delivery review', 'Review deliverable', 1450, 238, 310, c.violet, '#211F36', 10220, 0, timelines.review);
  const steps = [
    { n: '01', verb: 'Delegate.', detail: 'The supervisor assigns a bounded task.', from: 0, to: 2940, color: c.violet, parent: timelines.delegate },
    { n: '02', verb: 'Execute.', detail: 'The executor uses tools to do the work.', from: 2940, to: 4700, color: c.teal, parent: timelines.execute },
    { n: '03', verb: 'Check.', detail: 'A result needs supporting evidence.', from: 4700, to: 6540, color: c.amber, parent: timelines.check },
    { n: '04', verb: 'Improve.', detail: 'Missing proof sends the task back.', from: 6540, to: 8550, color: c.coral, parent: timelines.improve },
    { n: '05', verb: 'Review.', detail: 'The checked phase returns to the plan.', from: 8550, to: 12000, color: c.green, parent: timelines.review }
  ];
  for (const step of steps) {
    const g = group('Story · ' + step.verb, 100, 590, 600, 176);
    rect('Step ' + step.n + ' · index plate', 0, 4, 58, 54, '#142034', 14, g);
    text('Step ' + step.n + ' · index', step.n, 0, 6, 58, 48, 23, step.color, 600, g, { textAlign: 'center' });
    text('Step ' + step.n + ' · action', step.verb, 83, -3, 490, 70, 45, step.color, 600, g);
    text('Step ' + step.n + ' · explanation', step.detail, 0, 83, 560, 90, 27, c.muted, 400, g, { verticalAlign: 'top', lineHeight: 130 });
    reveal(g, step.from + 50, step.from + 270, step.parent);
    if (step.to < 12000) vanish(g, step.to - 180, step.to, step.parent);
  }
  const evidence = group('Proof added · explanatory callout', 100, 802, 520, 68, board, { background: true, fillColor: '#112C27', cornerRadius: 18 });
  checkMark('Evidence callout check', 24, 23, 23, c.green, evidence);
  text('Evidence callout text', 'Result + supporting evidence', 72, 13, 425, 42, 24, c.green, 500, evidence);
  reveal(evidence, 8100, 8420, timelines.improve);
  for (let i = 0; i < 5; i++) {
    rect('Progress rail · segment ' + (i + 1), 100 + i * 108, 928, 94, 4, '#25334A', 2);
    const fill = rect('Progress · step ' + (i + 1), 100 + i * 108, 928, 94, 4, steps[i].color, 2);
    op('maskResizeIn', fill, steps[i].from, Math.min(steps[i].to, 11700), { zoomContent: false, anchor: 'w' }, steps[i].parent);
  }
  text('Concept disclosure', 'SUPERVISION LOOP  /  CONCEPT STUDY', 100, 962, 600, 34, 16, '#647990', 500, board, { letterSpacing: 1.4 });
  text('Closing line', 'Supervision at every handoff.', 746, 1002, 1078, 46, 24, c.muted, 400, board, { textAlign: 'center' });
};
