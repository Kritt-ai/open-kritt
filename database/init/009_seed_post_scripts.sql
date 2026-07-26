INSERT INTO public.post_scripts (name, description, content, output_format)
SELECT
    'Resource exhaustion',
    'Classifies whether a finding is fundamentally a memory or resource exhaustion issue and scores reliability, scale, and mainnet impact.',
    $script$
You are a senior security engineer.

Repository: {{repo_full}}
Scan commit: {{commit_sha}}
Repository scope: {{repo_scope}}

Finding:
- Vulnerability type: {{vulnerability_type}}
- Summary: {{summary}}
- File path: {{file_path}}
- Line: {{line}}
- Explanation: {{explanation}}
- Trigger flow: {{trigger_flow}}
- Malicious input example: {{malicious_input_example}}
- Malicious actor: {{malicious_actor}}
- Exploitable: {{exploitable}}

Task:
Decide whether this finding is fundamentally a resource exhaustion attack.

Set _chip_resource_exhaustion=true when the core exploit is memory exhaustion, out-of-memory, unbounded storage growth, queue/pool exhaustion, connection/session exhaustion, file descriptor exhaustion, or another bounded runtime resource being consumed until service or network function fails.

Set _chip_resource_exhaustion=false for unrelated bug classes, purely logical consensus bugs, authorization bypasses, reward/accounting bugs, or cases where resource pressure is only incidental.

Score:
- attack_reliability: 1 = rare/specific state, 2 = realistic but conditional, 3 = reliable when attempted.
- network_scale: 1 = one node/user, 2 = several nodes/users, 3 = broad network participation or many victims.
- mainnet_impact: 0 = no meaningful mainnet impact, 1 = limited, 2 = material but not catastrophic, 3 = severe chain-wide or high-value impact.

Be conservative. If evidence is ambiguous, set _chip_resource_exhaustion=false and explain what is missing.
$script$,
    '{"_chip_resource_exhaustion":"boolean","attack_reliability":"number","network_scale":"number","mainnet_impact":"number","resource_exhaustion_reason":"string","attack_reliability_reason":"string","network_scale_reason":"string","mainnet_impact_reason":"string"}'
WHERE NOT EXISTS (SELECT 1 FROM public.post_scripts WHERE name = 'Resource exhaustion');

INSERT INTO public.post_scripts (name, description, content, output_format)
SELECT
    'Patched since',
    'Checks whether the reported risky behavior appears fixed or still present in the checked-out repository and scan context commits.',
    $script$
You are verifying whether a previously reported security finding appears patched or still present.

The repository is checked out for this scan. You may inspect the checked-out code and run read-only commands such as git diff, git show, git grep, and file reads. If useful, compare the checked-out commit with commit hints in the scan configuration.

Repository: {{repo_full}}
Scan commit field: {{commit_sha}}
Scan configuration JSON: {{configuration}}

Reported finding:
- Vulnerability type: {{vulnerability_type}}
- Summary: {{summary}}
- Explanation: {{explanation}}
- Trigger flow: {{trigger_flow}}
- Malicious input example: {{malicious_input_example}}
- File path: {{file_path}}
- Line: {{line}}

Task:
1. Determine the actual checked-out commit with git rev-parse HEAD.
2. If scan configuration includes source_tree_head_observed, production_mainnet_refresh, target commit, or similar commit hints, use them as context.
3. Determine whether the specific risky behavior described above is clearly fixed, clearly still present, or ambiguous in the checked-out code.
4. If there is no older and newer commit pair available, do not invent a diff. Make the best current-code judgment and set needs_manual_review=true when patch status cannot be conclusively established.

Return a concrete judgment tied to this finding, not a generic repo health statement.
$script$,
    '{"patched":"boolean","needs_manual_review":"boolean","confidence":"number","summary":"string","reasoning":"string","found_at_commit":"string","target_commit":"string"}'
WHERE NOT EXISTS (SELECT 1 FROM public.post_scripts WHERE name = 'Patched since');

INSERT INTO public.post_scripts (name, description, content, output_format)
SELECT
    'Ease of exploitability',
    'Scores how easy the reported bug is to exploit in practice from the finding text and scan context.',
    $script$
You are a bug bounty triager. Determine the ease of exploitability of this bug report.

Repository: {{repo_full}}
Finding:
- Vulnerability type: {{vulnerability_type}}
- Summary: {{summary}}
- Explanation: {{explanation}}
- Trigger flow: {{trigger_flow}}
- Malicious input example: {{malicious_input_example}}
- Malicious actor: {{malicious_actor}}
- Exploitable: {{exploitable}}

Score ease_of_exploitability from 0 to 10, where 10 is easiest and 0 is hardest.

Decrease the score for special permissions, rare victim state, narrow timing windows, victim cooperation, many repeated actions, preexisting compromise assumptions, resource-limit dependence, luck, race conditions, or weak evidence.

Focus on practical exploitability, not impact. A high-impact bug can still be hard to exploit, and a low-impact bug can still be easy to trigger.

If details are missing, make the most defensible assumption from the report and explain what would improve confidence.
$script$,
    '{"ease_of_exploitability":"number","reasoning":"string","missing_from_prompt":"string"}'
WHERE NOT EXISTS (SELECT 1 FROM public.post_scripts WHERE name = 'Ease of exploitability');
