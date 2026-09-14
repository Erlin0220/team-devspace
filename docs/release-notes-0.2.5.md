# Team DevSpace 0.2.5

## Changes

- Freeze the shared Control Center and Windows first-run Key/project setup surface. Paused, unavailable and healthy services now have distinct signals; local settings and updates remain on the existing controller.
- Harden updater handoff, single-flight checks, signed version/target validation, interrupted-install recovery and scoped cache cleanup. Preserve device identity, binding, project directory and the user's remote-access intent.
- Add low-frequency update inventory and auditable lifecycle cleanup for revoked Access Keys. Device status migration remains in Expand: both authenticated status interfaces continue to work.
- Require previous-version installer acceptance and native CPU evidence before publishing the exact accepted packages. Re-accept the existing macOS x64 package on Intel without rebuilding it.

## Upgrade and rollout boundaries

0.2.4 already includes an updater. 0.2.3 and earlier must use the fixed download site's installer for a manual overlay installation. Installing software must not require a new Access Key or a replacement device binding.

Production schema additions precede the dual-interface Gateway deployment; client delivery follows backend readiness. Stable delivery, automatic promotion, minimum support and legacy-interface retirement are separate decisions. Offline devices and manual recovery must remain supported while the migration is unconfirmed.

The release keeps the current internal-free signing profile. Native installation tests do not claim Apple notarization, Gatekeeper approval or unattended administrator authorization. Actual acceptance receipts identify the source commit, exact package hash, checks performed and remaining limitations.
