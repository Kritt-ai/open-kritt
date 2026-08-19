export const RESOURCE_IMPORT_MAX_BYTES = 2 * 1024 * 1024;

const RESOURCE_TYPES = Object.freeze({
  postScript: Object.freeze({
    kind: 'open-kritt-post-script',
    field: 'postScript',
    filenameSuffix: 'post-script',
    label: 'post-script',
    properties: Object.freeze({
      name: Object.freeze({ required: true, trim: true }),
      description: Object.freeze({ defaultValue: '' }),
      content: Object.freeze({ required: true }),
      outputFormat: Object.freeze({ required: true, type: 'object' }),
    }),
  }),
  agentSkill: Object.freeze({
    kind: 'open-kritt-agent-skill',
    field: 'agentSkill',
    filenameSuffix: 'agent-skill',
    label: 'agent skill',
    properties: Object.freeze({
      name: Object.freeze({ required: true, trim: true }),
      slug: Object.freeze({ required: true, trim: true }),
      description: Object.freeze({ defaultValue: '' }),
      content: Object.freeze({ required: true }),
      sourceUrl: Object.freeze({ defaultValue: null, nullable: true }),
      licenseSpdx: Object.freeze({ defaultValue: null, nullable: true }),
      attribution: Object.freeze({ defaultValue: null, nullable: true }),
    }),
  }),
  severityRanker: Object.freeze({
    kind: 'open-kritt-severity-ranker',
    field: 'severityRanker',
    filenameSuffix: 'severity-ranker',
    label: 'severity ranker',
    properties: Object.freeze({
      name: Object.freeze({ required: true, trim: true }),
      description: Object.freeze({ defaultValue: '' }),
      content: Object.freeze({ required: true }),
    }),
  }),
});

export const RESOURCE_FILE_VERSION = 1;

function configFor(resourceType) {
  const config = RESOURCE_TYPES[resourceType];
  if (!config) throw new TypeError(`Unsupported resource type: ${resourceType}`);
  return config;
}

function isObjectMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidResource(config, message) {
  return new Error(`Invalid ${config.label} file: ${message}`);
}

function normalizedResource(resourceType, value) {
  const config = configFor(resourceType);
  if (!isObjectMap(value)) throw invalidResource(config, `${config.field} must be an object.`);

  const result = {};
  for (const [property, definition] of Object.entries(config.properties)) {
    const candidate = value[property];
    if (definition.type === 'object') {
      if (!isObjectMap(candidate)) throw invalidResource(config, `${config.field}.${property} must be an object.`);
      result[property] = Object.fromEntries(Object.entries(candidate));
      continue;
    }
    if (candidate === null && definition.nullable) {
      result[property] = null;
      continue;
    }
    if (candidate === undefined && Object.hasOwn(definition, 'defaultValue')) {
      result[property] = definition.defaultValue;
      continue;
    }
    if (typeof candidate !== 'string') {
      throw invalidResource(
        config,
        `${config.field}.${property} must be a string${definition.nullable ? ' or null' : ''}.`
      );
    }
    if (definition.required && !candidate.trim()) {
      throw invalidResource(config, `${config.field}.${property} is required.`);
    }
    result[property] = definition.trim ? candidate.trim() : candidate;
  }
  return result;
}

export function createResourceExport(resourceType, resource) {
  const config = configFor(resourceType);
  return {
    kind: config.kind,
    version: RESOURCE_FILE_VERSION,
    [config.field]: normalizedResource(resourceType, resource),
  };
}

export function resourcePayloadFromImport(resourceType, document) {
  const config = configFor(resourceType);
  if (!isObjectMap(document)) throw invalidResource(config, 'the JSON root must be an object.');

  if (Object.hasOwn(document, 'kind') || Object.hasOwn(document, 'version')) {
    if (document.kind !== config.kind) {
      throw invalidResource(config, `unsupported file kind "${document.kind || ''}".`);
    }
    if (document.version !== RESOURCE_FILE_VERSION) {
      throw invalidResource(config, `unsupported ${config.kind} version "${document.version ?? ''}".`);
    }
    return normalizedResource(resourceType, document[config.field]);
  }

  // Bare API/editor objects remain useful when moving manually-authored files
  // between installations. Unknown installation-specific fields are ignored.
  return normalizedResource(resourceType, document);
}

export function parseResourceImport(resourceType, contents) {
  let document;
  try {
    document = JSON.parse(contents);
  } catch {
    throw new Error('The selected file is not valid JSON.');
  }
  return resourcePayloadFromImport(resourceType, document);
}

function filenameSlug(value) {
  return `${value || ''}`
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

export function resourceExportFilename(resourceType, name) {
  const config = configFor(resourceType);
  return `${filenameSlug(name) || config.filenameSuffix}.${config.filenameSuffix}.json`;
}

export function downloadResourceExport(resourceType, resource, { documentRef = document, urlApi = URL } = {}) {
  const contents = `${JSON.stringify(createResourceExport(resourceType, resource), null, 2)}\n`;
  const url = urlApi.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const link = documentRef.createElement('a');
  link.href = url;
  link.download = resourceExportFilename(resourceType, resource?.name);
  link.style.display = 'none';
  documentRef.body.appendChild(link);
  link.click();
  link.remove();
  urlApi.revokeObjectURL(url);
}
