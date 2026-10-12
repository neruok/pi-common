# @neruok/pi-common

Shared behavior for Neruok Pi extensions. This package is a library, not an extension to install with `pi install`.

## Modules

| Import | Responsibility |
| --- | --- |
| `@neruok/pi-common/model-picker` | Inline searchable model picker and RPC selection |
| `@neruok/pi-common/model-types` | Provider-free model types and reasoning values |
| `@neruok/pi-common/models` | Host-SDK reasoning capability checks |
| `@neruok/pi-common/settings` | Bounded reads, scoped layers, locked updates, and explicit replacement |
| `@neruok/pi-common/commands` | Scope parsing, autocomplete, and context invalidation |
| `@neruok/pi-common/presentation` | Text sanitization and UI/non-UI command reporting |

The package has no root export. Each extension imports the modules it needs.
The library does not register tools, change models, call providers, or start background resources.
Commands and model workflows remain in each extension.

## Settings contract

The settings module uses Node APIs only. Supply the existing byte limit and the extension schema.
Wrap each complete update or replacement in Pi's `withFileMutationQueue`.
The caller owns that queue. The library owns no process-global queue.

`updateJsonSettings` reads and validates JSON before it calls a synchronous update function.
Use it for scope-owned patches. Do not report, call models, or start asynchronous work inside the update function.

`replaceJsonSettings` replaces a regular file without decoding its old content.
Use it for explicit repair or reset. It compares streamed raw-byte fingerprints before replacement.

Writes acquire an exclusive lock. They use a synchronized same-directory temporary file.
Existing files use rename. First creation uses an exclusive hard link.
Changed checkpoints and lock contention fail without retry. The library does not reclaim stale locks.
Inspect a failed save before retry. A save can have completed before a cleanup or delivery failure.

Target and immediate-parent symlinks, special files, malformed UTF-8 reads, and oversized reads fail.
Parent-directory races and nonparticipating writers remain outside the guarantee.
These checks are not an OS sandbox or a power-loss durability guarantee.

## Development

Requires Node.js 24 or newer. SDK-dependent modules use host Pi peers.
The settings, model-types, and presentation modules can load without Pi installed.
The picker and reporter accept narrow structural capabilities instead of complete session contexts.

```sh
npm ci --ignore-scripts
npm run verify
```

Build this library before checking the consumer extensions.
The initial consumers are pi-advisor, pi-magic8ball, and pi-compaction-model.
Library verification does not require sibling consumer checkouts.
In the maintainer workspace, run `npm run check:consumers` to check all three packed consumers against their pinned Pi hosts.
Registry releases pin `@neruok/pi-common` to `0.1.0`. A consumer checkout does not need this repository.
Do not publish a consumer with a local file dependency.

## Compatibility and release

Requires Node.js 24 or newer. Checks cover Pi 1.0.4 and 1.1.0 on Linux.
CI tests both host versions. Other Pi versions and operating systems do not have release evidence here.
Host Pi packages remain optional wildcard peers, as Pi's packaging contract requires.
The library does not install or bundle host SDKs.
Exported shared constants are immutable. Command registration and session state remain consumer-owned.

The first release is `0.1.0`. Run `npm run verify` before publication.
The `prepublishOnly` gate runs the same checks and stops publication on failure.
The `prepack` gate builds the runtime modules and declarations.
Inspect the archive, then verify a clean npm installation before publication.
Publish the library before consumers. Verify registry availability and downloaded integrity before consumer installation checks.
There are no live-provider checks in `verify`.
The canonical contract is the workspace document `pi-common`. Its generated project output is `docs/pi-common.md`.
