/** Aviso flutuante com título, passos opcionais e um botão de ação. Um de cada vez. */

export interface ToastOptions {
  title: string;
  steps?: string[];
  action?: { label: string; run: () => void };
  /** Chamado quando o utilizador fecha no ×. */
  onClose?: () => void;
  autoHideMs?: number;
}

export class Toast {
  private readonly title: HTMLElement;
  private readonly steps: HTMLOListElement;
  private readonly action: HTMLButtonElement;
  private current: ToastOptions | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly el: HTMLElement) {
    this.title = el.querySelector('.toast-title')!;
    this.steps = el.querySelector('.toast-steps')!;
    this.action = el.querySelector('.toast-action')!;
    this.action.addEventListener('click', () => {
      const run = this.current?.action?.run;
      this.hide();
      run?.();
    });
    el.querySelector('.toast-close')!.addEventListener('click', () => {
      const onClose = this.current?.onClose;
      this.hide();
      onClose?.();
    });
  }

  show(opts: ToastOptions): void {
    clearTimeout(this.timer);
    this.current = opts;
    this.title.textContent = opts.title;
    this.steps.replaceChildren(
      ...(opts.steps ?? []).map((s) => {
        const li = document.createElement('li');
        li.textContent = s;
        return li;
      }),
    );
    this.steps.hidden = !opts.steps?.length;
    this.action.hidden = !opts.action;
    this.action.textContent = opts.action?.label ?? '';
    this.el.hidden = false;
    if (opts.autoHideMs) this.timer = setTimeout(() => this.hide(), opts.autoHideMs);
  }

  hide(): void {
    clearTimeout(this.timer);
    this.current = null;
    this.el.hidden = true;
  }
}
