# Evidence Chain for Jira

Evidence Chain is a Forge app for Jira. It ties evidence reported by AI coding agents to individual acceptance criteria, and keeps all of it inside Atlassian.

1. A person drafts a **work order** from an issue's acceptance criteria and approves it.
2. An external AI coding agent reads the approved work order over the Forge MCP server and submits **evidence** for each criterion: a pass, fail or not-run verdict, a summary, a commit or CI reference, and an output excerpt.
3. A person **accepts or rejects** each piece of evidence in the issue panel.
4. The **Evidence Matrix** project page shows every issue with a work order, its progress, and its gaps. It can export an **audit pack** as Markdown or CSV.
5. The **Evidence Auditor** Rovo agent answers questions like "what evidence is still missing in this project?".

Every approval, submission and review is an append-only event. Each event stores the SHA-256 hash of the previous one, so the app can show whether the chain verifies.

**Only people can approve work orders and review evidence.** No MCP tool or Rovo action does either. Agents can only read work orders, submit evidence, and propose draft work orders that a person still has to approve.

## Install

You need a Jira Cloud site where you are a site admin (admin rights are only needed for the MCP setting below).

- **From the installation link:** open the link provided with the submission, pick your site, and confirm. Jira lists the scopes from the [Scopes](#scopes) table.
- **From source (development environment):**

  ```sh
  npm install
  forge deploy --non-interactive -e development
  forge install --non-interactive --site <your-site>.atlassian.net --product jira -e development
  ```

No settings page and no configuration are needed after installing.

## Where to find it in Jira

| What | Where | Needs a click first? |
|---|---|---|
| **Evidence Chain status** (issue context panel) | Right-hand column of every work item, under the fields such as Details and Automation. The collapsed header shows a status such as `No work order`, `Draft`, `2 gaps`, `4/4 accepted` or `Chain broken`. Expand it for a per-criterion summary. | No. Jira shows it on every work item. |
| **Evidence Chain panel** (issue panel) | Main column, above Activity. This is where people draft, approve and review. Open it once per work item: select the **app actions** icon in the row of icons under the work item title, then **Evidence Chain**. After that it stays on that work item for everyone. | Yes, once per work item |
| **Evidence Matrix** (project page) | In the space (project) navigation tabs. If it is not visible, open **More** and choose **Evidence Matrix**. | No |
| **Evidence Auditor** (Rovo agent) | Rovo Chat, agent list | No |

**Show the panel on every work item (Jira admins):** after opening the Evidence Chain panel on any work item, a Jira admin can open the panel's **•••** menu and choose **Show for all work items**. The panel then appears without the extra click. **Hide from all work items** in the same menu undoes it. Jira does not let apps turn this on themselves, which is why the always-visible status panel exists.

## Enable the MCP server for external agents

External MCP access is off by default. A site or organization admin turns it on:

1. Go to **Atlassian Administration > Apps > Sites > (your site) > Connected apps**.
2. Select **Evidence Chain**, open the app details, and turn on the tools you want to expose.

The setting applies per site and per app installation.

## Connect Claude Code

The MCP server URL is `https://mcp.atlassian.com/forge/<appId>`. `<appId>` is the UUID at the end of `app.id` in `manifest.yml`, the part after `ari:cloud:ecosystem::app/`.

```sh
claude mcp add --transport http evidence-chain https://mcp.atlassian.com/forge/<appId>
```

Inside Claude Code, run `/mcp` to authenticate. A browser window opens for Atlassian consent; pick the site where the app is installed. Tools then run with your own Jira permissions. A newly added server is loaded when Claude Code starts, so restart the session if the tools do not appear.

Claude Code adds the environment name to each tool name. On a development install, for example, `get-work-order` appears as `get-work-order_development`.

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
| `get-evidence-status` | GET | MCP, Rovo | Status and gap kind for each criterion of an issue, plus a summary of earlier revisions |
| `submit-evidence` | CREATE | MCP | Evidence for one criterion. Rejected if the revision or criterion ID does not match. |
| `propose-work-order` | CREATE | MCP, Rovo | Saves a draft for a person to approve. Never changes the approved revision. |
| `list-gaps` | GET | MCP, Rovo | Gaps per issue in a project |

Long fields are truncated, and the response says which ones were cut. The limits are 2,000 characters for `summary`, 4,000 for `outputExcerpt`, and 500 for `reference`.

### Statuses and gaps

- **Criterion status:** `no-evidence`, `submitted` (awaiting review), `accepted`, `rejected`. Only the latest evidence for a criterion counts.
- **Gap kinds:**
  - `no-evidence`
  - `failed`: the latest verdict is fail or not-run
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

## Audit pack export

On the Evidence Matrix page, **Export audit pack** builds a Markdown or CSV file for the issues you can see: approval, current status, latest evidence with its event number and hash, review decision, and a fresh hash-chain check per issue. UI Kit apps cannot start a browser download, so the pack opens in a dialog; copy the text and save it under the suggested file name. People appear as Atlassian account IDs, because the app does not store names. Text from agents is cut to 500 characters in the export; the event hash points to the full record. CSV cells that a spreadsheet could run as a formula are prefixed with an apostrophe.

## Permissions

- Viewing the panels needs permission to view the issue. Drafting, approving, reviewing and discarding drafts need permission to edit the issue; people without it see a read-only panel. Jira itself only shows the panel's add button to people who can edit the issue.
- MCP and Rovo tools run as the calling user. An issue the caller cannot view is reported as not found.
- The issue-updated trigger has no user, so it reads the issue as the app. It only recalculates the stored matrix row and returns nothing to anyone.

## Scopes

| Scope | Why |
|---|---|
| `storage:app` | Stores work orders, events and matrix summaries in Forge key-value storage |
| `read:jira-work` | Reads issue summary, description and project; checks browse and edit permissions; receives the issue-updated event that keeps stale markers current |
| `write:jira-work` | Reserved for the planned issue-property mirror. The app does not write to Jira yet. |

The app declares no egress, no remote backends, no web triggers and no Forge LLM. All data stays in Atlassian, which keeps the app eligible for Runs on Atlassian.

## Development

```sh
npm test      # node --test, using in-memory storage and simulated Jira responses
forge lint
```

| Path | Contents |
|---|---|
| `src/core/` | Pure logic: hash chain, state and gap derivation, ADF parsing, validation, audit export, status label. No Forge imports. |
| `src/storage/kvs.js` | Forge KVS adapter |
| `src/jira/client.js` | Jira REST calls. Tries `asUser()` first and falls back to `asApp()` with an explicit permission check. |
| `src/actions/` | The six MCP and Rovo tools |
| `src/resolvers/` | Backend for the issue panel, the status panel and the project page |
| `src/triggers/` | Issue-updated trigger that refreshes matrix rows |
| `src/frontend/` | UI Kit issue panel, status panel and project page |

### Developer tools (development environment only)

To show what happens when stored records are edited outside the app, the issue panel on a **development** install has two extra buttons: **Edit latest event** changes the newest stored event without fixing its hash, and **Restore edited events** puts the original back. Both work only when the Forge runtime reports the development environment **and** the environment variable `EC_DEV_TOOLS` is `1`:

```sh
forge variables set -e development EC_DEV_TOOLS 1
forge deploy -e development
```

Staging and production never pass the runtime check, so the buttons are not shown there and the backend refuses the calls.
