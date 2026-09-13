# Team DevSpace 0.2.2

Four-platform software distribution now uses stable HTTPS entrypoints on the existing Aliyun/Caddy server. Version directories, package checksums and release-specific scripts are immutable. The stable channel can be changed or rolled back without changing employee connection settings.

Windows installs the application before connection setup. Linux supports interactive setup and credential replacement through the existing CLI. Changing credentials preserves device identity, project directory and explicit pause intent. Repeated installation and removal of an unconfigured application are supported.

The previous temporary-download and R2 candidate is retired. Software download does not grant remote access. Existing device authorization remains unchanged.

Upgrades reuse the native installers and add no background updater or state-schema migration. Server rollback affects future downloads only. The internal-free signing limitations and normal operating-system security confirmations remain. macOS x64 CI validation runs through Rosetta, not physical Intel hardware. Exact final-byte validation records and limitations accompany each package.
