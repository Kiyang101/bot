import { PrismaClient } from '@prisma/client';

// Reuse one PrismaClient across hot-reloads in dev (Next.js recreates modules on edit).
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
