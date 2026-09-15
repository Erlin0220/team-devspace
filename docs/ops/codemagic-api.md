# Codemagic manual macOS builds

> Transitional after source-available preparation: the target is native GitHub
> Actions, but this fallback stays until hosted final-byte acceptance passes.
> Select `TEAM_DEVSPACE_RELEASE_PROFILE` or `TEAM_DEVSPACE_RELEASE_PROFILE_JSON`
> before the API command. New source builds pass only that validated public
> profile to Codemagic, distinguish reuse by profile digest and verify the full
> digest in the downloaded receipt. Manual website builds need the same profile
> variable. Never put deployment tokens or employee Keys in the profile. These
> changes are locally tested; no new hosted build was triggered by preparation.

## Decision and verified upstream contract

Use `npm run macos:ci -- <action>` through DevSpace in this checkout. It is a small release-operator command, not an employee runtime service. It reuses the single `macos-package` workflow and existing package, cache, system Installer acceptance and publication scripts. `start --arch both` starts/reuses two architecture-specific builds of that same workflow; it does not introduce a second workflow or claim to produce a Universal PKG.

Reviewed against official sources on 2026-09-14:

- [Build REST API](https://docs.codemagic.io/rest-api/builds/): the documented hosted-build start operation is `POST https://api.codemagic.io/builds`, with `appId`, `workflowId`, `tag`, `environment.variables` and `labels`. It returns `buildId`. Do not invent a REST `inputs` field from the YAML/UI input syntax.
- [API overview](https://docs.codemagic.io/rest-api/overview/): Codemagic is transitioning to the new API; authentication is a role-scoped personal API token in `x-auth-token`.
- [New official API](https://codemagic.io/api/v3/schema), including its live `openapi.json`: authenticated `GET /api/v3/teams/{team_id}/builds` and `GET /api/v3/builds/{build_id}` expose status, source commit, workflow, build inputs and artifacts with `short_lived_download_url`. The new schema reviewed here did not expose a replacement build-start POST, so the command uses the documented start endpoint and new read endpoints rather than undocumented website APIs.
- [Build inputs](https://docs.codemagic.io/yaml-basic-configuration/build-inputs/): the existing UI architecture choice remains available. API starts pass a documented environment override and an expected source commit; the first existing workflow step validates both before building.
- [Official CLI tools](https://github.com/codemagic-ci-cd/cli-tools) focus on build/signing/publishing utilities, not a necessary replacement hosted-build orchestration layer. The [official GitHub trigger action](https://github.com/codemagic-ci-cd/trigger-codemagic-workflow-action) wraps the same REST operation; using it here would add a second CI hop without replacing the build or acceptance work.

No push/tag trigger is added to Codemagic. The command creates a non-moving `ci/macos-<full-source-SHA>` remote Git tag only when a new build is needed. A tag already pointing elsewhere is rejected, never force-updated. The first workflow step compares its actual checkout to the expected SHA. Changing `codemagic.yaml` legitimately invalidates its existing native-cache fingerprint once; the architecture-specific cache and all cache verification stay unchanged.

## One-time operator credentials

Use the existing Codemagic account's API token from **User settings / Integrations / Codemagic API** and the application's App ID. `Team ID` is optional and only needed for a team-owned app. Personal-account apps are validated through `/api/v3/user/apps`; the latest visible app build is enough for opportunistic reuse, while build IDs created by this command remain the primary status source. Do not create a Codemagic team just to satisfy this operator command. This may require interactive GitHub/SSO login once. Do not extract unrelated browser profiles or send a password/token to chat. A GitHub API token is not a Codemagic API token.

The default protected file is `~/.team-devspace-admin/codemagic.json`, outside the repository. Configuration uses the existing current-user/SYSTEM Windows ACL helper (0700 directory and 0600 file on Unix). It never adds credentials to Git, the package, Gateway or the download server. This is a bearer credential protected by OS permissions, not a claim of hardware-backed encrypted storage. Rotate/revoke it in Codemagic when necessary.

In a local PowerShell 7 terminal, with the project as the working directory:

```powershell
$secret = Read-Host 'Codemagic API Token' -AsSecureString
$env:CM_API_TOKEN = [System.Net.NetworkCredential]::new('', $secret).Password
try {
  npm run macos:ci -- configure --app-id <app-id>
} finally {
  Remove-Item Env:CM_API_TOKEN -ErrorAction SilentlyContinue
  $secret.Dispose()
}
```

`configure` validates a read request before saving. For a team-owned app add `--team-id <team-id>`. A controlled CI/agent environment can instead supply `CM_API_TOKEN` (or `CODEMAGIC_API_TOKEN`) and `CODEMAGIC_APP_ID`; `CODEMAGIC_TEAM_ID` is optional. Never put the token in command arguments. `--config` may point to another operator-owned location outside the repository.

## Normal DevSpace commands

Finish review and commit first. New builds require **current HEAD to be clean**; do not build an earlier SHA and relabel it as the final checkout.

```text
npm run macos:ci -- start
npm run macos:ci -- status
npm run macos:ci -- collect
```

`start` defaults to both architectures. `--arch arm64` or `--arch x64` selects one. For team-owned apps it can scan the latest 100 workflow builds; for personal-account apps the official v3 API currently exposes the app's latest build, while build IDs created by this command are saved locally and queried directly. A known older eligible build can always be selected explicitly with `--build-id`. The command verifies full build details before reuse.

`status` performs a bounded query and exits; the agent can inspect it again while doing other work. There is no daemon, background delivery promise or long-held browser/DevSpace request. Build IDs and an unresolved submission marker are saved under ignored `build/codemagic/<commit>.json`. The existing `proper-lockfile` dependency prevents concurrent local submissions. Cloud build status remains authoritative.

A start POST is never automatically retried: a lost response may already have consumed build minutes. A subsequent invocation first reconciles cloud results. If a request remains ambiguous or a build failed, inspect Codemagic status/logs and use `start --retry` only after confirming a new attempt is appropriate. Normal reads have a small bounded retry for transient failures. Do not run independent machines' start commands concurrently for the same release.

`collect` obtains fresh short-lived artifact URLs through the authenticated API. The PKG remains a direct artifact. Codemagic may expose the SHA file and acceptance either directly or only inside its single `_artifacts.zip`; in the latter case `collect` downloads that bounded bundle and reads only the two fixed expected entries without arbitrary extraction. It independently hashes the PKG and calls the existing `verifyAcceptance`. It rejects incorrect commit, dirty checkout, wrong version/architecture, failed installation gates, conflicting hashes and truncated downloads. No account token is sent to the artifact download host, and signed URLs are neither saved nor printed. Only canonical expected filenames become local paths. Existing accepted bytes are reused; unknown/conflicting candidate directories are not overwritten.

The default output is `release/offline/<version>/darwin-arm64` and `darwin-x64`, exactly the existing publisher's layout. To recover a known existing build:

```text
npm run macos:ci -- status --arch arm64 --build-id <build-id> --commit <full-source-SHA>
npm run macos:ci -- collect --arch arm64 --build-id <build-id> --commit <full-source-SHA> --directory <candidate-root>
```

Changing the source after Windows/Linux acceptance also changes the final release identity. Rebuild/accept those targets for the final clean revision, or explicitly retain the previous revision as a separate release candidate. Never rewrite a receipt's commit/hash or mix previous macOS packages into the new final release.

## Publication and evidence boundaries

After all four final targets match one clean source commit, use the unchanged `npm run downloads:publish -- --publish` gate. It verifies exact accepted bytes, independently signed metadata, immutable upload, server hashes, public delivery, stable activation and retained policy/recovery versions. Artifact collection does **not** promote stable, change Gateway policy, delete server releases or redeploy unrelated runtime code.

The first updater rollout remains `stable -> observed canary -> auto -> minimumSupported`. Old clients without an updater require one manual covering install. Do not set auto/minimum to compensate for incomplete Mac acceptance. Codemagic M2 + Rosetta acceptance is not proof of physical Intel hardware, employee Enrollment input, Gatekeeper approval or Apple Developer ID signing/notarization.

The focused tests in `test/codemagic.test.mjs` use synthetic bytes and mocked HTTP to exercise safety and both target paths. They are not successful Codemagic runs. Real authenticated start/status/download and final system PKG acceptance must be recorded separately before claiming release completion.

During the source-available migration, the existing exact-byte Intel handoff is
retained as `.github/workflows/accept-codemagic-intel.yml`. It is manual,
main-only, uses the protected production operator profile, and checks that the
Codemagic receipt has the same profile digest. It does not rebuild the PKG.
The new four-platform workflow is separate and does not make this fallback
obsolete until its native runs have actually passed. Do not dispatch either
workflow to work around exhausted private-repository build quota.
