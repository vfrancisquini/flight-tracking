import type { Map as MlMap } from 'maplibre-gl';

export const PLANE_ICON = 'plane';

// Silhueta apontada para norte numa caixa 32×32.
const PATH =
  'M16 1.5c1.1 0 1.9 1 1.9 2.4V11l11.6 6.6v3l-11.6-3.4v6.6l3.6 2.7v2.3L16 27.4l-5.5 1.4v-2.3l3.6-2.7v-6.6L2.5 20.6v-3L14.1 11V3.9c0-1.4.8-2.4 1.9-2.4z';

/** Regista o ícone como SDF para podermos pintá-lo com `icon-color`. */
export function addPlaneIcon(map: MlMap): void {
  const ratio = 2;
  const size = 32 * ratio;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D indisponível');
  ctx.scale(ratio, ratio);
  ctx.fillStyle = '#000';
  ctx.fill(new Path2D(PATH));
  map.addImage(PLANE_ICON, ctx.getImageData(0, 0, size, size), { sdf: true, pixelRatio: ratio });
}
