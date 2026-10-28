import { UI_SCROLL_SHADOW } from './ui-layout.js';

const PANEL_SELECTOR = [
  '.gpu-project-mcp', '.gpu-a11y-bridge', '.gpu-announce-form',
  '.gpu-settings-tabs', '.gpu-settings-panel',
  '.gpu-assistant-content > .gpu-project-mcp-own-agent',
  '.gpu-assistant-markdown pre', '.gpu-assistant-markdown table', '.gpu-app textarea',
].join(',');

/** Clamp elastic overscroll; Chromium's RTL horizontal offsets run from -max to zero. */
export function scrollEdges(element: Pick<HTMLElement, 'scrollTop' | 'scrollLeft' | 'scrollHeight' | 'scrollWidth' | 'clientHeight' | 'clientWidth'>, rtl = false) {
  const maxY = Math.max(0, element.scrollHeight - element.clientHeight);
  const maxX = Math.max(0, element.scrollWidth - element.clientWidth);
  const y = Math.max(0, Math.min(maxY, element.scrollTop));
  const x = Math.max(0, Math.min(maxX, rtl ? maxX + element.scrollLeft : element.scrollLeft));
  return {
    top: element.clientHeight > 0 && y > 1,
    bottom: element.clientHeight > 0 && y < maxY - 1,
    left: element.clientWidth > 0 && x > 1,
    right: element.clientWidth > 0 && x < maxX - 1,
  };
}

/**
 * Sibling decorations leave the native scrollport, React children and geometry
 * intact. In particular, an overlay INSIDE a textarea or a scrolling grid can
 * change its scroll extent. These layers share the panel's clipping ancestors.
 * The file reader installs this in its script-disabled, same-origin document;
 * file-authored frames and generated applications are never traversed.
 */
