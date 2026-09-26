import BetterSqlite3 from "better-sqlite3";
import { randomUUID } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/infrastructure/persistence/sqlite/Database";
import { SqliteEventStateRepository } from "../../src/infrastructure/persistence/sqlite/SqliteEventStateRepository";
import { SqliteSubscriptionRepository } from "../../src/infrastructure/persistence/sqlite/SqliteSubscriptionRepository";
import { SqliteUserRepository } from "../../src/infrastructure/persistence/sqlite/SqliteUserRepository";
import { Subscription } from "../../src/domain/entities/Subscription";
import { User } from "../../src/domain/entities/User";
import { NotificationChannel } from "../../src/domain/value-objects/NotificationChannel";
import { EventStatus } from "../../src/domain/value-objects/EventStatus";

describe("SqliteEventStateRepository", () => {
  it("guarda y devuelve el último estado conocido", async () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteEventStateRepository(db);

    expect(await repo.getLastKnownStatus("ticketmaster:1")).toBeNull();

    await repo.saveStatus("ticketmaster:1", EventStatus.ONSALE);
    expect(await repo.getLastKnownStatus("ticketmaster:1")).toBe(EventStatus.ONSALE);

    await repo.saveStatus("ticketmaster:1", EventStatus.OFFSALE);
    expect(await repo.getLastKnownStatus("ticketmaster:1")).toBe(EventStatus.OFFSALE);
  });
});

describe("SqliteSubscriptionRepository", () => {
  it("guarda y devuelve solo las suscripciones activas del evento", async () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteSubscriptionRepository(db);

    const subscription = Subscription.create({
      userId: "user-1",
      eventId: "ticketmaster:1",
      channel: NotificationChannel.TELEGRAM,
      channelTarget: "123456",
    });
    await repo.save(subscription);

    const found = await repo.findActiveByEventId("ticketmaster:1");
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(subscription.id);

    const notFound = await repo.findActiveByEventId("ticketmaster:otro");
    expect(notFound).toHaveLength(0);
  });

  it("lista solo las suscripciones activas del usuario y las busca por id", async () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteSubscriptionRepository(db);

    const subscription = Subscription.create({
      userId: "user-1",
      eventId: "ticketmaster:1",
      channel: NotificationChannel.TELEGRAM,
      channelTarget: "123456",
    });
    await repo.save(subscription);
    await repo.save(subscription.deactivate());

    const found = await repo.findActiveByUserId("user-1");
    expect(found).toHaveLength(0);

    const another = Subscription.create({
      userId: "user-1",
      eventId: "ticketmaster:2",
      channel: NotificationChannel.TELEGRAM,
      channelTarget: "123456",
    });
    await repo.save(another);

    expect(await repo.findActiveByUserId("user-1")).toHaveLength(1);
    expect((await repo.findById(another.id))?.id).toBe(another.id);
    expect(await repo.findById("no-existe")).toBeNull();
  });

  it("findByEventChannelAndTarget encuentra sin filtrar por active", async () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteSubscriptionRepository(db);

    expect(
      await repo.findByEventChannelAndTarget("ticketmaster:1", NotificationChannel.EMAIL, "a@b.com")
    ).toBeNull();

    const subscription = Subscription.create({
      userId: "user-1",
      eventId: "ticketmaster:1",
      channel: NotificationChannel.EMAIL,
      channelTarget: "a@b.com",
    });
    await repo.save(subscription.deactivate());

    const found = await repo.findByEventChannelAndTarget(
      "ticketmaster:1",
      NotificationChannel.EMAIL,
      "a@b.com"
    );
    expect(found?.id).toBe(subscription.id);
    expect(found?.active).toBe(false);
  });
});

describe("SqliteUserRepository", () => {
  it("encuentra por phone y no duplica al reintentar el mismo id", async () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteUserRepository(db);

    expect(await repo.findByPhone("555")).toBeNull();

    const user = User.create({ phone: "555" });
    await repo.save(user);
    await repo.save(user);

    const found = await repo.findByPhone("555");
    expect(found?.id).toBe(user.id);
    expect(found?.telegramChatId).toBeNull();
  });

  it("linkea un telegramChatId a un usuario ya identificado por phone", async () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteUserRepository(db);

    const user = User.create({ phone: "555" });
    await repo.save(user);

    expect(await repo.findByTelegramChatId("chat-1")).toBeNull();

    await repo.linkTelegramChatId(user.id, "chat-1");

    const linked = await repo.findByTelegramChatId("chat-1");
    expect(linked?.id).toBe(user.id);
    expect(linked?.phone).toBe("555");
  });

  it("desvincula el telegramChatId de un usuario", async () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteUserRepository(db);

    const user = User.create({ phone: "555" });
    await repo.save(user);
    await repo.linkTelegramChatId(user.id, "chat-1");

    await repo.unlinkTelegramChatId(user.id);

    expect(await repo.findByTelegramChatId("chat-1")).toBeNull();
    expect((await repo.findByPhone("555"))?.telegramChatId).toBeNull();
  });

  it("linkea el email de cuenta a un usuario", async () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteUserRepository(db);

    const user = User.create({ phone: "555" });
    await repo.save(user);
    expect((await repo.findByPhone("555"))?.email).toBeNull();

    await repo.linkEmail(user.id, "a@b.com");

    expect((await repo.findByPhone("555"))?.email).toBe("a@b.com");
  });
});

