import { BUTTON_ICON_PATHS, BUTTON_ICON_SIZE, type ButtonIconKind } from './button-icons.js';

/** Decorative: the existing button text remains its accessible name. */
export function ButtonIcon({ kind }: { kind: ButtonIconKind }) {
  return <svg className="gpu-button-icon" width={BUTTON_ICON_SIZE} height={BUTTON_ICON_SIZE} viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" focusable="false"><path d={BUTTON_ICON_PATHS[kind]} /></svg>;
}
