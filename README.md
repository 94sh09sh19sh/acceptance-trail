# Acceptance Trail for Jira

Acceptance Trail is a Forge app for Jira. It ties evidence reported by AI coding agents to individual acceptance criteria, and keeps all of it inside Atlassian.

1. A person drafts a **work order** from an issue's acceptance criteria and approves it.
2. An external AI coding agent reads the approved work order over the Forge MCP server and submits **evidence** for each criterion: a pass, fail or not-run verdict, a summary, a commit or CI reference, and an output excerpt. A person can also record evidence by hand in the issue panel (**Record evidence**), for example for a review or a demo, or to try the app without an agent. Those entries are marked `Manual entry`.
3. A person **accepts or rejects** each piece of evidence in the issue panel, whichever way it arrived.
4. The **Evidence Matrix** project page shows every issue with a work order, its progress, and its gaps. It can be filtered by **fix version** ("what is still missing for 1.4.0?") and can export an **audit pack** as Markdown or CSV, for one version or for everything.
5. The **Evidence Auditor** Rovo agent answers questions like "what evidence is still missing in this project?".

Every approval, submission and review is an append-only event. Each event stores the SHA-256 hash of the previous one, so the app can show whether the chain verifies.

**Only people can approve work orders and review evidence.** No MCP tool or Rovo action does either. Evidence arrives two ways: agents submit it through MCP, and people with edit permission can record it by hand in the issue panel. Either way it waits for the same human review. Agents can only read work orders, submit evidence, and propose draft work orders that a person still has to approve.

## Try it in five minutes

For a first run on your own Jira site. The button names below are the ones the app shows. Steps 1 to 5 need only Jira and no AI agent. Step 6 connects an AI coding agent through MCP, which is how agents use the app; it needs a site admin and an MCP client. Steps 7 and 8 work with or without step 6.

