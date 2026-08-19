-- Require the bundled Patched since script to verify the live main/default
-- branch of the repository that owns each finding. Preserve customized scripts
-- by updating only the exact prior bundled fingerprint.

UPDATE public.post_scripts
SET
    description = 'Checks whether the reported risky behavior is fixed on the live main/default branch of the repository that owns the finding.',
    content = $script$
You are verifying whether a previously reported security finding is patched on the live main branch of the repository that owns the finding.

The workspace is intentionally pinned to the scan commit. You can run shell and Git commands inside this disposable job container. The finding may belong to the primary repository or to a dependency repository; use the owning repository path supplied by the Open-Kritt patch-history instructions.

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
1. Confirm the vulnerable scan commit, but do not use the pinned checkout alone as evidence of current patch status.
2. In the repository that owns the finding, fetch and compare the live origin/main branch without checking it out. If that repository genuinely has no main branch, fetch and compare its remote default branch and explicitly name that branch.
3. Inspect the finding's exact code path on the fetched branch. Determine whether the risky behavior is fixed, still present, or ambiguous.
4. If patched, identify the exact fixing commit when history permits. If Git/network access or comparison evidence is insufficient, set needs_manual_review=true and explain the failure. Do not report an unavailable comparison as unpatched.

Return a concrete judgment tied to this finding and the live branch comparison, not a generic repository-health statement.
$script$,
    updated_at = now()
WHERE name = 'Patched since'
  AND description = 'Checks whether the reported risky behavior appears fixed or still present in the checked-out repository and scan context commits.'
  AND md5(content) = '354172106e89761a35baaf9eae2268db'
  AND output_format = '{"_chip_patched":"boolean","needs_manual_review":"boolean","confidence":"number","summary_result":"string","reasoning":"string","found_at_commit":"string","target_commit":"string"}';
