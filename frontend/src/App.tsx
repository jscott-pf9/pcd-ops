import { useEffect, useState } from "react";
import {
  AlertTriangle,
  BarChart2,
  Briefcase,
  Camera,
  ChevronDown,
  Code2,
  FileText,
  type LucideIcon,
  Layers,
  Network,
  RefreshCw,
  Server,
  Settings as SettingsIcon,
  Sliders,
} from "lucide-react";
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import Anomaly from "./pages/Anomaly";
import Capacity from "./pages/Capacity";
import CapacityPlans from "./pages/CapacityPlans";
import Inventory from "./pages/Inventory";
import Logs from "./pages/Logs";
import Reclamation from "./pages/Reclamation";
import RightSizing from "./pages/RightSizing";
import Snapshots from "./pages/Snapshots";
import Generate from "./pages/Generate";
import Jobs from "./pages/Jobs";
import Topology from "./pages/Topology";
import SettingsAlerts from "./pages/settings/SettingsAlerts";
import SettingsConnection from "./pages/settings/SettingsConnection";
import SettingsAI from "./pages/settings/SettingsAI";
import SettingsUpdates from "./pages/settings/SettingsUpdates";

// ── Nav data types ─────────────────────────────────────────────────────────────

type NavChild = { path: string; label: string };
type NavLeaf  = {
  path:      string;
  label:     string;
  icon?:     LucideIcon;
  children?: NavChild[];
};
type NavSection = {
  id:    string;
  label: string;
  icon:  LucideIcon;
  items: NavLeaf[];
};

// ── Navigation sections ────────────────────────────────────────────────────────

