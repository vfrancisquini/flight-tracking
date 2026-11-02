/**
 * Dados oficiais do voo (FlightAware AeroAPI), reduzidos ao que o painel usa.
 * Partilhado entre o Worker, que tem a chave, e o cliente.
 */

export interface FlightAirport {
  iata: string | null;
  icao: string | null;
  city: string | null;
}

export interface OfficialFlight {
  status: string | null;
  cancelled: boolean;
  diverted: boolean;
  origin: FlightAirport | null;
  destination: FlightAirport | null;
  /** Datas em ISO 8601 (UTC). */
  scheduledOut: string | null;
  estimatedOut: string | null;
  actualOut: string | null;
  scheduledIn: string | null;
  estimatedIn: string | null;
  actualIn: string | null;
  /** Atrasos em segundos. */
  departureDelay: number | null;
  arrivalDelay: number | null;
  gateOrigin: string | null;
  terminalOrigin: string | null;
  gateDestination: string | null;
  terminalDestination: string | null;
  baggageClaim: string | null;
}

type Raw = Record<string, unknown>;

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const num = (v: unknown) => (typeof v === 'number' ? v : null);
const time = (v: unknown) => {
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : t;
};

function airport(raw: unknown): FlightAirport | null {
  const a = raw as Raw | null;
  return a ? { iata: str(a.code_iata), icao: str(a.code_icao), city: str(a.city) } : null;
}

/** A AeroAPI devolve vários voos com o mesmo identificador: o que está no ar, ou o de horário mais próximo. */
export function pickFlight(flights: Raw[], now: number): Raw | null {
  const airborne = flights.find((f) => f.actual_off && !f.actual_on && !f.cancelled);
  if (airborne) return airborne;
  const distance = (f: Raw) => Math.abs((time(f.estimated_out ?? f.scheduled_out) ?? Infinity) - now);
  return flights.reduce<Raw | null>((best, f) => (!best || distance(f) < distance(best) ? f : best), null);
}

export function parseOfficialFlight(body: unknown, now: number): OfficialFlight | null {
  const flights = (body as { flights?: Raw[] } | null)?.flights;
  const f = Array.isArray(flights) ? pickFlight(flights, now) : null;
  if (!f) return null;
  return {
    status: str(f.status),
    cancelled: f.cancelled === true,
    diverted: f.diverted === true,
    origin: airport(f.origin),
    destination: airport(f.destination),
    scheduledOut: str(f.scheduled_out),
    estimatedOut: str(f.estimated_out),
    actualOut: str(f.actual_out) ?? str(f.actual_off),
    scheduledIn: str(f.scheduled_in),
    estimatedIn: str(f.estimated_in) ?? str(f.estimated_on),
    actualIn: str(f.actual_in) ?? str(f.actual_on),
    departureDelay: num(f.departure_delay),
    arrivalDelay: num(f.arrival_delay),
    gateOrigin: str(f.gate_origin),
    terminalOrigin: str(f.terminal_origin),
    gateDestination: str(f.gate_destination),
    terminalDestination: str(f.terminal_destination),
    baggageClaim: str(f.baggage_claim),
  };
}
