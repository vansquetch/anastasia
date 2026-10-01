import { describe, expect, it, vi } from "vitest";
import { CheckEventAvailability } from "../../src/application/use-cases/CheckEventAvailability";
import { NotifySubscribers } from "../../src/application/use-cases/NotifySubscribers";
import { EventProviderPort } from "../../src/application/ports/out/EventProviderPort";
import { EventStateRepositoryPort } from "../../src/application/ports/out/EventStateRepositoryPort";
import { Event } from "../../src/domain/entities/Event";
import { EventStatus } from "../../src/domain/value-objects/EventStatus";

function fakeEvent(status: EventStatus): Event {
  return new Event({
    id: "ticketmaster:1",
    providerId: "1",
    name: "Test Event",
    venue: "Test Venue",
    status,
    onSaleDate: null,
    lastCheckedAt: null,
    lastKnownStatus: null,
  });
}

describe("CheckEventAvailability", () => {
  it("notifica cuando el estado cambia a ONSALE", async () => {
    const eventProvider: EventProviderPort = {
      checkStatus: vi.fn().mockResolvedValue(EventStatus.ONSALE),
      findEventById: vi.fn().mockResolvedValue(fakeEvent(EventStatus.ONSALE)),
    };
    const eventStateRepository: EventStateRepositoryPort = {
      getLastKnownStatus: vi.fn().mockResolvedValue(EventStatus.OFFSALE),
      saveStatus: vi.fn().mockResolvedValue(undefined),
    };
    const notifySubscribers = { execute: vi.fn().mockResolvedValue([]) } as unknown as NotifySubscribers;

    const useCase = new CheckEventAvailability(eventProvider, eventStateRepository, notifySubscribers);
    const result = await useCase.execute("ticketmaster:1");

    expect(result).toEqual({
      changed: true,
      newStatus: EventStatus.ONSALE,
      previousStatus: EventStatus.OFFSALE,
      notifications: { sent: 0, failed: 0 },
    });
    expect(notifySubscribers.execute).toHaveBeenCalledOnce();
    expect(eventStateRepository.saveStatus).toHaveBeenCalledWith("ticketmaster:1", EventStatus.ONSALE);
  });

  it("no notifica si el estado no cambió", async () => {
    const eventProvider: EventProviderPort = {
      checkStatus: vi.fn().mockResolvedValue(EventStatus.ONSALE),
      findEventById: vi.fn(),
    };
    const eventStateRepository: EventStateRepositoryPort = {
      getLastKnownStatus: vi.fn().mockResolvedValue(EventStatus.ONSALE),
      saveStatus: vi.fn().mockResolvedValue(undefined),
    };
    const notifySubscribers = { execute: vi.fn() } as unknown as NotifySubscribers;

    const useCase = new CheckEventAvailability(eventProvider, eventStateRepository, notifySubscribers);
    const result = await useCase.execute("ticketmaster:1");

    expect(result.changed).toBe(false);
    expect(notifySubscribers.execute).not.toHaveBeenCalled();
  });

  it("no notifica en el primer check (sin estado previo)", async () => {
    const eventProvider: EventProviderPort = {
      checkStatus: vi.fn().mockResolvedValue(EventStatus.ONSALE),
      findEventById: vi.fn(),
    };
    const eventStateRepository: EventStateRepositoryPort = {
      getLastKnownStatus: vi.fn().mockResolvedValue(null),
      saveStatus: vi.fn().mockResolvedValue(undefined),
    };
    const notifySubscribers = { execute: vi.fn() } as unknown as NotifySubscribers;

    const useCase = new CheckEventAvailability(eventProvider, eventStateRepository, notifySubscribers);
    const result = await useCase.execute("ticketmaster:1");

    expect(result.changed).toBe(false);
    expect(notifySubscribers.execute).not.toHaveBeenCalled();
  });
});
