# Client distribution

`release.config.json` is the canonical release declaration. CI builds every enabled OS/architecture on a native runner, runs the existing runtime tests, and produces four required immutable components (`app`, `devspace-runtime`, `node`, `cloudflared`) plus the conditional Windows `git-fallback` component. Employee machines never run `npm install` or a native build.

Each target layout is self-contained:

```text
release/offline/<release>/<target>/
  manifest.json
  manifest.json.sha256
  objects/sha256/<digest>/<component>.tar.gz
  <small platform bootstrapper>
```

The normal Windows installer embeds only `bootstrap.ps1`, the fixed-version manifest and small command wrappers. The macOS package embeds the same target manifest and the shared Unix bootstrap. Linux publishes the same manifest/component model as a bootstrap archive, but Linux is a candidate target until native CI and signing policy are accepted for stable distribution.

Windows production dependencies are installed from the lockfile with `npm ci --omit=dev --omit=optional`. Team DevSpace disables upstream subagents and DevSpace uses its pipe implementation on Windows, so the optional platform Claude executable, Pi clipboard binding and `node-pty` are not part of that target artifact. The package build rejects `node-pty` or any platform `claude-agent-sdk-*` payload if either reappears, and records the install profile in both the cache fingerprint and release provenance. macOS/Linux deliberately retain optional dependencies because upstream DevSpace uses `node-pty` for Unix TTY sessions.

## Install transaction

The bootstrapper validates target, version, artifact path, exact byte size and SHA-256. It uses the offline object when present beside the installer; otherwise it downloads the same content-addressed object from the fixed R2 Custom Domain URL. It never resolves `latest`.

Windows stores archives under `cache/sha256`, extracts into the short `s/` staging path, validates Node, DevSpace, cloudflared and native SQLite, then switches between the fixed `v/0` and `v/1` slots. Full release and manifest identity lives in `active.json`. The short physical slots keep the unmodified upstream dependency tree below legacy MAX_PATH. At least the prior active slot remains available for rollback. macOS/Linux use the equivalent `cache`, `staging`, `versions` and active-pointer layout.

Setup/Enrollment runs against the candidate before the active pointer changes. A download, integrity, extraction or setup failure leaves the previous active version selected and restores its startup entries. Repair calls the same bootstrapper, cache and manifest; it does not have a second installation implementation. Uninstall removes owned payload/cache/startup entries but retains Enrollment and employee project files.

## Publication gates

`.github/workflows/build-installers.yml` aggregates all native layouts, requires Authenticode for a published Windows installer and Developer ID Installer signing plus notarization/stapling for published macOS packages, uploads content-addressed objects with `rclone copy --immutable`, verifies every remote byte against its manifest SHA-256, and publishes the fixed-version manifests last. There is no mutable stable/latest channel in this release model.

R2 runtime artifacts are explicitly approved as public in `release.config.json` and are served through the dedicated `releases.568920429.xyz` Custom Domain. They contain no credentials or Enrollment state, expose no bucket listing, and use fixed version plus content-addressed paths. The Gateway is not a byte proxy for R2.

## Trust and remaining external gates

The fixed-version manifest is embedded in the signed platform installer, so this version does not add TUF or a second manifest-signing subsystem. Unsigned local builds are development candidates only. A production handoff still requires real signing credentials, native macOS/Linux runs, remote R2 publication/verification and real employee Enrollment.

The current Access Key and device-secret model remains in place until two distinct Workspace users pass Managed OAuth identity routing and Linked App Token is proven through the wildcard per-device Access application. Do not delete those credentials based only on protocol-level unit tests.
