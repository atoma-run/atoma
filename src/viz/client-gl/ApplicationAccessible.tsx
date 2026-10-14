import { useEffect, useRef } from 'react';
import { ButtonIcon } from './ButtonIcon.js';
import { buttonIconKind } from './button-icons.js';
import { applicationGuide } from './application-guide.js';
import type { LocalDockerState } from './local-docker.js';

export function ApplicationAccessible({ local, t, onActivate }: {
  local: LocalDockerState; t: (key: string) => string; onActivate?: (id: string) => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const focusNextStep = useRef(false);
  useEffect(() => {
    if (focusNextStep.current) { panel.current?.focus(); focusNextStep.current = false; }
  }, [local.step]);
  return <section ref={panel} tabIndex={-1} id="project-preview-panel" role="tabpanel" aria-labelledby="project-tab-preview">
    {applicationGuide(local, t).map((item, i) => item.kind === 'action'
      ? <button key={item.id} type="button" disabled={item.disabled} onClick={() => { focusNextStep.current = item.id.startsWith('localDocker.step.'); onActivate?.(item.id); }}>
          <ButtonIcon kind={buttonIconKind(item.id)} />{item.text}
        </button>
      : item.kind === 'heading' ? <h3 key={i}>{item.text}</h3>
      : <p key={i} role={item.kind === 'status' ? 'status' : undefined}>{item.text}</p>)}
  </section>;
}
