import React, { useEffect, useMemo, useState, useRef } from "react";
import ICALdefault, * as ICALns from "ical.js";
const ICAL = (ICALdefault && ICALdefault.parse) ? ICALdefault
           : (ICALns && ICALns.parse) ? ICALns
           : (() => { throw new Error("ical.js failed to load"); })();

/* =========================
   Helpers
========================= */
function useResizeWidth(ref) {
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => {
      const el = entries[0]?.contentRect;
      if (el?.width != null) setW(el.width);
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}
const startOfDay = (d) => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
const endOfDay   = (d) => { const x = new Date(d); x.setHours(23,59,59,999); return x; };
const addDays    = (d,n)=> { const x = new Date(d); x.setDate(x.getDate()+n); return x; };
const monthStart = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const monthEnd   = (d) => new Date(d.getFullYear(), d.getMonth()+1, 0);
const dayKey     = (d) => d.toISOString().slice(0,10);
const clamp      = (v,a,b)=> Math.max(a, Math.min(b, v));
const minutesBetween = (a,b)=> Math.max(0, Math.round((b-a)/60000));
const mergeIntervals = (ints)=>{
  if(!ints.length) return [];
  const s=[...ints].sort((x,y)=>x[0]-y[0]); const res=[s[0]];
  for(let i=1;i<s.length;i++){ const [A,B]=s[i]; const last=res[res.length-1]; if(A<=last[1]) last[1]=Math.max(last[1],B); else res.push([A,B]); }
  return res;
};
const splitIntervalByDays = (s,e)=>{
  const out=[]; let cur=s;
  while(cur<e){ const dayEnd=endOfDay(new Date(cur)).getTime()+1; const segEnd=Math.min(dayEnd,e); out.push({date:new Date(cur).toISOString().slice(0,10), start:cur, end:segEnd}); cur=segEnd; }
  return out;
};
const invertIntervals = (merged, ws, we) => {
  const out = []; let cur = ws;
  for (const [s, e] of merged) { if (s > cur) out.push([cur, s]); cur = Math.max(cur, e); if (cur >= we) break; }
  if (cur < we) out.push([cur, we]);
  return out;
};
// Subtract merged "cuts" from merged "busy"
function subtractIntervals(busy, cuts) {
  if (!busy.length || !cuts.length) return busy.slice();
  const out = [];
  let i = 0, j = 0;
  while (i < busy.length) {
    let [bs, be] = busy[i];
    while (j < cuts.length && cuts[j][1] <= bs) j++;
    let curS = bs;
    let k = j;
    while (k < cuts.length && cuts[k][0] < be) {
      const [cs, ce] = cuts[k];
      if (cs > curS) out.push([curS, Math.min(be, cs)]);
      curS = Math.max(curS, ce);
      if (curS >= be) break;
      k++;
    }
    if (curS < be) out.push([curS, be]);
    i++;
  }
  return out;
}
// Safe percent formatter (shows 0.1–0.9% as "<1")
function pct(value, total) {
  const t = Math.max(1, total|0);
  const r = Math.max(0, Math.min(1, value / t));
  const p = r * 100;
  return p > 0 && p < 1 ? "<1" : String(Math.round(p));
}

/* =========================
   Config
========================= */
const PODCAST_ID = "podcast_live";
const PODCAST_NAME = "Freedom to Thrive Podcast 2.0";
const MATT_SOURCE_ID = "matt_live";
const HECTOR_SOURCE_ID = "hector";

/** If you swapped Hector to a new ICS, export it as: public/calendars/Hector.ics */
const PRESET_CALENDARS = [
  { id: HECTOR_SOURCE_ID, name: "Hector.ics", url: `${import.meta.env.BASE_URL}calendars/Hector.ics` },
];

// One mirrored URL per remote (avoid direct google.com to dodge CORS)
const REMOTE_CALENDARS = [
  {
    id: MATT_SOURCE_ID,
    name: "Matt (Live)",
    urls: [
      "https://r.jina.ai/https://calendar.google.com/calendar/ical/c_30bddbc5906cde0880bde664af52861bd707468edcadd75e921e8dabc6d6fd56%40group.calendar.google.com/public/basic.ics",
    ],
  },
  {
    id: PODCAST_ID,
    name: PODCAST_NAME,
    urls: [
      "https://r.jina.ai/https://calendar.google.com/calendar/ical/13a4368be555f7c3c3046a21be8e01dc698839e43160cb25d3385d50b3d1c0a5%40group.calendar.google.com/public/basic.ics",
    ],
  },
];

// === Per-source colors (fallback hashes if unknown) ===
const SOURCE_COLORS = {
  [MATT_SOURCE_ID]: "#2563eb",  // Matt = blue
  [HECTOR_SOURCE_ID]: "#0ea5e9", // Hector = sky
};
function colorForSource(id) {
  if (SOURCE_COLORS[id]) return SOURCE_COLORS[id];
  let h = 0;
  for (let i=0;i<id.length;i++) h = (h*31 + id.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue}, 70%, 50%)`;
}
const PURPLE_URGENT = "#6d28d9";

/* =========================
   Hardened ICS fetch + parse
========================= */
const looksHtml = (s) => /^\s*<!doctype html|^\s*<html/i.test(s||"");
const looksJson = (s) => /^\s*(\{|\[)/.test(s||"");

async function fetchText(url, { bust = false } = {}) {
  const final = bust ? (url + (url.includes("?") ? "&" : "?") + "t=" + Date.now()) : url;
  const resp = await fetch(final, { cache: "no-store" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}
function sliceCalendar(raw) {
  if (!raw) return "";
  let s = String(raw).replace(/^\uFEFF/, "").trim();
  const b = s.indexOf("BEGIN:VCALENDAR");
  const e = s.lastIndexOf("END:VCALENDAR");
  if (b === -1 || e === -1) return "";
  return s.slice(b, e + "END:VCALENDAR".length);
}
function unfoldLines(text) {
  const lf = text.replace(/\r\n/g, "\n");
  const out = [];
  for (const line of lf.split("\n")) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out;
}
const VALID_PROP_RE = /^([A-Z0-9-]+)(;[^:]*)?:/;
function repairIcs(raw) {
  const sliced = sliceCalendar(raw);
  if (!sliced) return "";
  const lines = unfoldLines(sliced);
  const kept = [];
  for (const ln of lines) {
    if (!ln.trim()) { kept.push(ln); continue; }
    if (ln.startsWith("BEGIN:") || ln.startsWith("END:")) { kept.push(ln); continue; }
    if (VALID_PROP_RE.test(ln)) { kept.push(ln); continue; }
  }
  const refolded = kept.flatMap((l) => {
    if (l.length <= 75) return [l];
    const chunks = [];
    let i = 0;
    while (i < l.length) {
      const head = l.slice(i, i + (i ? 74 : 75));
      chunks.push(i ? " " + head : head);
      i += (i ? 74 : 75);
    }
    return chunks;
  });
  return refolded.join("\r\n") + "\r\n";
}
async function fetchFixedICS(name, urls) {
  let lastErr;
  for (const u of urls) {
    try {
      const raw = await fetchText(u, { bust: false });
      if (looksHtml(raw) || looksJson(raw)) throw new Error("not ICS (HTML/JSON)");
      const fixed = repairIcs(raw);
      if (!/BEGIN:VCALENDAR[\s\S]*END:VCALENDAR/i.test(fixed)) throw new Error("no VCALENDAR after repair");
      return fixed;
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || "");
      if (msg.includes("HTTP 429")) {
        await new Promise(r => setTimeout(r, 60_000));
      }
      console.warn(`${name} attempt failed at`, u, e);
    }
  }
  throw new Error(`${name} fetch failed: ${lastErr?.message || lastErr}`);
}
function parseICSText(text, sourceId, sourceName){
  const ics = repairIcs(text);
  if (!/^BEGIN:VCALENDAR[\s\S]*END:VCALENDAR\s*$/i.test(ics)) {
    throw new Error(`${sourceName} did not return a valid VCALENDAR`);
  }
  let jcal;
  try { jcal = ICAL.parse(ics); }
  catch (e) { throw new Error(`ICS parse failed for ${sourceName}: ${e?.message || e}`); }
  const comp = new ICAL.Component(jcal);

  try {
    const register = ICAL?.TimezoneService?.register;
    if (register) {
      for (const tzComp of comp.getAllSubcomponents("vtimezone")) {
        try {
          const tz = new ICAL.Timezone({ component: tzComp });
          if (tz?.tzid) register(tz.tzid, tz);
        } catch {}
      }
    }
  } catch {}

  const vevents = comp.getAllSubcomponents("vevent") || [];
  const events = [];
  for (const v of vevents) {
    try {
      const e = new ICAL.Event(v);
      const summary = e.summary || "Event";
      const isUrgent = /!/.test(summary); // marks “need more information” days
      const isFreeOverlay = /\bfree\b/i.test(summary); // <<—— FREE windows by title

      if (e.isRecurring()) {
        events.push({ sourceId, sourceName, summary, isUrgent, isFreeOverlay, isRecurring: true, component: v });
      } else {
        const s = e.startDate.toJSDate();
        const ee = e.endDate ? e.endDate.toJSDate() : new Date(s.getTime() + 30*60000);
        events.push({ sourceId, sourceName, summary, isUrgent, isFreeOverlay, start: s, end: ee, allDay: e.startDate.isDate, isRecurring: false });
      }
    } catch {}
  }
  return events;
}

/* =========================
   UI
========================= */
export default function App(){
  const today = new Date();

  const TZ_OPTS = [
    { id: "system", label: "System (auto)" },
    { id: "America/Los_Angeles", label: "PT (America/Los_Angeles)" },
    { id: "America/New_York",    label: "ET (America/New_York)" },
  ];
  const [displayTz, setDisplayTz] = useState("America/Los_Angeles");
  const fmt = (d) => new Intl.DateTimeFormat(undefined, {
    timeZone: displayTz === "system" ? undefined : displayTz,
    year: "numeric", month: "short", day: "numeric"
  }).format(d);
  const fmtTime = (d) => new Intl.DateTimeFormat(undefined, {
    timeZone: displayTz === "system" ? undefined : displayTz,
    hour: "2-digit", minute: "2-digit"
  }).format(d);

  const [sources, setSources] = useState([]);
  const [rawEvents, setRawEvents] = useState([]);
  const [dateFrom, setDateFrom] = useState(() => dayKey(monthStart(today)));
  const [dateTo,   setDateTo]   = useState(() => dayKey(monthEnd(today)));
  const [workStart, setWorkStart] = useState(8);
  const [workEnd,   setWorkEnd]   = useState(20);
  const [viewMode, setViewMode] = useState("single");
  const [currentMonth, setCurrentMonth] = useState(() => monthStart(today));
  const [hoverDay, setHoverDay] = useState(null);
  const [selectedDay, setSelectedDay] = useState(null);
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const [sourceCounts, setSourceCounts] = useState({});
  const [lastFetchAt, setLastFetchAt] = useState({});
  const [fetchErrors, setFetchErrors] = useState({});
  const [selectedIds, setSelectedIds] = useState(new Set());

  // New: Time slot view (Matt & Hector side-by-side)
  const [slotViewOn, setSlotViewOn] = useState(false);
  // New: Need more information toggle (purple outline/faint fill)
  const [outlineUrgent, setOutlineUrgent] = useState(false);

  const toggleSelected = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Keep Matt & Hector selected when slot view is on
  useEffect(() => {
    if (!slotViewOn) return;
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.add(MATT_SOURCE_ID);
      next.add(HECTOR_SOURCE_ID);
      return next;
    });
  }, [slotViewOn]);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setIsLoading(true);
        const loadedSources = [];
        const loadedEvents  = [];

        for (const p of PRESET_CALENDARS) {
          try {
            const raw = await fetchText(p.url, { bust: true });
            const evs = parseICSText(raw, p.id, p.name);
            loadedSources.push({ id: p.id, name: p.name });
            loadedEvents.push(...evs);
            setSourceCounts(prev => ({ ...prev, [p.id]: evs.length }));
            setLastFetchAt(prev => ({ ...prev, [p.id]: new Date() }));
          } catch (e) {
            setFetchErrors(prev => ({ ...prev, [p.id]: String(e?.message || e) }));
          }
        }
        for (const r of REMOTE_CALENDARS) {
          try {
            const fixed = await fetchFixedICS(r.name, r.urls);
            const evs = parseICSText(fixed, r.id, r.name);
            loadedSources.push({ id: r.id, name: r.name });
            loadedEvents.push(...evs);
            setSourceCounts(prev => ({ ...prev, [r.id]: evs.length }));
            setLastFetchAt(prev => ({ ...prev, [r.id]: new Date() }));
          } catch (e) {
            setFetchErrors(prev => ({ ...prev, [r.id]: String(e?.message || e) }));
          }
        }

        if (cancelled) return;
        setSources(loadedSources);
        setRawEvents(loadedEvents);
        setSelectedIds(new Set(loadedSources.map(s => s.id)));
        setNotice(`Loaded ${loadedSources.length} calendar${loadedSources.length>1?'s':''}.`);
      } catch (e) {
        setErr(`Initial load error: ${e?.message || e}`);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Auto-refresh every 6 hours
  useEffect(() => {
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    let stop = false;

    async function refresh() {
      for (const r of REMOTE_CALENDARS) {
        try {
          const last = lastFetchAt[r.id]?.getTime?.() || 0;
          if (Date.now() - last < SIX_HOURS) continue;
          setIsLoading(true);
          const fixed = await fetchFixedICS(r.name, r.urls);
          const evs = parseICSText(fixed, r.id, r.name);
          if (stop) return;
          setRawEvents(prev => {
            const others = prev.filter(e => e.sourceId !== r.id);
            return [...others, ...evs];
          });
          setSourceCounts(prev => ({ ...prev, [r.id]: evs.length }));
          setLastFetchAt(prev => ({ ...prev, [r.id]: new Date() }));
          setFetchErrors(prev => ({ ...prev, [r.id]: undefined }));
          setNotice(`Updated ${r.name}`);
        } catch (e) {
          setFetchErrors(prev => ({ ...prev, [r.id]: String(e?.message || e) }));
        } finally {
          setIsLoading(false);
        }
      }
    }

    const t = setInterval(refresh, SIX_HOURS);
    return () => { stop = true; clearInterval(t); };
  }, [lastFetchAt]);

  // Console-only manual refresh
  async function forceRefresh() {
    if (isRefreshing) return;
    setIsRefreshing(true);
    setIsLoading(true);
    let ok = 0;
    try {
      for (const r of REMOTE_CALENDARS) {
        try {
          const fixed = await fetchFixedICS(r.name, r.urls);
          const evs = parseICSText(fixed, r.id, r.name);
          setRawEvents(prev => {
            const others = prev.filter(e => e.sourceId !== r.id);
            return [...others, ...evs];
          });
          setSourceCounts(prev => ({ ...prev, [r.id]: evs.length }));
          setLastFetchAt(prev => ({ ...prev, [r.id]: new Date() }));
          setFetchErrors(prev => ({ ...prev, [r.id]: undefined }));
          ok++;
        } catch (e) {
          console.warn(`Manual refresh failed for ${r.name}: ${e?.message || e}`);
        }
      }
      const ts = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date());
      setNotice(ok ? `Refreshed at ${ts}` : `Refresh finished with errors at ${ts}`);
    } finally {
      setIsRefreshing(false);
      setIsLoading(false);
    }
  }
  useEffect(() => { window.forceRefresh = forceRefresh; }, []);

  // Single-month bounds for "single" view
  const singleFrom = useMemo(() => monthStart(currentMonth), [currentMonth]);
  const singleTo   = useMemo(() => monthEnd(currentMonth),   [currentMonth]);

  // Active calculation window
  const rangeStart = useMemo(() => {
    return viewMode === 'single'
      ? startOfDay(singleFrom)
      : new Date(dateFrom + "T00:00:00");
  }, [viewMode, singleFrom, dateFrom]);
  const rangeEnd = useMemo(() => {
    return viewMode === 'single'
      ? endOfDay(singleTo)
      : new Date(dateTo + "T23:59:59");
  }, [viewMode, singleTo, dateTo]);

  // Expand recurrences + filter by selected sources
  const events = useMemo(() => {
    const out = [];
    const want = selectedIds;
    for (const e of rawEvents) {
      if (!want.size || !want.has(e.sourceId)) continue;
      if (e.isRecurring) {
        const evt = new ICAL.Event(e.component);
        const it = evt.iterator();
        let next; let i = 0;
        while ((next = it.next())) {
          const s  = next.toJSDate();
          const ee = evt.duration ? next.clone().addDuration(evt.duration).toJSDate()
                                  : new Date(s.getTime() + 30 * 60000);
          if (ee < rangeStart) { if (++i > 5000) break; continue; }
          if (s  > rangeEnd) break;
          const summary = evt.summary || "Event";
          out.push({
            sourceId:e.sourceId, sourceName:e.sourceName, summary,
            isUrgent:/!/.test(summary), isFreeOverlay: /\bfree\b/i.test(summary),
            start:s, end:ee, allDay:next.isDate
          });
          if (++i > 5000) break;
        }
      } else if (!(e.end < rangeStart || e.start > rangeEnd)) {
        out.push(e);
      }
    }
    return out;
  }, [rawEvents, selectedIds, rangeStart, rangeEnd]);

  // Person-specific lists (respect selectedIds/current range)
  const mattEvents = useMemo(
    () => events.filter(e => e.sourceId === MATT_SOURCE_ID).sort((a,b)=> a.start - b.start),
    [events]
  );
  const hectorEvents = useMemo(
    () => events.filter(e => e.sourceId === HECTOR_SOURCE_ID).sort((a,b)=> a.start - b.start),
    [events]
  );

  // Aggregate per-day
  // Aggregate per-day (with FREE overlays applied to group and per-person)
const dayStats = useMemo(()=>{
  const perDayUnion = new Map();        // busy union (no podcast)
  const perDayBySrc = new Map();        // per-person intervals + titles
  const podcastByDay = new Map();       // podcast items
  const urgentByDay = new Map();        // any "!"
  const freeOverlayByDay = new Map();   // FREE windows (all sources) for group calc
  const freeOverlayByDaySrc = new Map(); // FREE windows keyed by day then source

  for(const ev of events){
    const s = ev.start.getTime(), e = ev.end.getTime();
    for(const seg of splitIntervalByDays(s,e)){
      const k = seg.date;

      // Track FREE windows (group + source-specific)
      if (ev.isFreeOverlay) {
        if (!freeOverlayByDay.has(k)) freeOverlayByDay.set(k, []);
        freeOverlayByDay.get(k).push([seg.start, seg.end]);

        if (!freeOverlayByDaySrc.has(k)) freeOverlayByDaySrc.set(k, new Map());
        const bySrc = freeOverlayByDaySrc.get(k);
        if (!bySrc.has(ev.sourceId)) bySrc.set(ev.sourceId, []);
        bySrc.get(ev.sourceId).push([seg.start, seg.end]);
      }

      // Group busy union (exclude podcast)
      if (ev.sourceId !== PODCAST_ID) {
        if(!perDayUnion.has(k)) perDayUnion.set(k, []);
        perDayUnion.get(k).push([seg.start, seg.end]);
      }

      // Per-person aggregation
      if(!perDayBySrc.has(k)) perDayBySrc.set(k, new Map());
      const m = perDayBySrc.get(k);
      if(!m.has(ev.sourceId)) m.set(ev.sourceId, { name: ev.sourceName, intervals: [], titles: [] });
      m.get(ev.sourceId).intervals.push([seg.start, seg.end]);
      m.get(ev.sourceId).titles.push({
        start: seg.start, end: seg.end,
        summary: ev.summary || "Event",
        isUrgent: !!ev.isUrgent
      });

      if (ev.isUrgent) urgentByDay.set(k, true);

      if (ev.sourceId === PODCAST_ID) {
        if (!podcastByDay.has(k)) podcastByDay.set(k, []);
        podcastByDay.get(k).push({ start: seg.start, end: seg.end, summary: ev.summary || "Podcast" });
      }
    }
  }

  const res = {};
  for(let d=new Date(rangeStart); d<=rangeEnd; d=addDays(d,1)){
    const k = dayKey(d);

    const hoursSpan = ((workEnd - workStart) + 24) % 24;
    const total = Math.max(0, Math.round(hoursSpan * 60));
    const WS = new Date(d.getFullYear(), d.getMonth(), d.getDate(), workStart).getTime();
    const WE = new Date(d.getFullYear(), d.getMonth(), d.getDate(), workEnd).getTime();

    // ----- GROUP BUSY (apply FREE overlays at the group level) -----
    const clippedBusy = (perDayUnion.get(k)||[])
      .map(([a,b])=>[Math.max(a,WS), Math.min(b,WE)]).filter(([a,b])=>b>a);
    let mergedAll = mergeIntervals(clippedBusy);

    const clippedFree = (freeOverlayByDay.get(k)||[])
      .map(([a,b])=>[Math.max(a,WS), Math.min(b,WE)]).filter(([a,b])=>b>a);
    const mergedFree = mergeIntervals(clippedFree);

    if (mergedFree.length) mergedAll = subtractIntervals(mergedAll, mergedFree);

    let busyUnion = mergedAll.reduce((acc,[a,b])=> acc + minutesBetween(a,b), 0);
    busyUnion = Math.min(Math.max(0, busyUnion), total);
    const freeUnion = Math.min(total, Math.max(0, total - busyUnion));

    // ----- PER-PERSON (apply FREE overlays PER SOURCE) -----
    const bySrcMap = perDayBySrc.get(k) || new Map();
    const perPerson = [];
    const dayEventTitles = [];

    for (const [sid, {name, intervals, titles}] of bySrcMap.entries()){
      if (sid !== PODCAST_ID) {
        // busy intervals for this source, clipped + merged
        const clipped = intervals.map(([a,b])=>[Math.max(a,WS), Math.min(b,WE)]).filter(([a,b])=>b>a);
        let merged = mergeIntervals(clipped);

        // source-specific FREE cuts
        const cutsRaw = (freeOverlayByDaySrc.get(k)?.get(sid) || [])
          .map(([a,b])=>[Math.max(a,WS), Math.min(b,WE)]).filter(([a,b])=>b>a);
        const mergedCuts = mergeIntervals(cutsRaw);

        if (mergedCuts.length) merged = subtractIntervals(merged, mergedCuts);

        const busy = Math.min(total, merged.reduce((acc,[a,b])=> acc + minutesBetween(a,b), 0));
        const free = Math.min(total, Math.max(0, total - busy));
        const freeBlocks = invertIntervals(merged, WS, WE);

        perPerson.push({
          sourceId: sid, sourceName: name,
          busyMinutes: busy, freeMinutes: free, freeRatio: total ? free/total : 0,
          mergedBusy: merged, freeBlocks
        });
      }

      for (const t of titles) {
        const a = Math.max(t.start, WS), b = Math.min(t.end, WE);
        if (b > a) dayEventTitles.push({
          sourceId: sid, sourceName: name,
          start: a, end: b, summary: t.summary, isUrgent: !!t.isUrgent
        });
      }
    }

    // Add rows for selected sources that had no events that day
    for (const s of sources) {
      if (s.id === PODCAST_ID) continue;
      if (!selectedIds.has(s.id)) continue;
      if (!(bySrcMap.has(s.id))) {
        perPerson.push({
          sourceId: s.id, sourceName: s.name,
          busyMinutes: 0, freeMinutes: total, freeRatio: total ? 1 : 0,
          mergedBusy: [], freeBlocks: total ? [[WS, WE]] : []
        });
      }
    }

    perPerson.sort((a,b)=> a.sourceName.localeCompare(b.sourceName));
    dayEventTitles.sort((a,b)=> a.start - b.start);

    const podcastItems = (podcastByDay.get(k) || [])
      .map(it => ({ start: Math.max(it.start, WS), end: Math.min(it.end, WE), summary: it.summary }))
      .filter(it => it.end > it.start)
      .sort((a,b) => a.start - b.start);

    res[k] = {
      date:new Date(d),
      totalMinutes: total,
      freeMinutes: freeUnion,
      busyMinutes: busyUnion,
      freeRatio: total? freeUnion/total : 0,
      mergedBusy: mergedAll,
      perPerson,
      podcastItems,
      titles: dayEventTitles,
      hasUrgent: !!urgentByDay.get(k),
    };
  }
  return res;
}, [events, sources, selectedIds, rangeStart, rangeEnd, workStart, workEnd]);

  const colorForRatio = (r)=>{ const hue = r*120, sat=70, light=90 - r*40; return `hsl(${hue}, ${sat}%, ${light}%)`; };

  const activeDayKey = selectedDay ?? hoverDay;
  const activeInfo = activeDayKey ? dayStats[activeDayKey] : null;
  const dayHasPodcast = (k) => !!dayStats[k]?.podcastItems?.length;

  function renderMonthGrid(from, to){
    const blocks = [];
    let cur = startOfDay(from);
    while (cur <= to) {
      const mStart = monthStart(cur);
      const mEnd   = monthEnd(cur);
      const secFrom = cur < mStart ? mStart : cur;
      const secTo   = to  < mEnd   ? to    : mEnd;
      blocks.push(
        <MonthGrid
          key={`${mStart.getFullYear()}-${mStart.getMonth()}`}
          year={mStart.getFullYear()}
          month={mStart.getMonth()}
          from={secFrom}
          to={secTo}
          dayStats={dayStats}
          setHoverDay={setHoverDay}
          onClickDay={(k)=> setSelectedDay(prev => prev === k ? null : k)}
          selectedDay={selectedDay}
          colorForRatio={colorForRatio}
          fmt={fmt}
          fmtTime={fmtTime}
          podcastOn={selectedIds.has(PODCAST_ID)}
          outlineUrgent={outlineUrgent}
        />
      );
      cur = addDays(mEnd, 1);
    }
    return blocks;
  }

  return (
    <div className="min-h-screen w-full" style={{ background: "#f8fafc", color: "#111", colorScheme: "light" }}>
      <style>{`
        :root { color-scheme: light !important; }
        input, select, textarea, button { background:#fff !important; color:#111 !important; }
        input[type="date"], input[type="number"] { background:#fff !important; color:#111 !important; }
        .chip{display:inline-block;padding:2px 8px;border:1px solid #ddd;border-radius:9999px;font-size:12px;line-height:18px;margin-left:6px;}
        .muted{color:#6b7280;}
        .mono{font-variant-numeric: tabular-nums;}
        @keyframes rainbowShift { 0%{background-position:0% 50%} 50%{background-position:100% 50%} 100%{background-position:0% 50%} }
        .rainbow-always {
          background: linear-gradient(90deg,#ff004c,#ff8a00,#ffe600,#4cd964,#1ecfff,#5856d6,#ff2d55);
          background-size: 400% 400%;
          animation: rainbowShift 6s linear infinite;
          color: #111; border-radius: 6px; padding: 0 6px; font-weight: 600;
        }
        .rainbow-outline {
          position: relative; border: 2px solid transparent;
          background: linear-gradient(#ffffff,#ffffff) padding-box,
                      linear-gradient(90deg,#ff004c,#ff8a00,#ffe600,#4cd964,#1ecfff,#5856d6,#ff2d55) border-box;
          background-size: auto, 400% 400%; animation: rainbowShift 6s linear infinite;
        }
        .day-cell { transition: box-shadow .15s ease; }
        .divider { height:1px; background:#eee; margin:8px 0; }
        .day-selected { outline: 2px solid #111; outline-offset: -2px; }
        .spinner { width:14px;height:14px;border:2px solid #93c5fd; border-top-color: transparent; border-radius:50%; display:inline-block; animation: spin .8s linear infinite; vertical-align: -2px;}
        @keyframes spin { to { transform: rotate(360deg); } }
        .btn { display:inline-flex; align-items:center; gap:8px; padding:6px 10px; border:1px solid #e5e7eb; border-radius:10px; font-size:13px; background:#fff; }
        .btn-toggle-on { background:#111; color:#fff; border-color:#111; }
        .urgent-outline { outline: 2px solid ${PURPLE_URGENT}; outline-offset: -2px; }
        .urgent-faint { box-shadow: inset 0 0 0 9999px rgba(109, 40, 217, 0.07); }
        .tag { font-size:11px; padding:2px 6px; border-radius:9999px; border:1px solid #e5e7eb; background:#f3f4f6; color:#111; }
        .tag-urgent { background:#f5f3ff; border-color:#ddd6fe; color:${PURPLE_URGENT}; }
      `}</style>

      <div className="max-w-screen-xl mx-auto px-3 sm:px-4 lg:px-6 py-3">
        {/* Top toolbar: title + status + TZ */}
        <div className="flex items-center gap-3 flex-wrap mb-2">
          <h1 className="text-2xl font-bold mr-2">Dawn's F2T Heat Map</h1>

          {isLoading ? (
            <div className="text-sm text-blue-700 flex items-center gap-2">
              <span className="spinner" /> <span>Loading calendars…</span>
            </div>
          ) : (
            notice && <div className="text-xs" style={{padding:"3px 8px", background:"#ecfeff", border:"1px solid #a5f3fc", borderRadius:9999}}>ℹ️ {notice}</div>
          )}

          {err && <div className="text-xs text-red-600">Error: {err}</div>}

          <div className="ml-auto flex items-center gap-2">
            <label className="text-sm text-gray-600">Display time zone:</label>
            <select className="border rounded-lg p-2 text-sm" value={displayTz} onChange={e=>setDisplayTz(e.target.value)}>
              {TZ_OPTS.map(z => <option key={z.id} value={z.id}>{z.label}</option>)}
            </select>
          </div>
        </div>

        {/* Per-source status */}
        <div className="text-xs text-gray-600 mb-3">
          {sources.map(s => (
            <div key={s.id}>
              <b>{s.name}</b>: {sourceCounts[s.id] ?? 0} events
              {lastFetchAt[s.id] && <> · updated {new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second:'2-digit' }).format(lastFetchAt[s.id])}</>}
              {fetchErrors[s.id] && <span className="text-red-600"> · err: {fetchErrors[s.id]}</span>}
            </div>
          ))}
        </div>

        {/* Filters + controls row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6 items-stretch">
          <div className="bg-white rounded-2xl shadow p-3 min-w-0">
            <h2 className="font-semibold mb-2">1) Calendars</h2>
            <div className="text-sm">Show calendars</div>
            <div className="flex flex-wrap gap-3 text-sm mt-2">
              {sources.filter(s => s.id !== PODCAST_ID).map(s => (
                <label key={s.id} className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={selectedIds.has(s.id)} onChange={() => toggleSelected(s.id)} />
                  {s.name}
                </label>
              ))}
            </div>

            <div className="divider" />
            <div className="text-sm font-medium mb-1">Permanent Schedule</div>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={selectedIds.has(PODCAST_ID)}
                onChange={() => toggleSelected(PODCAST_ID)}
              />
              {PODCAST_NAME}
            </label>
          </div>

          <div className="bg-white rounded-2xl shadow p-4 min-w-0">
            <h2 className="font-semibold mb-2">2) Date range</h2>
            <div className="flex items-center gap-2">
              <input type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)} className="border rounded-lg p-2 w-full min-w-0" />
              <span className="text-gray-500">to</span>
              <input type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)} className="border rounded-lg p-2 w-full min-w-0" />
            </div>
            <div className="text-xs text-gray-500 mt-2">{fmt(new Date(dateFrom))} – {fmt(new Date(dateTo))}</div>

            {/* Time slot view toggle (Matt & Hector) */}
            <div className="mt-3 flex items-center justify-between">
              <div className="text-sm text-gray-700">Time slot view (Matt & Hector)</div>
              <button
                className={`btn ${slotViewOn ? "btn-toggle-on" : ""}`}
                onClick={()=> setSlotViewOn(v => !v)}
              >
                {slotViewOn ? "Toggled on" : "Toggled off"}
              </button>
            </div>

            {/* Need more info toggle (purple day outline) */}
            <div className="mt-2 flex items-center justify-between">
              <div className="text-sm text-gray-700">Need more information days (“!”)</div>
              <button
                className={`btn ${outlineUrgent ? "btn-toggle-on" : ""}`}
                onClick={()=> setOutlineUrgent(v => !v)}
                title="Adds a faint purple outline/fill to days that include any '!' events"
              >
                {outlineUrgent ? "Toggled on" : "Toggled off"}
              </button>
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow p-4 min-w-0">
            <h2 className="font-semibold mb-2">3) Hours & View</h2>
            <div className="flex items-center gap-2 mb-3">
              <input type="number" min={0} max={23} value={workStart} onChange={e=>setWorkStart(clamp(parseInt(e.target.value||"0",10),0,23))} className="border rounded-lg p-2 w-20" />
              <span className="text-gray-500">to</span>
              <input type="number" min={1} max={24} value={workEnd} onChange={e=>setWorkEnd(clamp(parseInt(e.target.value||"24",10),1,24))} className="border rounded-lg p-2 w-20" />
              <span className="text-gray-500">o'clock</span>
            </div>
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3 text-sm">
                <label className="flex items-center gap-1 cursor-pointer"><input type="radio" name="v" checked={viewMode==='single'} onChange={()=>setViewMode('single')} /> Single month</label>
                <label className="flex items-center gap-1 cursor-pointer"><input type="radio" name="v" checked={viewMode==='range'}  onChange={()=>setViewMode('range')} /> Range</label>
              </div>
              {viewMode==='single' && (
                <div className="flex items-center gap-2">
                  <button className="px-2 py-1 border rounded text-sm" onClick={()=>setCurrentMonth(monthStart(addDays(currentMonth,-1)))}>&lt;</button>
                  <div className="text-sm text-gray-600 w-28 text-center">{new Date(currentMonth).toLocaleDateString(undefined,{month:'long',year:'numeric'})}</div>
                  <button className="px-2 py-1 border rounded text-sm" onClick={()=>setCurrentMonth(monthStart(addDays(monthEnd(currentMonth),1)))}>&gt;</button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Legend + counts (hidden when slot view is on) */}
        {!slotViewOn && (
          <div className="flex items-center gap-2 sm:gap-3 mb-3">
            <span className="text-sm font-medium">Legend:</span>
            <div className="flex items-center gap-1">
              {Array.from({length:10},(_,i)=>i/9).map(r=> (
                <div key={r} className="h-3 w-6 rounded" style={{ backgroundColor: colorForRatio(r) }} />
              ))}
            </div>
            <span className="text-xs text-gray-600">Less free → More free</span>
            <span className="text-xs text-gray-600 ml-3">“!” items = “Need more info”.</span>
            <span className="text-sm text-gray-600 ml-auto">Loaded events: <b>{events.length}</b></span>
          </div>
        )}

        <div className="grid md:grid-cols-[1fr_minmax(300px,360px)] gap-6 items-start">
          <div>
            {/* EITHER Dual time-slot agenda OR Heat map */}
            {slotViewOn ? (
              <DualAgenda
                mattEvents={mattEvents}
                hectorEvents={hectorEvents}
                fmt={fmt}
                fmtTime={fmtTime}
              />
            ) : (
              viewMode==='single'
                ? <MonthGrid
                    year={new Date(currentMonth).getFullYear()}
                    month={new Date(currentMonth).getMonth()}
                    from={monthStart(currentMonth)}
                    to={monthEnd(currentMonth)}
                    dayStats={dayStats}
                    setHoverDay={setHoverDay}
                    onClickDay={(k)=> setSelectedDay(prev => prev === k ? null : k)}
                    selectedDay={selectedDay}
                    colorForRatio={colorForRatio}
                    fmt={fmt}
                    fmtTime={fmtTime}
                    podcastOn={selectedIds.has(PODCAST_ID)}
                    outlineUrgent={outlineUrgent}
                  />
                : renderMonthGrid(new Date(dateFrom), new Date(dateTo))
            )}
          </div>

          {/* Sidebar (hover/click details) */}
          {!slotViewOn && (
            <aside className={selectedIds.has(PODCAST_ID) && activeDayKey && dayHasPodcast(activeDayKey) ? "rainbow-outline rounded-2xl" : ""}>
              {activeInfo
                ? <div className="bg-white rounded-2xl shadow p-4">
                    <h3 className="text-lg font-semibold">{fmt(activeInfo.date)}</h3>

                    {selectedIds.has(PODCAST_ID) && activeInfo.podcastItems?.length ? (
                      <div className="mt-2 mb-3">
                        <span className="rainbow-always">Podcast Recording</span>
                        <div className="mt-1 text-sm">
                          {activeInfo.podcastItems.map((it,i)=>(
                            <div key={i} className="mono">
                              {fmtTime(new Date(it.start))}–{fmtTime(new Date(it.end))} · <span className="font-medium">{it.summary}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    <p className="text-sm text-gray-600">
                      Group free: <span className="mono">{Math.round(activeInfo.freeMinutes)}</span> / <span className="mono">{Math.round(activeInfo.totalMinutes)}</span> min
                      <span className="chip">{pct(activeInfo.freeMinutes, activeInfo.totalMinutes)}% free</span>
                    </p>

                    <div className="mt-3">
                      <h4 className="font-medium text-sm mb-1">Per person (in selected hours)</h4>
                      <ul style={{maxHeight: 220, overflow: "auto", paddingRight: 4}}>
                        {activeInfo.perPerson.map(p => (
                          <li key={p.sourceId} className="text-sm mb-2">
  <div>
    <b>{p.sourceName}</b>
    <span className="chip">{pct(p.freeMinutes, activeInfo.totalMinutes)}% free</span>
  </div>

  {/* Busy ranges (already account for FREE overlays) */}
  {p.mergedBusy.length
    ? (
      <div className="muted">
        Busy:{" "}
        {p.mergedBusy.map(([s,e],i)=>(
          <span key={i} className="mono">
            {fmtTime(new Date(s))}–{fmtTime(new Date(e))}{i<p.mergedBusy.length-1?", ":""}
          </span>
        ))}
      </div>
    )
    : <div className="muted">Busy: none</div>
  }

  {/* NEW: Free slots (computed via invertIntervals) */}
  {p.freeBlocks.length
    ? (
      <div className="muted">
        Free:{" "}
        {p.freeBlocks.map(([s,e],i)=>(
          <span key={i} className="mono">
            {fmtTime(new Date(s))}–{fmtTime(new Date(e))}{i<p.freeBlocks.length-1?", ":""}
          </span>
        ))}
      </div>
    )
    : <div className="muted">Free: none</div>
  }
</li>
                        ))}
                      </ul>
                    </div>

                    {activeInfo.titles?.length ? (
                      <div className="mt-3">
                        <details>
                          <summary className="cursor-pointer text-sm font-medium">Show all events/titles</summary>
                          <ul className="text-sm mt-2 space-y-1">
                            {activeInfo.titles.map((t,i)=>(
                              <li key={i} className="flex items-start gap-2">
                                <span
                                  className="mt-1 inline-block w-2.5 h-2.5 rounded-full"
                                  style={{ background: t.isUrgent ? PURPLE_URGENT : colorForSource(t.sourceId) }}
                                  title={t.isUrgent ? "Need more information" : t.sourceName}
                                />
                                <div>
                                  <span className="mono">{fmtTime(new Date(t.start))}–{fmtTime(new Date(t.end))}</span>
                                  {" "}· <b>{t.sourceName}</b>: {t.summary || "Event"} {t.isUrgent ? <span className="tag tag-urgent">!</span> : null}
                                </div>
                              </li>
                            ))}
                          </ul>
                        </details>
                      </div>
                    ) : null}
                  </div>
                : <div className="text-sm text-gray-500 bg-white rounded-2xl shadow p-4">Hover or click a day to see details.</div>}
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}

/* ===== Dual Agenda (Matt & Hector side-by-side) ===== */
function DualAgenda({ mattEvents, hectorEvents, fmt, fmtTime }) {
  return (
    <div className="grid md:grid-cols-2 gap-4">
      <PersonAgenda person="Matt" events={mattEvents} fmt={fmt} fmtTime={fmtTime} />
      <PersonAgenda person="Hector" events={hectorEvents} fmt={fmt} fmtTime={fmtTime} />
    </div>
  );
}

function PersonAgenda({ person, events, fmt, fmtTime }) {
  const groups = useMemo(() => {
    const m = new Map();
    for (const e of events) {
      const k = e.start.toISOString().slice(0,10);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(e);
    }
    for (const [, list] of m) list.sort((a,b)=> a.start - b.start);
    return [...m.entries()].sort((a,b)=> a[0].localeCompare(b[0]));
  }, [events]);

  return (
    <div className="bg-white rounded-2xl shadow p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">{person} — Time slots</h3>
        <span className="text-xs text-gray-500">List view</span>
      </div>

      {!events.length ? (
        <div className="text-sm text-gray-600">No {person} events in the selected range.</div>
      ) : (
        <div className="space-y-3">
          {groups.map(([k, list]) => (
            <div key={k}>
              <div className="text-xs font-medium text-gray-500 mb-1">{fmt(new Date(k))}</div>
              <div className="space-y-2">
                {list.map((e, i) => (
                  <div key={i} className="flex items-start gap-3 p-2 border rounded-lg">
                    <div
                      className="w-1.5 rounded h-10"
                      style={{ background: e.isUrgent ? PURPLE_URGENT : colorForSource(e.sourceId) }}
                    />
                    <div className="flex-1">
                      <div className="text-sm font-medium">
                        {e.summary || "Event"} {e.isUrgent ? <span className="tag tag-urgent">!</span> : null}
                      </div>
                      <div className="text-xs text-gray-600 mono">
                        {e.allDay ? "All day" : `${fmtTime(e.start)}–${fmtTime(e.end)}`}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ===== Calendar Grid ===== */
function MonthGrid({ year, month, from, to, dayStats, setHoverDay, onClickDay, selectedDay, colorForRatio, fmt, fmtTime, podcastOn, outlineUrgent }){
  const first = new Date(year, month, 1);
  const startWeekday = (first.getDay() + 6) % 7; // Mon=0
  const daysInMonth = new Date(year, month+1, 0).getDate();

  const wrapRef = useRef(null);
  const gridWidth = useResizeWidth(wrapRef);
  const gap = 4;
  const cellSize = Math.max(28, Math.floor((gridWidth - gap * 6) / 7));
  const dayNumSize = Math.round(cellSize * 0.14);
  const pctSize    = Math.round(cellSize * 0.16);

  const cells=[];
  for(let i=0;i<startWeekday;i++) cells.push(<div key={"pad-"+i}/>);

  for(let day=1; day<=daysInMonth; day++){
    const date = new Date(year, month, day);
    if(date < startOfDay(from) || date > endOfDay(to)){
      cells.push(<div key={day} className="aspect-square rounded-xl border border-dashed border-gray-200 text-gray-300 flex items-start justify-end p-1 text-xs">{day}</div>);
      continue;
    }
    const k = dayKey(date);
    const info = dayStats[k];
    const r = info ? info.freeRatio : 0;

    const hasPodcast = podcastOn && info?.podcastItems?.length > 0;
    const selected = selectedDay === k;
    const urgentDecor = outlineUrgent && info?.hasUrgent;

    const title = `${fmt(date)} — ${pct(info?.freeMinutes||0, info?.totalMinutes||0)}% free` + (hasPodcast ? ` • ${info.podcastItems[0].summary}` : "");

    cells.push(
      <div
        key={day}
        onMouseEnter={()=>setHoverDay(k)}
        onMouseLeave={()=>setHoverDay(null)}
        onClick={()=> onClickDay?.(k)}
        className={`day-cell aspect-square rounded-2xl shadow-sm border border-gray-200 relative overflow-hidden cursor-pointer
          ${hasPodcast ? 'rainbow-outline' : ''} ${selected ? 'day-selected' : ''} ${urgentDecor ? 'urgent-outline urgent-faint' : ''}`}
        style={{ backgroundColor: colorForRatio(r) }}
        title={title}
      >
        <div className="absolute top-1 right-2 font-semibold text-gray-700/80" style={{ fontSize: Math.max(8, dayNumSize) }}>{day}</div>
        <div className="absolute bottom-1 left-2 font-medium text-gray-700/90" style={{ fontSize: Math.max(9, pctSize) }}>{pct(info?.freeMinutes||0, info?.totalMinutes||0)}%</div>
      </div>
    );
  }

  return (
    <div ref={wrapRef} className="bg-white rounded-2xl shadow p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">{first.toLocaleDateString(undefined,{month:"long",year:"numeric"})}</h3>
        <div className="text-xs text-gray-500">Mon–Sun</div>
      </div>
      <div className="grid grid-cols-7 gap-1 sm:gap-1 text-[clamp(10px,1.2vw,11px)] text-gray-500 mb-1">
        {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(d=> <div key={d} className="text-center">{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1 sm:gap-1">{cells}</div>
    </div>
  );
}
