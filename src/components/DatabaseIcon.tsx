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

// PostgreSQL — elephant head silhouette
function PostgreSQLIcon({ size, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M16.5 2C14 1.5 12.5 2 12 3.5C11.5 2 10 1.5 7.5 2C5 3.5 4 7 4.5 10C5 13 7 15.5 9 17.5C10 18.5 11.5 19.5 12 20.5C12.5 19.5 14 18.5 15 17.5C17 15.5 19 13 19.5 10C20 7 19 3.5 16.5 2Z" fill={color} opacity="0.9" />
      <ellipse cx="9" cy="8" rx="1.3" ry="1.8" fill="white" opacity="0.8" />
      <path d="M12.5 7.5C12.5 7.5 14 8.5 14 10.5C14 12.5 12.5 13.5 12.5 13.5" stroke="white" strokeWidth="1.2" strokeLinecap="round" fill="none" opacity="0.6" />
    </svg>
  );
}

// MySQL — dolphin
function MySQLIcon({ size, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M4 14C4 14 5 8 9 6C13 4 15 5 16 7C17 9 17 11 19 12C21 13 22 14 22 14" stroke={color} strokeWidth="1.8" strokeLinecap="round" fill="none" />
      <path d="M16 7C16 7 18 4 20 3" stroke={color} strokeWidth="1.3" strokeLinecap="round" fill="none" />
      <path d="M4 14C4 14 3 17 5 19C7 21 11 21 13 19C15 17 14 14 14 14" stroke={color} strokeWidth="1.8" strokeLinecap="round" fill="none" />
      <circle cx="8" cy="10" r="0.8" fill={color} />
    </svg>
  );
}

// SQLite — diamond/feather
function SQLiteIcon({ size, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <polygon points="12,2 20,7 12,22 4,7" fill={color} opacity="0.15" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
      <polygon points="12,2 20,7 12,12 4,7" fill={color} opacity="0.5" />
      <circle cx="12" cy="12" r="0.8" fill={color} opacity="0.8" />
    </svg>
  );
}

// ClickHouse — column chart icon
function ClickHouseIcon({ size, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="3" y="8" width="3" height="13" rx="0.5" fill={color} />
      <rect x="7.5" y="4" width="3" height="17" rx="0.5" fill={color} />
      <rect x="12" y="10" width="3" height="11" rx="0.5" fill={color} />
      <rect x="16.5" y="3" width="3" height="18" rx="0.5" fill={color} />
      <rect x="16.5" y="3" width="3" height="4" rx="0.5" fill={color === "#FFCC00" ? "#FF4400" : color} />
    </svg>
  );
}

// GaussDB — Huawei-style flower petal
function GaussDBIcon({ size, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M12 2C12 2 7 6 7 11C7 16 12 20 12 20" stroke={color} strokeWidth="2" strokeLinecap="round" fill="none" />
      <path d="M12 2C12 2 17 6 17 11C17 16 12 20 12 20" stroke={color} strokeWidth="2" strokeLinecap="round" fill="none" />
      <path d="M2 11C2 11 7 7 12 7C17 7 22 11 22 11" stroke={color} strokeWidth="2" strokeLinecap="round" fill="none" />
      <path d="M2 11C2 11 7 15 12 15C17 15 22 11 22 11" stroke={color} strokeWidth="2" strokeLinecap="round" fill="none" />
      <circle cx="12" cy="11" r="2" fill={color} />
    </svg>
  );
}

// Default — generic database cylinder
function DefaultDBIcon({ size, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5V19C3 20.7 7 22 12 22C17 22 21 20.7 21 19V5" />
      <path d="M3 12C3 13.7 7 15 12 15C17 15 21 13.7 21 12" />
    </svg>
  );
}
