/**
 * Heatpump Card — a custom Lovelace card for Home Assistant
 * Animated schematic of an air-to-water heat pump with DHW tank and floor heating.
 *
 * No build step, no dependencies. Drop into /config/www/ and add as a resource.
 */

const VERSION = "3.2.0";

const I18N = {
  nl: {
    title: "Warmtepomp",
    modes: { dhw: "Warmwater", heating: "Verwarmen", cooling: "Koelen", defrost: "Ontdooien", idle: "Stand-by", off: "Uit" },
    outside: "Buiten",
    supply: "Aanvoer",
    return: "Retour",
    elec: "Elektrisch",
    heat: "Warmte",
    cool: "Koeling",
    cop: "COP",
    flow: "Debiet",
    pressure: "Druk",
    delta: "ΔT",
    tank: "Boiler",
    set: "Doel",
    floor: "Vloer",
    room: "Kamer",
    booster: "Booster",
    unit: "Warmtepomp",
    defrost: "Ontdooien",
    dhw_demand: "WW-vraag",
    history: "Afgelopen {h} uur",
    power: "Vermogen",
  },
  en: {
    title: "Heat pump",
    modes: { dhw: "Hot water", heating: "Heating", cooling: "Cooling", defrost: "Defrosting", idle: "Standby", off: "Off" },
    outside: "Outside",
    supply: "Supply",
    return: "Return",
    elec: "Electric",
    heat: "Heat",
    cool: "Cooling",
    cop: "COP",
    flow: "Flow",
    pressure: "Pressure",
    delta: "ΔT",
    tank: "Tank",
    set: "Target",
    floor: "Floor",
    room: "Room",
    booster: "Booster",
    unit: "Heat pump",
    defrost: "Defrost",
    dhw_demand: "DHW demand",
    history: "Last {h} hours",
    power: "Power",
  },
};

const DEFAULT_STATUS_MAP = {
  warmwater: "dhw", "warm water": "dhw", dhw: "dhw", "hot water": "dhw", tapwater: "dhw", sanitary: "dhw",
  verwarmen: "heating", heating: "heating", heat: "heating", verwarming: "heating", cv: "heating",
  koelen: "cooling", cooling: "cooling", cool: "cooling",
  defrost: "defrost", ontdooien: "defrost", defrosting: "defrost",
  uit: "off", off: "off",
  idle: "idle", standby: "idle", "stand-by": "idle", rust: "idle",
};

const MODE_COLORS = {
  dhw: "#f2546b",
  heating: "#ff8a3d",
  cooling: "#3fb6ff",
  defrost: "#6fd6e8",
  idle: "#8e99ab",
  off: "#6b7280",
};

const MODE_ICONS = {
  dhw: "mdi:water-boiler",
  heating: "mdi:heating-coil",
  cooling: "mdi:snowflake",
  defrost: "mdi:snowflake-melt",
  idle: "mdi:sleep",
  off: "mdi:power",
};

const HISTORY_COLORS = ["#ff8a3d", "#4c9dff", "#ff5c7a", "#3ddc84", "#a78bfa"];

/** Temperature → color (cold blue → amber → hot red). */
function tempColor(t) {
  if (!isFinite(t)) return "#8e99ab";
  const stops = [
    [5, [76, 157, 255]],
    [22, [72, 199, 214]],
    [32, [255, 191, 71]],
    [45, [255, 122, 61]],
    [60, [236, 64, 91]],
  ];
  if (t <= stops[0][0]) return rgb(stops[0][1]);
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const k = (t - t0) / (t1 - t0);
      return rgb(c0.map((v, j) => Math.round(v + (c1[j] - v) * k)));
    }
  }
  return rgb(stops[stops.length - 1][1]);
}
const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

class HeatpumpCard extends HTMLElement {
  static getStubConfig() {
    return { title: "Warmtepomp", entities: {} };
  }

  static getConfigElement() {
    return document.createElement("heatpump-card-editor");
  }

  setConfig(config) {
    if (!config) throw new Error("heatpump-card: invalid configuration");
    config = { ...config, entities: { ...(config.entities || {}) } };
    this._config = {
      min_power: 50,
      show_history: true,
      hours: 24,
      ...config,
      status_map: { ...DEFAULT_STATUS_MAP, ...(config.status_map || {}) },
    };
    this._built = false;
    this._historyFetched = 0;
    if (this.isConnected) this._build();
  }

  connectedCallback() {
    if (this._config && !this._built) this._build();
    if (this._hass) this._update();
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    this._timer = null;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._build();
    this._update();
    const now = Date.now();
    if (this._config.show_history && now - this._historyFetched > 5 * 60 * 1000) {
      this._historyFetched = now;
      this._fetchHistory();
    }
  }

