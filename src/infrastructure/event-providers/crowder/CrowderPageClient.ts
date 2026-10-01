import * as cheerio from "cheerio";

export type CrowderStatusCode = "AVAILABLE" | "SOON" | "SOLDOUT" | "CANCELED" | "UNKNOWN";

export interface CrowderPageItem {
  key: string;
  title: string;
  description: string;
  statusCode: CrowderStatusCode;
}

export interface CrowderPageClientOptions {
  pageUrl: string;
  cacheTtlMs: number;
  requestTimeoutMs?: number;
  // Log de auditoría (ver FileLogger): registra qué ítems trajo cada fetch
  // real, para detectar si la página cambió las claves o sirvió un captcha.
  log?: (line: string) => void;
}

const DOT_CLASS_TO_STATUS: Record<string, CrowderStatusCode> = {
  "tm-dot-available": "AVAILABLE",
  "tm-dot-soon": "SOON",
  "tm-dot-soldout": "SOLDOUT",
  "tm-dot-canceled": "CANCELED",
};

function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/**
 * Cliente para la página de evento de Ticketmaster.co servida por Crowder
 * (no es la Discovery API — es HTML). Cachea el HTML parseado por
 * `cacheTtlMs` para que varios ítems vigilados de la misma página no
 * disparen un fetch por cada uno en el mismo tick del scheduler.
 */
export class CrowderPageClient {
  private cachedItems: CrowderPageItem[] | null = null;
  private cachedAt = 0;

  constructor(private readonly options: CrowderPageClientOptions) {}

  async getItems(): Promise<CrowderPageItem[]> {
    const now = Date.now();
    if (this.cachedItems && now - this.cachedAt < this.options.cacheTtlMs) {
      return this.cachedItems;
    }

    let items: CrowderPageItem[];
    try {
      items = await this.fetchAndParse();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.log?.(`[crowder] fetch ${this.options.pageUrl} FALLÓ: ${message}`);
      throw error;
    }
    this.options.log?.(
      `[crowder] fetch ${this.options.pageUrl}: ${items.length} ítem(s)` +
        (items.length > 0 ? ` — ${items.map((item) => `${item.key}=${item.statusCode}`).join(", ")}` : "")
    );
    this.cachedItems = items;
    this.cachedAt = now;
    return items;
  }

  private async fetchAndParse(): Promise<CrowderPageItem[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? 10000);

    let html: string;
    try {
      const response = await fetch(this.options.pageUrl, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        },
      });
      if (!response.ok) {
        throw new Error(`Crowder respondió ${response.status} para ${this.options.pageUrl}`);
      }
      html = await response.text();
    } finally {
      clearTimeout(timeout);
    }

    if (html.includes("page-captcha") && html.includes("request-captcha-container")) {
      this.options.log?.(`[crowder] fetch ${this.options.pageUrl}: la respuesta trae contenedores de captcha`);
      console.warn(
        "[CrowderPageClient] la respuesta incluye contenedores de captcha; si los estados se ven raros, puede que se haya disparado un challenge en vez de servir el contenido real."
      );
    }

    const $ = cheerio.load(html);
    const items: CrowderPageItem[] = [];

    $(".button_item").each((_, el) => {
      const dotClass = $(el)
        .find(".tm-status-dot")
        .first()
        .attr("class")
        ?.split(/\s+/)
        .find((c) => c.startsWith("tm-dot-"));

      if (!dotClass) return; // ítems sin badge de estado (ej. "Servicios de Accesibilidad")

      const title = $(el).find(".button_item__title").first().text().trim();
      const description = $(el).find(".button_item__description").first().text().trim();
      const dateFragment = description.split("·")[0]?.trim() ?? "";

      items.push({
        key: slugify(`${title}-${dateFragment}`),
        title,
        description,
        statusCode: DOT_CLASS_TO_STATUS[dotClass] ?? "UNKNOWN",
      });
    });

    return items;
  }
}
