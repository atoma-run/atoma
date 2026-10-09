import { Container, Graphics, GraphicsPath } from 'pixi.js';
import { BUTTON_ICON_PATHS, BUTTON_ICON_SIZE, CHEVRON_SIZE, type ButtonIconKind } from '../button-icons.js';

const paths = new Map<ButtonIconKind, GraphicsPath>();
export function drawButtonIcon(parent: Container, kind: ButtonIconKind,
  x: number, y: number, color: number, size = BUTTON_ICON_SIZE): Graphics {
  let path = paths.get(kind);
  if (!path) { path = new GraphicsPath(BUTTON_ICON_PATHS[kind]); paths.set(kind, path); }
  const icon = new Graphics().path(path).stroke({ color, width: 1.8, cap: 'round', join: 'round' });
  icon.scale.set(size / 24);
  icon.position.set(x, y);
  icon.eventMode = 'none';
  parent.addChild(icon);
  return icon;
}

export function drawChevron(parent: Container, x: number, y: number, color: number,
  direction: 'down' | 'right' | 'up' | 'left' = 'down'): Graphics {
  const icon = drawButtonIcon(parent, 'down', x + CHEVRON_SIZE / 2, y + CHEVRON_SIZE / 2, color, CHEVRON_SIZE);
  icon.pivot.set(12, 12);
  icon.angle = { down: 0, right: -90, up: 180, left: 90 }[direction];
  return icon;
}
