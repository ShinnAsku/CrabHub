import com.google.gson.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.sql.*;
import java.util.*;

public final class CrabHubJdbc {
    private static final Gson JSON = new GsonBuilder().serializeNulls().disableHtmlEscaping().create();
    private static final int MAX_ROWS = 20000;
    private static final int MAX_VALUE = 1024 * 1024;
    private static final int MAX_FRAME = 16 * 1024 * 1024;
    private Connection connection;
    private int timeout = 300;
    private String dialect;
    private String databaseLabel;

    public static void main(String[] args) throws Exception {
        PrintWriter output = new PrintWriter(new OutputStreamWriter(new FileOutputStream(FileDescriptor.out), StandardCharsets.UTF_8), true);
        System.setOut(new PrintStream(OutputStream.nullOutputStream()));
        CrabHubJdbc bridge = new CrabHubJdbc();
        try (BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = readFrame(input)) != null) {
                JsonObject response = new JsonObject();
                try {
                    JsonObject request = JsonParser.parseString(line).getAsJsonObject();
                    response.add("id", request.get("id"));
                    Object result = bridge.dispatch(request.get("method").getAsString(), request.getAsJsonObject("params"));
                    response.add("result", JSON.toJsonTree(result));
                } catch (Exception error) {
                    if (error instanceof SQLException sql) {
                        response.addProperty("error", "JDBC SQLState=" + sql.getSQLState() + " code=" + sql.getErrorCode() + ": " + sql.getMessage());
                        response.addProperty("fatal", sql instanceof SQLRecoverableException || sql instanceof SQLNonTransientConnectionException || (sql.getSQLState() != null && sql.getSQLState().startsWith("08")));
                    }
                    else response.addProperty("error", error.getClass().getSimpleName() + ": " + error.getMessage());
                }
                String encoded = JSON.toJson(response);
                if (encoded.getBytes(StandardCharsets.UTF_8).length > MAX_FRAME) {
                    response.remove("result");
                    response.addProperty("error", "JDBC response exceeds 16 MiB; narrow the query.");
                    encoded = JSON.toJson(response);
                }
                output.println(encoded);
                if (output.checkError()) break;
            }
        } finally { if (bridge.connection != null) bridge.connection.close(); }
    }

    private static String readFrame(Reader reader) throws IOException {
        StringBuilder frame = new StringBuilder();
        int value;
        while ((value = reader.read()) != -1) {
            if (value == '\n') return frame.toString();
            if (frame.length() >= MAX_FRAME) throw new IOException("Request exceeds frame limit");
            frame.append((char) value);
        }
        return frame.isEmpty() ? null : frame.toString();
    }

    private Object dispatch(String method, JsonObject params) throws Exception {
        if (method.equals("connect")) {
            Class.forName(text(params, "driver", ""));
            DriverManager.setLoginTimeout(15);
            Properties properties = new Properties();
            if (params.has("properties")) {
                for (Map.Entry<String, JsonElement> property : params.getAsJsonObject("properties").entrySet()) properties.setProperty(property.getKey(), property.getValue().getAsString());
            }
            properties.setProperty("user", text(params, "username", ""));
            properties.setProperty("password", text(params, "password", ""));
            connection = DriverManager.getConnection(text(params, "url", ""), properties);
            dialect = text(params, "dialect", "generic");
            timeout = Math.max(0, params.get("timeout").getAsInt());
            databaseLabel = text(params, "database", "");
            if (dialect.equals("dameng") && !databaseLabel.isEmpty()) connection.setSchema(databaseLabel);
            connection.setAutoCommit(true);
            return Map.of("product", connection.getMetaData().getDatabaseProductName(), "version", connection.getMetaData().getDatabaseProductVersion());
        }
        if (connection == null || connection.isClosed()) throw new SQLException("Connection is closed");
        return switch (method) {
            case "query" -> query(text(params, "sql", ""), null, 0, 0);
            case "query_paged" -> query(text(params, "sql", ""), null, params.get("offset").getAsInt(), params.get("limit").getAsInt());
            case "databases" -> databases();
            case "ping" -> ping();
            case "execute" -> execute(text(params, "sql", ""), null);
            case "tables" -> tables(null, false);
            case "views" -> tables(text(params, "schema", null), true);
            case "schemas" -> schemas();
            case "columns" -> columns(params);
            case "indexes" -> indexes(params);
            case "foreign_keys" -> foreignKeys(params);
            case "count" -> count(params);
            case "data" -> data(params);
            case "insert", "update", "delete" -> mutate(method, params);
            case "ddl" -> ddl(params);
            default -> throw new IllegalArgumentException("Unknown JDBC operation: " + method);
        };
    }

    private static String text(JsonObject value, String key, String fallback) {
        return value.has(key) && !value.get(key).isJsonNull() ? value.get(key).getAsString() : fallback;
    }

    private String quote(String name) throws SQLException {
        if (name == null || name.isEmpty() || name.indexOf('\0') >= 0) throw new SQLException("Empty or invalid identifier");
        String quote = connection.getMetaData().getIdentifierQuoteString().trim();
        if (quote.isEmpty()) {
            if (!name.matches("[A-Za-z_][A-Za-z0-9_]*")) throw new SQLException("Driver does not support quoted identifiers");
            return name;
        }
        return quote + name.replace(quote, quote + quote) + quote;
    }

    private String table(JsonObject params) throws SQLException {
        String schema = text(params, "schema", null);
        return (schema == null || schema.isEmpty() ? "" : quote(schema) + ".") + quote(text(params, "table", ""));
    }

    private String catalog(JsonObject params) throws SQLException {
        return connection.getMetaData().supportsSchemasInTableDefinitions() ? connection.getCatalog() : text(params, "schema", connection.getCatalog());
    }

    private String schema(JsonObject params) throws SQLException {
        if (!connection.getMetaData().supportsSchemasInTableDefinitions()) return null;
        String explicit = text(params, "schema", null);
        if (explicit != null) return explicit;
        try { return connection.getSchema(); }
        catch (SQLFeatureNotSupportedException unsupported) { return null; }
    }

    private PreparedStatement statement(String sql, List<JsonElement> values) throws SQLException {
        return statement(sql, values, null);
    }

    private PreparedStatement statement(String sql, List<JsonElement> values, List<Integer> parameterTypes) throws SQLException {
        PreparedStatement statement = connection.prepareStatement(sql);
        try {
            statement.setQueryTimeout(timeout);
            statement.setFetchSize(100);
            if (values != null) {
                for (int index = 0; index < values.size(); index++) {
                    JsonElement value = values.get(index);
                    if (value.isJsonNull()) statement.setNull(index + 1, parameterTypes == null ? Types.NULL : parameterTypes.get(index));
                    else if (value.isJsonPrimitive()) {
                        JsonPrimitive primitive = value.getAsJsonPrimitive();
                        if (primitive.isNumber()) statement.setBigDecimal(index + 1, primitive.getAsBigDecimal());
                        else if (primitive.isBoolean()) statement.setBoolean(index + 1, primitive.getAsBoolean());
                        else statement.setString(index + 1, primitive.getAsString());
                    } else statement.setString(index + 1, JSON.toJson(value));
                }
            }
            return statement;
        } catch (SQLException error) { statement.close(); throw error; }
    }

    private Map<String, Object> execute(String sql, List<JsonElement> values) throws Exception {
        return execute(sql, values, null);
    }

    private Map<String, Object> execute(String sql, List<JsonElement> values, List<Integer> parameterTypes) throws Exception {
        long started = System.nanoTime();
        try (PreparedStatement statement = statement(sql, values, parameterTypes)) {
            boolean rows = statement.execute();
            long affected = rows ? 0 : Math.max(0, statement.getLargeUpdateCount());
            if (rows) try (ResultSet result = statement.getResultSet()) { while (result.next()) {} }
            return Map.of("rowsAffected", affected, "executionTimeMs", (System.nanoTime() - started) / 1000000);
        }
    }

    private Map<String, Object> query(String sql, List<JsonElement> values, int offset, int limit) throws Exception {
        if (offset < 0 || limit < 0 || limit > MAX_ROWS) throw new SQLException("Invalid JDBC page bounds");
        long started = System.nanoTime();
        try (PreparedStatement statement = statement(sql, values)) {
            statement.setMaxRows(limit > 0 ? Math.addExact(offset, limit) : MAX_ROWS + 1);
            if (!statement.execute()) return Map.of("columns", List.of(), "rows", List.of(), "rowCount", 0, "executionTimeMs", (System.nanoTime() - started) / 1000000);
            try (ResultSet result = statement.getResultSet()) {
                ResultSetMetaData metadata = result.getMetaData();
                List<Map<String, Object>> columns = new ArrayList<>();
                List<String> names = new ArrayList<>();
                for (int index = 1; index <= metadata.getColumnCount(); index++) {
                    String original = metadata.getColumnLabel(index);
                    String name = original;
                    for (int suffix = 2; names.contains(name); suffix++) name = original + "_" + suffix;
                    names.add(name);
                    Map<String, Object> column = new LinkedHashMap<>();
                    column.put("name", name);
                    column.put("dataType", metadata.getColumnTypeName(index));
                    column.put("nullable", metadata.isNullable(index) != ResultSetMetaData.columnNoNulls);
                    column.put("isPrimaryKey", false);
                    column.put("numericPrecision", metadata.getPrecision(index));
                    column.put("numericScale", metadata.getScale(index));
                    columns.add(column);
                }
                List<Map<String, Object>> rows = new ArrayList<>();
                int skipped = 0;
                long budget = JSON.toJson(columns).getBytes(StandardCharsets.UTF_8).length;
                while (result.next()) {
                    if (skipped++ < offset) continue;
                    if (rows.size() >= MAX_ROWS) throw new SQLException("Result exceeds 20000 rows; narrow or page the query");
                    Map<String, Object> row = new LinkedHashMap<>();
                    for (int index = 1; index <= names.size(); index++) {
                        Object value = cell(result, metadata, index);
                        row.put(names.get(index - 1), value);
                    }
                    budget += JSON.toJson(row).getBytes(StandardCharsets.UTF_8).length;
                    if (budget > MAX_FRAME / 2) throw new SQLException("Result exceeds memory budget; narrow the query");
                    rows.add(row);
                    if (limit > 0 && rows.size() >= limit) break;
                }
                return Map.of("columns", columns, "rows", rows, "rowCount", rows.size(), "executionTimeMs", (System.nanoTime() - started) / 1000000);
            }
        }
    }

    private static Object cell(ResultSet result, ResultSetMetaData metadata, int index) throws Exception {
        int type = metadata.getColumnType(index);
        if (type == Types.BINARY || type == Types.VARBINARY || type == Types.LONGVARBINARY || type == Types.BLOB) {
            try (InputStream stream = result.getBinaryStream(index)) {
                if (stream == null) return null;
                byte[] bytes = stream.readNBytes(MAX_VALUE + 1);
                if (bytes.length > MAX_VALUE) throw new SQLException("Binary value exceeds 1 MiB");
                return Base64.getEncoder().encodeToString(bytes);
            }
        }
        if (type == Types.CLOB || type == Types.NCLOB || type == Types.LONGVARCHAR || type == Types.LONGNVARCHAR) {
            try (Reader reader = result.getCharacterStream(index)) {
                if (reader == null) return null;
                StringBuilder text = new StringBuilder();
                char[] buffer = new char[4096];
                int count;
                while ((count = reader.read(buffer)) != -1) { if (text.length() + count > MAX_VALUE) throw new SQLException("Text value exceeds 1 MiB"); text.append(buffer, 0, count); }
                return text.toString();
            }
        }
        String text = result.getString(index);
        if (text == null) return null;
        if (text.length() > MAX_VALUE) throw new SQLException("Value exceeds 1 MiB");
        if (type == Types.BOOLEAN || (type == Types.BIT && metadata.getPrecision(index) == 1)) return result.getBoolean(index);
        return text;
    }

    private List<Map<String, Object>> tables(String schema, boolean onlyViews) throws Exception {
        List<Map<String, Object>> tables = new ArrayList<>();
        DatabaseMetaData metadata = connection.getMetaData();
        boolean catalogAsSchema = !metadata.supportsSchemasInTableDefinitions();
        try (ResultSet result = metadata.getTables(catalogAsSchema ? schema : connection.getCatalog(), catalogAsSchema ? null : pattern(schema), "%", onlyViews ? new String[]{"VIEW"} : new String[]{"TABLE"})) {
            while (result.next()) {
                if (tables.size() >= MAX_ROWS) throw new SQLException("Too many table metadata entries");
                Map<String, Object> table = new LinkedHashMap<>();
                table.put("name", result.getString("TABLE_NAME"));
                table.put("schema", result.getString(catalogAsSchema ? "TABLE_CAT" : "TABLE_SCHEM"));
                table.put("tableType", result.getString("TABLE_TYPE"));
                table.put("comment", result.getString("REMARKS"));
                tables.add(table);
            }
        }
        return tables;
    }

    private List<String> schemas() throws Exception {
        List<String> schemas = new ArrayList<>();
        if (!connection.getMetaData().supportsSchemasInTableDefinitions()) return databases();
        try (ResultSet result = connection.getMetaData().getSchemas()) {
            while (result.next()) { if (schemas.size() >= MAX_ROWS) throw new SQLException("Too many schemas"); schemas.add(result.getString("TABLE_SCHEM")); }
        }
        return schemas;
    }

    private List<String> databases() throws Exception {
        if (dialect.equals("oracle")) {
            if (databaseLabel.isEmpty()) throw new SQLException("An Oracle service name is required");
            return List.of(databaseLabel);
        }
        if (Set.of("dameng", "yashandb").contains(dialect)) return List.of(connection.getMetaData().getDatabaseProductName());
        List<String> catalogs = new ArrayList<>();
        try (ResultSet result = connection.getMetaData().getCatalogs()) {
            while (result.next()) {
                if (catalogs.size() >= MAX_ROWS) throw new SQLException("Too many catalogs");
                String name = result.getString("TABLE_CAT");
                if (name != null && !name.isEmpty()) catalogs.add(name);
            }
        }
        if (catalogs.isEmpty()) {
            String current = connection.getCatalog();
            if (current == null || current.isEmpty()) current = databaseLabel;
            if (current == null || current.isEmpty()) throw new SQLException("Select a database in the connection settings");
            catalogs.add(current);
        }
        return catalogs;
    }

    private boolean ping() throws SQLException {
        if (!connection.isValid(10)) throw new SQLException("JDBC connection is no longer valid", "08003");
        return true;
    }

    private String pattern(String identifier) throws SQLException {
        if (identifier == null) return null;
        String escape = connection.getMetaData().getSearchStringEscape();
        return escape.isEmpty() ? identifier : identifier.replace(escape, escape + escape).replace("_", escape + "_").replace("%", escape + "%");
    }

    private List<Map<String, Object>> columns(JsonObject params) throws Exception {
        String schema = schema(params), catalog = catalog(params), table = text(params, "table", "");
        DatabaseMetaData metadata = connection.getMetaData();
        Set<String> primary = new HashSet<>();
        try (ResultSet keys = metadata.getPrimaryKeys(catalog, schema, table)) { while (keys.next()) primary.add(keys.getString("COLUMN_NAME")); }
        List<Map<String, Object>> columns = new ArrayList<>();
        try (ResultSet result = metadata.getColumns(catalog, pattern(schema), pattern(table), "%")) {
            while (result.next()) {
                if (!table.equals(result.getString("TABLE_NAME")) || (schema != null && !schema.equals(result.getString("TABLE_SCHEM")))) continue;
                Map<String, Object> column = new LinkedHashMap<>();
                column.put("name", result.getString("COLUMN_NAME"));
                column.put("dataType", result.getString("TYPE_NAME"));
                column.put("nullable", result.getInt("NULLABLE") != DatabaseMetaData.columnNoNulls);
                column.put("isPrimaryKey", primary.contains(result.getString("COLUMN_NAME")));
                column.put("defaultValue", result.getString("COLUMN_DEF"));
                column.put("comment", result.getString("REMARKS"));
                int type = result.getInt("DATA_TYPE");
                boolean numeric = Set.of(Types.NUMERIC, Types.DECIMAL, Types.INTEGER, Types.BIGINT, Types.SMALLINT, Types.FLOAT, Types.DOUBLE, Types.REAL).contains(type);
                column.put("characterMaximumLength", numeric ? null : result.getLong("COLUMN_SIZE"));
                column.put("numericPrecision", numeric ? result.getLong("COLUMN_SIZE") : null);
                column.put("numericScale", numeric ? result.getInt("DECIMAL_DIGITS") : null);
                columns.add(column);
                if (columns.size() >= MAX_ROWS) throw new SQLException("Too many columns");
            }
        }
        return columns;
    }

    private List<Map<String, Object>> indexes(JsonObject params) throws Exception {
        List<Map<String, Object>> indexes = new ArrayList<>();
        try (ResultSet result = connection.getMetaData().getIndexInfo(catalog(params), schema(params), text(params, "table", ""), false, true)) {
            while (result.next()) {
            if (indexes.size() >= MAX_ROWS) throw new SQLException("Too many indexes");
                if (result.getShort("TYPE") == DatabaseMetaData.tableIndexStatistic) continue;
                Map<String, Object> index = new LinkedHashMap<>();
                index.put("name", result.getString("INDEX_NAME")); index.put("column_name", result.getString("COLUMN_NAME"));
                index.put("is_unique", !result.getBoolean("NON_UNIQUE")); index.put("ordinal_position", result.getShort("ORDINAL_POSITION"));
                indexes.add(index);
            }
        }
        return indexes;
    }

    private List<Map<String, Object>> foreignKeys(JsonObject params) throws Exception {
        List<Map<String, Object>> keys = new ArrayList<>();
        try (ResultSet result = connection.getMetaData().getImportedKeys(catalog(params), schema(params), text(params, "table", ""))) {
            while (result.next()) {
            if (keys.size() >= MAX_ROWS) throw new SQLException("Too many foreign keys");
                Map<String, Object> key = new LinkedHashMap<>();
                key.put("name", result.getString("FK_NAME")); key.put("column_name", result.getString("FKCOLUMN_NAME"));
                key.put("foreign_table_schema", result.getString("PKTABLE_SCHEM")); key.put("foreign_table_name", result.getString("PKTABLE_NAME"));
                key.put("foreign_column_name", result.getString("PKCOLUMN_NAME")); key.put("ordinal_position", result.getShort("KEY_SEQ")); keys.add(key);
            }
        }
        return keys;
    }

    private long count(JsonObject params) throws Exception {
        try (PreparedStatement statement = statement("SELECT COUNT(*) FROM " + table(params), null); ResultSet result = statement.executeQuery()) {
            if (!result.next()) throw new SQLException("COUNT returned no row");
            return result.getBigDecimal(1).longValueExact();
        }
    }

    private Map<String, Object> data(JsonObject params) throws Exception {
        int page = params.get("page").getAsInt(), size = params.get("pageSize").getAsInt();
        if (page < 1 || size < 1 || size > MAX_ROWS) throw new SQLException("Invalid page size");
        int offset = Math.multiplyExact(page - 1, size);
        String order = text(params, "orderBy", "1");
        String sql = "SELECT * FROM " + table(params) + " ORDER BY " + order;
        if (dialect.equals("mysql")) return query(sql + " LIMIT " + size + " OFFSET " + offset, null, 0, size);
        return query(sql, null, offset, size);
    }

    private Map<String, Object> mutate(String method, JsonObject params) throws Exception {
        List<JsonElement> values = new ArrayList<>();
        List<String> fields = new ArrayList<>();
        Map<String, Integer> columnTypes = dialect.equals("oracle") ? mutationColumnTypes(params) : Map.of();
        List<Integer> parameterTypes = dialect.equals("oracle") ? new ArrayList<>() : null;
        if (!method.equals("delete")) {
            for (JsonElement entry : params.getAsJsonArray("values")) {
                JsonArray pair = entry.getAsJsonArray();
                String name = pair.get(0).getAsString();
                fields.add(quote(name)); values.add(pair.get(1));
                if (parameterTypes != null) parameterTypes.add(columnType(columnTypes, name));
            }
            if (fields.isEmpty()) throw new SQLException("No values supplied");
        }
        if (method.equals("insert")) return execute("INSERT INTO " + table(params) + " (" + String.join(",", fields) + ") VALUES (" + String.join(",", Collections.nCopies(values.size(), "?")) + ")", values, parameterTypes);
        List<String> conditions = new ArrayList<>();
        for (JsonElement item : params.getAsJsonArray("conditions")) {
            JsonObject condition = item.getAsJsonObject();
            String name = condition.get("column").getAsString();
            String column = quote(name);
            if (condition.get("value").isJsonNull()) conditions.add(column + " IS NULL");
            else {
                conditions.add(column + " = ?"); values.add(condition.get("value"));
                if (parameterTypes != null) parameterTypes.add(columnType(columnTypes, name));
            }
        }
        if (conditions.isEmpty()) throw new SQLException("WHERE conditions are required");
        String prefix = method.equals("delete") ? "DELETE FROM " + table(params) : "UPDATE " + table(params) + " SET " + String.join(",", fields.stream().map(field -> field + " = ?").toList());
        return execute(prefix + " WHERE " + String.join(" AND ", conditions), values, parameterTypes);
    }

    private Map<String, Integer> mutationColumnTypes(JsonObject params) throws SQLException {
        String schema = schema(params), table = text(params, "table", "");
        Map<String, Integer> types = new HashMap<>();
        try (ResultSet columns = connection.getMetaData().getColumns(catalog(params), pattern(schema), pattern(table), "%")) {
            while (columns.next()) {
                if (!table.equals(columns.getString("TABLE_NAME")) || (schema != null && !schema.equals(columns.getString("TABLE_SCHEM")))) continue;
                if (types.size() >= MAX_ROWS) throw new SQLException("Too many column metadata entries");
                types.put(columns.getString("COLUMN_NAME"), columns.getInt("DATA_TYPE"));
            }
        }
        return types;
    }

    private static int columnType(Map<String, Integer> types, String name) throws SQLException {
        Integer type = types.get(name);
        if (type == null) throw new SQLException("Column metadata is unavailable: " + name);
        return type;
    }

    private String ddl(JsonObject params) throws Exception {
        if (dialect.equals("mysql")) {
            try (PreparedStatement statement = statement("SHOW CREATE TABLE " + table(params), null); ResultSet result = statement.executeQuery()) {
                if (!result.next()) throw new SQLException("DDL returned no row");
                return result.getString(2);
            }
        }
        if (!Set.of("oracle", "dameng", "yashandb").contains(dialect)) throw new SQLFeatureNotSupportedException("Exact DDL export is not supported for this JDBC dialect");
        String schema = schema(params);
        if (schema == null) throw new SQLException("Choose a schema before exporting DDL");
        String table = text(params, "table", "");
        String objectType = "TABLE";
        if (dialect.equals("oracle")) {
            boolean found = false;
            try (ResultSet objects = connection.getMetaData().getTables(null, pattern(schema), pattern(table), new String[]{"TABLE", "VIEW"})) {
                while (objects.next()) {
                    if (!table.equals(objects.getString("TABLE_NAME")) || !schema.equals(objects.getString("TABLE_SCHEM"))) continue;
                    objectType = objects.getString("TABLE_TYPE");
                    found = true;
                    break;
                }
            }
            if (!found) throw new SQLException("No accessible table or view with this name in the selected schema");
        }
        try (PreparedStatement statement = statement("SELECT DBMS_METADATA.GET_DDL(?, ?, ?) FROM DUAL", List.of(new JsonPrimitive(objectType), new JsonPrimitive(table), new JsonPrimitive(schema))); ResultSet result = statement.executeQuery()) {
            if (!result.next()) throw new SQLException("DDL returned no row");
            return String.valueOf(cell(result, result.getMetaData(), 1));
        }
    }
}