import { extractExtraKeys } from './keys.js';

export function requiredScanExtraKeys(workflow, postScripts = [], selectedPostScriptIds = []) {
  const keys = new Set(Array.isArray(workflow?.extra) ? workflow.extra : []);
  const postScriptsById = new Map(postScripts.map((postScript) => [`${postScript.id}`, postScript]));

  for (const id of selectedPostScriptIds) {
    const postScript = postScriptsById.get(`${id}`);
    if (!postScript) continue;
    for (const key of extractExtraKeys(postScript.content)) keys.add(key);
  }

  return [...keys];
}
