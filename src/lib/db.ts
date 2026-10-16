import "server-only";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "@/generated/prisma/client";
import { parseDatabaseUrl } from "@/lib/db-config";
import { env } from "@/lib/env";

function createClient() {
  const adapter = new PrismaMariaDb({
    ...parseDatabaseUrl(env().DATABASE_URL),
    connectionLimit: 10,
    // Con el servidor lejos conviene fallar rapido y no dejar conexiones inactivas
    // que un firewall o NAT pueda cortar sin avisar.
    connectTimeout: 10_000,
    idleTimeout: 300,
  });
  return new PrismaClient({ adapter });
}

// En desarrollo el hot reload recarga los modulos: guardamos el cliente en
// globalThis para no abrir una conexion nueva en cada recarga.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
