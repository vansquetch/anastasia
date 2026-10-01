import { appendFileSync, mkdirSync, renameSync, statSync } from "fs";
import { dirname } from "path";

export type LogLine = (line: string) => void;

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** Hora de Colombia (UTC-5 fijo, sin horario de verano), ej. "2026-10-01T14:03:00.123-05:00". */
function bogotaTimestamp(date: Date): string {
  const shifted = new Date(date.getTime() - 5 * 60 * 60 * 1000);
  return shifted.toISOString().replace("Z", "-05:00");
}

/**
 * Log de texto en disco para auditar el scheduler después del hecho (`fly logs`
 * solo guarda un rato). Escritura síncrona: son pocas líneas por minuto y así
 * no se pierde nada si el proceso muere. Cuando pasa de `maxBytes` rota a
 * `<archivo>.1` (se pisa el anterior) para no llenar el volumen.
 *
 * Nunca lanza: un problema de disco no puede frenar al scheduler.
 */
export class FileLogger {
  private warned = false;

  constructor(
    private readonly filePath: string,
    private readonly maxBytes: number = DEFAULT_MAX_BYTES
  ) {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
    } catch {
      // se reporta en el primer write fallido
    }
  }

  readonly log: LogLine = (line) => {
    try {
      this.rotateIfNeeded();
      appendFileSync(this.filePath, `${bogotaTimestamp(new Date())} ${line}\n`);
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        console.error(`[FileLogger] no se pudo escribir en ${this.filePath}:`, error);
      }
    }
  };

  private rotateIfNeeded(): void {
    let size: number;
    try {
      size = statSync(this.filePath).size;
    } catch {
      return; // todavía no existe
    }
    if (size >= this.maxBytes) {
      renameSync(this.filePath, `${this.filePath}.1`);
    }
  }
}
