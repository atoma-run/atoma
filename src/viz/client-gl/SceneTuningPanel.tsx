import { ButtonIcon } from './ButtonIcon.js';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  SCENE_TUNING_WIDTH,
  SCENE_TUNING_WINDOW_MARGIN,
  TUNING_IDENTITY,
  TUNING_KEYS,
  TUNING_RANGE,
  clampSceneTuningPosition,
  type SceneTuningPosition,
  type VizTuning,
} from './tuning.js';
import { readTuning, resetTuning, setTuningValue } from './tuning-live.js';
import { VIZ_WIREFRAME_MODE, wireframeModeUrl, type VizWireframeMode } from './wireframe-mode.js';
import { useGpuStore } from './store.js';
import { sceneCameraViewport, unprojectScenePointInFrame } from './scene-camera.js';
import { translate } from '../client/i18n-catalog.js';

const DEFAULT_TOP = 64;

function initialPosition(): SceneTuningPosition {
  if (typeof window === 'undefined') {
    return { x: SCENE_TUNING_WINDOW_MARGIN, y: DEFAULT_TOP };
  }
  return {
    x: Math.max(
      SCENE_TUNING_WINDOW_MARGIN,
      window.innerWidth - SCENE_TUNING_WIDTH - SCENE_TUNING_WINDOW_MARGIN
    ),
    y: DEFAULT_TOP,
  };
}

function tuningSnapshot(): VizTuning {
  const current = readTuning();
  return Object.fromEntries(TUNING_KEYS.map((key) => [key, current[key]])) as unknown as VizTuning;
}

const WIREFRAME_CHOICES: ReadonlyArray<{ value: string; mode: VizWireframeMode; labelKey: string }> = [
  { value: 'off', mode: null, labelKey: 'tuning.wireframe.off' },
  { value: 'lines', mode: 'lines', labelKey: 'tuning.wireframe.lines' },
  { value: 'overlay', mode: 'overlay', labelKey: 'tuning.wireframe.overlay' },
];

function formatValue(key: keyof VizTuning, value: number): string {
  const range = TUNING_RANGE[key];
  return `${value.toFixed(range.step < 1 ? 2 : 0)}${range.unit}`;
}

export function SceneTuningPanel() {
  const locale = useGpuStore((state) => state.locale);
  const t = useCallback(
    (key: string) => translate(locale, key),
    [locale]
  );
  const open = useGpuStore((state) => state.tuningPanelOpen);
  // THE SAME VEIL EVERY OTHER DOM OVERLAY GETS. This window is `position:
  // fixed; z-index: 8` and its default corner is the top-right — exactly where
  // the Pixi account menu anchors — so while a chrome menu is open it painted
  // OVER the menu and kept its sliders clickable above it: the failure mode
  // 4ab40b4 and 01ed50c closed for every other overlay and missed here
  // (2026-08-27, 2.10). Read from the store rather than threaded through
  // GpuApp because this panel takes no props at all.
  const veiled = useGpuStore((state) => state.accountMenuOpen || state.localeMenuOpen);
  const panelRef = useRef<HTMLElement>(null);
  const drag = useRef<{ offsetX: number; offsetY: number } | null>(null);
  const [position, setPosition] = useState(initialPosition);
  const [values, setValues] = useState(tuningSnapshot);

  const clamp = (next: SceneTuningPosition): SceneTuningPosition => {
    const panel = panelRef.current;
    return clampSceneTuningPosition(
      next,
      window.innerWidth,
      window.innerHeight,
      panel?.offsetWidth ?? SCENE_TUNING_WIDTH,
      panel?.offsetHeight ?? 0
    );
  };

  const pointerOnScene = (event: ReactPointerEvent<HTMLElement>) => {
    const viewport = sceneCameraViewport(panelRef.current);
    if (!viewport) return { x: event.clientX, y: event.clientY };
    return unprojectScenePointInFrame({ x: event.clientX, y: event.clientY }, viewport);
  };

  useEffect(() => {
    if (!open) return;
    const resize = () => setPosition((current) => clamp(current));
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [open]);

  if (!open) return null;

  const startMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!panelRef.current) return;
    const pointer = pointerOnScene(event);
    drag.current = { offsetX: pointer.x - position.x, offsetY: pointer.y - position.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const move = (event: ReactPointerEvent<HTMLElement>) => {
    if (!drag.current) return;
    const pointer = pointerOnScene(event);
    setPosition(clamp({
      x: pointer.x - drag.current.offsetX,
      y: pointer.y - drag.current.offsetY,
    }));
  };

  const stopMove = (event: ReactPointerEvent<HTMLElement>) => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const slider = (key: keyof VizTuning) => {
    const range = TUNING_RANGE[key];
    return (
      <div key={key} className="gpu-scene-tuning__row">
        <label htmlFor={`scene-tuning-${key}`}>{t(range.labelKey)}</label>
        <input
          id={`scene-tuning-${key}`}
          name={key}
          type="range"
          min={range.min}
          max={range.max}
          step={range.step}
          value={values[key]}
          onChange={(event) => {
            const value = Number(event.target.value);
            setTuningValue(key, value);
            setValues((current) => ({ ...current, [key]: value }));
          }}
        />
        <output>{formatValue(key, values[key])}</output>
      </div>
    );
  };

  return (
    <aside
      ref={panelRef}
      className={`gpu-panel-skin gpu-scene-tuning${veiled ? ' gpu-overlays-veiled' : ''}`}
      aria-label={t('tuning.title')}
      inert={veiled}
      // The clip is expressed in the element's OWN box, so every veiled
      // overlay restates its origin. The others do it in CSS because their
      // position is CSS; this one is dragged, so its origin is state and the
      // variables are inline for the same reason `left`/`top` are.
      style={
        {
          left: position.x,
          top: position.y,
          '--gpu-overlay-left': `${position.x}px`,
          '--gpu-overlay-top': `${position.y}px`,
        } as CSSProperties
      }
    >
      <header
        className="gpu-scene-tuning__header"
        onPointerDown={startMove}
        onPointerMove={move}
        onPointerUp={stopMove}
        onPointerCancel={stopMove}
      >
        <strong>{t('tuning.title').toUpperCase()}</strong>
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => {
            resetTuning();
            setValues({ ...TUNING_IDENTITY });
          }}
        ><ButtonIcon kind="refresh" />
          {t('tuning.reset').toUpperCase()}
        </button>
      </header>
      <div className="gpu-scene-tuning__rows">
        {TUNING_KEYS.map(slider)}
      </div>
      <h3 className="gpu-scene-tuning__section">{t('tuning.diagnostics')}</h3>
      <div className="gpu-scene-tuning__rows">
        <div className="gpu-scene-tuning__row gpu-scene-tuning__row--choice">
          <label htmlFor="scene-tuning-wireframe">{t('tuning.wireframe')}</label>
          <select
            id="scene-tuning-wireframe"
            aria-describedby="scene-tuning-wireframe-note"
            value={WIREFRAME_CHOICES.find((choice) => choice.mode === VIZ_WIREFRAME_MODE)?.value ?? 'off'}
            onChange={(event) => {
              const choice = WIREFRAME_CHOICES.find((option) => option.value === event.target.value);
              // Wired into the GL context at init: switching it is a reload.
              if (choice) window.location.assign(wireframeModeUrl(choice.mode, window.location.href));
            }}
          >
            {WIREFRAME_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>{t(choice.labelKey)}</option>
            ))}
          </select>
        </div>
        <p id="scene-tuning-wireframe-note" className="gpu-scene-tuning__note">{t('tuning.wireframe.reloads')}</p>
      </div>
    </aside>
  );
}
