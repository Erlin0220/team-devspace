# Source-available publication readiness

Assessment: 2026-09-15. Tracking: Issue #9. Scope: the existing repository,
including every fetched public-candidate branch/tag, GitHub metadata and old
release assets, not merely the cleaned working tree.

## Cutover update — 2026-09-16

The repository owner explicitly accepted publication of the historical private
contact metadata described below. The remaining legacy-binary gate was closed by
quarantining the only previously published binary release (`v0.2.0`) as a draft
after its restricted local backup was rechecked against GitHub's recorded asset
digests. No historical Git rewrite or byte replacement was used.

The repository is now Public. The `Reviewed main` branch ruleset is active and
requires a pull request, linear history, no branch deletion/non-fast-forward
updates, and the `verify` plus `secret-scan` checks. The original 2026-09-15
assessment below is retained as the audit record of what was known before this
explicit owner decision and cutover. Public visibility does not by itself approve
new installer bytes: native four-platform build/acceptance and the normal release
gates still apply to each new version.

## Decision and execution boundary

**NO-GO for making the existing repository Public in this review.** No usable
authentication secret was confirmed in the completed source/history/log/old-app
scans. The remaining gates are private historical contact data and incomplete
binary-redistribution evidence, not the existence of public endpoints or resource
IDs. Passing a secret scanner does not approve those other disclosures.

The review is delivered by explicit `prep/source-available` and fast-forward
`main` pushes, without a PR or a force-push. Issue #9 records the final remote
commit and read-back results. The integration baseline was 47 commits ahead of
fetched main with no divergence; it was not reset onto an older application.
Local-only tool checkpoint refs are excluded from all pushes.

No production Gateway deployment/migration, new employee release, signing-key
rotation, rollout change or download redirect is authorized by this document.
The repository remains Private; the four-platform GitHub Actions workflow was
not dispatched. Public-only enforcement and native hosted acceptance are
therefore **not completed**, rather than assumed to have passed.

## Preparation and defects fixed

| Area | Implemented and verified |
| --- | --- |
| Original-code license | Unmodified official PolyForm Shield 1.0.0; SHA-256 `67530f8e9adfcc5d2e9d72b804500cebb7472ff84c34a6729a80a2a9be901ee6`; separate NOTICE; source-available, not an OSI-approved license |
| Operator configuration | Reserved examples in tracked files; production resource IDs in ignored private config; explicit employee release profile with only public client settings |
| Trust continuity | Actual candidate app archive retains the original operator endpoints and update public key, binds them to provenance, and omits the Zone ID |
| Dependency notices | DevSpace MIT, cloudflared Apache and Pico notices retained; new packaging collector preserves original notices for all 35 resolved external Windows Tray Cargo packages |
| Rust notice regression | SBOM license expressions alone were insufficient; exact notice files and a path-redacted index are now packaged, with missing-notice/path-escape rejection and four focused tests |
| Legacy Intel handoff | Restored as `.github/workflows/accept-codemagic-intel.yml`; manual, main-only and production-Environment protected, separate from the unproven replacement matrix |
| Legacy acceptance profile | `macos-accept-existing.mjs` now reads the operator profile, not tracked sample defaults, and verifies the prior receipt's full profile digest |
| Deployment workflow | Manual/main-only; repository contents read-only; no config write-back; existing resources required; migration still precedes Worker rollout; secrets confined to deployment |
| Source-level abuse controls | Credential-shape rejection before D1, per-Key enrollment limiter before provider provisioning, bounded/coalesced update discovery with short negative caching; device authorization remains uncached |
| Repository process | Issue/PR templates, CODEOWNERS, security/contribution guidance, unprivileged CI, pinned Actions, and a main ruleset template; workflow token defaults read-only and cannot approve PRs |

The added source defenses are **not a claim that the production Worker has been
redeployed**. Public Access IDs, public verification keys, hostnames and cache
keys were classified separately from authentication secrets. Existing production
credentials were reused, not rotated.

## Source and complete reachable-history disclosure review

