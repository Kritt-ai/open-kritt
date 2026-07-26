-- Bring the original bundled post-scripts in line with the supported input contract.
-- Exact legacy fingerprints keep customized and user-created scripts untouched.

UPDATE public.post_scripts
SET
    description = replace(description, 'canonical finding', 'finding'),
    content = replace(
        replace(
            replace(
                replace(
                    content,
                    E'- Dedupe reason: {{dedupe_reason}}\n',
                    ''
                ),
                E'- Bounty rank: {{bounty_rank}}\n',
                ''
            ),
            E'- Bounty impact level: {{bounty_rank_impact_level}}\n',
            ''
        ),
        E'- Bounty rank reasoning: {{bounty_rank_reasoning}}\n',
        ''
    ),
    updated_at = now()
WHERE name = 'Resource exhaustion'
  AND description = 'Classifies whether a canonical finding is fundamentally a memory or resource exhaustion issue and scores reliability, scale, and mainnet impact.'
  AND md5(content) = '566d4f4027afeb61ff15119814d4f7b7';

UPDATE public.post_scripts
SET
    content = replace(
        replace(
            content,
            E'- Dedupe reason: {{dedupe_reason}}\n',
            ''
        ),
        E'- Bounty rank reasoning: {{bounty_rank_reasoning}}\n',
        ''
    ),
    updated_at = now()
WHERE name = 'Patched since'
  AND description = 'Checks whether the reported risky behavior appears fixed or still present in the checked-out repository and scan context commits.'
  AND md5(content) = '4ae47c6f595b799f3ea8d422e4bcc677';

UPDATE public.post_scripts
SET
    content = replace(
        replace(
            replace(
                content,
                E'- Bounty rank: {{bounty_rank}}\n',
                ''
            ),
            E'- Bounty impact level: {{bounty_rank_impact_level}}\n',
            ''
        ),
        E'- Bounty rank reasoning: {{bounty_rank_reasoning}}\n',
        ''
    ),
    updated_at = now()
WHERE name = 'Ease of exploitability'
  AND description = 'Scores how easy the reported bug is to exploit in practice from the finding text and scan context.'
  AND md5(content) = '848a1af405353b981a7d7c7c7cbfe5aa';
