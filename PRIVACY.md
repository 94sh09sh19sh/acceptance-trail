# Privacy policy for Acceptance Trail for Jira

Last updated: 2026-11-20

Acceptance Trail for Jira ("the app") is an Atlassian Forge app published by an individual developer under the handle `94sh09sh19sh` ("the developer"). This document describes what the app stores, where, and who can see it. Every statement about the app's behaviour can be checked against the source code in this repository.

## Summary

- The app stores its records in Atlassian's Forge hosted storage and in one Jira issue property. Both are on Atlassian's platform.
- The app makes no network requests outside Atlassian. Its manifest declares no egress, no remote backend and no web trigger, and it does not call an LLM.
- The only user identifier the app stores is the Atlassian account ID of the person who saved a draft, approved a work order, submitted or recorded evidence, or reviewed it. It stores no names, email addresses or avatars.
- The developer runs no server for this app and receives no copy of the stored records.
- Outside a development install, the app has no function that edits or deletes a stored event.

## What the app stores

In Forge key-value storage, keyed by Jira's numeric issue ID:

| Record | Contents |
|---|---|
| Draft work order | Acceptance criteria (text and evidence type), how the draft was made (`parser`, `manual` or `agent`), the time, and the account ID of the person who saved it. For a draft proposed by an agent, this is the account that the agent's MCP connection is signed in as. |
| Approved work order revision | Revision number, criteria (ID, text, evidence type), the approver's account ID, the approval time, a SHA-256 hash of the issue description at approval, the draft source, and the number of the approval event. |
| Events | An append-only hash chain. Each event has a sequence number, type, time, the acting account ID, the previous hash, its own hash, and a payload (below). |
| Chain head | The latest sequence number, its hash, and the latest revision number. |
| Matrix summary | Issue ID, issue key, issue title, revision, counts, gap kinds, stale flag, the status of each criterion, the result of the last chain check, and the update time. Stored per project and issue. |

Event payloads:

- `work_order_approved`: revision, criteria, description hash.
- `evidence_submitted`: revision, criterion ID, verdict, evidence type, summary (up to 2,000 characters), reference (up to 500), output excerpt (up to 4,000), agent name (up to 100), the names of any fields that were cut to length, and the source (`mcp` or `panel`).
- `evidence_reviewed`: revision, the number of the evidence event, criterion ID, decision, and an optional note (up to 500 characters).

On the Jira issue itself, the app writes one issue property, `evidence-chain-summary`: a schema number, revision, total and accepted counts, gap count, gap kinds, stale flag and update time. It contains no account IDs, no criteria text and no text from agents.

Criteria text (up to 1,000 characters each, up to 30 criteria), evidence summaries, references, output excerpts, agent names and review notes are free text. The app stores them as written, by a person or by an agent, and does not scan or redact them.

## What the app reads but does not store

- The issue description. The app reads it to suggest draft criteria and to compute the hash that detects later edits. Only the hash is stored, plus any text a person keeps as acceptance criteria.
- The issue's fix versions and the project's version list, used to filter the Evidence Matrix and the audit pack.
- Jira permission checks for the calling user (browse and edit).

## What the app does not store or collect

- Names, email addresses, avatars or any other profile field. The app never requests user profiles from Jira. Where the panel shows a person's name and avatar, Jira's own user component renders them in the browser from the account ID.
- Authentication tokens, IP addresses, cookies or analytics. The app has no tracking and no telemetry of its own.

## Where the data is stored

- Work orders, events, chain heads and matrix summaries are in Forge hosted storage (the Key-Value Store), which Atlassian operates.
- The `evidence-chain-summary` property is stored by Jira on the issue.
- The app keeps no copy anywhere else.

## Who can see the data

- **People on your Jira site.** The panels, the Evidence Matrix and the audit pack show records only for issues the viewer has permission to view. The audit pack contains account IDs and the stored text; it is displayed for the viewer to copy, and the app does not send it anywhere.
- **MCP clients.** If a site admin enables the app's MCP tools and a person connects an MCP client (for example an AI coding agent), the tools return work order content and evidence status to that client, and accept evidence and draft proposals from it, with that person's Jira permissions. The connection runs through Atlassian's MCP endpoint. What the client and its AI provider do with what they receive is outside the app's control.
- **Rovo.** The app includes a Rovo agent, Evidence Auditor. When a person uses it, Atlassian Rovo calls the same tools as that person. That processing is done by Atlassian.
- **The developer.** The app contains no code that sends stored records to the developer. As with any Forge app, Atlassian's developer console shows the developer which sites have installed the app, and the app's log lines (next section).

## Logs

The app writes short log lines to Forge's logging: the tool or function name, the issue or project key (or issue ID), a result code, and, for unexpected errors, the first 200 characters of the error message. It does not log tool inputs, stored records, tokens or account IDs.

Forge shares an installation's logs with the app developer by default. A site admin can turn this off in Atlassian Administration: **Apps**, **Connected apps**, the app's **Details** tab, **Logs access**.

## Retention and deletion

- Events are append-only. Outside a development install, the app has no function that edits or deletes an event, an approved revision or a single piece of evidence. This is by design: the chain is the audit record.
- A draft can be discarded by anyone who can edit the issue, and is removed when it is approved.
- When an issue moves to another project, its matrix summary is removed from the old project and written under the new one.
- The app does not react to an issue being deleted in Jira. Its records for that issue stay in Forge storage until the app is uninstalled.
- When the app is uninstalled, Atlassian deletes its Forge hosted storage for that site. Atlassian's documentation states a retention period of 28 days after uninstallation. See [Forge hosted storage data lifecycle](https://developer.atlassian.com/platform/forge/storage-reference/hosted-storage-data-lifecycle/).
- The app has no uninstall handler, so it does not itself remove the `evidence-chain-summary` issue properties.

Because the developer has no access to the stored records, the developer cannot look up, export, correct or delete them on request. A site admin controls them by uninstalling the app.

## Changes

Changes to this policy are made in this file. The repository history shows every earlier version.

## Contact

Open an issue at <https://github.com/94sh09sh19sh/acceptance-trail/issues>. Issues are public, so do not include personal data or secrets.