At the pre-integration audit baseline, the repository was not shallow. The full
local history scan covered 126 commits, including local tool checkpoints. The
origin branches/tags covered 121 commits, 1,864 Git objects and 1,097 inspected
text/small blobs. The new review commit and final source snapshot are rescanned
before pushing; the baseline counts are not presented as final commit counts.

Gitleaks 8.30.1 found no remaining source/history credential findings after two
narrow field-and-file-scoped false-positive exceptions: a pinned upstream commit
SHA and an Access application UUID. The current-tree known-value privacy scan
also had no matches. Historical findings are not silently hidden by those rules.
The final pre-commit snapshot contained 241 source files and no copied private
ignored files. All 121 reachable commit messages/author records and eight tag
metadata entries were additionally extracted to restricted storage and secret-
scanned with zero findings; patch-only scanning was not treated as metadata review.

The origin subset still contains **100 historical blobs matching deployment
metadata or private contact details**, plus **two non-noreply author/committer
addresses**. These are not 100 secrets. Ordinary endpoint/ID disclosure is not
itself a security blocker; private contact-data removal/acceptance has not been
completed across all refs and server metadata. Editing main, or adding a
mailmap, would not erase the underlying objects.

The remote binary objects were three small PNG branding files and a 4,096-byte
RGBA icon. The large archive and screenshot seen in the full local object set
were reachable only from local checkpoint refs, not origin branches/tags. They
are not pushed. This review does not claim reverse engineering of every vendor
binary or automatic legal clearance of branding.

## GitHub logs, metadata, caches and old Releases

The live inventory covered nine Issues, one Issue comment, no PRs, three
Releases, 48 workflow runs and zero retained Actions artifacts. The previously
missing executed-run logs were recovered from its four individual job-log
endpoints. Seven runs had no executed steps; the earlier executed-log text gap
is now closed.

The log scanner produced 30 alerts, all classified: 24 Access resource-ID
occurrences and six Action cache-key inputs. **No authentication credential was
confirmed.** A separate privacy scan identified 12 run logs containing private
email addresses. Those logs were copied to a restricted local directory,
SHA-256 checked, deleted remotely, and each deletion read back as unavailable.
The workflow run records themselves were retained; their commit-author metadata
can still contain historical addresses.

Integration activated the prepared Dependabot configuration and automatically
opened dependency PRs #11 and #12, independently of the direct main integration.
Their ordinary `verify`/`secret-scan` CI failed before running any steps; these
were not the four-platform installer workflow. Version-update PR limits are now
paused at zero while private quota is exhausted, without disabling security
alerts. The integration follow-up closes only these newly generated bot PRs and
records their metadata, CI failure evidence and cancellation/read-back results
in Issue #9. No dependency-update PR is merged into the release candidate.

All four old caches were deleted: **844,426,293 bytes**, with a live read-back of
**zero remaining caches**. Cache contents were not represented as exhaustively
audited; removing these regenerable objects removes their future cache-disclosure
surface. No new build was started to replace them.

All **33 Release assets (1,247,175,666 bytes)** were obtained or reused only after
matching GitHub's size and SHA-256 digest. All 11 installer archives and both
acceptance ZIPs were opened as data, including the installer nested in the old
Windows ZIP and the compressed app layers in macOS PKGs. The review inspected
533 application files, installer scripts, receipts and metadata entries. It did
not execute any old installer or reverse-engineer the vendor runtime binaries.
The eight asset-scanner alerts were exact known cloudflared source commits in
old release configuration, not Cloudflare authentication keys.

The two **draft** Releases contain 12 app metadata entries with private contact
information, principally package metadata and macOS Info.plist. They have not
been published or silently rebuilt. Drafts are not automatically published by
a visibility change, but must not later be promoted without this review. The
non-draft 0.2.0 Release remains a separate immediate binary-distribution surface;
its corresponding-source/notices obligations are not closed merely because its
app secret scan is clean. The bundled `.cer` is a public publisher certificate,
not a private signing key.

