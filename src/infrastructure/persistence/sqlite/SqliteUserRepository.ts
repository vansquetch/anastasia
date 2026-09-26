import type { Database } from "better-sqlite3";
import { UserRepositoryPort } from "../../../application/ports/out/UserRepositoryPort";
import { User } from "../../../domain/entities/User";

interface UserRow {
  id: string;
  phone: string | null;
  telegram_chat_id: string | null;
  email: string | null;
  created_at: string;
}

function toDomain(row: UserRow): User {
  return new User({
    id: row.id,
    phone: row.phone,
    telegramChatId: row.telegram_chat_id,
    email: row.email,
    createdAt: new Date(row.created_at),
  });
}

export class SqliteUserRepository implements UserRepositoryPort {
  constructor(private readonly db: Database) {}

  async findByPhone(phone: string): Promise<User | null> {
    const row = this.db
      .prepare<[string], UserRow>("SELECT * FROM users WHERE phone = ?")
      .get(phone);

    return row ? toDomain(row) : null;
  }

  async findByTelegramChatId(telegramChatId: string): Promise<User | null> {
    const row = this.db
      .prepare<[string], UserRow>("SELECT * FROM users WHERE telegram_chat_id = ?")
      .get(telegramChatId);

    return row ? toDomain(row) : null;
  }

  async linkTelegramChatId(userId: string, telegramChatId: string): Promise<void> {
    this.db
      .prepare("UPDATE users SET telegram_chat_id = ? WHERE id = ?")
      .run(telegramChatId, userId);
  }

  async unlinkTelegramChatId(userId: string): Promise<void> {
    this.db.prepare("UPDATE users SET telegram_chat_id = NULL WHERE id = ?").run(userId);
  }

  async reassignPhone(fromUserId: string, toUserId: string): Promise<void> {
    const move = this.db.transaction((phone: string) => {
      this.db.prepare("UPDATE users SET phone = NULL WHERE id = ?").run(fromUserId);
      this.db.prepare("UPDATE users SET phone = ? WHERE id = ?").run(phone, toUserId);
    });

    const from = this.db
      .prepare<[string], { phone: string | null }>("SELECT phone FROM users WHERE id = ?")
      .get(fromUserId);
    if (from?.phone) {
      move(from.phone);
    }
  }

  async linkEmail(userId: string, email: string): Promise<void> {
    this.db.prepare("UPDATE users SET email = ? WHERE id = ?").run(email, userId);
  }

  async save(user: User): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO users (id, phone, telegram_chat_id, email, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`
      )
      .run(user.id, user.phone, user.telegramChatId, user.email, user.createdAt.toISOString());
  }
}