describe("migraciones", () => {
  it("crea usuarios reales a partir de subscriptions.user_id legacy sin perder datos", () => {
    // Simula una DB desplegada antes de la migración de `users`: solo el
    // esquema inicial, con user_id como el chatId suelto (o "test-user").
    const dbPath = path.join(os.tmpdir(), `event-watcher-migration-test-${randomUUID()}.sqlite`);
    const legacyDb = new BetterSqlite3(dbPath);
    legacyDb.exec(`
      CREATE TABLE event_state (
        event_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE subscriptions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        channel_target TEXT NOT NULL,
        created_at TEXT NOT NULL,
        active INTEGER NOT NULL
      );
    `);
    legacyDb
      .prepare(
        `INSERT INTO subscriptions (id, user_id, event_id, channel, channel_target, created_at, active)
         VALUES (?, 'test-user', 'ticketmaster:1', 'TELEGRAM', '5023707731', ?, 1)`
      )
      .run(randomUUID(), new Date().toISOString());
    legacyDb.close();

    // openDatabase corre las migraciones pendientes, incluyendo el backfill.
    const db = openDatabase(dbPath);

    const user = db
      .prepare("SELECT * FROM users WHERE telegram_chat_id = ?")
      .get("5023707731") as { id: string } | undefined;
    expect(user).toBeDefined();

    const subscription = db
      .prepare("SELECT user_id FROM subscriptions WHERE channel_target = ?")
      .get("5023707731") as { user_id: string };
    expect(subscription.user_id).toBe(user!.id);

    db.close();
    fs.unlinkSync(dbPath);
  });

  it("adopta el email EMAIL más reciente como email de cuenta y lo propaga a las suscripciones existentes", () => {
    // Simula una DB en el estado post-migración-3 (users con phone/telegram_chat_id,
    // sin `email` todavía) con dos suscripciones EMAIL del mismo usuario a
    // eventos distintos, con direcciones distintas — el caso real de antes
    // de que el email pasara a ser un dato de cuenta único.
    const dbPath = path.join(os.tmpdir(), `event-watcher-migration4-test-${randomUUID()}.sqlite`);
    const legacyDb = new BetterSqlite3(dbPath);
    legacyDb.exec(`
      CREATE TABLE event_state (
        event_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE subscriptions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        channel_target TEXT NOT NULL,
        created_at TEXT NOT NULL,
        active INTEGER NOT NULL
      );
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        telegram_chat_id TEXT UNIQUE,
        created_at TEXT NOT NULL,
        phone TEXT
      );
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations (version, applied_at) VALUES (1, '2026-01-01'), (2, '2026-01-01'), (3, '2026-01-01');
    `);
    const userId = randomUUID();
    legacyDb
      .prepare("INSERT INTO users (id, phone, created_at) VALUES (?, ?, ?)")
      .run(userId, "3001234567", "2026-01-01T00:00:00.000Z");
    legacyDb
      .prepare(
        `INSERT INTO subscriptions (id, user_id, event_id, channel, channel_target, created_at, active)
         VALUES (?, ?, 'ticketmaster:1', 'EMAIL', 'viejo@ejemplo.com', '2026-01-01T00:00:00.000Z', 1)`
      )
      .run(randomUUID(), userId);
    legacyDb
      .prepare(
        `INSERT INTO subscriptions (id, user_id, event_id, channel, channel_target, created_at, active)
         VALUES (?, ?, 'ticketmaster:2', 'EMAIL', 'nuevo@ejemplo.com', '2026-02-01T00:00:00.000Z', 1)`
      )
      .run(randomUUID(), userId);
    legacyDb.close();

    const db = openDatabase(dbPath);

    const user = db.prepare("SELECT email FROM users WHERE id = ?").get(userId) as { email: string };
    expect(user.email).toBe("nuevo@ejemplo.com");

    const targets = db
      .prepare<[string], { channel_target: string }>(
        "SELECT channel_target FROM subscriptions WHERE user_id = ? ORDER BY event_id"
      )
      .all(userId);
    expect(targets.map((t) => t.channel_target)).toEqual(["nuevo@ejemplo.com", "nuevo@ejemplo.com"]);

    db.close();
    fs.unlinkSync(dbPath);
  });
});