Raw reports and extracted app text remain in ignored `build/public-audit/`.
Hash-matched Release backups and deleted-log backups are in restricted
`.runtime/public-final/`. Never upload either audit directory to a public Issue,
CI artifact or release.

## Third-party license and corresponding-source gate

PolyForm Shield applies only to original Team DevSpace code. The earlier
original-code license was proprietary internal-use, not MIT; third-party MIT,
Apache, GPL and other rights are not replaced by this change.

The new candidate preserves the official original-code license and upstream
notices. Its archived `LICENSES/rust/index.json` and the actual notice files for
35 resolved Cargo packages were verified after a real Windows build. This fixes
future candidate packaging; it does not retroactively alter old immutable bytes.

Git for Windows is used as an independent executable. Its public binary
redistribution still requires the applicable complete corresponding sources and
notices, including applicable separately bundled MSYS/MinGW components and build
scripts. The pinned Git for Windows release was inspected; no complete
corresponding-source delivery arrangement was established by this task. A
generic upstream repository/release link and an SBOM are not sufficient evidence
of that arrangement. Bit-for-bit reproducible rebuilding is not being imposed
as an extra GPL requirement.

**Remaining binary gate:** establish and verify source access for the exact
redistributed GPL components, and finish the exact-byte third-party notice
inventory for Go/compiler runtimes and old packages. Alternatively, quarantine
old binary distribution before a separately approved source-only public cutover.
Do not relabel vendor components, invent a source offer that cannot be fulfilled,
or replace existing employee versions to make a checklist appear complete.

## Cloudflare management state and production boundary

Authenticated reads used the already logged-in Cloudflare dashboard. The old
local credential-file audit entrypoint no longer existed; that failure was not
treated as a successful provider audit. Provider secret values were never
exported. D1 inspection used SELECT queries with zero writes.

| Live check | Observed result |
| --- | --- |
| Owned Gateway WAF | Enabled block rule matches the repository's host-scoped expression, including the retired status route; unrelated hosts/rules were untouched |
| Alternative Worker entrypoints | `workers.dev` and preview URLs both disabled |
| Gateway routing | Exact production Custom Domain verified; the empty legacy routes list was not mistaken for missing routing |
| Admin Access | Self-hosted `/admin*` app; one email-allow policy, no everyone/bypass policy; audience matches Worker configuration |
| Secret storage | ADMIN_TOKEN, CF_API_TOKEN and MASTER_KEY are secret bindings; only binding names/types were read |
| D1 | Production primary, read replication disabled, four tables and 143,360 bytes at inspection |
| Owned Tunnels | Nine database-linked tunnels; matching ingress host, loopback-only service and fallback 404 verified for all nine |
| DNS | Gateway and device-tunnel records proxied; download origin is an unproxied A record |
| Edge rate limits | No configured rate-limit entrypoint; the source's new enrollment binding is also absent from the currently deployed Worker |
| Version policy | `auto=0.2.6`, `minimumSupported=0.2.5`, `enforceAfter=2026-09-15T08:57:00.000Z`, revision 4; not modified |

Read-only anonymous probes returned health 200, Admin 302, MCP 401, retired
status 403, unknown path 403 and public update policy 200. The existing download
homepage returned 200, and four-platform update metadata verified with the
original public key using redirect rejection. No authenticated employee
enrollment, rollout or production installation was performed.
At `2026-09-15T13:59:14Z`, unauthenticated direct `/mcp` probes to all three
currently healthy owned device Tunnels each returned the Bridge's explicit 401
`device_credential_required`, without passing through Gateway. The production
policy remained at revision 4 and the new enrollment binding remained undeployed.

For the exact UTC window `2026-09-15T00:00:00Z` through
`2026-09-15T13:25:15.557Z`, Workers adaptive analytics reported 26,031 requests,
including 785 `clientDisconnected`, 3,512 subrequests and zero reported errors.
This is a partial-day, script-scoped analytics observation, not an invoice,
whole-account usage total or post-publication traffic forecast. The subscriptions
read returned zero-price Free/Teams plans; the Worker usage-model field alone
does not establish a paid plan, and no billing settings were changed.

