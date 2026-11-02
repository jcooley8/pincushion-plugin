# QA result ingestion (Release 4 pilot)

`import_qa_results` is a bounded bridge from an existing axe or Playwright
run into Pincushion's agent-pin workflow. It is intended for small
AI-using agencies that already run checks in their own CI or local agent.

The project pilot is disabled unless an owner enables its server-side project
configuration. Prices, stakeholder access, manual-work entitlements, and
existing plan limits are unchanged.

## Call shape

Pass already-parsed JSON; the MCP server does not read a path or fetch a URL.

```json
{
  "projectId": "project_123",
  "pageUrl": "https://app.example.test/checkout",
  "device": "desktop",
  "format": "axe",
  "formatVersion": "4.10.2",
  "runId": "gha-1842",
  "source": "github-actions",
  "commitSha": "0123456789abcdef0123456789abcdef01234567",
  "environment": "staging",
  "results": {
    "violations": [],
    "passes": [],
    "incomplete": [],
    "inapplicable": []
  }
}
```

Supported formats are `axe` and `playwright`. A producer version is required
or must be present in the recognized result metadata. Payloads are limited to
512 KiB and 200 normalized records. Page URLs are canonicalized (HTTP(S), no
credentials, fragments removed, query pairs sorted) and result URLs must point
at the requested page.

Set `dryRun: true` to receive a preview containing normalized counts, the
exact deduplication key, and the deterministic pin ID. A dry run performs no
network request and makes no cloud or local write.

## What is stored

Each import stores a bounded run receipt with the source, exact format version,
run ID, commit/environment metadata, payload digest, and result counts. A
finding is deduplicated by exactly:

`project + canonical page + device + rule + target`

Repeated observations update one finding's latest outcome and provenance while
retaining its observation counters. Failed observations may create a
deterministic `ann_qa_...` pin tagged `agent-pin`, `qa-import`, and the format.
Existing terminal pins are preserved and never reopened; an unexpected pin
identity is a conflict rather than an overwrite.

Only a newly created agent pin consumes the existing `agent_pin` action pool;
pass-only runs, replays, and provenance updates are free. Free-plan quota and
credit-pack checks happen in the same transaction as the import, and a quota
failure rolls back the run and any pin it would have created. Pro and Team
accounts retain their existing unlimited automation behavior.

`passed`, `inconclusive`, and `skipped` observations never create a pin, close
one, change its status, or qualify as trusted verification. The response
explicitly reports `trusted: false` / `verification: not_established`.
Deployment confirmation, independently obtained checks, implementation
receipts, and client acceptance remain separate Pincushion evidence states.

## Authorization and rollout boundary

The hosted Edge adapter requires the exact active license credential, rechecks
the immutable `licenses.id` against project ownership or an `owner`/`editor`/
`developer` membership, verifies the registered page, and enforces the
project pilot flag. Its preflight reads a narrow service-only context RPC
because the pilot/config table has no direct service-role grant. The database
writer is a service-only RPC with RLS-protected tables; no browser, commenter,
shared report link, or hosted agent can enable the pilot or write records
directly.

The reviewed schema is applied and mirrored canonically as
[`20260910070702_add_qa_ingestion_records.sql`](../../supabase/migrations/20260910070702_add_qa_ingestion_records.sql).
Its migration identity, the 167-entry parity ledger, Edge function version 1,
provider source, and pilot-off response have independent production read-backs.
The disposable proof is
[`test-qa-ingestion-db.mjs`](../../scripts/test-qa-ingestion-db.mjs).

This increment does not configure providers, run checks, upload repository
contents, automatically resolve pins, or teach the agent project-specific
implementation guidance. Those concerns require separate, explicitly
authorized releases.
