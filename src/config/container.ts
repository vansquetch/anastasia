import TelegramBot from "node-telegram-bot-api";
import { CheckEventAvailability } from "../application/use-cases/CheckEventAvailability";
import { FindOrCreateUserByPhone } from "../application/use-cases/FindOrCreateUserByPhone";
import { ListUserSubscriptions } from "../application/use-cases/ListUserSubscriptions";
import { NotifySubscribers } from "../application/use-cases/NotifySubscribers";
import { SubscribeUserToEvent } from "../application/use-cases/SubscribeUserToEvent";
import { UnsubscribeUser } from "../application/use-cases/UnsubscribeUser";
import { NotificationChannel } from "../domain/value-objects/NotificationChannel";
import { NotificationPort } from "../application/ports/out/NotificationPort";
import {
  CrowderEventProvider,
  crowderEventId,
  crowderPageSlug,
} from "../infrastructure/event-providers/crowder/CrowderEventProvider";
import { CrowderPageClient } from "../infrastructure/event-providers/crowder/CrowderPageClient";
import { TicketmasterApiClient } from "../infrastructure/event-providers/ticketmaster/TicketmasterApiClient";
import { TicketmasterEventProvider } from "../infrastructure/event-providers/ticketmaster/TicketmasterEventProvider";
import { BrevoEmailNotifier } from "../infrastructure/notifiers/brevo/BrevoEmailNotifier";
import { TelegramNotifier } from "../infrastructure/notifiers/telegram/TelegramNotifier";
import { TwilioCallNotifier } from "../infrastructure/notifiers/twilio/TwilioCallNotifier";
import { WhatsAppNotifier } from "../infrastructure/notifiers/whatsapp/WhatsAppNotifier";
import { FileLogger } from "../infrastructure/logging/FileLogger";
import { openDatabase } from "../infrastructure/persistence/sqlite/Database";
import { SqliteEventStateRepository } from "../infrastructure/persistence/sqlite/SqliteEventStateRepository";
import { SqliteSubscriptionRepository } from "../infrastructure/persistence/sqlite/SqliteSubscriptionRepository";
import { SqliteUserRepository } from "../infrastructure/persistence/sqlite/SqliteUserRepository";
import { PollingScheduler, WatchedEvent } from "../infrastructure/scheduler/PollingScheduler";
import { PendingTelegramLinkStore } from "../infrastructure/telegram/PendingTelegramLinkStore";
import { buildHttpServer, confirmTelegramSubscription, WatchedEventEntry } from "../infrastructure/http/server";
import { parseAllowedPhones } from "../infrastructure/http/phone";
import { loadWatchedEventsConfig, parseOptionalDate } from "./watchedEventsConfig";
import { env } from "./env";

export interface ContainerOptions {
  // Los scripts (scripts/) solo necesitan ENVIAR por Telegram: con polling
  // apagado no le disputan los updates del bot al servidor que esté corriendo
  // (Telegram permite un solo consumidor de getUpdates por token).
  telegramPolling?: boolean;
}

