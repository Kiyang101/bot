import { PrismaClient } from '@prisma/client';

// One shared Prisma client for the whole bot process.
// It connects lazily on the first query, so importing this is cheap.
export const prisma = new PrismaClient();
