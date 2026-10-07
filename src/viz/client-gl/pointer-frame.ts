/** Connect a trusted, same-origin output frame to the one Atoma cursor. */
export function connectPointerFrame(frame: HTMLIFrameElement): () => void {
  const child = frame.contentWindow;
  const doc = frame.contentDocument;
  if (!child || !doc) return () => {};
  frame.dataset['atomaPointerFrame'] = 'true';
  const syncCursor = () => doc.documentElement.classList.toggle('atoma-cursor-active',
    document.documentElement.classList.contains('atoma-cursor-active'));
  const observer = new MutationObserver(syncCursor);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  const style = doc.createElement('style');
  style.textContent = 'html.atoma-cursor-active, html.atoma-cursor-active * { cursor: none !important; }';
  doc.head.append(style);
  syncCursor();
  const move = (event: PointerEvent) => {
    const bounds = frame.getBoundingClientRect();
    const scaleX = frame.offsetWidth ? bounds.width / frame.offsetWidth : 1;
    const scaleY = frame.offsetHeight ? bounds.height / frame.offsetHeight : 1;
    window.dispatchEvent(new PointerEvent('pointermove', {
      clientX: bounds.left + (frame.clientLeft + event.clientX) * scaleX,
      clientY: bounds.top + (frame.clientTop + event.clientY) * scaleY,
      pointerType: event.pointerType,
    }));
  };
  const hide = () => window.dispatchEvent(new Event('pointercancel'));
  const out = (event: PointerEvent) => { if (event.relatedTarget === null) hide(); };
  child.addEventListener('pointermove', move, { passive: true });
  child.addEventListener('pointerout', out, { passive: true });
  child.addEventListener('pointercancel', hide);
  child.addEventListener('blur', hide);
  return () => {
    observer.disconnect();
    style.remove();
    doc.documentElement.classList.remove('atoma-cursor-active');
    delete frame.dataset['atomaPointerFrame'];
    child.removeEventListener('pointermove', move);
    child.removeEventListener('pointerout', out);
    child.removeEventListener('pointercancel', hide);
    child.removeEventListener('blur', hide);
  };
}