export function buildContainer(options: ContainerOptions = {}) {
  const db = openDatabase(env.databasePath);
  const watchedEventsConfig = loadWatchedEventsConfig(env.watchedEventsFile);
  const schedulerLog = new FileLogger(env.schedulerLogFile).log;

  const ticketmasterClient = new TicketmasterApiClient(env.ticketmasterApiKey, env.ticketmaster);
  const eventProvider = new TicketmasterEventProvider(ticketmasterClient);

  // polling: true porque además de enviar notificaciones, el bot escucha
  // /start <token> para confirmar las suscripciones iniciadas desde la web.
  const telegramBot = new TelegramBot(env.telegramBotToken, { polling: options.telegramPolling ?? true });
  const notifiersByChannel = new Map<NotificationChannel, NotificationPort>([
    [NotificationChannel.TELEGRAM, new TelegramNotifier(telegramBot)],
    [NotificationChannel.CALL, new TwilioCallNotifier()],
  ]);

  // Opt-in, igual que Crowder: sin credenciales todavía no se registra el
  // canal, y NotifySubscribers ya marca FAILED cuando no hay adapter.
  if (env.whatsapp.phoneNumberId && env.whatsapp.accessToken && env.whatsapp.templateName) {
    notifiersByChannel.set(
      NotificationChannel.WHATSAPP,
      new WhatsAppNotifier({
        phoneNumberId: env.whatsapp.phoneNumberId,
        accessToken: env.whatsapp.accessToken,
        templateName: env.whatsapp.templateName,
        apiVersion: env.whatsapp.apiVersion,
        defaultCountryCode: env.whatsapp.defaultCountryCode,
      })
    );
  }
  if (env.brevo.apiKey && env.brevo.senderEmail) {
    notifiersByChannel.set(
      NotificationChannel.EMAIL,
      new BrevoEmailNotifier({
        apiKey: env.brevo.apiKey,
        senderEmail: env.brevo.senderEmail,
        senderName: env.brevo.senderName,
      })
    );
  }

  const eventStateRepository = new SqliteEventStateRepository(db);
  const subscriptionRepository = new SqliteSubscriptionRepository(db);
  const userRepository = new SqliteUserRepository(db);
  const notifySubscribers = new NotifySubscribers(subscriptionRepository, notifiersByChannel);
  const findOrCreateUser = new FindOrCreateUserByPhone(userRepository);
  const listUserSubscriptions = new ListUserSubscriptions(subscriptionRepository);
  const unsubscribeUser = new UnsubscribeUser(subscriptionRepository);

  const schedulers: PollingScheduler[] = [];
  const watchedEvents: WatchedEventEntry[] = [];

  if (watchedEventsConfig.ticketmaster.length > 0) {
    const subscribeUserToEvent = new SubscribeUserToEvent(eventProvider, subscriptionRepository);
    const checkEventAvailability = new CheckEventAvailability(
      eventProvider,
      eventStateRepository,
      notifySubscribers
    );

    const ticketmasterWatched: WatchedEvent[] = watchedEventsConfig.ticketmaster.map((item) => ({
      id: item.id,
      activeFrom: parseOptionalDate(item.activeFrom, `watched-events.json (ticketmaster:${item.id})`),
      activeUntil: parseOptionalDate(item.activeUntil, `watched-events.json (ticketmaster:${item.id})`),
    }));
    schedulers.push(
      new PollingScheduler(ticketmasterWatched, env.pollingIntervalSeconds, checkEventAvailability, {
        name: "ticketmaster",
        log: schedulerLog,
      })
    );

    for (const item of watchedEventsConfig.ticketmaster) {
      watchedEvents.push({
        id: item.id,
        name: item.name,
        venue: item.venue,
        provider: eventProvider,
        subscribe: subscribeUserToEvent,
      });
    }
  }

  // Varios ítems de Crowder pueden compartir la misma página de evento —
  // agrupamos por pageUrl para reusar un solo CrowderPageClient (y su
  // caché) por página en vez de golpearla una vez por ítem vigilado.
  const crowderItemsByPage = new Map<string, typeof watchedEventsConfig.crowder>();
  for (const item of watchedEventsConfig.crowder) {
    const list = crowderItemsByPage.get(item.pageUrl) ?? [];
    list.push(item);
    crowderItemsByPage.set(item.pageUrl, list);
  }

  for (const [pageUrl, items] of crowderItemsByPage) {
    const crowderClient = new CrowderPageClient({
      pageUrl,
      cacheTtlMs: env.crowder.pageCacheTtlSeconds * 1000,
      log: schedulerLog,
    });
    const pageSlug = crowderPageSlug(pageUrl);
    const crowderProvider = new CrowderEventProvider(
      crowderClient,
      new Map(items.map((item) => [item.id, { name: item.name, venue: item.venue }]))
    );
    const checkCrowderAvailability = new CheckEventAvailability(
      crowderProvider,
      eventStateRepository,
      notifySubscribers
    );
    const subscribeUserToEventCrowder = new SubscribeUserToEvent(crowderProvider, subscriptionRepository);

    const crowderWatched: WatchedEvent[] = items.map((item) => ({
      id: crowderEventId(pageSlug, item.id),
      activeFrom: parseOptionalDate(item.activeFrom, `watched-events.json (${crowderEventId(pageSlug, item.id)})`),
      activeUntil: parseOptionalDate(item.activeUntil, `watched-events.json (${crowderEventId(pageSlug, item.id)})`),
    }));
    schedulers.push(
      new PollingScheduler(crowderWatched, env.crowder.pollingIntervalSeconds, checkCrowderAvailability, {
        name: `crowder:${pageSlug}`,
        log: schedulerLog,
      })
    );

    for (const item of items) {
      watchedEvents.push({
        id: crowderEventId(pageSlug, item.id),
        name: item.name,
        venue: item.venue,
        provider: crowderProvider,
        subscribe: subscribeUserToEventCrowder,
      });
    }
  }

  const pendingTelegramLinks = new PendingTelegramLinkStore();

  const misuscripcionesHint =
    "Usá /misuscripciones cuando quieras ver o cancelar tus suscripciones por acá, o /unsuscribe para cancelarlas todas.";

  // /start sin token (alguien abre el bot directo, sin venir de un deep link
  // de la web) — explica para qué sirve el bot y el comando de gestión.
  telegramBot.onText(/^\/start$/, async (msg) => {
    const chatId = String(msg.chat.id);
    await telegramBot.sendMessage(
      chatId,
      `👋 ¡Hola! Este bot avisa cuando cambia la disponibilidad de los eventos que elegiste en la web.\n\n${misuscripcionesHint}`
    );
  });

  telegramBot.onText(/^\/start (.+)$/, async (msg, match) => {
    const token = match?.[1];
    const chatId = String(msg.chat.id);
    if (!token) return;

    const result = await confirmTelegramSubscription(
      { watchedEvents, pendingTelegramLinks, userRepository },
      token,
      chatId
    );

    if (result.ok) {
      await telegramBot.sendMessage(
        chatId,
        `✅ ¡Listo! Te vamos a avisar por acá apenas cambie la disponibilidad de ese evento.\n\n${misuscripcionesHint}`
      );
    } else {
      const reason =
        result.reason === "expired_token"
          ? "Ese link ya venció o ya se usó. Volvé a la web y generá uno nuevo."
          : "Ese evento ya no está vigilado.";
      await telegramBot.sendMessage(chatId, `⚠️ ${reason}`);
    }
  });

  // /misuscripciones + botones inline "Cancelar" — el chatId de Telegram ya
  // autentica al usuario, así que no hace falta ningún login para que cada
  // quien vea y cancele solo sus propias suscripciones. Solo busca (no crea):
  // un chat sin usuario linkeado todavía simplemente no tiene nada que listar.
  //
  // Se filtra a solo el canal TELEGRAM: un mismo usuario puede tener
  // suscripciones activas en WhatsApp/Email también (multi-select del
  // modal), pero esas se gestionan desde "Suscrito a" en la web — listarlas
  // acá también generaba filas que parecían duplicadas cuando en realidad
  // eran canales distintos del mismo evento.
  telegramBot.onText(/^\/misuscripciones$/, async (msg) => {
    const chatId = String(msg.chat.id);
    const user = await userRepository.findByTelegramChatId(chatId);
    const allSubscriptions = user ? await listUserSubscriptions.execute(user.id) : [];
    const subscriptions = allSubscriptions.filter(
      (subscription) => subscription.channel === NotificationChannel.TELEGRAM
    );

    if (subscriptions.length === 0) {
      await telegramBot.sendMessage(chatId, "No tenés suscripciones activas por Telegram todavía.");
      return;
    }

    const rows = subscriptions.map((subscription) => {
      const entry = watchedEvents.find((e) => e.id === subscription.eventId);
      const label = entry ? `${entry.name} (${entry.venue})` : subscription.eventId;
      return [{ text: `❌ Cancelar: ${label}`, callback_data: `unsub:${subscription.id}` }];
    });

    await telegramBot.sendMessage(chatId, "Tus suscripciones activas por Telegram:", {
      reply_markup: { inline_keyboard: rows },
    });
  });

  // /unsuscribe cancela TODAS las suscripciones de Telegram del chat (mismo
  // filtro por canal que /misuscripciones: WhatsApp/Email no se tocan) y
  // desvincula el chatId del usuario, para que volver a suscribirse por
  // Telegram exija pasar otra vez por el deep link /start <token>.
  telegramBot.onText(/^\/(unsuscribe|unsubscribe)$/, async (msg) => {
    const chatId = String(msg.chat.id);
    const user = await userRepository.findByTelegramChatId(chatId);
    if (!user) {
      await telegramBot.sendMessage(chatId, "No tenés suscripciones activas por Telegram.");
      return;
    }

    const allSubscriptions = await listUserSubscriptions.execute(user.id);
    const subscriptions = allSubscriptions.filter(
      (subscription) => subscription.channel === NotificationChannel.TELEGRAM
    );
    for (const subscription of subscriptions) {
      await unsubscribeUser.execute(subscription.id, user.id);
    }
    await userRepository.unlinkTelegramChatId(user.id);

    const summary =
      subscriptions.length === 0
        ? "No tenías suscripciones activas por Telegram, pero desvinculamos este chat."
        : `Cancelamos ${subscriptions.length} ${subscriptions.length === 1 ? "suscripción" : "suscripciones"} por Telegram y desvinculamos este chat.`;
    await telegramBot.sendMessage(
      chatId,
      `✅ ${summary} Ya no vas a recibir avisos por acá. Para volver a suscribirte, hacelo desde la web.`
    );
  });

  telegramBot.on("callback_query", async (query) => {
    const data = query.data;
    const chatId = query.message ? String(query.message.chat.id) : undefined;
    if (!data?.startsWith("unsub:") || !chatId) return;

    const subscriptionId = data.slice("unsub:".length);
    const user = await userRepository.findByTelegramChatId(chatId);
    const result = user
      ? await unsubscribeUser.execute(subscriptionId, user.id)
      : ({ ok: false, reason: "not_found" } as const);

    if (result.ok) {
      await telegramBot.answerCallbackQuery(query.id, { text: "Cancelada ✅" });
      if (query.message) {
        await telegramBot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: chatId, message_id: query.message.message_id }
        );
      }
    } else {
      await telegramBot.answerCallbackQuery(query.id, {
        text: "No se pudo cancelar esa suscripción.",
      });
    }
  });

  const httpServer = buildHttpServer({
    watchedEvents,
    pendingTelegramLinks,
    findOrCreateUser,
    userRepository,
    subscriptionRepository,
    listUserSubscriptions,
    unsubscribeUser,
    telegramBotUsername: env.telegramBotUsername,
    frontendOrigin: env.frontendOrigin,
    staticDir: env.staticDir,
    allowedPhones: parseAllowedPhones(env.allowedPhones),
    enabledChannels: new Set(notifiersByChannel.keys()),
    whatsappWebhook:
      env.whatsapp.webhookVerifyToken && env.whatsapp.appSecret
        ? { verifyToken: env.whatsapp.webhookVerifyToken, appSecret: env.whatsapp.appSecret }
        : undefined,
  });

  return {
    watchedEvents,
    schedulers,
    httpServer,
    db,
    // Expuestos para scripts de prueba manual (ver scripts/), que arman su
    // propio CheckEventAvailability con un provider de prueba pero quieren
    // reusar la persistencia y los notificadores reales.
    eventStateRepository,
    notifySubscribers,
    findOrCreateUser,
    userRepository,
    subscriptionRepository,
  };
}