1. **Install.** Install the app ([Install](#install)).
2. **Create a work item.** In any project (the examples use the key `DEMO`), create a work item with this title and description. The four criteria must stay a numbered or bulleted list under the line `Acceptance criteria`; the Jira editor turns lines that start with `1. ` into a numbered list as you type, or when you paste the whole block.

   Title: `BMS firmware: over-temperature protection for charge and discharge paths`

   ```text
   Demo only, not a design recommendation. All numbers are common published values used for illustration; real thresholds come from the cell datasheet and the safety analysis.

   The BMS must protect the cells from operating outside their rated temperature window. Charge and discharge are handled as separate paths because cells commonly tolerate a wider temperature range when discharging than when charging. A failed temperature sensor must never be read as a safe temperature.

   Acceptance criteria
   1. When any cell temperature reaches 45 °C or higher, the BMS opens the charge path within 1 s and logs the event with timestamp and sensor ID.
   2. When any cell temperature reaches 60 °C or higher, the BMS opens the discharge path within 1 s and logs the event.
   3. The charge path is re-enabled only after all cell temperatures fall to 40 °C or lower (5 °C hysteresis), and the test shows no more than one open/close cycle while temperature oscillates between 43 °C and 46 °C.
   4. If a temperature sensor reads open-circuit or short-circuit, the BMS reports a sensor fault, opens both charge and discharge paths, and stays in the safe state until the fault is cleared and the sensor passes a plausibility check.
   ```

3. **Draft and approve.** On the work item, select the hexagon-shaped **app actions** icon under the title (it has no label), then **Acceptance Trail**, to add the panel. Select **Draft work order**. The four criteria appear as AC-1 to AC-4; pick the evidence each one needs (`test`, `analysis`, `review` or `demo`) and select **Approve**. The panel now shows `Work order revision 1` and `Chain verified`. If the description has nothing the app can use as criteria, the draft has one empty row (AC-1): type a criterion there, then **Approve**. If it has no `Acceptance criteria` heading, the draft takes the items of every list in the description and says so above the draft; remove the ones that are not criteria before you approve.
4. **Record evidence by hand.** Each criterion now has **Record evidence**. Select it for AC-1, choose the verdict `pass`, type a summary such as `Trial entry recorded by hand`, and select **Record evidence**. Do the same for AC-2 with `fail`, AC-3 with `not-run` and AC-4 with `pass`. Each criterion shows `Awaiting review`, and the latest evidence carries the label `Manual entry`; fail and not-run count as gaps, which the Evidence Matrix lists as `Failed` and `Not run`.
5. **Review in Jira.** **Details** opens the evidence: **Source** says `Manual entry (Jira panel)` and **Recorded by** shows your account. **Accept** or **Reject** records your review. Then select **Record evidence** for AC-2 again with `pass` and open **Details** for AC-2: the **History** list shows both entries, the newest marked `latest` and the earlier one `superseded`. Only the latest counts and can be reviewed.
6. **Let an AI agent report through MCP.** This is the path for AI coding agents. It needs a site admin and an MCP client with remote HTTP and OAuth support (we tested Claude Code). If you cannot do this now, go on to step 7.
   1. Turn on the app's MCP tools in Atlassian Administration ([Enable the MCP server](#enable-the-mcp-server-for-external-agents)).
   2. Connect Claude Code ([Connect Claude Code](#connect-claude-code)): `claude mcp add --transport http acceptance-trail https://mcp.atlassian.com/forge/ce2a1488-ddf0-481d-ba69-e606897cb462` (the URL for an install from the installation link; an install from source uses its own app ID), then `/mcp` to sign in to Atlassian and pick your site. On an install from the installation link the tool names have no suffix (`get-work-order`); a development install appends `_development` (`get-work-order_development`). `/mcp` lists the exact names.
   3. Give the agent a prompt that needs no code. Replace `DEMO-1` with the key of your work item:

      ```text
      Use the Acceptance Trail MCP tools. Call get-work-order for DEMO-1 and list the criteria.
      Then call submit-evidence once per criterion with workOrderRev from get-work-order,
      verdict not-run, evidenceType test, agentName "Claude Code", and a summary saying this
      is a trial and no tests were run. Finally call get-evidence-status for DEMO-1.
      ```

   4. Select **Refresh** in the Acceptance Trail panel. The agent's submissions are now the latest evidence for each criterion and wait for review; **Details** shows **Source** `AI agent through MCP` and the agent name, and your manual entries move down the **History** list as `superseded`. Review them as in step 5.

   To try real evidence instead, this repository's `demo/` folder holds a small C project with tests for these four criteria, and `agent-skill/evidence-chain/SKILL.md` teaches an agent the full loop (read the work order, implement, run the tests, report each criterion).
7. **See the gaps.** Open the **Evidence Matrix** project page (project navigation tabs, or **More**). It shows progress, fix version and gap kinds per work item; **Refresh** reloads it, and **Export audit pack** produces Markdown or CSV. If the project has versions, give the work item a fix version, **Refresh**, and pick that version in **Fix version**: the table and the four counts then cover only that version, and the export follows the same filter.
8. **Ask Rovo.** If your site has Rovo, in Jira select **Ask Rovo**, open the agent menu at the top of the chat, choose **Browse agents**, find **Evidence Auditor** and select **Chat**. Then ask `What evidence is still missing in project DEMO?`, with `DEMO` replaced by your project key.

## Install

You need a Jira Cloud site where you are a site admin (admin rights are only needed for the MCP setting below).

- **From the installation link:** open the [installation link](https://developer.atlassian.com/console/install/ce2a1488-ddf0-481d-ba69-e606897cb462?signature=AYABeE134mi35UsCKVE2xh3rMSEAAAADAAdhd3Mta21zAEthcm46YXdzOmttczp1cy13ZXN0LTI6NzA5NTg3ODM1MjQzOmtleS83MDVlZDY3MC1mNTdjLTQxYjUtOWY5Yi1lM2YyZGNjMTQ2ZTcAuAECAQB4CxqLTo9l4lqXuFjNim1xJM%2Bp%2F3TVP9xHS2BrU5DRRucBBPboXrLH0On9SgdlzRbjpQAAAH4wfAYJKoZIhvcNAQcGoG8wbQIBADBoBgkqhkiG9w0BBwEwHgYJYIZIAWUDBAEuMBEEDOpP9Q7yipWfEyRUtwIBEIA7RCEZYaJoxit9eKzKzt1jhA%2FYiq0BVS1gwHI7sC%2BXgrhBQ758ls%2B0Z%2BjKywi4EVqsRU9f69dV48%2FVxioAB2F3cy1rbXMAS2Fybjphd3M6a21zOmV1LXdlc3QtMTo3MDk1ODc4MzUyNDM6a2V5LzQ2MzBjZTZiLTAwYzMtNGRlMi04NzdiLTYyN2UyMDYwZTVjYwC4AQICAHi9bVMAkme4qVQX1fQHo6ePw3H40A7cGfz7yrmSfBWMXgF%2FpHGQhbJOlGca71khRo8MAAAAfjB8BgkqhkiG9w0BBwagbzBtAgEAMGgGCSqGSIb3DQEHATAeBglghkgBZQMEAS4wEQQMtoHoEX1Y4WilddPmAgEQgDs3gY8M%2BSxsAl2hh9XfAuRz6YFcEcROXwMNZIc%2BuAgYD5LbuTWxn4wqf7jzilNH05cTnyXmwyiWTyMePQAHYXdzLWttcwBLYXJuOmF3czprbXM6dXMtZWFzdC0xOjcwOTU4NzgzNTI0MzprZXkvNmMxMjBiYTAtNGNkNS00OTg1LWI4MmUtNDBhMDQ5NTJjYzU3ALgBAgIAeDYASx0XCjkny4iLV6vz%2BKtEGSGT6kdt0QRpkn6D%2FlVEAZvQZEu%2BvVrfAU%2BKcjkm1i4AAAB%2BMHwGCSqGSIb3DQEHBqBvMG0CAQAwaAYJKoZIhvcNAQcBMB4GCWCGSAFlAwQBLjARBAwanr1l%2BkH4y8fcRCsCARCAOxHXTHvdIsdfGjcz4qhQ3BnGiMJJjb2A87yqyWXJBLNoY3Xkf6wg4QqK2fmYrcdB1uKJg2K2JPbkKkMjAgAAAAAMAAAQAAAAAAAAAAAAAAAAAFR7fV7rX723NYF4AK7hD2T%2F%2F%2F%2F%2FAAAAAQAAAAAAAAAAAAAAAQAAADI9dTVnaNkUcv4eragiP1524XqswIrkTkLsWb6G%2BbVQnKKUpvsGIInxvl%2Bawqiq8XyG%2F2cKwXhUmScyDzhURrodrK4%3D&product=jira), select **Get app**, pick your site, and select **Install**. The page lists three permissions in plain words (View Jira issue data, Create and manage issues, App Storage scope); they are the scopes in the [Scopes](#scopes) table.
- **From source (development environment):** the `app.id` in `manifest.yml` belongs to the original app, so register your own copy first. `forge register` creates an app under your Atlassian developer account and writes its ID into `manifest.yml`; the MCP server URL then uses that ID ([Connect Claude Code](#connect-claude-code)).

  ```sh
  npm install
  forge register acceptance-trail
  forge deploy --non-interactive -e development
  forge install --non-interactive --site <your-site>.atlassian.net --product jira -e development
  ```

No settings page and no configuration are needed after installing.

## Where to find it in Jira

| What | Where | Needs a click first? |
|---|---|---|
| **Acceptance Trail status** (issue context panel) | Right-hand column of every work item, under the fields such as Details and Automation. The collapsed header shows a status such as `No work order`, `Draft`, `2 gaps`, `4/4 accepted` or `Chain broken`. Expand it for a per-criterion summary. | No. Jira shows it on every work item. |
| **Acceptance Trail panel** (issue panel) | Main column, above Activity. This is where people draft, approve, record evidence by hand and review. Open it once per work item: select the **app actions** icon in the row of icons under the work item title, then **Acceptance Trail**. After that it stays on that work item for everyone. | Yes, once per work item |
| **Evidence Matrix** (project page) | In the space (project) navigation tabs. If it is not visible, open **More** and choose **Evidence Matrix**. | No |
| **Evidence Auditor** (Rovo agent) | Rovo Chat, agent list | No |

**One-time setup for Jira admins: show the panel on every work item.** Jira does not let apps turn this on themselves, which is why the always-visible status panel exists.

1. Open any work item and add the Acceptance Trail panel once (app actions icon, then **Acceptance Trail**).
2. In the panel header, open the **•••** menu and choose **Show for all work items**.
3. The panel now appears on work items without the extra click. **Hide from all work items** in the same menu undoes it.

## Enable the MCP server for external agents

External MCP access is off by default. A site or organization admin turns it on:

1. Go to **Atlassian Administration > Apps > Sites > (your site) > Connected apps**.
2. Select **Acceptance Trail**, open the app details, and turn on the tools you want to expose.

The setting applies per site and per app installation.

## Connect Claude Code

For an install from the installation link, the MCP server URL is `https://mcp.atlassian.com/forge/ce2a1488-ddf0-481d-ba69-e606897cb462`:

```sh
claude mcp add --transport http acceptance-trail https://mcp.atlassian.com/forge/ce2a1488-ddf0-481d-ba69-e606897cb462
```

For an install from source, replace the UUID with your own app ID: the UUID at the end of `app.id` in `manifest.yml`, the part after `ari:cloud:ecosystem::app/`, which `forge register` wrote there.

Inside Claude Code, run `/mcp` to authenticate. A browser window opens for Atlassian consent; pick the site where the app is installed. Tools then run with your own Jira permissions. A newly added server is loaded when Claude Code starts, so restart the session if the tools do not appear.

Tool names depend on the environment. An install from the installation link (production) uses the plain names, for example `get-work-order`. A development install appends the environment name: `get-work-order_development`. A site that has both installs sees both sets on the same connection.

A typical agent loop:

1. `get-work-order` with the issue key. If the status is `not-approved`, stop and ask a person to approve it in Jira.
2. Implement the change and run the tests.
3. Call `submit-evidence` once per criterion, using the `workOrderRev` from step 1.
4. `get-evidence-status` to check what is still open.

## Tools

| Tool | Verb | Exposed to | Purpose |
|---|---|---|---|
| `get-work-order` | GET | MCP, Rovo | Approved criteria and revision. If the work order is not approved, returns only the status. |
| `list-open-work-orders` | GET | MCP, Rovo | Approved work orders in a project that still have gaps |
| `get-evidence-status` | GET | MCP, Rovo | Status, gap kind, `evidenceCount` (submissions for the current revision) and `latestSource` (`mcp` or `panel`, see below) for each criterion of an issue, plus a summary of earlier revisions |
| `submit-evidence` | CREATE | MCP | Evidence for one criterion. Needs permission to edit the issue. Rejected if the revision or criterion ID does not match. |
| `propose-work-order` | CREATE | MCP, Rovo | Saves a draft for a person to approve. Needs permission to edit the issue. Never changes the approved revision. |
| `list-gaps` | GET | MCP, Rovo | Gaps per issue in a project. Optional `fixVersion` (a version name such as `1.4.0`) lists only issues with that fix version; an unknown name is an error that lists the project's versions, not an empty list. |

Long fields are truncated, and the response says which ones were cut. The limits are 2,000 characters for `summary`, 4,000 for `outputExcerpt`, and 500 for `reference`.

### Evidence recorded by hand

**Record evidence** in the issue panel is not a tool: agents and the Evidence Auditor cannot call it. It takes the same fields as `submit-evidence` except `agentName` (verdict, evidence type, summary, and optional reference and output excerpt) and goes through the same checks: current revision, existing criterion ID, allowed values, the same length limits and truncation. It needs permission to edit the issue, like approving and reviewing.

The app marks where each piece of evidence came from, and the person filling in the form cannot change it:

- Each evidence event stores `source`: `mcp` for `submit-evidence`, `panel` for **Record evidence**. Events written before this field existed have no `source` and count as `mcp`, because MCP was the only way in at the time. The field is part of the hashed event, so changing it later breaks the chain check.
- For manual entries the app writes the agent name `Manual entry (Jira panel)` itself. Labels follow `source`, not the name, so an agent that calls itself `Manual entry (Jira panel)` is still shown as `MCP: Manual entry (Jira panel)`.
- Where it shows: the evidence table (`Manual entry` under the time), **Details** (**Source**, and **Recorded by** instead of **Submitted by**), **History** (`MCP: <agent name>` or `Manual entry (Jira panel)`), the review dialog, the audit pack (Markdown and the CSV column `evidence_source`) and `latestSource` in `get-evidence-status`.

### Errors

Failures return `{ ok: false, error: { code, message } }` and store nothing.

| Code | Meaning |
|---|---|
| `NOT_APPROVED` | The issue has no approved work order yet |
| `REVISION_MISMATCH` | `workOrderRev` is not the current revision |
| `UNKNOWN_CRITERION` | `criterionId` is not in the current revision; the message lists valid IDs |
| `INVALID_INPUT` | A parameter is missing or not one of the allowed values |
| `VERSION_NOT_FOUND` | `list-gaps` was given a `fixVersion` that is not a version of the project; the message lists the available versions |
| `VERSIONS_UNAVAILABLE` | A fix-version filter was requested but Jira did not return the versions; nothing is filtered silently, retry once |
| `FORBIDDEN` | The caller can view the issue but cannot edit it, so `submit-evidence` and `propose-work-order` are refused (and, in the issue panel, drafting, approving, **Record evidence** and reviewing). Read-only tools still work. |
| `ISSUE_NOT_FOUND`, `PROJECT_NOT_FOUND` | The key does not exist, or the caller cannot view it |
| `BUSY` | Too many writes reached the same issue at once, for example many `submit-evidence` calls in parallel. Nothing was stored; retry the call. |
| `INTERNAL_ERROR` | Unexpected failure; retry once |

### Statuses and gaps

- **Criterion status:** `no-evidence`, `submitted` (awaiting review), `accepted`, `rejected`. Only the latest evidence for a criterion counts, and only the latest can be reviewed. Earlier submissions for the same revision stay in the chain and are listed as `superseded` in the evidence **History** (issue panel, **Details**) and in the audit pack.
- **Gap kinds:**
  - `no-evidence`
  - `failed`: the latest verdict is fail
  - `not-run`: the latest verdict is not-run, so the check was not run. It is a gap, but not a failure. Like `failed`, it stays a gap when the evidence is accepted or rejected.
  - `unreviewed`
  - `rejected`
  - `stale`: the issue description changed after approval

### New revisions

Evidence belongs to the revision it was submitted for. When a person approves a new revision:

- Every criterion of the new revision starts at `no-evidence`, even if its text did not change.
- Earlier evidence and reviews stay in the hash chain, but they no longer count. The panel and `get-evidence-status` show a short summary of each earlier revision.
- Evidence sent with the old `workOrderRev` is refused with `REVISION_MISMATCH`, and old evidence can no longer be reviewed.

### Stale markers

When an issue's description changes after approval, the issue is marked stale. The issue panel checks this when it opens. The Evidence Matrix is updated by an issue-updated event trigger, usually within a few minutes and without anyone opening the issue.

## Search with JQL

Each issue with an approved work order carries an issue property, `evidence-chain-summary`, that the app indexes for JQL through a `jira:entityProperty` module. It holds only counts and kinds, no names, account IDs or agent text:

| JQL field | Property path | Type | Meaning |
|---|---|---|---|
| `evidenceRevision` | `rev` | number | Current work order revision |
| `evidenceCriteria` | `total` | number | Number of acceptance criteria |
| `evidenceAccepted` | `accepted` | number | Criteria with accepted evidence |
| `evidenceGaps` | `gapCount` | number | Gaps, counting a stale work order as one |
| `evidenceGapKind` | `gapKinds` | string list | `no-evidence`, `failed`, `not-run`, `unreviewed`, `rejected`, `stale` |
| `evidenceStale` | `stale` | string | `"true"` or `"false"` |
| `evidenceUpdated` | `updatedAt` | date | When the counts last changed |

Examples:

```
project = BMS AND evidenceGaps > 0 ORDER BY evidenceGaps DESC
project = BMS AND evidenceStale = "true"
project = BMS AND evidenceGapKind = "failed"
project = BMS AND evidenceGapKind = "not-run"
project = BMS AND evidenceCriteria > 0 AND evidenceGaps = 0
issue.property[evidence-chain-summary].gapCount > 0

project = BMS AND fixVersion = "1.4.0" AND evidenceGaps > 0
```

The last example is the release question in JQL form: work items in version 1.4.0 that still have gaps. The Evidence Matrix filter and `list-gaps` with `fixVersion` answer the same question without JQL.

The property is a copy for searching; the hash chain stays the source of truth. The app rewrites it whenever it recalculates an issue (approval, evidence, review, the issue-updated trigger, or opening the panel) and the counts have changed. If Jira refuses the write, for example because the caller cannot edit the issue, the main action still succeeds and the next recalculation tries again. Issues approved before this feature get the property the next time they are recalculated.

## Release check by fix version

Before a release, ask which acceptance criteria in a version still lack accepted evidence:

- **Evidence Matrix:** each row shows the work item's fix versions. Pick a version in **Fix version** (the list is the project's versions, plus **All versions** and **No version**). The table and the four counts above it cover only the matching work items. A work item with several fix versions matches each of them.
- **MCP and Rovo:** `list-gaps` with `projectKey` and `fixVersion`, for example `fixVersion` `1.4.0`. The answer lists only that version's work items with gaps, shows each one's fix versions, and echoes the version name as the project spells it (matching ignores case). A name that is not a version of the project returns `VERSION_NOT_FOUND` and the list of versions. Without `fixVersion` the tool answers as before. The Evidence Auditor agent uses the same action, so it answers release questions the same way.
- **Audit pack:** when a version is selected, **Export audit pack** includes only that version and says so (see below).

Fix versions are not stored by the app. They are read from Jira each time (as the caller, one bulk request per 100 work items), so a version change shows up as soon as you select **Refresh**, and a work item that Jira does not return shows `-` and matches no version filter. If Jira cannot return versions, the matrix still loads, hides the version filter and says so.

## Audit pack export

On the Evidence Matrix page, **Export audit pack** builds a Markdown or CSV file for the issues you can see: approval, current status, latest evidence with its event number, hash, source (`MCP: <agent name>` or `Manual entry (Jira panel)`) and the account that submitted or recorded it, review decision, superseded evidence for the same revision (event number, verdict, time, first 12 characters of the hash, `(manual entry)` for entries recorded by hand, and review decision if any), and a fresh hash-chain check per issue. When the pack contains manual entries, the Markdown header explains the two sources. In CSV, `evidence_source` (`mcp` or `panel`) follows `agent_name`; the superseded evidence is the second-to-last column, `superseded_evidence`, newest first; the last column, `fix_versions`, lists the work item's fix versions separated by semicolons. If a fix version is selected on the Evidence Matrix, the pack contains only the work items of that version (or only those without one, for **No version**), the counts cover only them, the Markdown header says `Filter: fix version "1.4.0"`, and the suggested file name carries it (for example `BMS-evidence-audit-fixversion-1.4.0-2026-11-13.md`), so the file can serve as the release evidence for that version. CSV has no header text, so there the filter is in the file name and in `fix_versions`. If the versions cannot be read or the version no longer exists, a filtered export fails instead of producing an unfiltered file. UI Kit apps cannot start a browser download, so the pack opens in a dialog; copy the text and save it under the suggested file name. People appear as Atlassian account IDs, because the app does not store names. Long text is cut in the export: in CSV, the evidence summary, reference and review note to 500 characters; in Markdown, the summary and review note to 200 and the reference to 120. The output excerpt is not exported. The event hash points to the full record. CSV cells that a spreadsheet could run as a formula are prefixed with an apostrophe.

## Permissions

- Viewing the panels needs permission to view the issue. Drafting, approving, recording evidence by hand, reviewing and discarding drafts need permission to edit the issue; people without it see a read-only panel without **Record evidence**, **Accept** or **Reject**, and the backend refuses those calls as well. Jira itself only shows the panel's add button to people who can edit the issue.
- MCP and Rovo tools run as the calling user. An issue the caller cannot view is reported as not found. Fix versions are read the same way: as the caller first, and as the app only after Jira refuses that call, in which case the app checks the caller's browse permission for the issues and the project before using the answer.
- `submit-evidence` and `propose-work-order` write, so they need permission to edit the issue, the same as the panel. People with view permission only can still use the read-only tools (`get-work-order`, `get-evidence-status`, `list-open-work-orders`, `list-gaps`). The app asks Jira as the caller first; if Jira refuses that call, it checks the caller's account ID as the app instead, and an unknown caller counts as having no permission.
- The issue property for JQL is written as the calling user, so Jira applies that user's edit permission.
- The issue-updated trigger has no user, so it reads the issue and writes the issue property as the app. It only recalculates the stored matrix row and the property, and returns nothing to anyone.

## Scopes

| Scope | Why |
|---|---|
| `storage:app` | Stores work orders, events and matrix summaries in Forge key-value storage |
| `read:jira-work` | Reads issue summary, description, fix versions and project, and the project's version list; checks browse and edit permissions; receives the issue-updated event that keeps stale markers current |
| `write:jira-work` | Writes the `evidence-chain-summary` issue property that makes gaps searchable with JQL. The app changes nothing else in Jira. |

The app declares no egress, no remote backends, no web triggers and no Forge LLM. All data stays in Atlassian, which keeps the app eligible for Runs on Atlassian. What the app stores, where, and who can see it is in [`PRIVACY.md`](PRIVACY.md).

## Known limitations

- **No separation of duties.** An external agent submits evidence with the Atlassian identity of the person who signed in through `/mcp`, so `Submitted by` shows that person, and the same account can then accept or reject the evidence. Likewise, a person can record evidence by hand and then accept it themselves. The app does not stop anyone from reviewing their own submission or manual entry; it only records who submitted, who recorded and who reviewed, so the panel and the audit pack show it. `agentName` is reported by the agent and is not verified.
- **Manual entries are not checked against anything.** **Record evidence** stores what a person enters; the app does not compare it with a commit, a CI run or a document.
- **Developer tools are development-only.** Edit latest event, Restore edited events and Reset exist only on a development install with `EC_DEV_TOOLS=1` ([Developer tools](#developer-tools-development-environment-only)). Other installs cannot edit or delete events, so a demo work item cannot be reset there.
- **Tool names differ by environment.** A production install uses the plain names (`get-work-order`); a development install appends `_development`. Use the names that `/mcp` lists.
- **The issue panel is added per work item.** Each work item needs the app actions icon, then **Acceptance Trail**, once, unless a Jira admin chooses **Show for all work items** in the panel's **•••** menu. The status panel in the right-hand column needs no click.
- **The audit pack is text to copy, not a downloaded file.** UI Kit cannot start a browser download, so the pack opens in a dialog.
- **Views do not update live.** After an agent submits evidence through MCP, select **Refresh** in the issue panel, the status panel or the Evidence Matrix, or reload the page. The collapsed status label in the right-hand column is recalculated only when Jira redraws it, for example when the work item is opened again; the app cannot ask Jira to update it.
- **History covers the current revision only.** Evidence for earlier revisions stays in the chain, but the panel shows only a per-revision summary of it.

## Development

```sh
npm test      # node --test, using in-memory storage and simulated Jira responses
forge lint
```

| Path | Contents |
|---|---|
| `src/core/` | Pure logic: hash chain, state, evidence history and gap derivation, ADF parsing, validation, evidence source labels (`source.js`), audit export, status label, count wording, fix-version filtering (`versions.js`, shared with the project page) and the Jira version lookups (`version-lookup.js`). No Forge imports. |
| `src/storage/kvs.js` | Forge KVS adapter |
| `src/jira/client.js` | Jira REST calls. Tries `asUser()` first and falls back to `asApp()` with an explicit permission check. |
| `src/actions/` | The six MCP and Rovo tools |
| `src/resolvers/` | Backend for the issue panel (including **Record evidence**), the status panel and the project page |
| `src/triggers/` | Issue-updated trigger that refreshes matrix rows |
| `src/frontend/` | UI Kit issue panel, status panel and project page |

### Developer tools (development environment only)

The issue panel on a **development** install has a Developer tools section for demos:

- **Edit latest event** changes the newest stored event without fixing its hash, to show what happens when stored records are edited outside the app. **Restore edited events** puts the original back.
- **Reset this issue's Acceptance Trail data** deletes the issue's draft, every work order revision, the chain head, all events and reviews, the matrix row, tamper backups and the `evidence-chain-summary` issue property, so a demo can start from scratch. It asks for confirmation first.

All three need permission to edit the issue, and work only when the Forge runtime reports the development environment **and** the environment variable `EC_DEV_TOOLS` is `1`:

```sh
forge variables set -e development EC_DEV_TOOLS 1
forge deploy -e development
```

Staging and production never pass the runtime check, so the buttons are not shown there and the backend refuses the calls. Outside development there is no way to delete or edit events: the chain is append-only.

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.
