import { PrismaClient } from '@prisma/client';

// Make BigInt serializable so res.json() can emit ids as strings.
// (Done once, globally — ids are always returned as strings to the client.)
if (typeof BigInt.prototype.toJSON !== 'function') {
  BigInt.prototype.toJSON = function toJSON() {
    return this.toString();
  };
}

export const prisma = new PrismaClient();

export async function disconnect() {
  await prisma.$disconnect();
}
