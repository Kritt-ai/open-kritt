import { extractExtraKeys } from './keys.js';

export function hasExtraValue(value) {
  return value !== undefined && value !== null && (typeof value !== 'string' || value.trim() !== '');
}

// Format JSON values for the textarea without changing their stored types.
export function extraInputText(value) {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

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
