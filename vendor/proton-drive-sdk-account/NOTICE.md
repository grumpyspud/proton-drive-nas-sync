# Vendored: proton-drive-sdk-account

This directory is a verbatim copy of the `proton-drive-sdk-account` module from
the official Proton Drive SDK repository:

- Upstream: https://github.com/ProtonDriveApps/sdk
- Source path: `incubating/account/js/src/`

Copyright (c) 2026 Proton AG. Licensed under the MIT License.

It is vendored (not installed from npm) because the module is marked
`"private": true` and is still incubating — Proton does not publish it to the
npm registry yet. The module implements the SRP login, session management, and
account/address API access that `@protontech/drive-sdk` requires but does not
itself provide.

The code is reproduced **verbatim** (no edits). The extensions this project
needs on top of it — TOTP two-factor authentication and two-password-mode
support — live in `src/auth/login.ts` and are deliberately kept out of this
directory, so it can be cleanly re-vendored when upstream updates.

To re-vendor: copy `incubating/account/js/src/*.ts` from the SDK repo into this
directory, replacing all files.
