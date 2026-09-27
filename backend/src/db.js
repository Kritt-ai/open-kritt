import { PrismaClient } from '@prisma/client';
import { prismaDatasourceUrl } from './lib/prismaDatasource.js';

// Make BigInt serializable so res.json() can emit ids as strings.
// (Done once, globally — ids are always returned as strings to the client.)
if (typeof BigInt.prototype.toJSON !== 'function') {
  BigInt.prototype.toJSON = function toJSON() {
    return this.toString();
  };
}

const datasourceUrl = prismaDatasourceUrl(process.env.DATABASE_URL);
export const prisma = new PrismaClient(
  datasourceUrl ? { datasources: { db: { url: datasourceUrl } } } : undefined
);

export async function disconnect() {
  await prisma.$disconnect();
}
