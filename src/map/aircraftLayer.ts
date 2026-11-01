import type { GeoJSONSource, Map as MlMap, MapLayerMouseEvent } from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import { predictPosition, type AircraftStore } from '../store';
import { addPlaneIcon, PLANE_ICON } from './planeIcon';

const SOURCE = 'aircraft';
export const AIRCRAFT_LAYER = 'aircraft-icons';
const LABEL_LAYER = 'aircraft-labels';
/** Frequência de redesenho da extrapolação (ms). */
const FRAME_MS = 250;

/** Cor por altitude (metros), estilo radar. Selecionado sobrepõe-se. */
const COLOR = [
  'case',
  ['boolean', ['feature-state', 'selected'], false],
  '#ff2d55',
  ['get', 'ground'],
  '#8e8e93',
  ['==', ['get', 'alt'], null],
  '#c7c7cc',
  ['interpolate', ['linear'], ['get', 'alt'], 0, '#ffcc00', 3000, '#ff9500', 6000, '#34c759', 9000, '#0a84ff', 12000, '#bf5af2'],
] as const;

export class AircraftLayer {
  private selected: string | null = null;
  private raf = 0;
  private lastFrame = 0;

  constructor(
    private readonly map: MlMap,
    private readonly store: AircraftStore,
    private readonly onSelect: (hex: string | null) => void,
  ) {
    addPlaneIcon(map);
    map.addSource(SOURCE, { type: 'geojson', data: empty(), promoteId: 'hex' });
    map.addLayer({
      id: AIRCRAFT_LAYER,
      type: 'symbol',
      source: SOURCE,
      layout: {
        'icon-image': PLANE_ICON,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 3, 0.45, 8, 0.75, 12, 1],
        'icon-rotate': ['coalesce', ['get', 'heading'], 0],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: {
        'icon-color': COLOR as never,
        'icon-halo-color': 'rgba(0,0,0,0.6)',
        'icon-halo-width': 1,
      },
    });
    map.addLayer({
      id: LABEL_LAYER,
      type: 'symbol',
      source: SOURCE,
      minzoom: 8,
      layout: {
        'text-field': ['coalesce', ['get', 'callsign'], ''],
        'text-size': 11,
        'text-offset': [0, 1.6],
        'text-anchor': 'top',
        'text-optional': true,
      },
      paint: { 'text-color': '#f2f2f7', 'text-halo-color': 'rgba(0,0,0,0.75)', 'text-halo-width': 1.2 },
    });

    map.on('click', AIRCRAFT_LAYER, (e: MapLayerMouseEvent) => {
      const hex = e.features?.[0]?.properties?.hex as string | undefined;
      if (hex) this.select(hex);
      e.preventDefault();
    });
    map.on('click', (e) => {
      if (!e.defaultPrevented) this.select(null);
    });
    map.on('mouseenter', AIRCRAFT_LAYER, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', AIRCRAFT_LAYER, () => (map.getCanvas().style.cursor = ''));

    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  get selectedHex(): string | null {
    return this.selected;
  }

  select(hex: string | null): void {
    if (hex === this.selected) return;
    if (this.selected) this.map.setFeatureState({ source: SOURCE, id: this.selected }, { selected: false });
    this.selected = hex && this.store.byHex.has(hex) ? hex : null;
    if (this.selected) this.map.setFeatureState({ source: SOURCE, id: this.selected }, { selected: true });
    this.onSelect(this.selected);
  }

  /** Força redesenho imediato (ex.: chegaram dados novos). */
  render(): void {
    this.lastFrame = 0;
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
  }

  private loop(t: number): void {
    this.raf = requestAnimationFrame(this.loop);
    if (t - this.lastFrame < FRAME_MS) return;
    this.lastFrame = t;
    if (this.selected && !this.store.byHex.has(this.selected)) this.select(null);
    (this.map.getSource(SOURCE) as GeoJSONSource | undefined)?.setData(this.toGeoJSON(Date.now()));
  }

  private toGeoJSON(now: number): FeatureCollection {
    const features: Feature[] = [];
    for (const a of this.store.byHex.values()) {
      const p = predictPosition(a, now);
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { hex: a.hex, callsign: a.callsign, heading: a.heading, alt: a.altitudeM, ground: a.onGround },
      });
    }
    return { type: 'FeatureCollection', features };
  }
}

const empty = (): FeatureCollection => ({ type: 'FeatureCollection', features: [] });
