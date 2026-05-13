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

interface IconProps {
  size: number;
  color: string;
}

// PostgreSQL - Elephant head silhouette
function PostgreSQLIcon({ size, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M17.5 3C15.5 2 13.5 2.5 12 4C10.5 2.5 8.5 2 6.5 3C4 4.5 3 7.5 3.5 10.5C4 13.5 6 16 8 18C9 19 10.5 20 12 21C13.5 20 15 19 16 18C18 16 20 13.5 20.5 10.5C21 7.5 20 4.5 17.5 3Z"
        fill={color}
        opacity="0.9"
      />
      <ellipse cx="9" cy="9" rx="1.5" ry="2" fill="white" opacity="0.8" />
      <path d="M13 8C13 8 14.5 9 14.5 11C14.5 13 13 14 13 14" stroke="white" strokeWidth="1.2" strokeLinecap="round" fill="none" opacity="0.7" />
    </svg>
  );
}

// MySQL - Dolphin silhouette
function MySQLIcon({ size, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M4 14C4 14 5 8 9 6C13 4 15 5 16 7C17 9 17 11 19 12C21 13 22 14 22 14"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M16 7C16 7 18 4 20 3"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M4 14C4 14 3 17 5 19C7 21 11 21 13 19C15 17 14 14 14 14"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="8" cy="10" r="1" fill={color} />
    </svg>
  );
}

// SQLite - Feather / lightweight icon
function SQLiteIcon({ size, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M12 2L10 6L12 10L10 14L12 18L10 22"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d="M10 6C7 5 4 6 3 9C2 12 4 14 10 14"
        fill={color}
        opacity="0.3"
        stroke={color}
        strokeWidth="1"
      />
      <path
        d="M12 10C15 9 18 10 19 13C20 16 18 18 12 18"
        fill={color}
        opacity="0.3"
        stroke={color}
        strokeWidth="1"
      />
    </svg>
  );
}

// MSSQL - Database with "S" mark
function MSSQLIcon({ size, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <ellipse cx="12" cy="6" rx="8" ry="3" fill={color} opacity="0.8" />
      <path d="M4 6V18C4 19.7 7.6 21 12 21C16.4 21 20 19.7 20 18V6" stroke={color} strokeWidth="1.5" fill="none" />
      <path d="M4 12C4 13.7 7.6 15 12 15C16.4 15 20 13.7 20 12" stroke={color} strokeWidth="1.5" fill="none" />
      <text x="12" y="19" textAnchor="middle" fill="white" fontSize="7" fontWeight="bold" fontFamily="Arial">S</text>
    </svg>
  );
}

// ClickHouse - Column/bar chart style
function ClickHouseIcon({ size, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="3" y="8" width="3" height="13" rx="0.5" fill={color} />
      <rect x="7.5" y="4" width="3" height="17" rx="0.5" fill={color} />
      <rect x="12" y="10" width="3" height="11" rx="0.5" fill={color} />
      <rect x="16.5" y="3" width="3" height="18" rx="0.5" fill={color} />
      <rect x="16.5" y="3" width="3" height="5" rx="0.5" fill={color === "#FFCC00" ? "#FF4400" : color} />
    </svg>
  );
}

// GaussDB - Huawei-style petal
function GaussDBIcon({ size, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M12 3C12 3 8 7 8 12C8 17 12 21 12 21" stroke={color} strokeWidth="2" strokeLinecap="round" fill="none" />
      <path d="M12 3C12 3 16 7 16 12C16 17 12 21 12 21" stroke={color} strokeWidth="2" strokeLinecap="round" fill="none" />
      <path d="M3 12C3 12 7 8 12 8C17 8 21 12 21 12" stroke={color} strokeWidth="2" strokeLinecap="round" fill="none" />
      <path d="M3 12C3 12 7 16 12 16C17 16 21 12 21 12" stroke={color} strokeWidth="2" strokeLinecap="round" fill="none" />
      <circle cx="12" cy="12" r="2" fill={color} />
    </svg>
  );
}

// OpenGauss - Open source variant
function OpenGaussIcon({ size, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="8" stroke={color} strokeWidth="2" fill="none" />
      <path d="M12 4C12 4 8 8 8 12C8 16 12 20 12 20" stroke={color} strokeWidth="1.5" strokeLinecap="round" fill="none" />
      <path d="M12 4C12 4 16 8 16 12C16 16 12 20 12 20" stroke={color} strokeWidth="1.5" strokeLinecap="round" fill="none" />
      <line x1="4" y1="12" x2="20" y2="12" stroke={color} strokeWidth="1.5" />
      <circle cx="12" cy="12" r="1.5" fill={color} />
    </svg>
  );
}

// Default - Generic database cylinder
function DefaultDBIcon({ size, color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5V19C3 20.7 7 22 12 22C17 22 21 20.7 21 19V5" />
      <path d="M3 12C3 13.7 7 15 12 15C17 15 21 13.7 21 12" />
    </svg>
  );
}
