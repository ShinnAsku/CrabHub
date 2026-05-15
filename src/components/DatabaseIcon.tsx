interface DatabaseIconProps {
  type: string;
  connected: boolean;
  size?: number;
  isActive?: boolean;
}

export default function DatabaseIcon({ type, connected, size = 14, isActive = false }: DatabaseIconProps) {
  const color = isActive ? "#ffffff" : connected ? getBrandColor(type) : "#9ca3af";

  switch (type) {
    case "postgresql":
      return <PostgreSQLIcon size={size} color={color} />;
    case "mysql":
      return <MySQLIcon size={size} color={color} />;
    case "sqlite":
      return <SQLiteIcon size={size} color={color} />;
    case "clickhouse":
      return <ClickHouseIcon size={size} color={color} />;
    case "gaussdb":
      return <GaussDBIcon size={size} color={color} />;
    default:
      return <DefaultDBIcon size={size} color={color} />;
  }
}

function getBrandColor(type: string): string {
  switch (type) {
    case "postgresql": return "#336791";
    case "mysql": return "#00758F";
    case "sqlite": return "#003B57";
    case "clickhouse": return "#FFCC00";
    case "gaussdb": return "#CF0A2C";
    default: return "#6b7280";
  }
}

interface IconProps { size: number; color: string; }

// PostgreSQL — clean elephant head (forward-facing)
function PostgreSQLIcon({ size, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M18 3C15.5 2.5 13.5 3 12.5 4.5C11.5 3 9.5 2.5 7 3C4.5 4 3 7.5 3.5 11C4 14 6.5 16.5 8 18C10 19.5 11.5 20.5 12 21C12.5 20.5 14 19.5 16 18C17.5 16.5 20 14 20.5 11C21 7.5 19.5 4 18 3Z"
        fill={color} opacity="0.12" stroke={color} strokeWidth="1.6" strokeLinejoin="round"
      />
      <circle cx="8.5" cy="10" r="1.6" fill={color} opacity="0.25" />
      <circle cx="8.5" cy="10" r="0.8" fill={color} />
      <path d="M13 9.5C13 9.5 14 10.5 14 12C14 14 12.5 14.5 12.5 14.5" stroke={color} strokeWidth="1.2" strokeLinecap="round" opacity="0.6" />
    </svg>
  );
}

// MySQL — sleek dolphin silhouette facing right
function MySQLIcon({ size, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M5.5 14.5C5.5 14.5 6.5 8.5 10 7C13.5 5.5 16 6.5 17 8.5C18 10.5 18 14.5 19 13.5C20 12.5 21 11 21 11"
        stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
      />
      <path d="M10 7C10 7 9 4.5 7 3.5" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
      <path
        d="M5.5 14.5C5.5 14.5 4 17 5.5 18.5C7 20 11 21 13 18.5C15 16 14 14 14 14"
        stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
      />
      <circle cx="8.5" cy="10.5" r="1.3" fill={color} opacity="0.2" />
      <circle cx="8.5" cy="10.5" r="0.7" fill={color} />
    </svg>
  );
}

// SQLite — clean geometric diamond
function SQLiteIcon({ size, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <polygon points="12,3 20,9 12,21 4,9" fill={color} opacity="0.15" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
      <polygon points="12,3 20,9 12,13 4,9" fill={color} opacity="0.45" />
      <polygon points="12,10 16,12 12,18 8,12" fill={color} opacity="0.25" />
    </svg>
  );
}

// ClickHouse — three clean vertical bars
function ClickHouseIcon({ size, color }: IconProps) {
  const highlight = color === "#FFCC00" ? "#E52" : color;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="3" y="8" width="3.5" height="13" rx="1" fill={color} opacity="0.85" />
      <rect x="8" y="4" width="3.5" height="17" rx="1" fill={color} opacity="0.85" />
      <rect x="13" y="10" width="3.5" height="11" rx="1" fill={color} opacity="0.85" />
      <rect x="18" y="4" width="3.5" height="17" rx="1" fill={highlight} opacity="0.7" />
      <rect x="18" y="4" width="3.5" height="4" rx="1" fill={highlight} />
    </svg>
  );
}

// GaussDB — elegant flower-petal with clean geometry
function GaussDBIcon({ size, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M12 3C12 3 7 7 7 12C7 17 12 20 12 20" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
      <path d="M12 3C12 3 17 7 17 12C17 17 12 20 12 20" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
      <path d="M3 12C3 12 7 8 12 8C17 8 21 12 21 12" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
      <path d="M3 12C3 12 7 16 12 16C17 16 21 12 21 12" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="12" r="2.5" fill={color} opacity="0.25" />
      <circle cx="12" cy="12" r="1.3" fill={color} />
    </svg>
  );
}

// Default — classic database cylinder stack
function DefaultDBIcon({ size, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="8" ry="2.5" />
      <path d="M4 5V19C4 20.38 7.58 21.5 12 21.5S20 20.38 20 19V5" />
      <path d="M4 12C4 13.38 7.58 14.5 12 14.5S20 13.38 20 12" />
    </svg>
  );
}