const NAV_SECTIONS: NavSection[] = [
  {
    id: "infrastructure", label: "Infrastructure", icon: Server,
    items: [
      { path: "/",         label: "Inventory", icon: Server  },
      { path: "/topology", label: "Topology",  icon: Network },
    ],
  },
  {
    id: "operations", label: "Operations", icon: RefreshCw,
    items: [
      { path: "/reclamation", label: "Reclamation",     icon: RefreshCw },
      { path: "/capacity",    label: "Capacity Planning", icon: BarChart2,
        children: [{ path: "/capacity/plans", label: "What-If Plans" }] },
      { path: "/rightsizing", label: "Right-Sizing",    icon: Sliders   },
      { path: "/snapshots",   label: "Snapshots",       icon: Camera    },
      { path: "/jobs",        label: "Jobs",            icon: Briefcase },
    ],
  },
  {
    id: "insights", label: "AI Insights", icon: AlertTriangle,
    items: [
      { path: "/anomaly", label: "Anomaly", icon: AlertTriangle },
      { path: "/logs",    label: "Logs",    icon: FileText      },
    ],
  },
  {
    id: "tools", label: "Tools", icon: Code2,
    items: [
      { path: "/generate", label: "Generate", icon: Code2 },
    ],
  },
  {
    id: "settings", label: "Settings", icon: SettingsIcon,
    // No icons on settings children — renders as nav-child style
    items: [
      { path: "/settings/connection", label: "PCD & Metrics" },
      { path: "/settings/ai",         label: "AI Backend"    },
      { path: "/settings/alerts",     label: "Alerts"        },
      { path: "/settings/updates",    label: "Software"      },
    ],
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function isPathActive(path: string, pathname: string) {
  return path === "/" ? pathname === "/" : pathname.startsWith(path);
}

function sectionContainsActive(sec: NavSection, pathname: string) {
  return sec.items.some(item => isPathActive(item.path, pathname));
}

// ── Sidebar ────────────────────────────────────────────────────────────────────

function Sidebar() {
  const loc = useLocation();

  // Start with all sections containing the active path expanded
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const active = new Set<string>();
    for (const sec of NAV_SECTIONS) {
      if (sectionContainsActive(sec, loc.pathname)) active.add(sec.id);
    }
    return active;
  });

  // Expand section automatically when navigating into it
  useEffect(() => {
    setExpanded(prev => {
      const next = new Set(prev);
      for (const sec of NAV_SECTIONS) {
        if (sectionContainsActive(sec, loc.pathname)) next.add(sec.id);
      }
      return next;
    });
  }, [loc.pathname]);

  const toggle = (id: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <nav className="sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-mark"><Layers size={16} /></div>
        <div className="brand-stack">
          <span className="brand-name">PCD Ops</span>
          <span className="brand-sub">Platform9</span>
        </div>
      </div>

      <div className="sidebar-scroll">
        {NAV_SECTIONS.map(sec => {
          const isOpen    = expanded.has(sec.id);
          const hasActive = sectionContainsActive(sec, loc.pathname);

          return (
            <div key={sec.id} className="nav-group">
              {/* Section toggle button */}
              <button
                className={`nav-section-btn${hasActive ? " has-active" : ""}`}
                onClick={() => toggle(sec.id)}
              >
                <span className="nav-ico"><sec.icon size={14} /></span>
                <span>{sec.label}</span>
                <ChevronDown size={12} className={`chevron${isOpen ? " open" : ""}`} />
              </button>

              {/* Expanded items */}
              {isOpen && (
                <div className="nav-children">
                  {sec.items.map(item => {
                    const itemActive = isPathActive(item.path, loc.pathname);

                    // Settings-style: no icon → plain nav-child link
                    if (!item.icon) {
                      return (
                        <Link
                          key={item.path}
                          to={item.path}
                          className={`nav-child${itemActive ? " active" : ""}`}
                        >
                          {item.label}
                        </Link>
                      );
                    }

                    // Regular item with icon
                    return (
                      <div key={item.path}>
                        <Link
                          to={item.path}
                          className={`nav-item${itemActive ? " active" : ""}`}
                        >
                          <span className="nav-ico"><item.icon size={14} /></span>
                          <span>{item.label}</span>
                        </Link>
                        {/* Sub-children (e.g. What-If Plans under Capacity) */}
                        {item.children && itemActive && item.children.map(child => (
                          <Link
                            key={child.path}
                            to={child.path}
                            className={`nav-child${loc.pathname === child.path ? " active" : ""}`}
                            style={{ marginLeft: 26 }}
                          >
                            {child.label}
                          </Link>
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
}

// ── Shell ──────────────────────────────────────────────────────────────────────

function Shell() {
  const loc = useLocation();

  const crumb = (() => {
    for (const sec of NAV_SECTIONS) {
      for (const item of sec.items) {
        // Check sub-children first
        if (item.children) {
          const child = item.children.find(c => c.path === loc.pathname);
          if (child) return `${item.label} / ${child.label}`;
        }
        // Check item itself
        if (isPathActive(item.path, loc.pathname)) return item.label;
      }
    }
    return "PCD Ops";
  })();

  return (
    <div className="shell">
      <header className="topbar">
        <div className="crumbs">
          <span>PCD Ops</span>
          <span className="sep">/</span>
          <span className="here">{crumb}</span>
        </div>
        <div className="topbar-spacer" />
      </header>
      <main className="page">
        <Routes>
          <Route path="/"                  element={<Inventory />}       />
          <Route path="/topology"          element={<Topology />}        />
          <Route path="/reclamation"       element={<Reclamation />}     />
          <Route path="/capacity"          element={<Capacity />}        />
          <Route path="/capacity/plans"    element={<CapacityPlans />}   />
          <Route path="/rightsizing"       element={<RightSizing />}     />
          <Route path="/snapshots"         element={<Snapshots />}       />
          <Route path="/jobs"              element={<Jobs />}            />
          <Route path="/anomaly"           element={<Anomaly />}         />
          <Route path="/logs"              element={<Logs />}            />
          <Route path="/generate"          element={<Generate />}        />
          <Route path="/settings"          element={<Navigate to="/settings/connection" replace />} />
          <Route path="/settings/connection" element={<SettingsConnection />} />
          <Route path="/settings/ai"       element={<SettingsAI />}         />
          <Route path="/settings/alerts"   element={<SettingsAlerts />}     />
          <Route path="/settings/updates"  element={<SettingsUpdates />}    />
        </Routes>
      </main>
    </div>
  );
}

// ── App ────────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <BrowserRouter>
      <div className="app">
        <Sidebar />
        <Shell />
      </div>
    </BrowserRouter>
  );
}
