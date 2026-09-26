import { User } from "../../../domain/entities/User";

export interface UserRepositoryPort {
  findByPhone(phone: string): Promise<User | null>;
  findByTelegramChatId(telegramChatId: string): Promise<User | null>;
  linkTelegramChatId(userId: string, telegramChatId: string): Promise<void>;
  // Vacía el chatId (usado por /unsuscribe): la próxima suscripción por
  // Telegram vuelve a exigir el deep link /start <token>.
  unlinkTelegramChatId(userId: string): Promise<void>;
  // Mueve el phone de un usuario a otro de forma atómica (limpia el origen
  // antes de setearlo en el destino) — necesario porque `phone` es único y
  // el usuario origen todavía lo tiene puesto en el momento de la fusión.
  reassignPhone(fromUserId: string, toUserId: string): Promise<void>;
  linkEmail(userId: string, email: string): Promise<void>;
  save(user: User): Promise<void>;
}
