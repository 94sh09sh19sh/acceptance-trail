# Evidence Chain for Jira

Evidence Chain is a Forge app for Jira. It ties evidence reported by AI coding agents to individual acceptance criteria, and keeps all of it inside Atlassian.

1. A person drafts a **work order** from an issue's acceptance criteria and approves it.
2. An external AI coding agent reads the approved work order over the Forge MCP server and submits **evidence** for each criterion: a pass, fail or not-run verdict, a summary, a commit or CI reference, and an output excerpt.
3. A person **accepts or rejects** each piece of evidence in the issue panel.
4. The **Evidence Matrix** project page shows every issue with a work order, its progress, and its gaps.
5. The **Evidence Auditor** Rovo agent answers questions like "what evidence is still missing in this project?".

Every approval, submission and review is an append-only event. Each event stores the SHA-256 hash of the previous one, so the issue panel can show whether the chain verifies.

**Only people can approve work orders and review evidence.** No MCP tool or Rovo action does either. Agents can only read work orders, submit evidence, and propose draft work orders that a person still has to approve.

## Install (development)

```sh
npm install
forge deploy --non-interactive -e development
forge install --non-interactive --site <your-site>.atlassian.net --product jira -e development
```

After installing:

- **Issue panel:** open an issue and click the Evidence Chain panel button.
- **Project page:** open a project and look for **Evidence Matrix** in the project sidebar.
- **Rovo agent:** **Evidence Auditor** appears in Rovo Chat.

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

Inside Claude Code, run `/mcp` to authenticate. A browser window opens for Atlassian consent; pick the site where the app is installed. Tools then run with your own Jira permissions.

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
| `get-evidence-status` | GET | MCP, Rovo | Status and gap kind for each criterion of an issue |
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

## Scopes

| Scope | Why |
|---|---|
| `storage:app` | Stores work orders, events and matrix summaries in Forge key-value storage |
| `read:jira-work` | Reads issue summary, description and project. Checks browse and edit permissions. |
| `write:jira-work` | Reserved for the planned issue-property mirror. The main flow does not write to Jira yet. |

The app declares no egress, no remote backends, no web triggers and no Forge LLM. All data stays in Atlassian, which keeps the app eligible for Runs on Atlassian.

## Development

```sh
npm test      # node --test, using in-memory storage
forge lint
```

| Path | Contents |
|---|---|
| `src/core/` | Pure logic: hash chain, state and gap derivation, ADF parsing, validation. No Forge imports. |
| `src/storage/kvs.js` | Forge KVS adapter |
| `src/jira/client.js` | Jira REST calls. Tries `asUser()` first and falls back to `asApp()` with an explicit permission check. |
| `src/actions/` | The six MCP and Rovo tools |
| `src/resolvers/` | Backend for the issue panel and the project page |
| `src/frontend/` | UI Kit issue panel and project page |
