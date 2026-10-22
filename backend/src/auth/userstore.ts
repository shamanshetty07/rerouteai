import type { ProviderName } from "./providers.ts";

/** OAuth providers plus "dev", which only the development login (devlogin.ts) ever uses. */
export type UserProvider = ProviderName | "dev";

export type User = {
  id: number;
  email: string;
  name: string | null;
  provider: UserProvider;
  providerId: string;
};

/** Swap this for a Prisma-backed implementation once the contract emits. */
export type UserStore = {
  findByProvider(provider: UserProvider, providerId: string): Promise<User | null>;
  findById(id: number): Promise<User | null>;
  create(data: Omit<User, "id">): Promise<User>;
};

export function createMemoryUserStore(): UserStore {
  const users: User[] = [];
  return {
    async findByProvider(provider, providerId) {
      return users.find((u) => u.provider === provider && u.providerId === providerId) ?? null;
    },
    async findById(id) {
      return users.find((u) => u.id === id) ?? null;
    },
    async create(data) {
      const user = { id: users.length + 1, ...data };
      users.push(user);
      return user;
    },
  };
}

export const userStore: UserStore = createMemoryUserStore();
