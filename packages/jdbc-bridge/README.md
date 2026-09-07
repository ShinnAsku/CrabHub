# JDBC Bridge

Explicit alternative adapters for Oracle, DM8, YashanDB and GBase 8s. The default paths are now [native adapters](../native-clients/README.md). Set `CRABHUB_JDBC_DATABASES=oracle,dameng,yashandb,gbase` (or a subset) before launching CrabHub to select JDBC. Failures never trigger an automatic switch. JDBC requires a full JDK 17 or newer: the Rust executable embeds and launches this Java source with source-file mode. A JRE alone is insufficient. No Java server port is opened.

## Install On Windows

```powershell
& ./packages/jdbc-bridge/setup.ps1
```

The default destination is `%LOCALAPPDATA%\CrabHub\jdbc`. Set `JAVA_HOME` to the installed JDK, or make `java` available on PATH. Set `CRABHUB_JDBC_DIR` in the CrabHub process environment to use a different driver directory. In Web deployments, these paths and Java belong to the server machine, not the browser client.

The installer validates the pinned SHA-256 values in [artifacts.json](artifacts.json). The Gson, Oracle, DM and Yashan pins were checked against Maven Central SHA-256 sidecars. GBase only published SHA-1/MD5 sidecars for this version; its SHA-256 pin was calculated after HTTPS download and comparison with the published SHA-1. This is package integrity checking, not signature verification or a CVE audit.

On other platforms, place the same verified JARs in `CRABHUB_JDBC_DIR`. Without that variable, CrabHub uses the platform local-data directory plus `CrabHub/jdbc` (Linux normally `~/.local/share/CrabHub/jdbc`; macOS normally `~/Library/Application Support/CrabHub/jdbc`). JARs are not included in the application bundle; users must comply with their vendor licenses.

| Selector | Driver Class | JAR | Connection |
| --- | --- | --- | --- |
| Oracle | `oracle.jdbc.OracleDriver` | `oracle.jar` (`ojdbc11` 23.26.3.0.0) | Host/port, Service Name, user/password; Thin driver, no native Oracle client required |
| DaMeng | `dm.jdbc.driver.DmDriver` | `dameng.jar` | Host/port, user/password; the optional database field selects the default schema |
| YashanDB | `com.yashandb.jdbc.Driver` | `yashandb.jar` | Host/port, database name, user/password |
| GBase | `com.gbasedbt.jdbc.Driver` | `gbase8s.jar` | GBase 8s host/port, database, user/password |

## Vendor Profiles

The defaults are embedded from [profiles/oracle.json](profiles/oracle.json), [profiles/dameng.json](profiles/dameng.json), [profiles/yashandb.json](profiles/yashandb.json) and [profiles/gbase.json](profiles/gbase.json). A file with the same name in the driver directory overrides its default. Malformed overrides are errors, not ignored.

Profiles are trusted local administrator configuration: JARs execute with the CrabHub user's permissions. Only install trusted vendor JARs. Profiles accept `driver`, `jar`, `urlTemplate`, `dialect`, optional `properties` and optional `extraJars`. Paths may be absolute or relative to the driver directory. Supported dialect settings are `oracle`, `dameng`, `yashandb`, `mysql` and `generic`.

URL placeholders are `{host}`, `{port}` and `{database}`. Keep credentials out of profiles; supply them through the connection form. For an 8s deployment that requires an instance name or non-default locale, set the matching vendor `GBASEDBTSERVER`, `DB_LOCALE` and `CLIENT_LOCALE` properties in its profile. `DELIMIDENT=y` enables the quoted identifiers used by the data editor.

GBase 8a/8s/8t/8c are distinct products. The built-in profile and downloaded artifact are specifically 8s. For another family, install that vendor's JAR and create an explicit profile with its documented driver, URL and dialect. Such custom profiles have not passed vendor acceptance. A PostgreSQL URL or an Oracle driver is not a substitute.

## Oracle Connections

Use the listener's Service Name (for example `FREEPDB1` or `sales.example.com`), not a schema/user name. The form saves it in the existing `database` field. The tree shows the connected service, then schemas. Connect to other PDBs through their own service connections; the bridge does not query privileged CDB catalogs or grant access automatically.

For a legacy SID deployment, override the Oracle profile in the driver directory with:

```json
{
	"driver": "oracle.jdbc.OracleDriver",
	"jar": "oracle.jar",
	"urlTemplate": "jdbc:oracle:thin:@{host}:{port}:{database}",
	"dialect": "oracle",
	"properties": { "remarksReporting": "true", "oracle.net.CONNECT_TIMEOUT": "15000" }
}
```

With that explicit override, enter the SID in the form's Service Name field. The override applies to Oracle connections in that CrabHub process; it is not a per-connection mode selector. SYS administrative roles are not enabled automatically; an administrator can explicitly configure the driver's documented `internal_logon` property in a trusted profile when required.

The JDBC data page quotes identifiers and binds values; Oracle NULLs use the target column type. Table and view DDL is read through `DBMS_METADATA.GET_DDL`, subject to the connected user's privileges. Oracle's empty-string-as-NULL semantics remain unchanged. NUMBER values are preserved as strings on the wire. Wallet/TCPS UI configuration, LOB/binary editing, SQL*Plus commands and complete PL/SQL/multiple-result handling are not covered by this core implementation.

## Boundaries

- One worker/physical connection per active connection, requests serialized. Process cancellation invalidates it; reconnect explicitly and inspect database state before retrying writes.
- No automatic grant escalation. Metadata visibility and data access remain subject to database permissions.
- Paging uses JDBC `setMaxRows` and forward reading rather than assuming a shared SQL grammar. Deep offset pages can be expensive.
- The bridge currently rejects the UI TLS flag until vendor-specific certificate configuration is implemented. Use an approved SSH tunnel where suitable; do not assume plaintext is acceptable for production.
- Data editing uses bound values and quoted identifiers. Exact DDL depends on vendor metadata support and user privileges; generic dialect export is explicitly unsupported.
- No isolated script sessions, bulk API, stored-code browsing, generic trigger/partition design or production acceptance is claimed.

## Official Sources

- [Oracle JDBC data sources and URLs](https://docs.oracle.com/en/database/oracle/oracle-database/23/jjdbc/data-sources-and-URLs.html)
- [Oracle ojdbc11 package and license metadata](https://repo.maven.apache.org/maven2/com/oracle/database/jdbc/ojdbc11/23.26.3.0.0/ojdbc11-23.26.3.0.0.pom)
- [DM JDBC guide](https://eco.dameng.com/document/dm/zh-cn/pm/jdbc-rogramming-guide.html)
- [YashanDB JDBC installation](https://doc.yashandb.com/yashandb/23.4/zh/All-Manuals/Development-Guide/JDBC-Driver/YashanDB-JDBC-Driver-Installation.html)
- [YashanDB connection example](https://doc.yashandb.com/yashandb/23.4/zh/All-Manuals/Development-Guide/JDBC-Driver/YashanDB-JDBC-Driver-Usage-Introduction/YashanDB-JDBC-Driver-Usage-Examples.html)
- [GBase 8s Maven publication and license metadata](https://repo.maven.apache.org/maven2/com/gbasedbt/jdbc/3.6.5.21_nobson/jdbc-3.6.5.21_nobson.pom)

Runtime and vendor E2E tests are deferred to the final acceptance phase at the user's request. Compilation and successful JAR download do not establish database compatibility.