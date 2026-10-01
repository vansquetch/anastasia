import { CheckEventAvailabilityPort, CheckEventAvailabilityResult } from "../../application/ports/in/CheckEventAvailabilityPort";
import { LogLine } from "../logging/FileLogger";

export interface WatchedEvent {
  id: string;
  // Ventana activa opcional: fuera de ella, el scheduler ni siquiera llama
  // al provider (evita pegarle a un sitio con protección anti-bot fuera de
  // las fechas en que de verdad importa vigilarlo).
  activeFrom?: Date;
  activeUntil?: Date;
}

export interface PollingSchedulerOptions {
  // Etiqueta para distinguir schedulers en el log (ej. "crowder:bts-world-tour-2026").
  name?: string;
  // Destino del log de auditoría (ver FileLogger). Por defecto no escribe nada.
  log?: LogLine;
}

function isActive(item: WatchedEvent, now: Date): boolean {
  if (item.activeFrom && now < item.activeFrom) return false;
  if (item.activeUntil && now > item.activeUntil) return false;
  return true;
}

function describeResult(result: CheckEventAvailabilityResult): string {
  const previous = result.previousStatus;
  if (previous === null) return `${result.newStatus} (primera lectura, solo línea base)`;
  if (!result.changed) return `${result.newStatus} (sin cambio)`;
  if (!result.notifications) return `CAMBIO ${previous} -> ${result.newStatus} (no notifica)`;
  const { sent, failed } = result.notifications;
  return `CAMBIO ${previous} -> ${result.newStatus}, notificaciones: ${sent} enviadas, ${failed} fallidas`;
}

export class PollingScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private tickCount = 0;
  private readonly name: string;
  private readonly log: LogLine;

  constructor(
    private readonly watchedEvents: WatchedEvent[],
    private readonly intervalSeconds: number,
    private readonly checkEventAvailability: CheckEventAvailabilityPort,
    options: PollingSchedulerOptions = {}
  ) {
    this.name = options.name ?? "scheduler";
    this.log = options.log ?? (() => {});
  }

  start(): void {
    if (this.timer) return;
    this.log(
      `[${this.name}] arrancado: ${this.watchedEvents.length} evento(s), intervalo ${this.intervalSeconds}s`
    );
    this.timer = setInterval(() => this.tick(), this.intervalSeconds * 1000);
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.log(`[${this.name}] detenido`);
    }
  }

  private async tick(): Promise<void> {
    const tickNumber = ++this.tickCount;

    // Evita ticks superpuestos si una vuelta anterior todavía no terminó
    // (ej. porque el rate limit de Ticketmaster obligó a esperar). Se deja
    // en el log: muchos saltos seguidos = el scheduler está trabado.
    if (this.running) {
      this.log(`[${this.name}] tick #${tickNumber} saltado: el anterior sigue corriendo`);
      return;
    }
    this.running = true;

    try {
      const startedAt = Date.now();
      const now = new Date(startedAt);
      const active = this.watchedEvents.filter((item) => isActive(item, now));

      // Línea de latido en cada tick, aunque todo esté fuera de ventana: es
      // la que permite verificar que la recurrencia se cumple en el servidor.
      this.log(
        `[${this.name}] tick #${tickNumber}: ${active.length} activo(s), ${this.watchedEvents.length - active.length} fuera de ventana`
      );

      for (const item of active) {
        const checkStartedAt = Date.now();
        try {
          const result = await this.checkEventAvailability.execute(item.id);
          this.log(`[${this.name}]   ${item.id}: ${describeResult(result)} (${Date.now() - checkStartedAt}ms)`);
          if (result.changed) {
            console.log(`[scheduler] ${item.id} cambió de estado -> ${result.newStatus}`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.log(`[${this.name}]   ${item.id}: ERROR ${message} (${Date.now() - checkStartedAt}ms)`);
          console.error(`[scheduler] error revisando ${item.id}:`, error);
        }
      }

      if (active.length > 0) {
        this.log(`[${this.name}] tick #${tickNumber} terminado en ${Date.now() - startedAt}ms`);
      }
    } finally {
      this.running = false;
    }
  }
}
