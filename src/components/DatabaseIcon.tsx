interface DatabaseIconProps {
  type: string;
  connected: boolean;
  size?: number;
  isActive?: boolean;
}

export default function DatabaseIcon({ type, connected, size = 14, isActive = false }: DatabaseIconProps) {
  const cls = !connected && !isActive ? "opacity-40" : isActive ? "opacity-100" : "opacity-100";
  const s = size;
  return (
    <span className={cls}>
      {type === "postgresql" && <PgIcon size={s} />}
      {type === "mysql" && <MyIcon size={s} />}
      {type === "sqlite" && <SQLiteIcon size={s} />}
      {type === "clickhouse" && <ChIcon size={s} />}
      {type === "gaussdb" && <GaussIcon size={s} />}
      {type === "oracle" && <OracleIcon size={s} />}
      {type === "sqlserver" && <MssqlIcon size={s} />}
      {type === "kingbase" && <KingIcon size={s} />}
      {type === "oceanbase" && <ObIcon size={s} />}
      {type === "tidb" && <TiDBIcon size={s} />}
      {type === "dameng" && <DmIcon size={s} />}
      {type === "gbase" && <GbIcon size={s} />}
      {!["postgresql","mysql","sqlite","clickhouse","gaussdb","oracle","sqlserver","kingbase","oceanbase","tidb","dameng","gbase"].includes(type) && <DefaultIcon size={s} />}
    </span>
  );
}

interface IconProps { size: number; }

// PostgreSQL — Blue Elephant head, recognizable brand silhouette
function PgIcon({ size }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {/* Main head shape */}
      <path d="M3 8.5C3 5 7 3 12 3c3 0 6 1 7.5 3.5C21 8 21 10 20 12c-1 3-3 4.5-5 5-1 .4-2 .8-2.5 1.5l-1 1.5c-.2.3-.5.5-.8.4-.1 0-.3-.1-.3-.3L10 18c-.2-.5-.2-1.2 0-1.8" fill="#336791" opacity=".15"/>
      <path d="M3 8.5C3 5 7 3 12 3c3 0 6 1 7.5 3.5C21 8 21 10 20 12c-1 3-3 4.5-5 5-1 .4-2 .8-2.5 1.5l-1 1.5c-.2.3-.5.5-.8.4-.1 0-.3-.1-.3-.3L10 18c-.2-.5-.2-1.2 0-1.8" stroke="#4169E1" strokeWidth="1.4" strokeLinejoin="round"/>
      {/* Eye */}
      <ellipse cx="9" cy="9.5" rx="1.8" ry="1.8" fill="#4169E1" opacity=".15"/>
      <circle cx="9" cy="9.5" r=".8" fill="#4169E1"/>
      {/* Trunk line */}
      <path d="M14 10c1 0 2 1 2.5 2.5" stroke="#4169E1" strokeWidth="1.3" strokeLinecap="round" opacity=".6"/>
    </svg>
  );
}

// MySQL — Dolphin with fin, recognizable brand silhouette
function MyIcon({ size }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {/* Body */}
      <path d="M6 14c-1-2-.5-6 2-8 2-1.5 4.5-1 6 .5C15 5 17 4.5 18 6c1.5 2 1 5 .5 7" fill="#4479A1" opacity=".12"/>
      <path d="M6 14c-1-2-.5-6 2-8 2-1.5 4.5-1 6 .5C15 5 17 4.5 18 6c1.5 2 1 5 .5 7" stroke="#4479A1" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      {/* Dorsal fin */}
      <path d="M12 6c1-2 2-4 0-4.5" stroke="#4479A1" strokeWidth="1.3" strokeLinecap="round"/>
      {/* Tail */}
      <path d="M6 14c-1 2 0 5 2.5 6s6 2 8-1c1-2 1-4 0-5" stroke="#4479A1" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
      {/* Eye */}
      <circle cx="9.5" cy="9.5" r="1.4" fill="#4479A1" opacity=".15"/>
      <circle cx="9.5" cy="9.5" r=".65" fill="#4479A1"/>
    </svg>
  );
}

// SQLite — Clean geometric diamond with feather-like layers
function SQLiteIcon({ size }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {/* Outer diamond */}
      <polygon points="12,2 21,9 12,22 3,9" fill="#003B57" opacity=".12" stroke="#003B57" strokeWidth="1.4" strokeLinejoin="round"/>
      {/* Top half */}
      <polygon points="12,2 21,9 12,14 3,9" fill="#003B57" opacity=".4"/>
      {/* Inner layers */}
      <polygon points="12,10 17,12.5 12,18 7,12.5" fill="#003B57" opacity=".2"/>
      <polygon points="12,12 15,13.5 12,16 9,13.5" fill="#003B57" opacity=".25"/>
    </svg>
  );
}

// ClickHouse — Geometric logo mark (cube + bars)
function ChIcon({ size }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {/* Left bar */}
      <rect x="2.5" y="6" width="3" height="15" rx="1" fill="#FFCC00" opacity=".85"/>
      {/* Center bar */}
      <rect x="7.5" y="3" width="3" height="18" rx="1" fill="#FFCC00" opacity=".85"/>
      {/* Right bars — taller */}
      <rect x="12.5" y="5" width="3" height="16" rx="1" fill="#FFCC00" opacity=".6"/>
      <rect x="17.5" y="2" width="3" height="19" rx="1" fill="#FF6B00" opacity=".8"/>
    </svg>
  );
}

