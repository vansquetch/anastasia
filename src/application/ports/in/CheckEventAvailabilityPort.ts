import { EventStatus } from "../../../domain/value-objects/EventStatus";

export interface CheckEventAvailabilityResult {
  changed: boolean;
  newStatus: EventStatus;
  // null = primera lectura del evento (solo fija la línea base, no notifica).
  previousStatus?: EventStatus | null;
  // Solo presente si el cambio disparó notificaciones.
  notifications?: { sent: number; failed: number };
}

export interface CheckEventAvailabilityPort {
  execute(eventId: string): Promise<CheckEventAvailabilityResult>;
}
