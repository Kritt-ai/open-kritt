export async function lockWorkflowForScan(tx, workflowId) {
  await tx.$queryRaw`SELECT id FROM public.llm_workflows WHERE id = ${workflowId} FOR SHARE`;
}

export async function lockWorkflowForEdit(tx, workflowId) {
  await tx.$queryRaw`SELECT id FROM public.llm_workflows WHERE id = ${workflowId} FOR UPDATE`;
}