  getCardSize() {
    return this._config && this._config.show_history ? 9 : 7;
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6, rows: "auto" };
  }

  /* ---------------- helpers ---------------- */

  get _t() {
    const lang = (this._config.language || this._hass?.locale?.language || this._hass?.language || "nl").slice(0, 2);
    return I18N[lang] || I18N.en;
  }

  _entity(key) {
    const id = this._config.entities[key];
    return id && this._hass ? this._hass.states[id] : undefined;
  }

  _num(key) {
    const s = this._entity(key);
    if (!s) return NaN;
    const domain = s.entity_id.split(".")[0];
    if (key === "dhw_target" && (domain === "water_heater" || domain === "climate")) {
      return parseFloat(s.attributes.temperature);
    }
    return parseFloat(s.state);
  }

  /** Returns power in kW regardless of the sensor unit. */
  _kw(key) {
    const s = this._entity(key);
    const v = this._num(key);
    if (!s || !isFinite(v)) return NaN;
    const u = (s.attributes.unit_of_measurement || "").toLowerCase();
    if (u === "w") return v / 1000;
    if (u === "mw") return v * 1000;
    return v;
  }

  _on(key) {
    const s = this._entity(key);
    if (!s) return false;
    const st = String(s.state).toLowerCase();
    if (["on", "true", "aan", "active", "1", "yes", "heat", "heating"].includes(st)) return true;
    const n = parseFloat(st);
    return isFinite(n) && n > 0;
  }

  _fmt(v, digits = 1) {
    if (!isFinite(v)) return "–";
    const loc = this._hass?.locale?.language || this._hass?.language || "nl";
    return v.toLocaleString(loc, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  _mode() {
    const map = this._config.status_map;
    const s = this._entity("status");
    if (s) {
      const key = String(s.state).toLowerCase().trim();
      if (map[key]) return map[key];
    }
    if (this._on("defrost")) return "defrost";
    const pin = this._kw("power_in");
    const running = isFinite(pin) ? pin * 1000 > this._config.min_power : this._num("flow_rate") > 0.5;
    if (this._on("dhw_demand") && running) return "dhw";
    if (running) return "heating";
    return "idle";
  }

  _moreInfo(entityId) {
    if (!entityId) return;
    const ev = new Event("hass-more-info", { bubbles: true, composed: true });
    ev.detail = { entityId };
    this.dispatchEvent(ev);
  }

  /* ---------------- build ---------------- */

  _build() {
    if (!this._config) return;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const t = this._t;
    const e = this._config.entities;
    const title = this._config.title ?? t.title;

    /* ---- isometric helpers ---- */
    const U = 20, CX = 0.866, SY = 0.5, OX = 240, OY = 165;
    const P = (x, y, z = 0) => [+(OX + (x - y) * CX * U).toFixed(1), +(OY + (x + y) * SY * U - z * U).toFixed(1)];
    const pts = (a) => a.map((p) => P(...p).join(",")).join(" ");
    const poly = (cls, a, extra = "") => `<polygon class="${cls}" points="${pts(a)}" ${extra}/>`;
    const path = (a) => "M" + a.map((p) => P(...p).join(",")).join(" L");
    const box = (x, y, z, w, d, h, cls) =>
      poly(`${cls} f-right`, [[x + w, y, z], [x + w, y + d, z], [x + w, y + d, z + h], [x + w, y, z + h]]) +
      poly(`${cls} f-left`, [[x, y + d, z], [x + w, y + d, z], [x + w, y + d, z + h], [x, y + d, z + h]]) +
      poly(`${cls} f-top`, [[x, y, z + h], [x + w, y, z + h], [x + w, y + d, z + h], [x, y + d, z + h]]);
    const wire = (ref, color, a, cls = "") => {
      const d = path(a);
      return `<g class="wire ${cls}" data-ref="${ref}" style="--c:${color}">
        <path class="base" d="${d}"/><path class="glow" d="${d}"/><path class="core" d="${d}"/><path class="dash" d="${d}"/></g>`;
    };
    const node = (p, color, ref = "") => {
      const [x, y] = P(...p);
      return `<g class="node" ${ref ? `data-ref="${ref}"` : ""} style="--c:${color}"><circle cx="${x}" cy="${y}" r="7" class="halo"/><circle cx="${x}" cy="${y}" r="4.2" class="pt"/></g>`;
    };
    /** Floating label with dotted leader. dir -1 = label above, 1 = below. */
    const label = (p, len, dir, ttl, ref, unit, entity, extraRef) => {
      const [x, y] = P(...p);
      const y2 = y + dir * len;
      const ty = dir < 0 ? y2 - 22 : y2 + 13;
      const vy = dir < 0 ? y2 - 5 : y2 + 31;
      return `<g class="lab" data-entity="${entity || ""}">
        <line x1="${x}" y1="${y}" x2="${x}" y2="${y2}" class="leader"/><circle cx="${x}" cy="${y}" r="1.8" class="leader-dot"/>
        <text x="${x}" y="${ty}" text-anchor="middle" class="lt"><tspan data-ref="${ref}T">${ttl}</tspan>${extraRef ? ` <tspan class="lx" data-ref="${extraRef}"></tspan>` : ""}</text>
        <text x="${x}" y="${vy}" text-anchor="middle" class="lv"><tspan data-ref="${ref}">–</tspan><tspan class="lu" dx="${unit === "°" ? 0 : 2}">${unit}</tspan></text>
      </g>`;
    };

    /* ---- geometry ---- */
    const H = 5, T = 0.35;
    const rowsY = [3.4, 4.35, 5.3, 6.25, 7.2];
    const loop = [[5.6, 1.9], [5.6, 2.6], [2.0, 2.6]];
    rowsY.forEach((y, i) => {
      const [from, to] = i % 2 === 0 ? [2.0, 9.4] : [9.4, 2.0];
      loop.push([from, y], [to, y]);
    });
    const tank = { x: 8.3, y: 1.9, r: 1.15, h: 3.9 };
    const [tcx, tby] = P(tank.x, tank.y, 0);
    const tty = tby - tank.h * U;
    const trx = +(tank.r * U * 1.2247).toFixed(1), tryy = +(tank.r * U * 0.7071).toFixed(1);
    const [hubx, huby] = P(5.6, 1.9);
    const [ox, oy] = P(0.5, 10.8, 2.3); // outdoor unit fan face origin
    const [hx, hy] = P(1.6, 1.1, 4.8); // indoor unit front face origin
    const SKEW = `matrix(${CX},${SY},0,1,`;

    this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <ha-card>
        <div class="panel head">
          <div class="clickable" data-entity="${e.status || ""}">
            <div class="sub">${title}</div>
            <div class="big"><span class="dot" data-ref="dot"></span><span data-ref="hMode">–</span></div>
          </div>
          <div class="hstats">
            <div data-entity="${e.outside_temp || ""}"><div class="sub">${t.outside}</div><div class="hv"><span data-ref="hOut">–</span><small>°C</small></div></div>
            <div data-entity="${e.cop || ""}"><div class="sub">${t.cop}</div><div class="hv"><span data-ref="hCop">–</span></div></div>
          </div>
        </div>

        <div class="scene">
          <svg viewBox="0 30 460 342" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <radialGradient id="groundG"><stop offset="0%" stop-color="#c9d2e1" stop-opacity=".55"/><stop offset="100%" stop-color="#c9d2e1" stop-opacity="0"/></radialGradient>
              <radialGradient id="warmG"><stop offset="0%" data-ref="warmS0" stop-color="#ff9a4d" stop-opacity=".4"/><stop offset="100%" data-ref="warmS1" stop-color="#ff9a4d" stop-opacity="0"/></radialGradient>
              <linearGradient id="wallA" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#e9edf5"/></linearGradient>
              <linearGradient id="wallB" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#e6ebf3"/><stop offset="100%" stop-color="#d6dce8"/></linearGradient>
              <linearGradient id="tankGrad" x1="0" y1="1" x2="0" y2="0">
                <stop offset="0%" data-ref="tankStop0" stop-color="#4c9dff"/>
                <stop offset="55%" data-ref="tankStop1" stop-color="#ffbf47"/>
                <stop offset="100%" data-ref="tankStop2" stop-color="#f2546b"/>
              </linearGradient>
              <linearGradient id="cyl" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stop-color="#000" stop-opacity=".22"/><stop offset="28%" stop-color="#fff" stop-opacity=".35"/>
                <stop offset="55%" stop-color="#000" stop-opacity=".02"/><stop offset="100%" stop-color="#000" stop-opacity=".3"/>
              </linearGradient>
              <filter id="blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3.2"/></filter>
              <filter id="blurBig" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="9"/></filter>
            </defs>

            <!-- ground -->
            <ellipse cx="235" cy="275" rx="250" ry="120" fill="url(#groundG)"/>

            <!-- room: floor + back walls -->
            ${poly("floor", [[0, 0], [10, 0], [10, 8], [0, 8]])}
            <g class="warm" data-ref="warm"><ellipse cx="${P(5.7, 5.4)[0]}" cy="${P(5.7, 5.4)[1]}" rx="120" ry="62" fill="url(#warmG)"/></g>
            ${poly("wall-b", [[0, 0, 0], [0, 8, 0], [0, 8, H], [0, 0, H]])}
            ${poly("wall-a", [[0, 0, 0], [10, 0, 0], [10, 0, H], [0, 0, H]])}
            ${poly("wall-top", [[-T, -T, H], [10, -T, H], [10, 0, H], [0, 0, H]])}
            ${poly("wall-top", [[-T, -T, H], [0, 0, H], [0, 8, H], [-T, 8, H]])}
            ${poly("wall-cap", [[10, -T, 0], [10, 0, 0], [10, 0, H], [10, -T, H]])}
            ${poly("wall-cap l", [[-T, 8, 0], [0, 8, 0], [0, 8, H], [-T, 8, H]])}
            <!-- window -->
            ${poly("win-frame", [[0, 1.4, 1.9], [0, 3.8, 1.9], [0, 3.8, 4.1], [0, 1.4, 4.1]])}
            ${poly("win-glass", [[0, 1.52, 2.02], [0, 2.54, 2.02], [0, 2.54, 3.98], [0, 1.52, 3.98]])}
            ${poly("win-glass", [[0, 2.66, 2.02], [0, 3.68, 2.02], [0, 3.68, 3.98], [0, 2.66, 3.98]])}

            <!-- electricity to outdoor unit -->
            ${wire("wElec", "#ff5fd2", [[2, 13.6], [2, 10.9]])}

            <!-- outdoor ↔ indoor unit (refrigerant / primary circuit) -->
            ${wire("wRefB", "#a78bfa", [[1.8, 0.05, 1.6], [1.8, 0.05, 0], [0.6, 0.05, 0], [0.6, 9.6, 0]], "thin")}
            ${wire("wRefA", "#a78bfa", [[1.1, 9.6, 0], [1.1, 0.4, 0], [2.2, 0.4, 0], [2.2, 0.05, 0], [2.2, 0.05, 1.6]], "thin")}

            <!-- return water: floor (around the tank, along the wall) / tank → indoor unit -->
            ${wire("wRetFloor", "var(--c-ret)", [[9.9, 1.2], [9.9, 0.4], [7.49, 0.4]])}
            ${wire("wRetTank", "var(--c-ret)", [[7.49, 1.1], [7.49, 0.4]])}
            ${wire("wRetCom", "var(--c-ret)", [[7.49, 0.4], [3.6, 0.4], [3.6, 0.05, 0], [3.6, 0.05, 1.6]])}

            <!-- supply water: indoor unit → valve → tank / floor loop -->
            ${wire("wFloor", "var(--c-floor)", loop, "thin")}
            ${wire("wHub", "var(--c-sup)", [[2.9, 0.05, 1.6], [2.9, 0.05, 0], [2.9, 1.9, 0], [5.6, 1.9, 0]])}
            ${wire("wTank", "var(--c-sup)", [[5.6, 1.9], [7.15, 1.9]])}

            <!-- hub (3-way valve) -->
            <g class="hub" data-ref="hub">
              <ellipse cx="${hubx}" cy="${huby}" rx="15" ry="8.7" class="hub-ring r3"/>
              <ellipse cx="${hubx}" cy="${huby}" rx="10.5" ry="6.1" class="hub-ring r2"/>
              <ellipse cx="${hubx}" cy="${huby}" rx="6.5" ry="3.8" class="hub-core"/>
              <path class="hub-arrow" data-ref="hubArrow" d=""/>
            </g>

            <!-- indoor unit -->
            <g class="clickable" data-entity="${e.status || ""}">
              ${box(1.6, 0, 1.6, 2.4, 1.1, 3.2, "unit")}
              <g transform="${SKEW}${hx},${hy})">
                <rect x="5" y="6" width="38" height="20" rx="3" class="screen"/>
                <text x="24" y="19.5" text-anchor="middle" class="screen-val" data-ref="screenVal">–</text>
                <g class="booster" data-ref="booster">
                  <path d="M9,37 l3,-4 l4,8 l4,-8 l4,8 l4,-8 l4,8 l4,-8 l3,4" class="booster-coil"/>
                </g>
                <circle cx="24" cy="52" r="7.5" class="pump"/>
                <g class="impeller" data-ref="impeller">
                  <circle cx="24" cy="52" r="6" fill="none"/>
                  <path d="M24,52 L24,46.5 M24,52 L28.8,54.8 M24,52 L19.2,54.8" class="impeller-blade"/>
                </g>
                <circle cx="8" cy="31" r="1.4" class="led" data-ref="led"/>
              </g>
            </g>

            <!-- DHW tank -->
            <g class="clickable" data-entity="${e.dhw_target || e.dhw_temp || ""}">
              <ellipse cx="${tcx}" cy="${tby + 3}" rx="${trx + 6}" ry="${tryy + 4}" class="shadow"/>
              <g class="tank-glow" data-ref="tankGlow"><ellipse cx="${tcx}" cy="${(tby + tty) / 2}" rx="${trx + 8}" ry="${(tby - tty) / 2 + 10}" fill="url(#tankGrad)" filter="url(#blurBig)"/></g>
              <path class="tank-body" d="M${tcx - trx},${tty} V${tby} A${trx},${tryy} 0 0 0 ${tcx + trx},${tby} V${tty} Z"/>
              <path d="M${tcx - trx},${tty} V${tby} A${trx},${tryy} 0 0 0 ${tcx + trx},${tby} V${tty} Z" fill="url(#tankGrad)" opacity=".9"/>
              <path d="M${tcx - trx},${tty} V${tby} A${trx},${tryy} 0 0 0 ${tcx + trx},${tby} V${tty} Z" fill="url(#cyl)"/>
              <ellipse cx="${tcx}" cy="${tty}" rx="${trx}" ry="${tryy}" class="tank-top"/>
              <ellipse cx="${tcx}" cy="${tty}" rx="${trx * 0.35}" ry="${tryy * 0.35}" class="tank-cap"/>
              <g data-ref="tankHeat" class="tank-heat">
                <path d="M${tcx - 8},${tty - 8} q-4,-6 0,-12 M${tcx},${tty - 8} q-4,-6 0,-12 M${tcx + 8},${tty - 8} q-4,-6 0,-12"/>
              </g>
            </g>

            ${wire("wRetFloorF", "var(--c-ret)", [[9.4, 7.2], [9.9, 7.2], [9.9, 1.2]])}

            <!-- nodes -->
            ${node([2.0, 3.4], "var(--c-floor)", "nFloor")}
            ${node([7.49, 1.1], "var(--c-ret)", "nTankRet")}
            ${node([7.15, 1.9], "var(--c-sup)", "nTank")}
            ${node([2, 13.6], "#ff5fd2", "nElec")}

            <!-- outdoor unit -->
            <g class="clickable" data-entity="${e.power_in || ""}">
              <ellipse cx="${P(2.2, 10.6)[0]}" cy="${P(2.2, 10.6)[1] + 4}" rx="44" ry="20" class="shadow"/>
              ${box(0.5, 9.6, 0, 3, 1.2, 2.3, "unit")}
              <g transform="${SKEW}${ox},${oy})">
                <circle cx="22" cy="23" r="17.5" class="fan-housing"/>
                <g class="fan" data-ref="fan">
                  <circle cx="22" cy="23" r="16" fill="none"/>
                  <path class="blade" d="M22,23 C17,13 20,6.5 26,6.5 C29,12 27,19 22,23Z"/>
                  <path class="blade" d="M22,23 C17,13 20,6.5 26,6.5 C29,12 27,19 22,23Z" transform="rotate(120 22 23)"/>
                  <path class="blade" d="M22,23 C17,13 20,6.5 26,6.5 C29,12 27,19 22,23Z" transform="rotate(240 22 23)"/>
                </g>
                <circle cx="22" cy="23" r="3" class="fan-hub"/>
                <g class="grille">${[9, 14, 19, 24, 29, 34].map((y) => `<line x1="45" x2="55" y1="${y}" y2="${y}"/>`).join("")}</g>
                <g class="frost" data-ref="frost">
                  <circle cx="22" cy="23" r="17.5" class="frost-ring"/>
                  <text x="22" y="29" text-anchor="middle" class="frost-ico">❄</text>
                </g>
              </g>
            </g>
            ${node([2, 10.95], "#ff5fd2", "nElec2")}

            <!-- labels -->
            ${label([2, 10.2, 2.3], 20, -1, t.unit, "lElec", "kW", e.power_in)}
            ${(() => {
              const [x, y] = P(2.8, 0.55, 4.8);
              return `<line x1="${x}" y1="${y}" x2="${x}" y2="${y - 22}" class="leader"/><circle cx="${x}" cy="${y}" r="1.8" class="leader-dot"/>
              <g class="lab" data-entity="${e.flow_temp || ""}">
                <circle cx="${x - 59}" cy="${y - 49}" r="3" style="fill:var(--c-sup)"/>
                <text x="${x - 7}" y="${y - 45}" text-anchor="end" class="lt">${t.supply}</text>
                <text x="${x - 7}" y="${y - 27}" text-anchor="end" class="lv"><tspan data-ref="lSup">–</tspan><tspan class="lu">°</tspan></text>
              </g>
              <g class="lab" data-entity="${e.return_temp || ""}">
                <circle cx="${x + 10}" cy="${y - 49}" r="3" style="fill:var(--c-ret)"/>
                <text x="${x + 17}" y="${y - 45}" class="lt">${t.return}</text>
                <text x="${x + 7}" y="${y - 27}" class="lv"><tspan data-ref="lRet">–</tspan><tspan class="lu">°</tspan></text>
              </g>`;
            })()}
            ${label([tank.x, tank.y, tank.h + 0.3], 16, -1, t.tank, "lTank", "°", e.dhw_target || e.dhw_temp, "lTankSet")}
            ${label([6.2, 7.2, 0], 18, 1, t.floor, "lFloor", "°", e.floor_temp || e.room_temp, "lRoom")}
          </svg>
        </div>

        <div class="badges" data-ref="badges"></div>

        <div class="tiles">
          ${this._tile("elec", "#ff5fd2", t.elec, e.power_in)}
          ${this._tile("heat", "#ff8a3d", t.heat, e.power_out)}
          ${this._tile("cop", "#3ddc84", t.cop, e.cop || e.power_out)}
          ${this._tile("delta", "#ffc857", t.delta, e.flow_temp)}
          ${this._tile("flow", "#4cc9f0", t.flow, e.flow_rate)}
          ${this._tile("pressure", "#7c8aa5", t.pressure, e.pressure)}
        </div>

        ${
          this._config.show_history
            ? `<div class="panel history">
                <div class="sub">${t.history.replace("{h}", this._config.hours)}</div>
                <svg viewBox="0 0 400 120" preserveAspectRatio="none" class="chart" data-ref="chart"></svg>
                <div class="axis" data-ref="axis"></div>
                <div class="legend" data-ref="legend"></div>
              </div>`
            : ""
        }
      </ha-card>
    `;

    this._hub = { x: hubx, y: huby };
    this._refs = {};
    this.shadowRoot.querySelectorAll("[data-ref]").forEach((el) => (this._refs[el.dataset.ref] = el));
    this.shadowRoot.querySelectorAll("[data-entity]").forEach((el) => {
      if (!el.dataset.entity) return;
      el.classList.add("clickable");
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this._moreInfo(el.dataset.entity);
      });
    });
    this._built = true;
  }

  _tile(key, color, label, entity) {
    return `
      <div class="panel tile" data-tile="${key}" data-entity="${entity || ""}" style="--c:${color}">
        <div class="tile-top"><i></i><span data-ref="l_${key}">${label}</span></div>
        <div class="tile-val"><span data-ref="v_${key}">–</span><small data-ref="u_${key}"></small></div>
      </div>`;
  }

  /* ---------------- update ---------------- */

  _update() {
    if (!this._built || !this._hass || !this._refs) return;
    const r = this._refs;
    const t = this._t;
    const mode = this._mode();
    const color = MODE_COLORS[mode] || MODE_COLORS.idle;

    const tOut = this._num("outside_temp");
    const tSup = this._num("flow_temp");
    const tRet = this._num("return_temp");
    const tDhw = this._num("dhw_temp");
    const tSet = this._num("dhw_target");
    const flow = this._num("flow_rate");
    const press = this._num("pressure");
    const pin = this._kw("power_in");
    let pout = this._kw("power_out");
    let cop = this._num("cop");
    const booster = this._kw("booster");
    const defrost = mode === "defrost" || this._on("defrost");

    // Derive thermal power from flow & ΔT if no sensor is given.
    if (!isFinite(pout) && isFinite(flow) && isFinite(tSup) && isFinite(tRet)) {
      pout = Math.max(0, (flow / 60) * 4.186 * (mode === "cooling" ? tRet - tSup : tSup - tRet));
    }
    if (mode === "cooling" && isFinite(pout)) pout = Math.abs(pout);
    if (!isFinite(cop) && isFinite(pin) && isFinite(pout) && pin > 0.05) cop = pout / pin;

    const running = isFinite(pin) ? pin * 1000 > this._config.min_power : !["idle", "off"].includes(mode);
    const flowing = isFinite(flow) ? flow > 0.5 : running;
    const toTank = mode === "dhw";
    const cooling = mode === "cooling";
    // A COP sensor is shown as-is (e.g. a daily COP); a calculated COP only while the compressor runs.
    const copOk = this._config.entities.cop ? isFinite(cop) : isFinite(cop) && cop > 0 && running && !defrost;

    this.style.setProperty("--hp-accent", color);
    this.style.setProperty("--hp-hot", tempColor(tSup));
    this.style.setProperty("--hp-cold", tempColor(tRet));
    this.style.setProperty("--hp-mix", tempColor((tSup + tRet) / 2));
    const dur = isFinite(flow) && flow > 0 ? clamp(24 / flow, 0.5, 3) : 1.4;
    this.style.setProperty("--hp-flow-dur", `${dur}s`);
    const fanDur = isFinite(pin) && pin > 0 ? clamp(1.6 / (pin + 0.2), 0.35, 2.5) : 1.2;
    this.style.setProperty("--hp-fan-dur", `${fanDur}s`);

    // header
    const statusEnt = this._entity("status");
    r.hMode.textContent = t.modes[mode] || (statusEnt ? statusEnt.state : mode);
    r.dot.classList.toggle("live", running || flowing);
    r.hOut.textContent = this._fmt(tOut);
    r.hCop.textContent = copOk ? this._fmt(cop, 1) : "–";

    // circuit colours: in cooling the supply is the cold side
    this.style.setProperty("--c-sup", cooling ? "#4cc9f0" : toTank ? "#ff5c7a" : "#ff8a3d");
    this.style.setProperty("--c-ret", cooling ? "#ffc857" : "#4c9dff");
    this.style.setProperty("--c-floor", cooling ? "#2fb4e6" : "#f5a524");
    const glowC = cooling ? "#4cc9f0" : "#ff9a4d";
    r.warmS0.setAttribute("stop-color", glowC);
    r.warmS1.setAttribute("stop-color", glowC);

    // flows
    const on = (el, v) => el && el.classList.toggle("on", !!v);
    on(r.wElec, running);
    on(r.nElec, running);
    on(r.nElec2, running);
    on(r.wRefA, running);
    on(r.wRefB, running);
    on(r.wHub, flowing);
    on(r.wRetCom, flowing);
    on(r.wRetTank, flowing && toTank);
    on(r.nTankRet, flowing && toTank);
    on(r.wRetFloor, flowing && !toTank);
    on(r.wRetFloorF, flowing && !toTank);
    on(r.wTank, flowing && toTank);
    on(r.nTank, flowing && toTank);
    on(r.wFloor, flowing && !toTank);
    on(r.nFloor, flowing && !toTank);
    on(r.warm, flowing && !toTank && (cooling || tSup > 24));
    on(r.hub, flowing);
    r.fan.classList.toggle("spin", running && !defrost);
    r.fan.classList.toggle("reverse", defrost);
    on(r.frost, defrost);
    r.impeller.classList.toggle("spin", flowing);
    r.led.style.fill = running ? color : "";
    on(r.booster, isFinite(booster) && booster > 0.01);
    const { x: hx, y: hy } = this._hub;
    // pointer on the hub: toward the tank (+x) or toward the floor loop (+y)
    r.hubArrow.setAttribute(
      "d",
      toTank
        ? `M${hx + 5.6},${hy + 3.2} L${hx + 1.2},${hy - 1.3} L${hx - 1.2},${hy + 1.5} Z`
        : `M${hx - 5.6},${hy + 3.2} L${hx - 1.2},${hy - 1.3} L${hx + 1.2},${hy + 1.5} Z`
    );

    // indoor screen
    r.screenVal.textContent = isFinite(pout) && running ? `${this._fmt(pout, 1)} kW` : `${this._fmt(tSup)}°`;

    // tank
    const top = isFinite(tDhw) ? tDhw : 40;
    r.tankStop2.setAttribute("stop-color", tempColor(top));
    r.tankStop1.setAttribute("stop-color", tempColor(top - 6));
    r.tankStop0.setAttribute("stop-color", tempColor(top - 18));
    on(r.tankHeat, toTank && flowing);
    on(r.tankGlow, toTank && flowing);

    // labels
    r.lElec.textContent = this._fmt(pin, 2);
    r.lSup.textContent = this._fmt(tSup);
    r.lRet.textContent = this._fmt(tRet);
    r.lTank.textContent = this._fmt(tDhw);
    r.lTankSet.textContent = isFinite(tSet) ? `→ ${this._fmt(tSet, 0)}°` : "";
    const tFloor = this._num("floor_temp");
    const tRoom = this._num("room_temp");
    const floorLab = r.lFloor.closest(".lab");
    floorLab.style.display = this._config.entities.floor_temp || this._config.entities.room_temp ? "" : "none";
    const hasFloor = !!this._config.entities.floor_temp;
    r.lFloorT.textContent = hasFloor ? t.floor : t.room;
    r.lFloor.textContent = this._fmt(hasFloor ? tFloor : tRoom);
    r.lRoom.textContent = hasFloor && isFinite(tRoom) ? `${t.room} ${this._fmt(tRoom)}°` : "";

    // badges
    const badges = [];
    if (this._config.entities.dhw_demand) badges.push([t.dhw_demand, this._on("dhw_demand"), "#ff5c7a"]);
    if (this._config.entities.defrost) badges.push([t.defrost, this._on("defrost"), "#6fd6e8"]);
    if (this._config.entities.booster) badges.push([t.booster, isFinite(booster) && booster > 0.01, "#ff8a3d"]);
    const bKey = badges.map((b) => b[1]).join();
    if (bKey !== this._bKey) {
      this._bKey = bKey;
      r.badges.innerHTML = badges.map(([lbl, active, c]) => `<span class="badge ${active ? "active" : ""}" style="--c:${c}"><i></i>${lbl}</span>`).join("");
    }

    // tiles
    const setTile = (k, v, u, state = "") => {
      r[`v_${k}`].textContent = v;
      r[`u_${k}`].textContent = u;
      r[`v_${k}`].closest(".tile").dataset.state = state;
    };
    setTile("elec", this._fmt(pin, 2), "kW");
    setTile("heat", this._fmt(pout, 2), "kW");
    r.l_heat.textContent = cooling ? t.cool : t.heat;
    r.v_heat.closest(".tile").style.setProperty("--c", cooling ? "#4cc9f0" : "#ff8a3d");
    setTile("cop", copOk ? this._fmt(cop, 1) : "–", "");
    setTile("delta", this._fmt(tSup - tRet), "K");
    setTile("flow", this._fmt(flow), "L/min");
    setTile("pressure", this._fmt(press), "bar", isFinite(press) && (press < 1 || press > 2.8) ? "warn" : "");
  }

  async _fetchHistory() {
    if (!this._hass || !this._config.show_history) return;
    const e = this._config.entities;
    const series = (this._config.history_entities || ["flow_temp", "return_temp", "dhw_temp", "outside_temp"])
      .map((k) => ({ key: k, id: e[k] || (k.includes(".") ? k : undefined) }))
      .filter((s) => s.id);
    const powerId = e.power_in;
    const ids = [...new Set([...series.map((s) => s.id), powerId].filter(Boolean))];
    if (!ids.length) return;
    const start = new Date(Date.now() - this._config.hours * 3600 * 1000);
    try {
      const res = await this._hass.callWS({
        type: "history/history_during_period",
        start_time: start.toISOString(),
        entity_ids: ids,
        minimal_response: true,
        no_attributes: true,
        significant_changes_only: false,
      });
      this._renderHistory(res, series, powerId, start.getTime());
    } catch (err) {
      console.warn("heatpump-card: history fetch failed", err);
    }
  }

  _renderHistory(res, series, powerId, t0) {
    const r = this._refs;
    if (!r.chart) return;
    const t1 = Date.now();
    const W = 400, H = 120, PAD = 6;
    const toPts = (id) =>
      (res[id] || [])
        .map((p) => [((p.lu ?? p.last_updated) * (p.lu ? 1000 : 1)) || Date.parse(p.last_updated), parseFloat(p.s ?? p.state)])
        .filter(([ts, v]) => isFinite(ts) && isFinite(v));
    const x = (ts) => ((clamp(ts, t0, t1) - t0) / (t1 - t0)) * W;

    // temperature lines
    const lines = series.map((s, i) => ({ ...s, pts: toPts(s.id), color: HISTORY_COLORS[i % HISTORY_COLORS.length] }));
    const all = lines.flatMap((l) => l.pts.map((p) => p[1]));
    if (!all.length) return;
    let lo = Math.floor(Math.min(...all) / 5) * 5;
    let hi = Math.ceil(Math.max(...all) / 5) * 5;
    if (hi - lo < 10) hi = lo + 10;
    const y = (v) => H - PAD - ((v - lo) / (hi - lo)) * (H - 2 * PAD);

    const step = (pts, yf) => {
      if (!pts.length) return "";
      let d = `M${x(pts[0][0]).toFixed(1)},${yf(pts[0][1]).toFixed(1)}`;
      for (let i = 1; i < pts.length; i++) {
        d += ` L${x(pts[i][0]).toFixed(1)},${yf(pts[i][1]).toFixed(1)}`;
      }
      d += ` L${W},${yf(pts[pts.length - 1][1]).toFixed(1)}`;
      return d;
    };

    // power area (own scale, background)
    let area = "";
    if (powerId) {
      const pp = toPts(powerId);
      if (pp.length) {
        const pmax = Math.max(...pp.map((p) => p[1]), 1);
        const py = (v) => H - (v / pmax) * (H * 0.85);
        let d = `M0,${H}`;
        let prev = null;
        pp.forEach(([ts, v]) => {
          const xx = x(ts).toFixed(1);
          if (prev !== null) d += ` L${xx},${py(prev).toFixed(1)}`;
          d += ` L${xx},${py(v).toFixed(1)}`;
          prev = v;
        });
        d += ` L${W},${py(prev).toFixed(1)} L${W},${H} Z`;
        area = `<path d="${d}" class="power-area"/>`;
      }
    }

    const grid = [];
    for (let v = lo; v <= hi; v += (hi - lo) / 4) {
      grid.push(`<line x1="0" x2="${W}" y1="${y(v)}" y2="${y(v)}" class="grid"/>`);
    }
    r.chart.innerHTML = `
      <defs><linearGradient id="pg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--hp-accent)" stop-opacity=".35"/>
        <stop offset="100%" stop-color="var(--hp-accent)" stop-opacity="0"/>
      </linearGradient></defs>
      ${grid.join("")}
      ${area}
      ${lines.map((l) => `<path d="${step(l.pts, y)}" stroke="${l.color}" class="line" vector-effect="non-scaling-stroke"/>`).join("")}
    `;

    // axis labels
    const ticks = [];
    const hours = this._config.hours;
    const every = hours <= 12 ? 3 : hours <= 24 ? 6 : 12;
    const first = new Date(t0);
    first.setMinutes(0, 0, 0);
    first.setHours(Math.ceil((first.getHours() + 1) / every) * every);
    for (let ts = first.getTime(); ts < t1; ts += every * 3600 * 1000) {
      const d = new Date(ts);
      ticks.push(`<span style="left:${(x(ts) / W) * 100}%">${String(d.getHours()).padStart(2, "0")}:00</span>`);
    }
    r.axis.innerHTML = `<span class="yl top">${hi}°</span><span class="yl bot">${lo}°</span>${ticks.join("")}`;

    const t = this._t;
    const names = { flow_temp: t.supply, return_temp: t.return, dhw_temp: t.tank, outside_temp: t.outside };
    r.legend.innerHTML =
      lines
        .map((l) => {
          const last = l.pts.length ? l.pts[l.pts.length - 1][1] : NaN;
          const name = names[l.key] || this._hass.states[l.id]?.attributes.friendly_name || l.id;
          return `<span><i style="background:${l.color}"></i>${name} <b>${this._fmt(last)}°</b></span>`;
        })
        .join("") + (area ? `<span><i class="area"></i>${t.power}</span>` : "");
  }
}

const STYLE = `
  :host {
    --hp-accent: #ff8a3d;
    --hp-hot: #ff7a3d;
    --hp-cold: #4c9dff;
    --hp-mix: #ffbf47;
    --hp-flow-dur: 1.2s;
    --hp-fan-dur: 1s;
    --fg: #1d2433;
    --fg2: #6a7489;
    display: block;
  }
  ha-card {
    display: block; overflow: hidden; position: relative;
    padding: 14px;
    border-radius: var(--ha-card-border-radius, 26px);
    border: none;
    color: var(--fg);
    background: linear-gradient(180deg, #f7f9fc 0%, #eef2f7 100%);
  }
  .clickable { cursor: pointer; }

  .panel {
    background: rgba(255,255,255,.72);
    border: 1px solid rgba(255,255,255,.9);
    border-radius: 20px;
    box-shadow: 0 1px 2px rgba(30,45,80,.05), 0 6px 18px rgba(30,45,80,.06);
    -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
  }
  .sub { font-size: .82rem; color: var(--fg2); letter-spacing: .02em; }

  /* header */
  .head { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 20px 15px; position: relative; z-index: 1; }
  .big { font-size: 1.85rem; font-weight: 650; letter-spacing: -.02em; line-height: 1.15; margin-top: 2px; display: flex; align-items: center; gap: 10px; white-space: nowrap; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--hp-accent); box-shadow: 0 0 8px color-mix(in srgb, var(--hp-accent) 70%, transparent); flex: none; transition: background .5s; }
  .dot.live { animation: pulse 1.8s ease-out infinite; }
  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--hp-accent) 60%, transparent); }
    100% { box-shadow: 0 0 0 9px transparent; }
  }
  .hstats { display: flex; gap: 22px; text-align: right; }
  .hv { font-size: 1.55rem; font-weight: 500; line-height: 1.2; margin-top: 2px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .hv small { font-size: .9rem; font-weight: 400; margin-left: 3px; color: var(--fg2); }

  /* scene */
  .scene { margin: 2px -14px -4px; }
  .scene svg { width: 100%; height: auto; display: block; }

  .floor { fill: #eef1f6; stroke: #d3d9e4; stroke-width: 1; stroke-linejoin: round; }
  .warm { opacity: 0; transition: opacity 1.2s; }
  .warm.on { opacity: 1; }
  .wall-a { fill: url(#wallA); }
  .wall-b { fill: url(#wallB); }
  .wall-top { fill: #c3cbda; }
  .wall-cap { fill: #b4bdce; }
  .wall-cap.l { fill: #cfd6e2; }
  .win-frame { fill: #ffffff; stroke: #c3cbda; stroke-width: .6; }
  .win-glass { fill: #bfe0fa; }
  .shadow { fill: rgba(40,60,100,.18); filter: url(#blur); }

  .unit.f-top { fill: #ffffff; }
  .unit.f-left { fill: #eef1f7; }
  .unit.f-right { fill: #c9d0de; }
  .unit { stroke: rgba(40,55,90,.18); stroke-width: .6; stroke-linejoin: round; }
  .fan-housing { fill: #3a4258; stroke: #9aa2ba; stroke-width: 1; }
  .blade { fill: #c3cad9; }
  .fan-hub { fill: #eef1f7; }
  .grille line { stroke: #a9b1c5; stroke-width: 1.8; stroke-linecap: round; }
  .fan { transform-box: fill-box; transform-origin: center; }
  .fan.spin { animation: spin var(--hp-fan-dur) linear infinite; }
  .fan.reverse { animation: spin 3s linear infinite reverse; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .frost { opacity: 0; transition: opacity .5s; }
  .frost.on { opacity: 1; }
  .frost-ring { fill: rgba(111, 214, 232, .55); stroke: #6fd6e8; stroke-width: 1.2; }
  .frost-ico { font-size: 17px; fill: #fff; }

  .screen { fill: #1d2433; stroke: var(--hp-accent); stroke-width: .8; transition: stroke .5s; }
  .screen-val { font-size: 8.6px; font-weight: 700; fill: #fff; font-variant-numeric: tabular-nums; }
  .led { fill: #b4bccd; transition: fill .4s; }
  .booster-coil { fill: none; stroke: #a9b1c5; stroke-width: 1.6; stroke-linejoin: round; stroke-linecap: round; transition: stroke .4s; }
  .booster.on .booster-coil { stroke: #ff7a1a; filter: drop-shadow(0 0 3px #ff8a3d); animation: flicker 1.8s ease-in-out infinite; }
  @keyframes flicker { 50% { opacity: .6; } }
  .pump { fill: #ffffff; stroke: #a9b1c5; stroke-width: 1; }
  .impeller-blade { stroke: #56607c; stroke-width: 1.8; stroke-linecap: round; }
  .impeller { transform-box: fill-box; transform-origin: center; }
  .impeller.spin { animation: spin .7s linear infinite; }

  .tank-body { fill: #e3e8f1; }
  .tank-top { fill: #ffffff; stroke: rgba(40,55,90,.18); stroke-width: .6; }
  .tank-cap { fill: #c9d0de; }
  .tank-glow { opacity: 0; transition: opacity 1s; }
  .tank-glow.on { opacity: .45; }
  stop { transition: stop-color 1s; }
  .tank-heat path { fill: none; stroke: #9aa6bd; stroke-width: 1.6; stroke-linecap: round; opacity: 0; }
  .tank-heat.on path { animation: steam 2.2s ease-in-out infinite; }
  @keyframes steam { 0% { opacity: 0; transform: translateY(4px); } 50% { opacity: .8; } 100% { opacity: 0; transform: translateY(-5px); } }

  /* wires */
  .wire path { fill: none; stroke-linecap: round; stroke-linejoin: round; }
  .wire .base { stroke: #cfd6e2; stroke-width: 2.6; }
  .wire .glow { stroke: var(--c); stroke-width: 7; filter: url(#blur); opacity: 0; transition: opacity .8s; }
  .wire .core { stroke: var(--c); stroke-width: 3.2; opacity: 0; transition: opacity .8s, stroke 1s; }
  .wire .dash { stroke: #fff; stroke-width: 2; stroke-dasharray: 9 13; opacity: 0; transition: opacity .8s;
    animation: dash var(--hp-flow-dur) linear infinite; animation-play-state: paused; }
  .wire.thin .glow { stroke-width: 5.5; }
  .wire.thin .core { stroke-width: 2.6; }
  .wire.thin .dash { stroke-width: 1.5; stroke-dasharray: 7 15; }
  .wire.on .glow { opacity: .45; }
  .wire.on .core { opacity: 1; }
  .wire.on .dash { opacity: .95; animation-play-state: running; }
  @keyframes dash { to { stroke-dashoffset: -44; } }

  .node .pt { fill: #b4bccd; stroke: #ffffff; stroke-width: 1.6; transition: fill .6s; }
  .node .halo { fill: none; stroke: transparent; stroke-width: 1.2; transition: stroke .6s; }
  .node.on .pt { fill: var(--c); stroke: #fff; }
  .node.on .halo { stroke: color-mix(in srgb, var(--c) 55%, transparent); }

  .hub-ring { fill: none; stroke: #cfd6e2; transition: stroke .6s; }
  .hub-ring.r3 { stroke-width: 1.4; }
  .hub-ring.r2 { stroke-width: 2.2; }
  .hub-core { fill: #ffffff; stroke: #a9b1c5; stroke-width: 1.2; }
  .hub-arrow { fill: #a9b1c5; transition: fill .6s; }
  .hub.on .r3 { stroke: color-mix(in srgb, var(--hp-accent) 55%, transparent); }
  .hub.on .r2 { stroke: #2ec4a6; }
  .hub.on .hub-arrow { fill: #16a88a; }

  /* labels */
  .leader { stroke: rgba(40,55,90,.45); stroke-width: 1; stroke-dasharray: .5 3.2; stroke-linecap: round; }
  .leader-dot { fill: #56607c; }
  .lt { font-size: 11px; fill: #6a7489; paint-order: stroke; stroke: rgba(255,255,255,.85); stroke-width: 3px; stroke-linejoin: round; }
  .lx { fill: #16a34a; font-weight: 700; font-size: 10px; }
  .lv { font-size: 18px; font-weight: 600; fill: #1d2433; font-variant-numeric: tabular-nums; paint-order: stroke; stroke: rgba(255,255,255,.9); stroke-width: 3.5px; stroke-linejoin: round; }
  .lu { font-size: 10.5px; font-weight: 400; }

  /* badges */
  .badges { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 2px 10px; position: relative; }
  .badges:empty { display: none; }
  .badge { --c: #fff; display: inline-flex; align-items: center; gap: 6px; padding: 4px 11px 4px 9px; border-radius: 999px;
    font-size: .76rem; color: var(--fg2); background: rgba(255,255,255,.6); border: 1px solid rgba(40,55,90,.08); transition: all .3s; }
  .badge i { width: 6px; height: 6px; border-radius: 50%; background: #c3cad9; }
  .badge.active { color: var(--fg); border-color: color-mix(in srgb, var(--c) 45%, transparent); background: color-mix(in srgb, var(--c) 14%, transparent); }
  .badge.active i { background: var(--c); box-shadow: 0 0 8px var(--c); }

  /* tiles */
  .tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; position: relative; }
  .tile { padding: 12px 14px 13px; min-width: 0; border-radius: 18px; transition: border-color .3s; }
  .tile:hover { border-color: rgba(40,55,90,.15); }
  .tile-top { display: flex; align-items: center; gap: 8px; font-size: .85rem; color: var(--fg2); white-space: nowrap; }
  .tile-top i { width: 7px; height: 7px; border-radius: 50%; background: var(--c); box-shadow: 0 0 8px var(--c); flex: none; }
  .tile-val { margin-top: 5px; font-size: 1.55rem; font-weight: 500; font-variant-numeric: tabular-nums; white-space: nowrap; line-height: 1.15; }
  .tile-val small { font-size: .85rem; font-weight: 400; margin-left: 4px; color: var(--fg2); }
  .tile[data-state="warn"] { border-color: rgba(255, 92, 122, .55); background: rgba(255, 92, 122, .1); }
  .tile[data-state="warn"] .tile-val { color: #e0435c; }
  .tile[data-state="warn"] { --c: #ff5c7a !important; }

  /* history */
  .history { margin-top: 8px; padding: 12px 14px 11px; border-radius: 18px; }
  .chart { width: 100%; height: 100px; display: block; overflow: visible; margin-top: 6px; }
  .chart .grid { stroke: rgba(40,55,90,.12); stroke-width: 1; vector-effect: non-scaling-stroke; stroke-dasharray: 1 4; }
  .chart .line { fill: none; stroke-width: 1.8; stroke-linejoin: round; }
  .chart .power-area { fill: url(#pg); }
  .axis { position: relative; height: 16px; font-size: .68rem; color: var(--fg2); font-variant-numeric: tabular-nums; }
  .axis span { position: absolute; top: 3px; transform: translateX(-50%); }
  .axis .yl { transform: none; right: 0; }
  .axis .yl.top { top: -104px; }
  .axis .yl.bot { top: -16px; }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 5px; font-size: .76rem; color: var(--fg2); }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .legend b { color: var(--fg); font-weight: 500; font-variant-numeric: tabular-nums; }
  .legend i { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
  .legend i.area { border-radius: 2px; background: linear-gradient(var(--hp-accent), transparent); }

  @media (max-width: 420px) {
    .big { font-size: 1.45rem; }
    .hv { font-size: 1.2rem; }
    .hstats { gap: 14px; }
    .tile-val { font-size: 1.2rem; }
    .tile { padding: 10px 11px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .wire .dash, .fan, .impeller, .dot, .tank-heat path, .booster-coil { animation: none !important; }
  }
`;


/* ======================= visual editor ======================= */

const EDITOR_LABELS = {
  nl: {
    title: "Titel",
    show_history: "Grafiek tonen",
    hours: "Uren in grafiek",
    min_power: "Compressor aan vanaf (W)",
    g_main: "Status & buiten",
    g_water: "Water: aanvoer, retour & boiler",
    g_power: "Vermogen & COP",
    g_floor: "Vloer & kamer",
    g_extra: "Extra signalen",
    status: "Status",
    outside_temp: "Buitentemperatuur",
    flow_temp: "Aanvoertemperatuur",
    return_temp: "Retourtemperatuur",
    dhw_temp: "Boilertemperatuur",
    dhw_target: "Boiler doeltemperatuur",
    flow_rate: "Debiet (L/min)",
    pressure: "Waterdruk (bar)",
    power_in: "Elektrisch vermogen",
    power_out: "Warmte-/koelvermogen",
    cop: "COP",
    floor_temp: "Vloertemperatuur",
    room_temp: "Kamertemperatuur",
    dhw_demand: "Warmwatervraag",
    defrost: "Ontdooien",
    booster: "Booster",
    h_cop: "Leeg laten om COP te berekenen uit warmte ÷ elektrisch",
    h_power_out: "Leeg laten om te berekenen uit debiet × ΔT",
    h_floor_temp: "Leeg laten om het vloerlabel te verbergen",
    h_status: "Tekstsensor, bv. Warmwater / Verwarmen / Koelen / Uit",
    h_dhw_target: "water_heater, climate of sensor",
  },
  en: {
    title: "Title",
    show_history: "Show chart",
    hours: "Hours in chart",
    min_power: "Compressor on above (W)",
    g_main: "Status & outside",
    g_water: "Water: supply, return & tank",
    g_power: "Power & COP",
    g_floor: "Floor & room",
    g_extra: "Extra signals",
    status: "Status",
    outside_temp: "Outside temperature",
    flow_temp: "Supply temperature",
    return_temp: "Return temperature",
    dhw_temp: "Tank temperature",
    dhw_target: "Tank target temperature",
    flow_rate: "Flow rate (L/min)",
    pressure: "Water pressure (bar)",
    power_in: "Electrical power",
    power_out: "Heating/cooling power",
    cop: "COP",
    floor_temp: "Floor temperature",
    room_temp: "Room temperature",
    dhw_demand: "Hot water demand",
    defrost: "Defrost",
    booster: "Booster",
    h_cop: "Leave empty to calculate COP from heat ÷ electrical",
    h_power_out: "Leave empty to calculate from flow × ΔT",
    h_floor_temp: "Leave empty to hide the floor label",
    h_status: "Text sensor, e.g. Hot water / Heating / Cooling / Off",
    h_dhw_target: "water_heater, climate or sensor",
  },
};

const ENTITY_KEYS = [
  "status", "outside_temp", "flow_temp", "return_temp", "dhw_temp", "dhw_target", "flow_rate", "pressure",
  "power_in", "power_out", "cop", "floor_temp", "room_temp", "dhw_demand", "defrost", "booster",
];

const ent = (name, domain) => ({ name, selector: { entity: domain ? { domain } : {} } });
const SENSOR = ["sensor", "input_number", "number"];
const EDITOR_SCHEMA = [
  { name: "title", selector: { text: {} } },
  {
    type: "expandable", name: "g_main", flatten: true, expanded: true,
    schema: [ent("status", ["sensor", "select", "input_select", "climate", "water_heater"]), ent("outside_temp", SENSOR)],
  },
  {
    type: "expandable", name: "g_water", flatten: true, expanded: true,
    schema: [
      ent("flow_temp", SENSOR), ent("return_temp", SENSOR), ent("dhw_temp", SENSOR),
      ent("dhw_target", ["water_heater", "climate", ...SENSOR]), ent("flow_rate", SENSOR), ent("pressure", SENSOR),
    ],
  },
  {
    type: "expandable", name: "g_power", flatten: true, expanded: true,
    schema: [ent("power_in", SENSOR), ent("power_out", SENSOR), ent("cop", SENSOR)],
  },
  {
    type: "expandable", name: "g_floor", flatten: true, expanded: true,
    schema: [ent("floor_temp", SENSOR), ent("room_temp", ["climate", ...SENSOR])],
  },
  {
    type: "expandable", name: "g_extra", flatten: true,
    schema: [
      ent("dhw_demand", ["binary_sensor", "sensor", "switch", "input_boolean"]),
      ent("defrost", ["binary_sensor", "sensor", "switch", "input_boolean"]),
      ent("booster", ["sensor", "binary_sensor", "switch"]),
      {
        type: "grid", name: "", schema: [
          { name: "show_history", selector: { boolean: {} } },
          { name: "hours", selector: { number: { min: 1, max: 168, mode: "box" } } },
          { name: "min_power", selector: { number: { min: 0, max: 2000, mode: "box" } } },
        ],
      },
    ],
  },
];

class HeatpumpCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...config, entities: { ...(config.entities || {}) } };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
  }

  get _l() {
    const lang = (this._hass?.locale?.language || this._hass?.language || "nl").slice(0, 2);
    return EDITOR_LABELS[lang] || EDITOR_LABELS.en;
  }

  _render() {
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.addEventListener("value-changed", (ev) => this._changed(ev.detail.value));
      this.appendChild(this._form);
    }
    const l = this._l;
    const c = this._config;
    this._form.hass = this._hass;
    this._form.schema = EDITOR_SCHEMA;
    this._form.data = {
      title: c.title ?? "",
      show_history: c.show_history ?? true,
      hours: c.hours ?? 24,
      min_power: c.min_power ?? 50,
      ...c.entities,
    };
    this._form.computeLabel = (s) => l[s.name] ?? s.name;
    this._form.computeHelper = (s) => l[`h_${s.name}`];
  }

  _changed(v) {
    const entities = {};
    ENTITY_KEYS.forEach((k) => {
      if (v[k]) entities[k] = v[k];
    });
    const config = { ...this._config, entities };
    ["title", "show_history", "hours", "min_power"].forEach((k) => {
      if (v[k] === "" || v[k] === undefined || v[k] === null) delete config[k];
      else config[k] = v[k];
    });
    this._config = config;
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
  }
}

if (!customElements.get("heatpump-card-editor")) customElements.define("heatpump-card-editor", HeatpumpCardEditor);

if (!customElements.get("heatpump-card")) {
  customElements.define("heatpump-card", HeatpumpCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "heatpump-card",
    name: "Heatpump Card",
    description: "Animated heat pump schematic with DHW tank, floor heating, COP and history.",
    preview: true,
  });
  console.info(`%c HEATPUMP-CARD %c v${VERSION} `, "background:#ff8a3d;color:#fff;font-weight:700;border-radius:3px 0 0 3px", "background:#333;color:#fff;border-radius:0 3px 3px 0");
}
