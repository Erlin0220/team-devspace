# Fixed software distribution

## Decision (2026-09-13)

Use the existing Aliyun Simple Application Server, existing Caddy and the owned domain `downloads.568920429.xyz`. DNS points directly to the server; the existing Cloudflare Gateway remains exclusively the control plane. No R2, temporary download JWT, Admin-generated link, new web service, database, HTTP upload API or package-manager repository is needed.

The desired employee contract is **one public installation entrypoint, then a separately issued Access Key entered inside Team DevSpace**. Downloading or installing software is not device Enrollment. The source repository remains private, but anyone who receives a public installer can copy and inspect its program files; download authentication was never DRM.

The existing server reported region `us-east-1`, Caddy 2.11.4, about 12 GB free disk and roughly 876 MiB available memory during inspection. Static files add no new resident application process. This is suitable for the current small team, not a high-availability or guaranteed-bandwidth download service. Keep the server/domain renewed and monitor actual disk and transfer usage. No new paid plan is enabled. A future host or storage migration can retain the same owned domain.

### Mature patterns reused

| Reference | Applied here | Deliberately not copied |
| --- | --- | --- |
| Tailscale public stable packages and previous versions | Fixed stable entrypoints; canonical immutable version URLs; four platform packages; SHA-256 and explicit version history | Its full multi-platform repository and release infrastructure |
| Tailscale manual/managed/automatic update choices | Re-run the existing installer to upgrade, preserve device policy; keep update delivery separate from connection authorization | A new always-running updater or forced downgrade mechanism |
| Caddy file server | HTTPS, streaming files, HEAD/Range/ETag, directory history and graceful configuration reload | A custom Node/Worker download proxy |
| Existing Team DevSpace native installers | EXE/PKG/Linux bootstrap retain their verified payload, repair, upgrade and uninstall behavior | A second installer or another credential/configuration system |

Primary sources reviewed:
- https://pkgs.tailscale.com/stable/ — public platform downloads, SHA-256 and older versions.
- https://tailscale.com/kb/1067/update and https://tailscale.com/docs/reference/messages/client/update-available — manual, managed and automatic update choices.
- https://caddyserver.com/docs/caddyfile/directives/file_server — native static serving; a site root is not a symlink sandbox, so only owned public files are placed inside it.
- https://caddyserver.com/docs/command-line — validate and reload the existing server rather than stop it.
- https://www.alibabacloud.com/help/en/simple-application-server/product-overview/usage-notes — small-workload fit, bandwidth not guaranteed; actual region and quotas matter.

## Employee entrypoints

Home and stable installation instructions: `https://downloads.568920429.xyz/`.

```powershell
irm https://downloads.568920429.xyz/install.ps1 | iex
```

```sh
curl -fsSL https://downloads.568920429.xyz/install.sh | sh
```

These commands execute a script from the trusted HTTPS site. Users can inspect the scripts first or download a package directly. Each generated script pins the immutable package URL, byte count and SHA-256 for one release. A stable switch between script download and package download cannot mix versions. No employee credential appears in these commands or URLs.

| Platform | Permanent package URL | Installation/configuration |
| --- | --- | --- |
| Windows x64 | `/stable/windows-x64.exe` | Normal NSIS installer; then open Team DevSpace from completion page, Desktop or Start Menu. |
| macOS Apple Silicon | `/stable/macos-arm64.pkg` | Normal system PKG installer and security approval; then Team DevSpace setup. |
| macOS Intel | `/stable/macos-x64.pkg` | Same system workflow; Unix script detects Apple Silicon even under Rosetta. |
| Linux x64 | `/stable/linux-x64.tar.gz` | Ordinary user, glibc 2.34+; then `~/.local/bin/team-devspace setup`. |

The script also supports a download-only check: save and run `install.ps1 -DownloadOnly -Destination <directory>` or `sh install.sh --download-only`. This verifies bytes without pretending that installation ran.

Access Key replacement uses the existing application/CLI transaction. Device identity, project directory and explicit pause intent survive upgrade and Key replacement. Legacy explicit request-file automation remains available, but is not part of normal software distribution. The old authenticated `/admin/downloads` command endpoint returns 410; the Admin page no longer generates links.

## Files and ownership

```text
/srv/team-devspace-downloads/
  .owner                         # ownership marker, private
  .incoming/<random-id>/         # incomplete uploads, private, never served
  backups/                       # only this Caddy site's previous configuration
  activations.log                # previous/new stable pointers, private
  public/
    index.html                      # independently published product/download homepage
    releases/<version>/
      Team-DevSpace-<version>-<platform-package>
      *.sha256
      acceptance-<target>.json   # sanitized exact-byte evidence and limitations
      catalog.json
      SHA256SUMS                 # packages, scripts, page and metadata
      install.ps1 / install.sh
      index.html / release-notes.txt
      <stable-platform-alias> -> canonical package
    stable -> releases/<version>
```

