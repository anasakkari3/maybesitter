# ADR 0002 — User-provided MCP servers are connections, not a second integration framework

## Status

Accepted as an architectural constraint.

The feature it constrains — letting a person add their own MCP server — is
**deferred and unscheduled**. This ADR grants no scope. It exists so that the
integrations shipped between now and then leave that feature as a small adapter
instead of a connection-layer rewrite. `docs/strategy/CURRENT_PRODUCT_STRATEGY.md`
is "narrow and test" and explicitly marks long-term vision as unvalidated; this
document does not amend it, and it must not be cited as approval to build.

## Context

The long-term product vision includes "connect anything": rather than MaybeSitter
shipping an official integration for every service in the world, a person points
it at an MCP server they already have — a home lab, an employer's internal
system, a small vendor's server — and the agent can use it.

That idea collides with the one fact that makes MaybeSitter worth using: its
context is a person's life. Commitments, memory, goals, email-derived signals.
An untrusted remote server placed inside that context is a data-exfiltration
surface, and prompt injection is its delivery mechanism.

Most of the architecture this needs **already exists and is merged**
(`docs/operations/EXPANSION_ORCHESTRATION_LEDGER.md`, "MCP capability gateway",
`eb2db9a`, issue #451, open item: *operator mappings and live MCP credentials*):

| Already in the codebase | What it settles |
|---|---|
| `lib/integrations/mcp/capabilityAdapter.ts` | `MCP_CAPABILITY_POLICY` states five invariants; every call routes through the action gateway; every response is wrapped as `untrusted_provider_data` |
| `src/contracts/v1/actionPolicyContracts.ts` | a **closed** 21-member `CapabilityId` union with a tier and confirmation level per capability, already including `read_mcp_context`, `mcp_lookup_context` (`read_only_context`, `confirmation: 'none'`) and `mcp_execute_capability` (`external_write`, `confirmation: 'explicit_confirmation'`) |
| `src/contracts/v1/integrationConnectionContracts.ts` | `ContextProviderKind` is deliberately open, `'mcp'` is a declared kind, `IntegrationCapability` carries `'mcp_tool_context'`, and `IntegrationConnectionProvenance` already allows `{ source: 'mcp', connectedBy: 'user' }` |
| `lib/integrations/providers/untrustedExternalContent.ts` + `docs/architecture/safety-policy-gateway.md` | injection is already a typed boundary with reason codes (`INJECTED_INSTRUCTION`, `UNTRUSTED_CONTENT_IN_TRUSTED_SLOT`, `UNCONFIRMED_WRITE_PROPOSED`) |
| `tests/safety/policyContract.test.ts`, `tests/safety/redTeam.test.ts` | the MCP invariants are already asserted, not merely written down |

So the distance between today and the vision is **one axis**:
`McpCapabilityBinding.configuredBy` is typed as the literal `'operator'`, and
`McpCapabilityRegistry`'s constructor throws on anything else. The vision needs
`'user'`. Everything dangerous about that widening is a **permission** question,
not a transport question — which is precisely why the permission rules belong in
a decision record now, before anyone writes the transport.

### One concrete blocker, recorded now rather than discovered later

`lib/integrations/providers/production/storedConnectionStore.ts` derives its
document id from the provider kind alone:

```ts
export function connectionIdFor(provider: ContextProviderKind): string {
  return docIdForKey(`provider-connection:${provider}`);
}
```

That is correct today — one Gmail per person. It becomes a data-loss defect the
moment a person adds a second MCP server, because both records collapse onto one
document. The provider-neutral `lib/integrations/connections/connectionRegistry.ts`
already hashes `scopeId ∥ provider ∥ providerAccountId ∥ providerSpaceId` and
handles it; only the production store is narrower. The production store must
adopt the neutral id **before** a second MCP server can exist.

## Decision

### 1. An MCP server is a connection, not a new entity

A user-added server is an `IntegrationConnectionRecord` with
`identity.provider = 'mcp'`, `identity.providerSpaceId` = the server id, and
`provenance = { source: 'mcp', connectedBy: 'user' }`. All three values already
exist in the contract.

There is no parallel `MCPConnection` collection and no second credential store:
`credentialRef` pointing into `encryptedCredentialVault` is the only path, and
`IntegrationConnectionStore` is the only storage verb set.

### 2. `CapabilityId` stays closed

Tool discovery may never introduce a capability. Every discovered MCP tool is
either bound to an existing entry in `ACTION_CAPABILITY_POLICIES` or it is
unusable. **A server advertising thirty tools grants zero permissions.**

Unknown or unmapped tools remain visible to the person as
*discovered-but-unavailable*. They are never silently mapped onto a generic
write capability. Reaching for `mcp_execute_capability` as a catch-all for
anything unrecognised would make the closed capability model a formality — that
fallback is forbidden, and it is the specific failure this clause exists to
prevent.

### 3. Discovery is not permission

`discoveredTools` and `allowedTools` are separate fields with separate
lifecycles. The default is deny. Rediscovery may add to `discoveredTools`; it
may never add to `allowedTools`.

### 4. The manifest never grants itself anything

When `configuredBy` widens to `'operator' | 'user'`,
`MCP_CAPABILITY_POLICY.providerManifestMayGrantCapability` stays `false`. The
human grants; the server asks. Widening `configuredBy` is the **only** sanctioned
change to that policy object — `providerManifestMayGrantCapability`,
`modelMaySelectRawTool`, `providerContentMayConfirmAction` and
`writesPassThroughActionGateway` are invariants.

### 5. No MCP path may write canonical state directly, or bypass the canonical write boundary

This is not "no MCP path ever causes a write". After confirmation the system
writes canonical state normally. What is forbidden is the *direct* write and any
route around the boundary. ADR-0001 rule 3 applies unchanged:

```
MCP -> capability -> actionGateway -> commandService -> persistence adapter
```

An MCP tool named `create_task` produces a **proposal** via
`create_local_proposal`, subject to the confirmation boundary that Capture,
Decomposition and Watchers already share. It never calls `schedulePlan()` and
never writes a `Commitment` itself. The same holds for reads: an MCP calendar
result becomes normalized context feeding `UserState`, not a planner input of
its own.

### 6. All MCP output is untrusted

Responses stay inside `UntrustedMcpContent` — `maySelectCapability: false`,
`maySelectTool: false`, `mayConfirmAction: false` — and reach the model only
through the safety gateway's untrusted slot. A read result from one connection
may never select or authorise an action on another connection.

### 7. Least context out

A call's payload carries only what the bound capability's scope requires. Memory,
commitments, goals and email-derived context are not sent to a third-party server
by default. "The person connected this server" is not consent to mirror their
life into it.

### 8. A person-supplied URL is an attack surface

Transport does not exist yet (see non-goals). The constraint is recorded before
it does, because retrofitting it is how these defects ship. When transport is
built it must at minimum:

- require HTTPS; no plaintext, and no redirect to a non-HTTPS origin;
- resolve the destination and **re-check the address at connect time** against a
  deny-list of private, loopback, link-local and cloud-metadata ranges. A
  one-time pre-resolution check stops SSRF but not DNS rebinding; the check must
  be the one the socket actually uses;
- re-apply that check to every redirect hop, or not follow redirects at all;
- enforce connect/read timeouts and a hard response-size cap **on the server**.
  Issue #508 is the precedent: a limit that lives only on the client is not a
  limit;
- reach private or local servers only through an allow-listed tunnel, never by
  letting a supplied URL name an internal host.

### 9. The binding constraint on all future integration work

> From today, every new integration ships as a provider adapter behind
> `IntegrationConnectionRecord` + a closed `CapabilityId` + `actionGateway`.
> No integration may own its own transport-to-write path, its own credential
> store, or its own confirmation prompt.

This clause is the reason the ADR is being written now rather than with the
feature. It is what makes "bring your own MCP" an adapter later instead of a
rewrite.

## Ownership

- Backend owns the connection contracts, the capability table, and the action
  gateway.
- Any future MCP work implements behind those, and extends
  `ACTION_CAPABILITY_POLICIES` by review — never by discovery.

## Consequences

### Non-goals, deferred rather than designed away

No OAuth client for third-party MCP servers. No tunnel for local or private
servers. No community catalogue or marketplace. No transport.

Per the existing state of the provider layer, the adapters under
`lib/integrations/*/adapter.ts` are **normalizers, not transports**; the MCP
capability adapter is the same. Its presence in the tree must not be read as a
working feature.

### Product surface, when it eventually ships

MCP belongs under *Settings → Connections → Advanced*. It never appears in
onboarding: to an ordinary person the word "MCP" means nothing, and the ordinary
path stays "Gmail, Calendar, Drive". Positioning changes when the feature ships,
not when this ADR lands.

### Enforcement, stated honestly

Partly mechanical today: `tests/safety/policyContract.test.ts` and
`tests/safety/redTeam.test.ts` assert the MCP invariants, and
`modelMaySelectRawProviderTool` is typed as a literal `false` so it cannot be set
true. `ProviderCatalogEntry.rawProviderToolsAllowedForModel` is pinned the same
way.

The rest of this ADR is enforced by review. Two tests would make it mechanical,
and they are required **with** the feature, not after it:

1. a discovery test asserting no discovered tool can yield a capability outside
   `ACTION_CAPABILITY_POLICIES`, and that an unmapped tool surfaces as
   unavailable rather than falling back to `mcp_execute_capability`;
2. a store test asserting two MCP servers on one account produce two records —
   the `connectionIdFor` blocker above.

Both should follow the source-scanning shape already used by
`tests/contract/intelligenceModuleBoundaries.test.ts` and
`tests/safety/safetyBoundaries.test.ts` where a boundary is what is being
checked.

## Migration and rollback

Documentation only. No contract change, no stored state, no data migration,
nothing to roll back. Superseding this decision means writing ADR-0003, not
deleting this file.
