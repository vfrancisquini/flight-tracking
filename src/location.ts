/**
 * Localização do utilizador: estado da permissão, obtenção da posição com uma
 * nova tentativa, e mensagens de ajuda por plataforma. Sem DOM do mapa, para ser testável.
 */

export type PermState = 'granted' | 'prompt' | 'denied' | 'unknown';
export type LocateFailure = 'denied' | 'unavailable' | 'timeout' | 'unsupported' | 'insecure';
export type Platform = 'ios' | 'android' | 'other';

export interface GeoEnv {
  geolocation?: Geolocation;
  permissions?: Pick<Permissions, 'query'>;
  isSecureContext: boolean;
  userAgent: string;
  maxTouchPoints: number;
}

export function browserEnv(): GeoEnv {
  return {
    geolocation: 'geolocation' in navigator ? navigator.geolocation : undefined,
    permissions: navigator.permissions,
    isSecureContext: window.isSecureContext,
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
  };
}

export class LocateError extends Error {
  constructor(readonly kind: LocateFailure) {
    super(`geolocalização: ${kind}`);
  }
}

/**
 * Estado atual da permissão, sem pedir nada. "unknown" quando o navegador não
 * expõe a Permissions API (Safari antigo) — aí só tentando é que se sabe.
 */
export async function permissionState(env: GeoEnv): Promise<{ state: PermState; status: PermissionStatus | null }> {
  if (!env.permissions?.query) return { state: 'unknown', status: null };
  try {
    const status = await env.permissions.query({ name: 'geolocation' });
    const s = status.state;
    return { state: s === 'granted' || s === 'denied' || s === 'prompt' ? s : 'unknown', status };
  } catch {
    return { state: 'unknown', status: null };
  }
}

export function failureOf(err: unknown): LocateFailure {
  if (err instanceof LocateError) return err.kind;
  const code = (err as { code?: number } | null)?.code;
  if (code === 1) return 'denied';
  if (code === 3) return 'timeout';
  return 'unavailable';
}

/** Primeira tentativa rápida (rede/Wi-Fi, aceita posição recente). */
export const FAST: PositionOptions = { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 };
/** Segunda tentativa, com GPS e mais tempo. */
export const PRECISE: PositionOptions = { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 };

function getPosition(geo: Geolocation, opts: PositionOptions): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => geo.getCurrentPosition(resolve, reject, opts));
}

/**
 * Obtém a posição. Se a permissão ainda não foi decidida, é esta chamada que faz
 * o navegador perguntar — por isso deve partir de um toque do utilizador.
 * Permissão negada falha logo; falta de sinal ou demora tentam mais uma vez com GPS.
 */
export async function locate(env: GeoEnv): Promise<GeolocationPosition> {
  if (!env.isSecureContext) throw new LocateError('insecure');
  if (!env.geolocation) throw new LocateError('unsupported');
  try {
    return await getPosition(env.geolocation, FAST);
  } catch (first) {
    if (failureOf(first) === 'denied') throw new LocateError('denied');
    try {
      return await getPosition(env.geolocation, PRECISE);
    } catch (second) {
      throw new LocateError(failureOf(second));
    }
  }
}

export function platformOf(env: Pick<GeoEnv, 'userAgent' | 'maxTouchPoints'>): Platform {
  const ua = env.userAgent;
  // iPadOS identifica-se como Mac; distingue-se pelo ecrã tátil.
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && env.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'other';
}

/** Navegadores embutidos noutros apps, que muitas vezes não dão acesso à localização. */
export function isInAppBrowser(ua: string): boolean {
  return /FBAN|FBAV|Instagram|WhatsApp|Line\/|LinkedInApp|Twitter|GSA\/|; wv\)/.test(ua);
}

export interface Help {
  title: string;
  steps: string[];
}

export function failureHelp(kind: LocateFailure, env: Pick<GeoEnv, 'userAgent' | 'maxTouchPoints'>): Help {
  const platform = platformOf(env);
  const browser = platform === 'ios' ? 'Safari' : platform === 'android' ? 'Chrome' : 'navegador';
  const inApp = isInAppBrowser(env.userAgent)
    ? [`Você abriu o site dentro de outro app. Abra no ${browser} para usar a localização.`]
    : [];

  switch (kind) {
    case 'denied':
      return {
        title: 'A localização está bloqueada para este site',
        steps: [
          ...inApp,
          ...(platform === 'ios'
            ? [
                'No Safari, toque em “aA” (ou no ícone à esquerda do endereço) › Ajustes do Site › Localização › Permitir.',
                'Se continuar bloqueado: Ajustes do iPhone › Privacidade e Segurança › Serviços de Localização › Sites do Safari › Durante o Uso.',
              ]
            : platform === 'android'
              ? [
                  'Toque no ícone à esquerda do endereço › Permissões › Localização › Permitir.',
                  'Confira também se a Localização do celular está ligada (painel rápido).',
                ]
              : ['Clique no ícone à esquerda do endereço e permita a Localização para este site.']),
          'Depois toque de novo no botão de localização.',
        ],
      };
    case 'unavailable':
      return {
        title: 'Não foi possível obter a sua posição',
        steps: [
          ...inApp,
          platform === 'ios'
            ? 'Confira se os Serviços de Localização estão ligados em Ajustes › Privacidade e Segurança.'
            : 'Confira se a localização do aparelho está ligada.',
          'Depois toque de novo no botão de localização.',
        ],
      };
    case 'timeout':
      return {
        title: 'O GPS demorou demais para responder',
        steps: ['Tente de novo; com Wi-Fi ligado ou ao ar livre costuma ser mais rápido.'],
      };
    case 'unsupported':
      return { title: 'Este navegador não oferece localização', steps: inApp };
    case 'insecure':
      return { title: 'A localização só funciona em endereços https', steps: [] };
  }
}
