# Verification evidence

This document indexes validation responsibilities. It is not an assertion that
the current checkout, production deployment and published packages are identical.
Current source-publication findings are in [public readiness](public-readiness.md).

## Evidence required for a release

| Gate | What it proves | What it does not prove |
| --- | --- | --- |
| `npm run check`, unit/contract tests | Source contracts, syntax and focused regressions | Native installer or production connectivity |
| `deploy --dry-run` | Worker bundling and local configuration schema | Production migrations, WAF/Access or rollout |
| `package` and `verify-release` | Native payload construction and archive integrity | Employee installation and cross-version preservation |
| `acceptance:platform` | Only the checks explicitly recorded in its receipt | Any skipped OS, CPU or UI interactions |
| Real employee / ChatGPT acceptance | The tested machine, Key, directory and actual MCP route | Every employee network and OS version |

Receipts identify the source commit, dirty-state flag, operator profile digest,
entrypoint SHA-256, checks and limitations. The publisher requires exact bytes
and strict gates. Do not relabel a build-only sample, a systemless Linux smoke,
PKG extraction or M2/Rosetta execution as complete native acceptance.

## Historical scope

Earlier internal releases used local Windows/WSL and Codemagic M2 builds. The
Intel macOS package could be exercised under Rosetta; that was not physical
Intel evidence. Old records do not grant the new native GitHub workflow a pass.
Preserve historical receipts privately alongside their original immutable
packages. Build/account IDs, production hostnames and server inventories are
not needed in this public source document.

Version-specific user-facing behavior remains in release notes. Historical
implementation reviews under `docs/ops` describe their own date/commit only.
Future releases require a fresh final-commit acceptance record, not copied
checkboxes or the previous version's green build.
