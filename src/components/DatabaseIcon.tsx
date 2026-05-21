interface DatabaseIconProps {
  type: string;
  connected: boolean;
  size?: number;
  isActive?: boolean;
}

// DBeaver-style: colored rounded square with white brand mark inside
export default function DatabaseIcon({ type, connected, size = 16, isActive = false }: DatabaseIconProps) {
  const bg = getColor(type, connected, isActive);
  const w = size;
  const h = size;
  const r = Math.max(3, size * 0.2); // proportional border radius

  return (
    <svg width={w} height={h} viewBox="0 0 24 24" fill="none">
      <rect x="1" y="1" width="22" height="22" rx={r} fill={bg} />
      {renderMark(type, connected, isActive)}
    </svg>
  );
}

function getColor(type: string, connected: boolean, _isActive: boolean): string {
  if (!connected) return "#9ca3af";
  switch (type) {
    case "postgresql": return "#4169E1";
    case "mysql": return "#4479A1";
    case "sqlite": return "#0F80CC";
    case "clickhouse": return "#FFCC00";
    case "gaussdb": return "#CF0A2C";
    case "oracle": return "#F80000";
    case "sqlserver": return "#CC2927";
    case "kingbase": return "#1E6BBD";
    case "oceanbase": return "#0078FF";
    case "tidb": return "#E6005A";
    case "dameng": return "#D6000F";
    case "gbase": return "#0068B7";
    default: return "#6b7280";
  }
}

function renderMark(type: string, connected: boolean, isActive: boolean) {
  const c = (connected || isActive) ? "#ffffff" : "#d1d5db";
  switch (type) {
    case "postgresql": return <PgMark color={c} />;
    case "mysql": return <MyMark color={c} />;
    case "sqlite": return <SQLiteMark color={c} />;
    case "clickhouse": return <ChMark color={c} />;
    case "gaussdb": return <GaussMark color={c} />;
    case "oracle": return <OracleMark color={c} />;
    case "sqlserver": return <MssqlMark color={c} />;
    case "kingbase": return <KingMark color={c} />;
    case "oceanbase": return <ObMark color={c} />;
    case "tidb": return <TiDBMark color={c} />;
    case "dameng": return <DmMark color={c} />;
    case "gbase": return <GbMark color={c} />;
    default: return <DefaultMark color={c} />;
  }
}

// PostgreSQL — Elephant head
function PgMark({ color }: { color: string }) {
  return (
    <g transform="translate(4,3) scale(0.7)">
      <path d="M12 2C8 1 5 3.5 5 8c0 4 1.5 6.5 2.5 8L9 19c.5.8 1 1.2 1.5 1 .3-.1.5-.4.5-.7l-.5-2.5c-.2-.6-.2-1.5 0-2" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="9" cy="8.5" r="2" fill={color} opacity=".3"/>
      <circle cx="9" cy="8.5" r=".9" fill={color}/>
      <path d="M4 8.5C4 5 7.5 3.5 12 3.5c3 0 5.5 1 6.5 3 .8 1.5.5 3.5-.5 5-1.2 1.8-2.5 2.5-4 3" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </g>
  );
}

// MySQL — Dolphin
function MyMark({ color }: { color: string }) {
  return (
    <g transform="translate(3,3) scale(0.78)">
      <path d="M7 12c-.5-2 0-5 2-7 1.5-1.2 4-1 5.5.5C15.5 4.5 17 4 18 5.5c1 1.5.8 4 .3 6" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M12.5 5.5c.5-2 1.5-3.5.5-4" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M7 12c-.8 2 0 5 2 5.5s5 1.5 7-1c1-2 1-3.5 0-4.5" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="10" cy="9" r="1" fill={color}/>
    </g>
  );
}

// SQLite — Diamond layers
function SQLiteMark({ color }: { color: string }) {
  return (
    <g transform="translate(6,4) scale(0.8)">
      <polygon points="8,0 16,6 8,16 0,6" fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round"/>
      <polygon points="8,0 16,6 8,10 0,6" fill={color} opacity=".6"/>
      <polygon points="8,8 12,10 8,14 4,10" fill={color} opacity=".3"/>
    </g>
  );
}