Residual operational risk is real but distinct from a secret leak: allowed-path
traffic can consume Worker requests/D1 authorization reads, a per-Key Worker
limiter is neither pre-Worker WAF nor a global billing cap, and the unproxied
download server has a separate bandwidth surface. No full origin-server billing
or load-test assessment was performed. Publicity is not proof of an exploit,
and no cost reduction or protection from arbitrary quota exhaustion is claimed.

## Validation and GitHub Actions migration

| Check | Actual result and boundary |
| --- | --- |
| Source/policy checks | `npm run check` passed |
| Test suite | 323 tests: 316 passed, zero failed, seven platform-dependent skips |
| Workflow syntax | Checksum-verified actionlint 1.7.12 passed, including the retained fallback |
| Runtime dependency audit | `npm audit --omit=dev`: zero reported vulnerabilities |
| Worker bundle | Dry-run passed with D1/assets and 6-per-60s enrollment binding; no deployment |
| Windows native candidate | Build and five-component layout verification passed; native Rust tests and SQLite loading passed; archived profile/license/35 Cargo notice sets verified |
| Four-platform hosted matrix | **Not run** while Private; no claim of Windows/Linux/ARM64/Intel hosted acceptance |
| Branch protection | Live rulesets request still returned HTTP 403 requiring a paid private plan or Public; the JSON policy is a template, not active enforcement |

The local Windows candidate is unsigned, isolated under `build/public-audit/`
and not installed over an employee environment. It must not replace published
0.2.6 bytes. Disposable-runner checks do not prove an existing employee upgrade;
the strict publication gate continues to reject missing evidence.

Codemagic, Rosetta-specific fallback evidence and the legacy Intel handoff are
**retained**. The new four-platform workflow must really build and accept its
own final bytes on matching native hardware before those paths can be removed.
Neither static workflow validation nor public-runner pricing proves that the
account's hosted jobs can execute.

After a future authorized Public cutover, install/read back the main PR/check,
no-deletion and no-force-push rules before dispatching the matrix. The current
template requires PRs and `verify`/`secret-scan`, but zero independent approvals
to avoid locking out a sole maintainer; it is not a claim of human reviewer
approval. A multi-maintainer approval requirement needs its own explicit policy.
Restore Dependabot's version-update limits to three per ecosystem only after
this cutover is verified; a `[skip ci]` message on a maintainer commit does not
suppress workflows triggered by later bot commits.

## Large-file distribution and remaining cutover work

GitHub Releases remains a suitable candidate: GitHub documents files below
2 GiB and no total-release-size or bandwidth quota. The observed installer sizes
fit that file limit, but employee-network accessibility and production delivery
must still be tested. No release-host migration or Aliyun traffic saving was
performed or claimed.

Keep current direct download/recovery URLs, signature/public-key trust,
immutable version bytes and `stable / auto / minimumSupported / enforceAfter`.
Supported clients reject HTTP redirects. Do not redirect their URLs to GitHub
until compatible approved-host redirect handling, credential non-forwarding,
length/hash validation, recovery and a real upgrade have passed acceptance.
Do not proxy large installers through Gateway or add a second rollout system.

The remaining cutover consists of a coordinated historical-contact/metadata
disclosure cleanup or explicit acceptance, and verified old-binary source/notice
delivery or quarantine. The review does not silently force-rewrite history,
delete provenance-bearing Releases, treat protected drafts as public releases,
or use ordinary endpoint visibility as a reason to reject source publication.
Public enforcement and real hosted/native acceptance follow that gate; they are
not predeclared successes.

## Primary references

- Official license: https://polyformproject.org/licenses/shield/1.0.0.txt
- Visibility/log disclosure: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility
- Release limits: https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases
- Native runners: https://docs.github.com/en/actions/reference/runners/github-hosted-runners
- GPL binary redistribution/source questions: https://www.gnu.org/licenses/gpl-faq.en.html
- Git for Windows components: https://gitforwindows.org/technical-overview.html
- Worker limiter boundaries: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
