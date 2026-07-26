-- Promote the short verdicts emitted by the untouched bundled post-scripts to
-- finding-list chips, and rename the untouched bundled severity ranker.
-- Exact default fingerprints preserve user-customized artifacts.

UPDATE public.post_scripts
SET
    content = replace(
        content,
        'Score ease_of_exploitability from 0 to 10, where 10 is easiest and 0 is hardest.',
        'Return _chip_ease_of_exploitability as a score from 0 to 10, where 10 is easiest and 0 is hardest.'
    ),
    output_format = '{"_chip_ease_of_exploitability":"number","reasoning":"string","missing_from_prompt":"string"}',
    updated_at = now()
WHERE name = 'Ease of exploitability'
  AND description = 'Scores how easy the reported bug is to exploit in practice from the finding text and scan context.'
  AND md5(content) = '3f5e65cbed69cbd470d8f13afa6a1bc5'
  AND output_format = '{"ease_of_exploitability":"number","reasoning":"string","missing_from_prompt":"string"}';

UPDATE public.post_scripts
SET
    output_format = '{"_chip_patched":"boolean","needs_manual_review":"boolean","confidence":"number","summary_result":"string","reasoning":"string","found_at_commit":"string","target_commit":"string"}',
    updated_at = now()
WHERE name = 'Patched since'
  AND description = 'Checks whether the reported risky behavior appears fixed or still present in the checked-out repository and scan context commits.'
  AND md5(content) = '354172106e89761a35baaf9eae2268db'
  AND output_format = '{"patched":"boolean","needs_manual_review":"boolean","confidence":"number","summary":"string","reasoning":"string","found_at_commit":"string","target_commit":"string"}';

-- A development server can install the renamed default before this migration is
-- applied. In that case, discard only the byte-for-byte legacy default.
DELETE FROM public.severity_rankers AS legacy
WHERE legacy.name = 'Open source security triage'
  AND legacy.description = 'A conservative production-impact ranker suitable for a first scan.'
  AND md5(legacy.content) = 'd0f0c59de551b8e4ebc53b0dd4b85c7a'
  AND EXISTS (
      SELECT 1
      FROM public.severity_rankers AS replacement
      WHERE replacement.name = 'Blockchain security triage'
        AND replacement.content = legacy.content
  );

UPDATE public.severity_rankers
SET
    name = 'Blockchain security triage',
    updated_at = now()
WHERE name = 'Open source security triage'
  AND description = 'A conservative production-impact ranker suitable for a first scan.'
  AND md5(content) = 'd0f0c59de551b8e4ebc53b0dd4b85c7a'
  AND NOT EXISTS (
      SELECT 1
      FROM public.severity_rankers AS replacement
      WHERE replacement.name = 'Blockchain security triage'
  );
