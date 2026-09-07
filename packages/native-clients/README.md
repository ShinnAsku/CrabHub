# Native Database Clients

Oracle, DaMeng, YashanDB and GBase 8s default to native adapters. No Java process is started for these paths. This is implementation, not vendor production certification.

| Database | Rust Dependency | Runtime Prerequisite |
| --- | --- | --- |
| DaMeng | tokio-dameng 0.1.0 | Rust protocol implementation; no vendor client or JVM |
| Oracle | oracle 0.6.3 / ODPI-C | Matching Oracle Instant Client Basic; native library directory on process PATH / loader path |
| YashanDB | yashandb 0.1.0 | Vendor yascli client >= 23.4.1.100 on loader path or `~/.yashandb/client/lib` |
| GBase 8s | odbc-api 29.0.0 | Vendor 8s ODBC driver matching process architecture plus OS ODBC manager |

Rust 1.95 is pinned in [rust-toolchain.toml](../../rust-toolchain.toml), required by YashanDB. Linux builds need `unixodbc-dev`; runtime needs `libodbc2` and vendor clients. macOS builds need `brew install unixodbc` and its library directory in `LIBRARY_PATH`. Successful macOS compilation does not establish vendor client availability on macOS. Proprietary clients are not bundled or redistributed by this repository.

## Oracle On Windows

Run [setup-oracle.ps1](setup-oracle.ps1). It downloads the Basic 23.26.3 x64 ZIP over HTTPS, checks the SHA-256 published on Oracle's download page, and extracts to `%LOCALAPPDATA%\CrabHub\native\oracle-23.26.3`. Basic is used instead of Basic Light to retain additional database character sets. It changes PATH only for the current PowerShell session; launch the app from that session. A matching Microsoft VC++ runtime is required. Review Oracle licensing before redistribution.

Oracle uses an ordinary authenticated connection and a required Service Name. SYSDBA is not selected implicitly. The descriptor disables connect retries. Wallet/TCPS and SID selection are not implemented on this native path.

## GBase 8s

Install the vendor's native ODBC driver with its documented installer. Registration may require an administrator; this repository does not elevate or modify machine-wide driver registrations automatically. Set these in the CrabHub process environment:

- `CRABHUB_GBASE_ODBC_DRIVER`: exact registered driver name (required).
- `CRABHUB_GBASE_SERVER`: vendor instance/server name if required by the deployment.
- `CRABHUB_GBASE_CLIENT_LOCALE`, `CRABHUB_GBASE_DB_LOCALE`: optional deployment locales.

Host, service port, database and credentials come from the connection form. Connection-string attributes are escaped, `DELIMIDENT=y` is enabled, and query parameters use Unicode binding. These environment settings apply to all GBase connections in that process; they are not per-connection UI controls. GBase 8a/8t/8c are not interchangeable with 8s.

The inspected `GBase8s_3.6.5_2ZJGS_14-Win64-ODBC-Driver.zip` registers `GBase ODBC DRIVER (64-bit)` and points to `GBaseCSDK/bin/iclit09b.dll`. Its `00` registration command file writes HKLM and must be run manually by an administrator after reviewing vendor instructions. The archive is downloaded locally but this privileged registration has not been executed. A locally computed archive hash is not a publisher signature or a vendor checksum verification.

This is a one-time Windows ODBC registration, not a requirement to run CrabHub as administrator. The client installer determines its local directory. Review the vendor's `00` CMD file and run it manually with administrator privileges when required. An unregistered driver can return ODBC `IM002` before database authentication.

## YashanDB On Windows

Run [setup-yashan.ps1](setup-yashan.ps1). It verifies the official GitHub release SHA-256 for client 23.4.7.100, then installs its DLL directory to `%USERPROFILE%\.yashandb\client\lib`. Existing clients are not overwritten. The installed client has been loaded by the validation desktop and reached its native socket connection path; an actual YashanDB engine is still required for SQL acceptance.

## Explicit JDBC Alternative

Set `CRABHUB_JDBC_DATABASES=oracle,gbase` to select JDBC for those types before launching CrabHub. Valid names: `oracle`, `dameng`, `yashandb`, `gbase`. Unlisted types use native adapters. The selection applies to desktop, web-server and RPC connections in the process; a web browser's environment does not configure its server. See [JDBC setup](../jdbc-bridge/README.md).

Selection is global per database type, not a saved per-connection field. There is no error-triggered fallback and no automatic write replay. Existing saved connections are not rewritten.

## Operational Boundaries

- At most 16 native workers per process, including schema subconnections. Each physical session serializes requests off the async/UI threads. Oracle, YashanDB and ODBC use blocking native calls; DaMeng uses its Tokio protocol client in an owning worker runtime.
- Autocommit is explicitly enabled. Isolated script sessions, bulk API, transaction UI and stored-code designers remain unsupported. Do not infer multi-statement transaction guarantees from ordinary editor execution.
- Dropping/cancelling an active request isolates its session. A blocked C call may finish later and may already have committed. A timed-out worker retains its capacity slot until the call returns. Closing the connection stops waiting but cannot guarantee server-side cancellation or rollback. Inspect data before any explicit retry.
- Result previews are limited to 20,000 rows, 16 MiB serialized result bytes and 1 MiB per materialized string. Oversized/truncated values fail rather than silently truncating. Paging reads one extra row and uses a forward cursor, so deep offsets can be expensive.
- Exact numeric values are returned as strings. NULL remains NULL; quoted strings retain leading zeros. Native grid NULL edits use SQL NULL rather than a guessed vendor bind type. Binary results are base64; binary/LOB editing is not implemented.
- DaMeng 0.1.0 is a new community protocol driver. Decimal formats it cannot decode exactly, unsupported temporal encodings and out-of-row LOB locators fail with an explicit projection/cast instruction. Its convenience empty-string decoder is not used. Real DM8 compatibility remains a required acceptance gate.
- YashanDB driver-unsupported timezone and other column types require an explicit supported SQL cast. Native client versions older than the documented baseline must not be used.
- Table/view, schema, column, PK, FK, index, count and data operations use native SQL catalogs or ODBC metadata. Oracle-style metadata packages supply exact DDL for Oracle/DM/Yashan subject to privileges. GBase exact DDL export remains unsupported; use vendor `dbschema`.
- The native UI TLS flag currently fails closed. Vendor TLS configuration is not implemented or certified. An approved SSH tunnel may be configured using the existing connection form; do not assume unencrypted transport is acceptable.

## Sources

- [Oracle client downloads and SHA-256](https://www.oracle.com/database/technologies/instant-client/winx64-64-downloads.html)
- [rust-oracle](https://github.com/kubo/rust-oracle)
- [tokio-dameng](https://docs.rs/tokio-dameng/0.1.0/tokio_dameng/)
- [YashanDB Rust driver](https://docs.rs/yashandb/0.1.0/yashandb/)
- [GBase 8s ODBC packages](https://gbasedbt.com/dl/odbc/)
- [odbc-api](https://docs.rs/odbc-api/29.0.0/odbc_api/)