// GaussDB — Huawei-inspired clean flower/petal mark
function GaussIcon({ size }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {/* Red outer petals */}
      <path d="M12 2.5C14 4 18 8 18 12s-4 8-6 9.5" stroke="#CF0A2C" strokeWidth="1.6" strokeLinecap="round"/>
      <path d="M12 2.5C10 4 6 8 6 12s4 8 6 9.5" stroke="#CF0A2C" strokeWidth="1.6" strokeLinecap="round"/>
      <path d="M2.5 12C4 10 8 6 12 6s8 4 9.5 6" stroke="#CF0A2C" strokeWidth="1.6" strokeLinecap="round"/>
      <path d="M2.5 12C4 14 8 18 12 18s8-4 9.5-6" stroke="#CF0A2C" strokeWidth="1.6" strokeLinecap="round"/>
      {/* Center */}
      <circle cx="12" cy="12" r="2.8" fill="#CF0A2C" opacity=".2"/>
      <circle cx="12" cy="12" r="1.4" fill="#CF0A2C"/>
    </svg>
  );
}

// Oracle — Red rectangle/"O" brand mark
function OracleIcon({ size }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="2" y="4" width="20" height="16" rx="2" fill="#F80000" opacity=".15" stroke="#F80000" strokeWidth="1.4"/>
      <text x="12" y="16" textAnchor="middle" fontSize="10" fontWeight="700" fill="#F80000" fontFamily="system-ui">O</text>
    </svg>
  );
}

// SQL Server — Microsoft grid/box style
function MssqlIcon({ size }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="2" y="4" width="9" height="7" rx="1" fill="#CC2927" opacity=".7"/>
      <rect x="13" y="4" width="9" height="7" rx="1" fill="#CC2927" opacity=".5"/>
      <rect x="2" y="13" width="9" height="7" rx="1" fill="#CC2927" opacity=".4"/>
      <rect x="13" y="13" width="9" height="7" rx="1" fill="#CC2927" opacity=".55"/>
    </svg>
  );
}

// Kingbase — Blue shield/crest
function KingIcon({ size }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M12 2L4 6v6c0 5.5 3.5 9.5 8 10 4.5-.5 8-4.5 8-10V6L12 2z" fill="#1E6BBD" opacity=".15" stroke="#1E6BBD" strokeWidth="1.4" strokeLinejoin="round"/>
      <circle cx="12" cy="12" r="3" fill="#1E6BBD" opacity=".25"/>
      <circle cx="12" cy="12" r="1.5" fill="#1E6BBD"/>
    </svg>
  );
}

// OceanBase — Wave/water droplet
function ObIcon({ size }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M3 15C5 11 8 8 12 8s7 3 9 7" stroke="#0078FF" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M5 18c2-2 4.5-3.5 7-3.5s5 2 7 4" stroke="#0078FF" strokeWidth="1.3" strokeLinecap="round" opacity=".6"/>
      <circle cx="18" cy="6" r="2.5" fill="#0078FF" opacity=".25"/>
      <circle cx="18" cy="6" r="1.2" fill="#0078FF"/>
    </svg>
  );
}

// TiDB — Pink lightning/flash mark (PingCAP brand)
function TiDBIcon({ size }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M13 2L6 13h4l-2 9 9-11h-5l3-9z" fill="#E6005A" opacity=".15" stroke="#E6005A" strokeWidth="1.4" strokeLinejoin="round"/>
    </svg>
  );
}

// DaMeng — Red diamond/star
function DmIcon({ size }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <polygon points="12,2 22,12 12,22 2,12" fill="#D6000F" opacity=".15" stroke="#D6000F" strokeWidth="1.4" strokeLinejoin="round"/>
      <circle cx="12" cy="12" r="3" fill="#D6000F" opacity=".25"/>
      <circle cx="12" cy="12" r="1.3" fill="#D6000F"/>
    </svg>
  );
}

// GBase — Blue hexagon
function GbIcon({ size }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M12 2l8.66 5v10L12 22l-8.66-5V7L12 2z" fill="#0068B7" opacity=".15" stroke="#0068B7" strokeWidth="1.4" strokeLinejoin="round"/>
      <text x="12" y="15.5" textAnchor="middle" fontSize="8" fontWeight="700" fill="#0068B7" fontFamily="system-ui">G</text>
    </svg>
  );
}

// Default — Classic database cylinder stack
function DefaultIcon({ size }: { size: number }) {
  const c = "#6b7280";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="7.5" ry="2.5"/>
      <path d="M4.5 5v14c0 1.38 3.36 2.5 7.5 2.5s7.5-1.12 7.5-2.5V5"/>
      <path d="M4.5 12c0 1.38 3.36 2.5 7.5 2.5s7.5-1.12 7.5-2.5"/>
    </svg>
  );
}
