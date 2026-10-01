import { afterEach, describe, expect, it, vi } from "vitest";
import { PollingScheduler } from "../../src/infrastructure/scheduler/PollingScheduler";
import { EventStatus } from "../../src/domain/value-objects/EventStatus";

let scheduler: PollingScheduler | undefined;

afterEach(() => {
  scheduler?.stop();
  scheduler = undefined;
});

describe("PollingScheduler (log de auditoría)", () => {
  it("registra latido por tick, resultado por evento y errores; omite los fuera de ventana", async () => {
    const lines: string[] = [];
    const execute = vi.fn().mockImplementation(async (id: string) => {
      if (id === "falla") throw new Error("ítem no encontrado");
      return {
        changed: true,
        newStatus: EventStatus.ONSALE,
        previousStatus: EventStatus.OFFSALE,
        notifications: { sent: 2, failed: 1 },
      };
    });

    scheduler = new PollingScheduler(
      [
        { id: "ok" },
        { id: "falla" },
        { id: "futuro", activeFrom: new Date(Date.now() + 60_000) },
      ],
      3600,
      { execute },
      { name: "test", log: (line) => lines.push(line) }
    );
    scheduler.start();

    await vi.waitFor(() => expect(lines.some((l) => l.includes("terminado"))).toBe(true));

    expect(lines).toContainEqual(expect.stringContaining("tick #1: 2 activo(s), 1 fuera de ventana"));
    expect(lines).toContainEqual(
      expect.stringContaining("ok: CAMBIO OFFSALE -> ONSALE, notificaciones: 2 enviadas, 1 fallidas")
    );
    expect(lines).toContainEqual(expect.stringContaining("falla: ERROR ítem no encontrado"));
    expect(execute).not.toHaveBeenCalledWith("futuro");
  });
});
