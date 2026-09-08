-- Make the bundled Report Creator's prompt readable after its input variables
-- are expanded. Update only the exact original default to preserve user edits.

UPDATE public.post_scripts
SET
    content = $script$
You are a whitehat security researcher preparing a bug bounty report for a single finding. Use only the finding and repository context below.

Repository and scan context:
- Repository full name: {{repo_full}}
- Repository scope scanned: {{repo_scope}}
- Commit SHA scanned: {{commit_sha}}
- Checked-out workspace root: {{workspace_root}}
- Workspace layout (available directories and files):
{{workspace_layout}}
- Workspace manifest JSON (repository metadata):
```json
{{workspace_manifest_json}}
```
- Runtime configuration:
```json
{{configuration}}
```
- Dependencies (packages and versions):
{{dependencies}}

Finding:
- Summary: {{summary}}
- Vulnerability type: {{vulnerability_type}}
- Vulnerable file path: {{file_path}}
- Vulnerable line number: {{line}}
- Technical explanation: {{explanation}}
- Trigger flow (ordered path from attacker input to the vulnerable operation): {{trigger_flow}}
- Confirmed exploitable: {{exploitable}}
- Malicious actor (the attacker role): {{malicious_actor}}
- Malicious input example (payload or sequence): {{malicious_input_example}}

Given this vulnerability, populate the following report template with the provided issue

```md
# Project Name + Issue
## Description
Bla bla bla

## Deep Dive
Bleep bloop blop

## Exploitation
Blllaaa

## Impact
Bla bla bla

## Recommendation
Woow wow
```

Return the Markdown report in the `_reserved_report` field
$script$,
    updated_at = now()
WHERE name = 'Report Creator'
  AND description = 'Turns each finding into a structured Markdown bug bounty report shown in the Report tab.'
  AND md5(content) = '3e84b073db0fd6b44b16eeecfe4c5048'
  AND output_format = '{"_reserved_report":"string"}';
