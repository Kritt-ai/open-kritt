export async function lockScanForMutation(tx, scanId) {
  await tx.$queryRaw`SELECT id FROM public.scans WHERE id = ${scanId} FOR UPDATE`;
}
