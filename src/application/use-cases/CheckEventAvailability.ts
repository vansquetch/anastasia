import { CheckEventAvailabilityPort, CheckEventAvailabilityResult } from "../ports/in/CheckEventAvailabilityPort";
import { EventProviderPort } from "../ports/out/EventProviderPort";
import { EventStateRepositoryPort } from "../ports/out/EventStateRepositoryPort";
import { NotificationStatus } from "../../domain/value-objects/NotificationStatus";
import { NotifySubscribers } from "./NotifySubscribers";

const RELEVANT_STATUSES_ON_CHANGE = new Set(["ONSALE", "CANCELLED", "RESCHEDULED"]);

export class CheckEventAvailability implements CheckEventAvailabilityPort {
  constructor(
    private readonly eventProvider: EventProviderPort,
    private readonly eventStateRepository: EventStateRepositoryPort,
    private readonly notifySubscribers: NotifySubscribers
  ) {}

  async execute(eventId: string): Promise<CheckEventAvailabilityResult> {
    const newStatus = await this.eventProvider.checkStatus(eventId);
    const previousStatus = await this.eventStateRepository.getLastKnownStatus(eventId);
    const changed = previousStatus !== null && previousStatus !== newStatus;

    let notifications: CheckEventAvailabilityResult["notifications"];
    if (changed && RELEVANT_STATUSES_ON_CHANGE.has(newStatus)) {
      const event = await this.eventProvider.findEventById(eventId);
      const records = await this.notifySubscribers.execute(eventId, event);
      const sent = records.filter((record) => record.status === NotificationStatus.SENT).length;
      notifications = { sent, failed: records.length - sent };
    }

    await this.eventStateRepository.saveStatus(eventId, newStatus);

    return { changed, newStatus, previousStatus, ...(notifications && { notifications }) };
  }
}
