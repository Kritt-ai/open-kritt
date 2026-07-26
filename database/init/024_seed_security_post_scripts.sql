-- Add the bundled report, proof-of-concept, and bounty-scope post-scripts.
-- Name guards keep the migration idempotent and preserve scripts users already created.

INSERT INTO public.post_scripts (name, description, content, output_format)
SELECT
    'PoC Creator',
    'Builds and validates a reproducible proof-of-concept for each finding, then stores its Git diff in the PoC tab.',
    $script$
You are a whitehat security researcher preparing a bug bounty PoC for a single finding. Use only the available finding and context inputs: {{repo_full}}, {{repo_scope}}, {{commit_sha}}, {{workspace_root}}, {{workspace_layout}}, {{workspace_manifest_json}}, {{configuration}}, {{dependencies}}, {{summary}}, {{vulnerability_type}}, {{file_path}}, {{line}}, {{explanation}}, {{trigger_flow}}, {{exploitable}}, {{malicious_actor}}, {{malicious_input_example}}.

Your task: create a local PoC to demonstrate this issue to submit to the team Bug bounty program. Notice, the PoC should actually trigger the real issue and not just theoretical.

Here are the PoC rules from the bug bounty page:
```
A valid PoC should:



Build and run against the mentioned commit branch with clear setup instructions

Demonstrate the impact - show the actual outcome (crash, corruption, Theft of funds, Buffer Overflow, etc.), not just a hypothesis

Be self-contained - a reviewer should be able to reproduce the issue by following the steps in the report without additional guesswork

Include the attacker model - specify what position the attacker is in (Outside user, logged in user, gossip participant, etc.) and what inputs they control.
```

Make sure to run the PoC to validate it works and not just create a PoC that seems valid but you haven't checked it works. If it doesn't work keep fixing and iterating over it until either it does or you found a blocker for the issue. So feel free to run the PoC.

Your final output: Deliver ONLY the PoC diff of all the relevant files as a string in the `_reserved_poc` field.

Generate actual diff by using `git diff`
$script$,
    '{"_reserved_poc":"string"}'
WHERE NOT EXISTS (SELECT 1 FROM public.post_scripts WHERE name = 'PoC Creator');

INSERT INTO public.post_scripts (name, description, content, output_format)
SELECT
    'Report Creator',
    'Turns each finding into a structured Markdown bug bounty report shown in the Report tab.',
    $script$
You are a whitehat security researcher preparing a bug bounty report for a single finding. Use only the available finding and context inputs: {{repo_full}}, {{repo_scope}}, {{commit_sha}}, {{workspace_root}}, {{workspace_layout}}, {{workspace_manifest_json}}, {{configuration}}, {{dependencies}}, {{summary}}, {{vulnerability_type}}, {{file_path}}, {{line}}, {{explanation}}, {{trigger_flow}}, {{exploitable}}, {{malicious_actor}}, {{malicious_input_example}}.

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
    '{"_reserved_report":"string"}'
WHERE NOT EXISTS (SELECT 1 FROM public.post_scripts WHERE name = 'Report Creator');

INSERT INTO public.post_scripts (name, description, content, output_format)
SELECT
    'Is Malicious Actor in scope',
    'Revalidates each finding and checks whether its malicious actor is eligible under the configured bug bounty program.',
    $script$
Given the following finding:
{{summary}}

{{explanation}}

At {{file_path}}:{{line}}

Triggerable with the following trigger flow:
{{trigger_flow}}

And the following malicious input example:
{{malicious_input_example}}

By the following malicious actor: {{malicious_actor}}


I want you to do the following:
1. Verify this vulnerability is corrent
2. Verify using the bug bounty program {{extra.bug_bounty_url}} if the malicious actor is indeed in scope for the bounty program

Output the results into `_chip_is_in_scope`, and `is_valid` fields.
$script$,
    '{"_chip_is_in_scope":"boolean","is_valid":"boolean"}'
WHERE NOT EXISTS (SELECT 1 FROM public.post_scripts WHERE name = 'Is Malicious Actor in scope');
