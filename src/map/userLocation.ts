import maplibregl, { type IControl, type Map as MlMap } from 'maplibre-gl';
import { fetchIpLocation } from '../api';
import { browserEnv, failureHelp, failureOf, locate, permissionState, type GeoEnv } from '../location';
import type { Toast } from '../toast';

const LOCATED_ZOOM = 9;
const HINT_DISMISSED_KEY = 'loc-hint-dismissed';

type ButtonState = 'idle' | 'locating' | 'active' | 'denied';

const ICON =
  '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="3.2" fill="currentColor"/>' +
  '<circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/>' +
  '<path d="M12 1.5v3.5M12 19v3.5M1.5 12H5M19 12h3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

/** Botão "centralizar em mim", no grupo de controlos do mapa. */
class LocateButton implements IControl {
  private container?: HTMLElement;
  readonly button = document.createElement('button');

  constructor(onClick: () => void) {
    this.button.type = 'button';
    this.button.className = 'locate-btn';
    this.button.innerHTML = ICON;
    this.button.addEventListener('click', onClick);
    this.setState('idle');
  }

  onAdd(): HTMLElement {
    this.container = document.createElement('div');
    this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    this.container.append(this.button);
    return this.container;
  }

  onRemove(): void {
    this.container?.remove();
  }

  setState(state: ButtonState): void {
    this.button.dataset.state = state;
    this.button.setAttribute('aria-busy', String(state === 'locating'));
    const label =
      state === 'locating'
        ? 'Procurando a sua localização…'
        : state === 'denied'
          ? 'Localização bloqueada — toque para ver como liberar'
          : 'Centralizar na minha localização';
    this.button.title = label;
    this.button.setAttribute('aria-label', label);
  }
}

function remember(key: string): void {
  try {
    localStorage.setItem(key, String(Date.now()));
  } catch {
    // sem armazenamento: o aviso volta na próxima visita
  }
}

function remembered(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

/**
 * Coloca o utilizador no mapa:
 * - abre no local aproximado pelo IP (sem pedir nada);
 * - se a permissão já foi dada, usa o GPS e centraliza;
 * - se ainda não foi decidida, convida a tocar em "Usar minha localização" —
 *   o pedido do navegador parte desse toque, como no Google Maps;
 * - se foi negada, o botão explica como liberar.
 */
export class UserLocation {
  readonly control: LocateButton;
  private readonly dot = document.createElement('div');
  private readonly marker = new maplibregl.Marker({ element: this.dot });
  private userMoved: boolean;
  private hasGps = false;
  private locating = false;

  constructor(
    private readonly map: MlMap,
    private readonly toast: Toast,
    private readonly opts: { urlView: boolean; onNote: (note: string) => void },
    private readonly env: GeoEnv = browserEnv(),
  ) {
    this.userMoved = opts.urlView;
    this.control = new LocateButton(() => void this.locateNow(true));
  }

  async start(): Promise<void> {
    this.map.on('dragstart', () => (this.userMoved = true));
    this.map.on('zoomstart', (e) => {
      if ('originalEvent' in e && e.originalEvent) this.userMoved = true;
    });

    void fetchIpLocation().then((ip) => {
      if (ip && !this.hasGps) this.place(ip.lat, ip.lon, true);
    });

    const { state, status } = await permissionState(this.env);
    status?.addEventListener('change', () => {
      if (status.state === 'granted' && !this.hasGps) void this.locateNow(false);
      else if (status.state === 'denied') this.control.setState('denied');
      else if (status.state === 'prompt') this.control.setState('idle');
    });

    if (state === 'granted') {
      void this.locateNow(false);
    } else if (state === 'denied') {
      this.control.setState('denied');
    } else if (!remembered(HINT_DISMISSED_KEY)) {
      this.toast.show({
        title: 'Ver os voos perto de você?',
        action: { label: 'Usar minha localização', run: () => void this.locateNow(true) },
        onClose: () => remember(HINT_DISMISSED_KEY),
      });
    }
  }

  /** `fromUser`: veio de um toque — centraliza sempre e mostra erros. */
  async locateNow(fromUser: boolean): Promise<void> {
    if (this.locating) return;
    this.locating = true;
    this.control.setState('locating');
    try {
      const pos = await locate(this.env);
      const { latitude: lat, longitude: lon } = pos.coords;
      this.hasGps = true;
      this.place(lat, lon, false);
      this.control.setState('active');
      remember(HINT_DISMISSED_KEY);
      if (fromUser || !this.userMoved) {
        this.toast.hide();
        this.center(lat, lon);
      } else {
        // Chegou depois de o utilizador mexer no mapa: não o arrastar sem pedir.
        this.toast.show({
          title: 'Localização encontrada',
          action: { label: 'Centralizar', run: () => this.center(lat, lon) },
          autoHideMs: 12_000,
        });
      }
    } catch (e) {
      const kind = failureOf(e);
      this.control.setState(kind === 'denied' ? 'denied' : this.hasGps ? 'active' : 'idle');
      if (fromUser) this.toast.show({ ...failureHelp(kind, this.env) });
    } finally {
      this.locating = false;
    }
  }

  private center(lat: number, lon: number): void {
    this.map.flyTo({ center: [lon, lat], zoom: Math.max(this.map.getZoom(), LOCATED_ZOOM), essential: true });
  }

  private place(lat: number, lon: number, approximate: boolean): void {
    this.dot.className = approximate ? 'me-dot approx' : 'me-dot';
    this.dot.title = approximate ? 'Sua localização aproximada (pelo IP)' : 'Sua localização';
    this.opts.onNote(approximate ? 'localização aproximada (IP)' : '');
    this.marker.setLngLat([lon, lat]).addTo(this.map);
    if (approximate && !this.userMoved) this.map.jumpTo({ center: [lon, lat], zoom: LOCATED_ZOOM });
  }
}
