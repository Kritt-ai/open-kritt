import { useRef, useState } from 'react';

import { ApiError, apiErrorMessages } from '../api/client.js';
import { parseResourceImport, RESOURCE_IMPORT_MAX_BYTES } from './resourceTransfer.js';

export function useResourceImport({ resourceType, label, create, onImported }) {
  const inputRef = useRef(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');

  const chooseFile = () => {
    setImportError('');
    inputRef.current?.click();
  };

  const importFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setImporting(true);
    setImportError('');
    try {
      if (file.size > RESOURCE_IMPORT_MAX_BYTES) {
        throw new Error(`${label} JSON files must be 2 MB or smaller.`);
      }
      const payload = parseResourceImport(resourceType, await file.text());
      const imported = await create(payload);
      onImported?.(imported);
    } catch (error) {
      const messages =
        error instanceof ApiError ? apiErrorMessages(error) : [error?.message || `The ${label} could not be imported.`];
      setImportError(messages.join(' '));
    } finally {
      setImporting(false);
    }
  };

  return { inputRef, importing, importError, chooseFile, importFile };
}