`release.config.json` remains the version/platform declaration and supplies the HTTPS origin. `downloads.config.json` contains only the SSH alias and dedicated server root. Secrets stay in existing SSH/admin stores. The publisher refuses to adopt nonempty unowned directories or overwrite unrelated Caddy configuration. Existing sites and services are not modified.

The dedicated site is `/etc/caddy/conf.d/team-devspace-downloads.caddy`; it uses the existing import in the main Caddyfile. Before reload it validates the whole Caddy configuration, backing up/restoring only its own site if validation or reload fails. Public file serving is rooted at `public/`, not the server root. No employee state, SSH files, private keys or build environment variables enter that directory.

Version URLs use immutable caching; `/`, scripts, stable metadata/aliases and version-history listing use `no-store`. The public homepage is intentionally separate from immutable release directories so product/download copy and layout can evolve without rebuilding four native installers; `npm run downloads:site` regenerates it from the currently active catalog and replaces one static file atomically. Release-specific `index.html` files remain immutable historical pages. One shell `flock` serializes publication operations. Stable activation additionally compares the previous pointer recorded by the publisher so a concurrent publisher cannot silently replace a newer activation.

## Release, verification and rollback

Prepare DNS once, then initialize the existing Caddy server:

```sh
npm run downloads:deploy
```

Build and accept the four platform packages from one clean committed source tree. Windows acceptance must include the unmodified final EXE transaction. Both Mac targets must pass actual system PKG and installed LaunchAgent acceptance on the existing Codemagic runner. Linux must pass its final archive and native lifecycle acceptance. Exact source commit, no dirty source, package filename and final SHA-256 are checked; no bypass flag is provided.

```sh
npm run downloads:publish                 # local preparation only
npm run downloads:publish -- --publish    # SSH upload, verify, activate, refresh homepage
npm run downloads:site                    # homepage-only refresh; no installer rebuild
```

Publication first copies all four files to a private random staging directory. Server-side SHA-256 verification must pass before the directory becomes visible. Existing versions cannot change. The publisher then streams all four packages back through public HTTPS and checks exact size/hash, HEAD/ETag and byte-range support. Only then is the stable symlink replaced by an atomic rename. Partial upload, corrupted files or failed HTTPS checks do not change stable.

Historical import is explicit and still checks the original source commit and exact final-byte acceptance:

```sh
npm run downloads:publish -- --publish --version <version> --commit <40-hex-source-commit> --directory <four-target-artifact-directory>
```

Safe server-side rollback revalidates the retained files and switches the same pointer:

```sh
npm run downloads:publish -- --activate <previous-version>
```

This changes future downloads, not already-running clients. Client downgrade requires an explicitly compatible historical installer; there is no generic promise that future state-schema migrations are backward-compatible. The current release adds no state-schema migration. A corrupt old release cannot be activated. Keep both current and a known-good previous version; do not automatically delete releases needed for rollback. Private GitHub release assets may serve as off-server backups, without being part of employee installation.

The deployed 0.2.2 packages were accepted at source commit `4c0e4cdc04c31121eb01e5c2e7f195b989020eaf`. A later documentation-only verification commit is not a new binary build. To re-publish these exact existing artifacts from such a checkout, supply `--commit 4c0e4cdc04c31121eb01e5c2e7f195b989020eaf`; do not relabel their receipts as coming from the documentation commit. The retained 0.2.1 release keeps its older onboarding behavior and is a recovery reference. Employees should use the current stable entrypoint, not assume that a historical package includes the new credential-free installation flow.

## Trust and actual evidence

SHA-256 pins here inherit HTTPS-site trust; they detect corruption and mixed versions, not a compromised publisher/server. They are not an independent software signature. Existing `internal-free` limits remain: no public Windows signing reputation is promised, and macOS is unsigned/unnotarized unless the existing signing path is explicitly enabled. The installer never disables Gatekeeper, imports root certificates or hides normal security confirmation. See [internal-distribution.md](internal-distribution.md).

`test/downloads.test.mjs` explicitly uses synthetic package bytes to test release identity, script pinning, exact acceptance gates, corruption rejection, immutable publish, compare-and-swap activation and rollback. Those tests are not installation evidence. Actual native builds, downloaded-byte installation tests, company-network measurements, Caddy service checks and production rollback observations belong in [verification.md](verification.md).
