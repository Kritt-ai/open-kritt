export async function lockAgentSkillForScan(tx, agentSkillId) {
  await tx.$queryRaw`SELECT id FROM public.agent_skills WHERE id = ${agentSkillId} FOR SHARE`;
}

export async function lockAgentSkillForMutation(tx, agentSkillId) {
  await tx.$queryRaw`SELECT id FROM public.agent_skills WHERE id = ${agentSkillId} FOR UPDATE`;
}
