import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno requerida: ${name}`);
  }
  return value;
}

function optionalEnvInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export const env = {
  ticketmasterApiKey: requireEnv("TICKETMASTER_API_KEY"),
  telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),
  telegramBotUsername: requireEnv("TELEGRAM_BOT_USERNAME"),
  databasePath: process.env.DATABASE_PATH ?? "./data/event-watcher.sqlite",

  apiPort: optionalEnvInt("API_PORT", 3001),
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? "http://localhost:5173",
  // Solo se setea en producción (Docker copia frontend/dist acá); en dev
  // el frontend corre aparte con `vite dev` y esto queda undefined.
  staticDir: process.env.STATIC_DIR,
  // Celulares habilitados para usar la app, separados por coma. Mientras se
  // prueba con números conocidos (los mismos de la lista de destinatarios de
  // prueba de WhatsApp). Vacío o sin definir = cualquiera puede registrarse.
  allowedPhones: process.env.ALLOWED_PHONES,

  // Lista de eventos observables (Ticketmaster + Crowder), con su info de
  // display — ver config/watched-events.json.
  watchedEventsFile: process.env.WATCHED_EVENTS_FILE ?? "./config/watched-events.json",

  pollingIntervalSeconds: optionalEnvInt("POLLING_INTERVAL_SECONDS", 15),
  // Log de auditoría de los schedulers (un latido por tick + resultado de
  // cada revisión). En Fly va al volumen para sobrevivir a reinicios.
  schedulerLogFile: process.env.SCHEDULER_LOG_FILE ?? "./data/scheduler.log",

  // Rate limiting / reintentos contra Ticketmaster Discovery API — ajustable
  // por configuración sin tocar código, ya que el tier/cuota puede cambiar.
  ticketmaster: {
    maxRequestsPerSecond: optionalEnvInt("TICKETMASTER_MAX_REQUESTS_PER_SECOND", 5),
    requestTimeoutMs: optionalEnvInt("TICKETMASTER_REQUEST_TIMEOUT_MS", 8000),
    retryMaxAttempts: optionalEnvInt("TICKETMASTER_RETRY_MAX_ATTEMPTS", 3),
    retryBaseDelayMs: optionalEnvInt("TICKETMASTER_RETRY_BASE_DELAY_MS", 500),
  },

  // Proveedor secundario: eventos de Ticketmaster.co vendidos por Crowder,
  // fuera de la Discovery API. Qué páginas/ítems vigilar vive en
  // watched-events.json — acá solo quedan los parámetros globales.
  crowder: {
    pollingIntervalSeconds: optionalEnvInt("CROWDER_POLLING_INTERVAL_SECONDS", 60),
    pageCacheTtlSeconds: optionalEnvInt("CROWDER_PAGE_CACHE_TTL_SECONDS", 60),
  },

  // Notificadores opcionales: si faltan sus variables, container.ts no los
  // registra en notifiersByChannel (mismo patrón opt-in que Crowder) y esos
  // canales quedan marcados FAILED al notificar, sin romper el arranque.
  whatsapp: {
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
    templateName: process.env.WHATSAPP_TEMPLATE_NAME,
    apiVersion: process.env.WHATSAPP_API_VERSION ?? "v20.0",
    // Los celulares se guardan sin código de país; la Cloud API lo exige.
    defaultCountryCode: process.env.WHATSAPP_DEFAULT_COUNTRY_CODE ?? "57",
    // Webhook (estados de entrega / mensajes entrantes). El verify token lo
    // inventamos nosotros y se pega igual en el panel de Meta; el app secret
    // valida la firma X-Hub-Signature-256 de cada POST.
    webhookVerifyToken: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
    appSecret: process.env.WHATSAPP_APP_SECRET,
  },
  brevo: {
    apiKey: process.env.BREVO_API_KEY,
    senderEmail: process.env.BREVO_SENDER_EMAIL,
    senderName: process.env.BREVO_SENDER_NAME ?? "Event Watcher",
  },
};
