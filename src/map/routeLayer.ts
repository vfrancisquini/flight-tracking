import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import { greatCircle, routeFitsPosition } from '../geo';
import type { RouteStore } from '../routes';
import { predictPosition, type AircraftStore } from '../store';

const LINES = 'route-lines';
const AIRPORTS = 'route-airports';
const SELECTED_COLOR = '#ff2d55';

/**
 * Linhas de rota: tracejado até ao destino em todos os voos; o selecionado fica
 * em destaque, com o trecho já voado a cheio e os aeroportos identificados.
 * Tem de ser criada antes da camada dos aviões, para ficar por baixo deles.
 */
export class RouteLayer {
  constructor(
    private readonly map: MlMap,
    private readonly store: AircraftStore,
    private readonly routes: RouteStore,
  ) {
    map.addSource(LINES, { type: 'geojson', data: empty() });
    map.addSource(AIRPORTS, { type: 'geojson', data: empty() });
    map.addLayer({
      id: 'route-others',
      type: 'line',
      source: LINES,
      filter: ['==', ['get', 'part'], 'other'],
      paint: { 'line-color': '#c7c7cc', 'line-width': 1, 'line-opacity': ['get', 'opacity'], 'line-dasharray': [3, 3] },
    });
    map.addLayer({
      id: 'route-flown',
      type: 'line',
      source: LINES,
      filter: ['==', ['get', 'part'], 'flown'],
      paint: { 'line-color': SELECTED_COLOR, 'line-width': 2, 'line-opacity': 0.55 },
    });
    map.addLayer({
      id: 'route-ahead',
      type: 'line',
      source: LINES,
      filter: ['==', ['get', 'part'], 'ahead'],
      paint: { 'line-color': SELECTED_COLOR, 'line-width': 3, 'line-dasharray': [2, 2] },
    });
    map.addLayer({
      id: 'route-airport-dots',
      type: 'circle',
      source: AIRPORTS,
      paint: { 'circle-radius': 5, 'circle-color': SELECTED_COLOR, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 },
    });
    map.addLayer({
      id: 'route-airport-labels',
      type: 'symbol',
      source: AIRPORTS,
      layout: { 'text-field': ['get', 'label'], 'text-size': 13, 'text-offset': [0, 1], 'text-anchor': 'top', 'text-allow-overlap': true },
      paint: { 'text-color': '#fff', 'text-halo-color': 'rgba(0,0,0,0.85)', 'text-halo-width': 1.5 },
    });
  }

  update(selected: string | null, now: number): void {
    const lines: Feature[] = [];
    const airports: Feature[] = [];
    for (const a of this.store.byHex.values()) {
      const isSelected = a.hex === selected;
      if (!a.callsign || (a.onGround && !isSelected)) continue;
      const route = this.routes.get(a.callsign);
      if (!route) continue;
      const p = predictPosition(a, now);
      if (!routeFitsPosition(route.origin, route.destination, p)) continue;
      if (!isSelected) {
        lines.push(line(greatCircle(p, route.destination), { part: 'other', opacity: selected ? 0.12 : 0.4 }));
        continue;
      }
      lines.push(line(greatCircle(route.origin, p), { part: 'flown' }), line(greatCircle(p, route.destination), { part: 'ahead' }));
      for (const ap of [route.origin, route.destination]) {
        airports.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [ap.lon, ap.lat] },
          properties: { label: ap.iata ?? ap.icao ?? '' },
        });
      }
    }
    (this.map.getSource(LINES) as GeoJSONSource).setData({ type: 'FeatureCollection', features: lines });
    (this.map.getSource(AIRPORTS) as GeoJSONSource).setData({ type: 'FeatureCollection', features: airports });
  }
}

const line = (coordinates: [number, number][], properties: Record<string, unknown>): Feature => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates },
  properties,
});

const empty = (): FeatureCollection => ({ type: 'FeatureCollection', features: [] });
