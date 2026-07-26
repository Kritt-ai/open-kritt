export async function lockPostScriptForScan(tx, postScriptId) {
  await tx.$queryRaw`SELECT id FROM public.post_scripts WHERE id = ${postScriptId} FOR SHARE`;
}

export async function lockPostScriptForMutation(tx, postScriptId) {
  await tx.$queryRaw`SELECT id FROM public.post_scripts WHERE id = ${postScriptId} FOR UPDATE`;
}
