import { describe, expect, it, vi } from "vitest";
import { FindOrCreateUserByPhone } from "../../src/application/use-cases/FindOrCreateUserByPhone";
import { UserRepositoryPort } from "../../src/application/ports/out/UserRepositoryPort";
import { User } from "../../src/domain/entities/User";

describe("FindOrCreateUserByPhone", () => {
  it("devuelve el usuario existente sin crear uno nuevo", async () => {
    const existing = User.create({ phone: "555" });
    const userRepository: UserRepositoryPort = {
      findByPhone: vi.fn().mockResolvedValue(existing),
      findByTelegramChatId: vi.fn(),
      linkTelegramChatId: vi.fn(),
      unlinkTelegramChatId: vi.fn(),
      reassignPhone: vi.fn(),
      save: vi.fn(),
    };

    const useCase = new FindOrCreateUserByPhone(userRepository);
    const result = await useCase.execute("555");

    expect(result).toBe(existing);
    expect(userRepository.save).not.toHaveBeenCalled();
  });

  it("crea y guarda un usuario nuevo si no existe", async () => {
    const userRepository: UserRepositoryPort = {
      findByPhone: vi.fn().mockResolvedValue(null),
      findByTelegramChatId: vi.fn(),
      linkTelegramChatId: vi.fn(),
      unlinkTelegramChatId: vi.fn(),
      reassignPhone: vi.fn(),
      save: vi.fn(),
    };

    const useCase = new FindOrCreateUserByPhone(userRepository);
    const result = await useCase.execute("555");

    expect(result.phone).toBe("555");
    expect(result.telegramChatId).toBeNull();
    expect(userRepository.save).toHaveBeenCalledWith(result);
  });
});
