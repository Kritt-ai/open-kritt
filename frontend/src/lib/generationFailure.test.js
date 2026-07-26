import { describe, expect, it } from 'vitest';
import {
  apiErrorMessages,
  formatGenerationDuration,
  generationFailureViewModel,
  normalizeGenerationValidationIssues,
  splitGenerationFailureMessage,
} from './generationFailure.js';

describe('generation failure presentation', () => {
  it('separates an actionable message from the engine diagnostic suffix', () => {
    expect(
      splitGenerationFailureMessage(
        'The configured account cannot use this model. Choose another model. Diagnostic: model_access_denied (generation 3).'
      )
    ).toEqual({
      message: 'The configured account cannot use this model. Choose another model.',
      diagnosticCode: 'model_access_denied',
      diagnosticGenerationId: '3',
    });
  });

  it('builds a complete view from the safe generation payload', () => {
    const view = generationFailureViewModel(
      {
        id: '17',
        error: 'Generated draft did not pass validation.',
        validationErrors: [{ field: 'terminal.outputFormat', message: 'line must use type number.' }],
        modelProvider: 'codex',
        model: 'gpt-5.6',
        harness: 'codex',
        thinkingEffort: 'high',
        insertedAt: '2026-07-14T10:00:00.000Z',
        runStartedAt: '2026-07-14T10:00:02.000Z',
        completedAt: '2026-07-14T10:02:06.000Z',
      },
      'workflow'
    );

    expect(view.reference).toBe('Generation #17');
    expect(view.issues).toEqual([{ field: 'terminal.outputFormat', message: 'line must use type number.' }]);
    expect(view.configuration).toEqual([
      { label: 'Provider', value: 'Codex' },
      { label: 'Model', value: 'gpt-5.6' },
      { label: 'Harness', value: 'Codex CLI' },
      { label: 'Thinking', value: 'High' },
    ]);
    expect(view.duration).toBe('2m 4s');
  });

  it('normalizes string issues and supplies a useful fallback', () => {
    expect(
      normalizeGenerationValidationIssues(['Missing output fields', null, { field: '', message: 'Bad prompt' }])
    ).toEqual([
      { field: 'draft', message: 'Missing output fields' },
      { field: 'draft', message: 'Bad prompt' },
    ]);
    expect(generationFailureViewModel({ id: '9' }, 'post-script').message).toContain('No additional safe diagnostic');
  });

  it('formats short and long run durations', () => {
    expect(formatGenerationDuration('2026-07-14T10:00:00Z', '2026-07-14T10:00:09Z')).toBe('9s');
    expect(formatGenerationDuration('2026-07-14T10:00:00Z', '2026-07-14T11:02:00Z')).toBe('1h 2m');
    expect(formatGenerationDuration('invalid', '2026-07-14T11:02:00Z')).toBeNull();
  });

  it('keeps the top-level API error when the detail array is empty', () => {
    expect(apiErrorMessages({ message: 'Provider unavailable.', errors: [] })).toEqual(['Provider unavailable.']);
    expect(
      apiErrorMessages({ message: 'Validation failed.', errors: [{ field: 'model', message: 'Not available.' }] })
    ).toEqual(['model: Not available.']);
  });
});
