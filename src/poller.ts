/**
 * Polling com setTimeout encadeado (nunca sobrepõe pedidos), backoff
 * exponencial em erro e pausa quando o separador fica oculto.
 */
export class Poller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inFlight = false;
  private pending = false;
  private failures = 0;

  constructor(
    private readonly task: () => Promise<void>,
    private readonly intervalMs = 10_000,
    private readonly maxBackoffMs = 60_000,
  ) {
    document.addEventListener('visibilitychange', () => {
      if (!this.running) return;
      if (document.hidden) this.clear();
      else this.trigger();
    });
  }

  start(): void {
    this.running = true;
    this.trigger();
  }

  stop(): void {
    this.running = false;
    this.clear();
  }

  /** Corre já (ex.: o utilizador moveu o mapa). Se houver um pedido em curso, repete no fim. */
  trigger(): void {
    if (!this.running) return;
    if (this.inFlight) {
      this.pending = true;
      return;
    }
    this.clear();
    void this.run();
  }

  private async run(): Promise<void> {
    this.inFlight = true;
    try {
      await this.task();
      this.failures = 0;
    } catch (e) {
      this.failures++;
      console.warn('[poller]', e);
    } finally {
      this.inFlight = false;
    }
    if (!this.running || document.hidden) return;
    if (this.pending) {
      this.pending = false;
      void this.run();
      return;
    }
    const delay = this.failures ? Math.min(this.intervalMs * 2 ** this.failures, this.maxBackoffMs) : this.intervalMs;
    this.timer = setTimeout(() => void this.run(), delay);
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
