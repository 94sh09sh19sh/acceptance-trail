---
name: evidence-chain
description: Use when you are asked to implement or verify a Jira issue and the Acceptance Trail MCP tools are available (get-work-order, submit-evidence, get-evidence-status), or when the user mentions a work order, acceptance criteria evidence, or an issue key like BMS-1. Fetches the person-approved work order, implements it, runs tests, reports honest evidence for every acceptance criterion, and checks what is still missing.
---

# Acceptance Trail workflow

Acceptance Trail is a Jira app. A person approves a **work order**: acceptance criteria `AC-1`, `AC-2`, ... plus a revision number. You implement it and report **evidence per criterion** through MCP tools. A person then reviews each piece of evidence.

Your client may add an environment suffix to tool names, for example `get-work-order_development`. Match on the base name.

The tools run with the Jira permissions of the account you connected with. Reading needs permission to view the issue; `submit-evidence` and `propose-work-order` also need permission to edit it.

## Hard rules
- Only a person can approve a work order or accept or reject evidence, in the Jira issue panel. No tool does either. Never try to do it for them, work around it, or edit the issue to make your work match its criteria.
- Never report a failure as a pass. A test that failed is `fail`. A criterion with no test, or tests you could not run, is `not-run`.
- Report only what you actually ran. Paste real output, never reconstructed output.
- Send `criterionId` and `workOrderRev` exactly as `get-work-order` returned them. Do not guess IDs or revisions.

## Steps
1. **Fetch.** Call `get-work-order` with `issueKey` (for example `BMS-1`).
2. **Check the answer.**
   - `ok: false`: see Errors.
   - `status: "not-approved"`: stop. Tell the person that a work order must be approved in the Acceptance Trail panel on the issue (`hasDraft: true` means a draft is already waiting). Do not implement or submit anything yet.
   - `status: "approved"`: note `workOrderRev` and, for each criterion, `criterionId`, `text` and `requiredEvidenceType`.
   - `stale: true`: see Stale work orders.
3. **Implement** one criterion at a time. Treat each criterion's `text` as the requirement; do not reword it. Give every criterion at least one test whose name contains its ID, such as `test_ac3_...`, so output maps back to criteria.
4. **Run the tests.** Run the whole suite and keep the exact output.
5. **Report.** Call `submit-evidence` once per criterion:
   - `issueKey`, `criterionId`, `workOrderRev` (integer).
   - `verdict`: `pass`, `fail` or `not-run`. Use `pass` only if the tests for that criterion all passed in your latest run.
   - `evidenceType`: `test`, `analysis`, `review` or `demo`. Prefer the `requiredEvidenceType`.
   - `summary`: what you did and what the result shows, up to 2,000 characters.
   - `reference`: commit SHA or CI link, up to 500 characters.
   - `outputExcerpt`: the relevant lines of real test output, up to 4,000 characters. Include the failing lines for a `fail`.
   - `agentName`: your name, for example `Claude Code`.
   Submit failures too. Never leave a failing criterion out so the picture looks better.
6. **Check for gaps.** Call `get-evidence-status` (see Gap check) and tell the person what is left.

## If a criterion fails
Submit `fail` with the failing output. If you then fix the code and rerun, submit new evidence for that criterion; only the latest evidence counts, and the earlier one stays in the record. Do not weaken or delete a test just to get a pass. If a test was wrong, fix it and say so in the summary.

## Errors
Failures come back as `{ok: false, error: {code, message}}` and nothing is stored.
- `NOT_APPROVED`: stop and ask a person to approve the work order in Jira.
- `REVISION_MISMATCH`: a newer revision exists. Call `get-work-order` again, re-read the criteria, check that your work still matches them, rerun the tests, then submit with the current revision.
- `UNKNOWN_CRITERION`: the message lists the valid IDs. Use one of those; do not invent IDs.
- `INVALID_INPUT`: fix the parameter named in the message, for example `verdict` or `evidenceType`.
- `FORBIDDEN`: you can view the issue but the Jira account you are connected with cannot edit it, so `submit-evidence` and `propose-work-order` are refused. Do not retry. Tell the person; someone with edit permission on the issue has to connect the agent, or grant that permission. Read-only tools such as `get-work-order` and `get-evidence-status` still work.
- `ISSUE_NOT_FOUND`, `PROJECT_NOT_FOUND`: check the key. You may also lack permission to view it; ask the person.
- `INTERNAL_ERROR`: retry once, then tell the person. Do not loop.

A successful `submit-evidence` returns `seq` and `hash`. If `truncated` lists fields, they were cut at the limits; keep the important lines at the start of long text.

## Stale work orders
`stale: true` (from `get-work-order` or `get-evidence-status`) means the issue description changed after approval, so the criteria may be out of date. The server still accepts evidence for the approved revision, but do not carry on silently. Stop, tell the person, and ask them to review the issue and use "Draft new revision" in the Acceptance Trail panel and approve it. Continue on the current revision only if the person says so, and then note in each summary that the work order was stale.

## Gap check
`get-evidence-status` returns `chainVerified`, `stale`, `gapCount` and, per criterion, `status` (`no-evidence`, `submitted`, `accepted`, `rejected`), `gap`, `latestVerdict` and `reviewNote`.
- `gap: "no-evidence"`: you missed a criterion. Implement and submit it.
- `gap: "failed"`: your latest verdict was `fail`. Fix it and resubmit, or explain the blocker.
- `gap: "not-run"`: your latest verdict was `not-run`, so the check has not been run. Run it and resubmit, or explain why it cannot run. Do not call it failed.
- `gap: "rejected"`: a person rejected it. Read `reviewNote`, fix, rerun, submit new evidence.
- `gap: "unreviewed"`: waiting for a person. That is expected after you submit; tell them. It is not yours to resolve.
- `chainVerified: false`: tell the person. Do not try to repair or resubmit.

Finish with a short table: criterion, verdict, one line of evidence, remaining gap. Say what a person must do next, such as review in the panel or approve a new revision.

## Other tools
- `list-open-work-orders` and `list-gaps` take a `projectKey` and show which issues still need evidence.
- `list-gaps` also takes an optional `fixVersion`, a version name such as `1.4.0`, to answer "what is still missing for this release?". It lists only issues with that fix version. If the name is not a version of the project, the error code is `VERSION_NOT_FOUND` and the message lists the real versions: pick one of those or ask the person; never guess. `VERSIONS_UNAVAILABLE` means Jira did not return the versions, so retry once.
- `propose-work-order` takes `issueKey` and `criteriaJson`, a JSON array string such as `[{"text":"...","evidenceType":"test"}]`. Use it only when an issue has no usable criteria and the person asked you to draft some. It saves a draft; it never approves one, so tell the person to review and approve it in Jira.
