# Active provider accounts

Use **Accounts → Active** to choose which saved accounts may receive new assignments.
Existing and newly added accounts default to active. Turning the switch off preserves
credentials and configuration; turn it on again to reuse the account. Authentication
and quota status remain visible separately from the saved switch.

The setting applies to the registered providers' saved logins and API keys, including
environment keys. A provider with several accounts uses its active subset. If no active
credential is available, activate an account in Accounts and retry. Manual actions that
start model usage also require an active account. Login, credential replacement, status
refresh, and quota management remain available for inactive accounts.

The engine checks eligibility during account selection and again when a call acquires
its assignment slot, including after waiting for capacity and before retries. Calls
admitted before a toggle is saved may finish. A previously selected account that becomes
inactive before admission fails with an actionable message; it is never silently reused.

Preferences are stored in `account-activity.json` beside the provider credential store
specified by `OPEN_KRITT_PROVIDER_CREDENTIALS_PATH`. The backend writes this file
atomically and the engine reads it at each assignment boundary. The existing shared
credential directory supplies the same file to both services; no database migration or
new mount is required. Missing preferences default to active for compatibility, while
unreadable or invalid preferences block assignments until repaired. Back up this file
alongside the credential store. Preferences are associated with a provider and its
configured credential location, so reconnecting or replacing credentials there keeps
the saved setting.

The file has one writer: the application's backend. Deploy the backend and engine
changes together so both services honor the setting.

Account API responses use `active` for the saved preference and `available` for the
credential health boolean previously exposed as `active`. Update clients that use
`active` as an authentication-health check. Toggle an observed account with
`PATCH /api/accounts/:provider/account/:activityId/active` and a boolean `active` in
the JSON body. Existing login and removal account IDs are unchanged.
