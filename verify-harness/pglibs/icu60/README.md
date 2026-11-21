# ICU 60 compatibility libraries (sandbox only)

The bundled embedded PostgreSQL 18 binaries (`@embedded-postgres/linux-x64`)
dynamically link `libicuuc.so.60` / `libicudata.so.60` / `libicui18n.so.60`.
ICU exports version-suffixed symbols (`uloc_toLanguageTag_60`, ...), so a newer
system ICU (e.g. `libicuuc.so.76`) cannot be symlinked as a substitute.

`extracted/` holds the runtime libraries from the Ubuntu 18.04 (bionic)
package:

- Package: `libicu60` (`60.2-3ubuntu3`, amd64)
- Source: `http://security.ubuntu.com/ubuntu/pool/main/i/icu/libicu60_60.2-3ubuntu3_amd64.deb`
- Extracted with: `dpkg-deb -x libicu60.deb extracted`

`start.mjs` prepends `extracted/usr/lib/x86_64-linux-gnu` to `LD_LIBRARY_PATH`
when `libicuuc.so.60` is found here, so initdb / pg_ctl / postgres resolve the
correct ICU. On machines whose system ICU already satisfies the binaries this
directory is ignored entirely (delete it there — the harness falls back to the
system libraries).