export function installScrollShadows(doc: Document, selector = PANEL_SELECTOR): () => void {
  const win = doc.defaultView;
  if (!win) return () => {};
  const style = doc.createElement('style');
  style.textContent = `
    :is(${selector}), .atoma-shadow-scrollport { scrollbar-width: none !important; }
    :is(${selector})::-webkit-scrollbar, .atoma-shadow-scrollport::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
    .atoma-shadow-scrollport:focus-visible { outline: 2px solid #89c4ff; outline-offset: -2px; }
    .atoma-scroll-shadows { position: absolute; pointer-events: none !important; overflow: hidden; margin: 0 !important; padding: 0 !important; border: 0 !important; box-sizing: border-box; }
    .atoma-scroll-shadows > span { position: absolute; pointer-events: none !important; }
    .atoma-scroll-shadows[hidden], .atoma-scroll-shadows > [hidden] { display: none !important; }
  `;
  doc.head.append(style);
  const entries = new Map<HTMLElement, { overlay: HTMLDivElement; tabIndex: string | null; parent: HTMLElement }>();
  const parents = new Map<HTMLElement, { count: number; position: string }>();
  let frame = 0;
  let needsScan = true;
  const requestFrame = (callback: FrameRequestCallback) => win.requestAnimationFrame
    ? win.requestAnimationFrame(callback) : win.setTimeout(() => callback(0), 16);
  const cancelFrame = (id: number) => win.cancelAnimationFrame ? win.cancelAnimationFrame(id) : win.clearTimeout(id);
  const schedule = () => { if (!frame) frame = requestFrame(update); };
  const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
  const remove = (element: HTMLElement) => {
    const entry = entries.get(element)!;
    entry.overlay.remove();
    element.classList.remove('atoma-shadow-scrollport');
    if (entry.tabIndex === null) element.removeAttribute('tabindex');
    else element.setAttribute('tabindex', entry.tabIndex);
    resize?.unobserve(element);
    for (const child of element.children) resize?.unobserve(child);
    const parent = parents.get(entry.parent);
    if (parent && --parent.count === 0) {
      entry.parent.style.position = parent.position;
      parents.delete(entry.parent);
    }
    entries.delete(element);
  };
  function update() {
    frame = 0;
    if (needsScan) {
      needsScan = false;
      for (const [element, entry] of entries) {
        if (!element.isConnected || element.parentElement !== entry.parent) remove(element);
      }
      for (const candidate of doc.querySelectorAll<HTMLElement>(selector)) {
        if (entries.has(candidate) || candidate.closest('.atoma-scroll-shadows')) continue;
        const computed = win!.getComputedStyle(candidate);
        if (!/auto|scroll/.test(`${computed.overflowX} ${computed.overflowY}`)) continue;
        const parent = candidate.parentElement;
        if (!parent) continue;
        // Static parents gain a containing block only; the layer stays out of flow.
        if (win!.getComputedStyle(parent).position === 'static' &&
          computed.position !== 'fixed' && computed.position !== 'absolute') {
          const previous = parents.get(parent);
          if (previous) previous.count++;
          else { parents.set(parent, { count: 1, position: parent.style.position }); parent.style.position = 'relative'; }
        } else if (parents.has(parent)) parents.get(parent)!.count++;
        const overlay = doc.createElement('div');
        overlay.className = 'atoma-scroll-shadows';
        overlay.setAttribute('aria-hidden', 'true');
        const color = `rgba(${UI_SCROLL_SHADOW.color >> 16},${(UI_SCROLL_SHADOW.color >> 8) & 255},${UI_SCROLL_SHADOW.color & 255},${UI_SCROLL_SHADOW.opacity})`;
        for (const edge of ['top', 'bottom', 'left', 'right']) {
          const span = doc.createElement('span');
          span.dataset.edge = edge;
          const vertical = edge === 'top' || edge === 'bottom';
          span.style.cssText = vertical
            ? `left:0;right:0;height:${UI_SCROLL_SHADOW.depth}px;${edge}:0;background:radial-gradient(ellipse 50% 100% at 50% ${edge === 'top' ? '0%' : '100%'},${color},transparent)`
            : `top:0;bottom:0;width:${UI_SCROLL_SHADOW.depth}px;${edge}:0;background:radial-gradient(ellipse 100% 50% at ${edge === 'left' ? '0%' : '100%'} 50%,${color},transparent)`;
          overlay.append(span);
        }
        parent.append(overlay);
        const tabIndex = candidate.getAttribute('tabindex');
        candidate.classList.add('atoma-shadow-scrollport');
        entries.set(candidate, { overlay, tabIndex, parent });
        resize?.observe(candidate);
      }
    }
    for (const [element, entry] of entries) {
      if (!element.isConnected || element.parentElement !== entry.parent) { remove(element); continue; }
      const { overlay } = entry;
      const computed = win!.getComputedStyle(element);
      // Closed disclosures, hidden settings sections and veiled scenes paint no cues.
      overlay.hidden = !(element.checkVisibility?.({ visibilityProperty: true, opacityProperty: true }) ?? element.getClientRects().length > 0) ||
        element.clientWidth === 0 || element.clientHeight === 0;
      if (overlay.hidden) continue;
      for (const child of element.children) resize?.observe(child);
      const fixed = computed.position === 'fixed';
      overlay.style.position = fixed ? 'fixed' : 'absolute';
      // Both siblings share the same containing block and camera transform.
      // Layout offsets remain correct under perspective; viewport rectangles
      // would apply that transform a second time to a fixed overlay.
      const left = element.offsetLeft + element.clientLeft;
      const top = element.offsetTop + element.clientTop;
      const css = `position:${fixed ? 'fixed' : 'absolute'};left:${left}px;top:${top}px;width:${element.clientWidth}px;height:${element.clientHeight}px;border-radius:${computed.borderRadius};z-index:${computed.zIndex === 'auto' ? 1 : Number(computed.zIndex) + 1};opacity:${computed.opacity};clip-path:${computed.clipPath}`;
      if (overlay.style.cssText !== css) overlay.style.cssText = css;
      const edges = scrollEdges(element, computed.direction === 'rtl');
      if (entry.tabIndex === null && !element.matches('textarea,input,select,button,a[href]')) {
        if (Object.values(edges).some(Boolean)) { if (element.tabIndex !== 0) element.tabIndex = 0; }
        else if (element.hasAttribute('tabindex')) element.removeAttribute('tabindex');
      }
      for (const child of overlay.children) {
        const span = child as HTMLSpanElement;
        span.hidden = !edges[span.dataset.edge as keyof typeof edges];
      }
    }
  }
  const mutations = new MutationObserver(records => {
    // Ignore our own decoration writes, including resize positioning.
    const relevant = records.some(record => {
      const target = record.target as Element;
      if (target.closest?.('.atoma-scroll-shadows')) return false;
      if (record.type === 'attributes' && record.attributeName === 'tabindex') return false;
      if (record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(node =>
        node.nodeType === 1 && (node as Element).classList.contains('atoma-scroll-shadows'))) return false;
      return true;
    });
    if (relevant) { needsScan = true; schedule(); }
  });
  mutations.observe(doc.body, { childList: true, subtree: true, characterData: true, attributes: true });
  doc.addEventListener('scroll', schedule, { passive: true, capture: true });
  doc.addEventListener('input', schedule, true);
  win.addEventListener('resize', schedule);
  doc.fonts?.addEventListener('loadingdone', schedule);
  schedule();
  return () => {
    mutations.disconnect();
    resize?.disconnect();
    cancelFrame(frame);
    doc.removeEventListener('scroll', schedule, true);
    doc.removeEventListener('input', schedule, true);
    win.removeEventListener('resize', schedule);
    doc.fonts?.removeEventListener('loadingdone', schedule);
    for (const element of [...entries.keys()]) remove(element);
    style.remove();
  };
}