// ClickHouse — Bars
function ChMark({ color }: { color: string }) {
  return (
    <g transform="translate(5,5) scale(0.82)">
      <rect x="1" y="6" width="2.5" height="11" rx="1" fill={color} opacity=".85"/>
      <rect x="5.5" y="3" width="2.5" height="14" rx="1" fill={color} opacity=".85"/>
      <rect x="10" y="4" width="2.5" height="13" rx="1" fill={color} opacity=".7"/>
      <rect x="14.5" y="1" width="2.5" height="16" rx="1" fill={color}/>
    </g>
  );
}

// GaussDB — Red flower/petal
function GaussMark({ color }: { color: string }) {
  return (
    <g transform="translate(3,3) scale(0.78)">
      <path d="M12 2.5C13.5 4 17 8 17 12s-3.5 8-5 9.5" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round"/>
      <path d="M12 2.5C10.5 4 7 8 7 12s3.5 8 5 9.5" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round"/>
      <path d="M2.5 12C4 10.5 8 7 12 7s8 3.5 9.5 5" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round"/>
      <path d="M2.5 12C4 13.5 8 17 12 17s8-3.5 9.5-5" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round"/>
      <circle cx="12" cy="12" r="1.8" fill={color}/>
    </g>
  );
}

// Oracle — "O" letterform
function OracleMark({ color }: { color: string }) {
  return (
    <text x="12" y="17" textAnchor="middle" fontSize="14" fontWeight="800" fill={color} fontFamily="system-ui, sans-serif">O</text>
  );
}

// SQL Server — Grid
function MssqlMark({ color }: { color: string }) {
  return (
    <g transform="translate(5,5) scale(0.82)">
      <rect x="1" y="1" width="7" height="7" rx="1" fill={color} opacity=".9"/>
      <rect x="10" y="1" width="7" height="7" rx="1" fill={color} opacity=".6"/>
      <rect x="1" y="10" width="7" height="7" rx="1" fill={color} opacity=".5"/>
      <rect x="10" y="10" width="7" height="7" rx="1" fill={color} opacity=".75"/>
    </g>
  );
}

// Kingbase — Shield
function KingMark({ color }: { color: string }) {
  return (
    <g transform="translate(5,3) scale(0.75)">
      <path d="M10 2L2 6v6c0 5.5 4 9 8 10 4-1 8-4.5 8-10V6L10 2z" fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round"/>
      <circle cx="10" cy="12" r="2.5" fill={color}/>
    </g>
  );
}

// OceanBase — Wave + droplet
function ObMark({ color }: { color: string }) {
  return (
    <g transform="translate(3,4) scale(0.82)">
      <path d="M2 13c2-3.5 5-5.5 8.5-5.5s6.5 2.5 8.5 5.5" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round"/>
      <path d="M4 16c1.5-2 3.5-3 6-3s5 1.5 6.5 3" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" opacity=".6"/>
      <circle cx="17.5" cy="6" r="2.2" fill={color}/>
    </g>
  );
}

// TiDB — Lightning bolt
function TiDBMark({ color }: { color: string }) {
  return (
    <g transform="translate(6,3) scale(0.7)">
      <path d="M12 2L5 14h4.5L7 22l10-12h-5.5L14 2z" fill="none" stroke={color} strokeWidth="2.2" strokeLinejoin="round"/>
    </g>
  );
}

// DaMeng — Diamond
function DmMark({ color }: { color: string }) {
  return (
    <g transform="translate(4,3) scale(0.78)">
      <polygon points="10,0 20,10 10,20 0,10" fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round"/>
      <circle cx="10" cy="10" r="2.2" fill={color}/>
    </g>
  );
}

// GBase — Hexagon G
function GbMark({ color }: { color: string }) {
  return (
    <g transform="translate(3,3) scale(0.78)">
      <path d="M12 1l9.5 5.5v11L12 23l-9.5-5.5v-11L12 1z" fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round"/>
      <text x="12" y="15.5" textAnchor="middle" fontSize="10" fontWeight="800" fill={color} fontFamily="system-ui, sans-serif">G</text>
    </g>
  );
}

// Default — Database cylinder
function DefaultMark({ color }: { color: string }) {
  return (
    <g transform="translate(5,4) scale(0.8)">
      <ellipse cx="9" cy="3" rx="7" ry="2.5" fill="none" stroke={color} strokeWidth="1.8"/>
      <path d="M2 3v14c0 1.5 3 2.5 7 2.5s7-1 7-2.5V3" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round"/>
      <path d="M2 10c0 1.5 3 2.5 7 2.5s7-1 7-2.5" fill="none" stroke={color} strokeWidth="1.5" opacity=".5"/>
    </g>
  );
}
