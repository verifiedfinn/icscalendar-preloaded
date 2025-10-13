import React, { useEffect, useMemo, useState, useRef } from "react";
import ICALdefault, * as ICALns from "ical.js";
const ICAL = (ICALdefault && ICALdefault.parse) ? ICALdefault
           : (ICALns && ICALns.parse) ? ICALns
           : (() => { throw new Error("ical.js failed to load"); })();

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

// ---------- helpers ----------
const startOfDay = (d) => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
const endOfDay   = (d) => { const x = new Date(d); x.setHours(23,59,59,999); return x; };
const addDays    = (d,n)=> { const x = new Date(d); x.setDate(x.getDate()+n); return x; };
const monthStart = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const monthEnd   = (d) => new Date(d.getFullYear(), d.getMonth()+1, 0);
const dayKey     = (d) => d.toISOString().slice(0,10);
const fmt        = (d) => d.toLocaleDateString(undefined,{year:"numeric",month:"short",day:"numeric"});
const fmtTime    = (d) => d.toLocaleTimeString(undefined,{hour:"2-digit",minute:"2-digit"});
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
  for (const [s, e] of merged) {
    if (s > cur) out.push([cur, s]);
    cur = Math.max(cur, e);
    if (cur >= we) break;
  }
  if (cur < we) out.push([cur, we]);
  return out;
};

// ---- Preloaded calendars served from /public/calendars ----
const PRESET_CALENDARS = [
  { id: "hector", name: "Hector.ics", url: `${import.meta.env.BASE_URL}calendars/Hector.ics` },
  { id: "matt",   name: "Matt.ics",   url: `${import.meta.env.BASE_URL}calendars/Matt.ics` },
];

// ---------- ICS parsing ----------
function parseICSText(text, sourceId, sourceName){
  const jcal = ICAL.parse(text);
  const comp = new ICAL.Component(jcal);
  const vevents = comp.getAllSubcomponents("vevent");

  // tz support when available
  try {
    const register = ICAL?.TimezoneService?.register;
    if (register) {
      for (const tzComp of comp.getAllSubcomponents("vtimezone")) {
        try { const tz = new ICAL.Timezone({ component: tzComp }); if (tz?.tzid) register(tz.tzid, tz); } catch {}
      }
    }
  } catch {}

  const events=[];
  for (const v of vevents) {
    try {
      const e = new ICAL.Event(v);
      if (e.isRecurring()) {
        events.push({ sourceId, sourceName, summary: e.summary, isRecurring: true, component: v });
      } else {
        const s = e.startDate.toJSDate();
        const ee = e.endDate ? e.endDate.toJSDate() : new Date(s.getTime() + 30*60000);
        events.push({ sourceId, sourceName, summary: e.summary, start: s, end: ee, allDay: e.startDate.isDate, isRecurring: false });
      }
    } catch {}
  }
  return events;
}

// ---------- UI ----------
export default function App(){
  const [sources, setSources] = useState([]);        // [{id,name}]
  const [rawEvents, setRawEvents] = useState([]);    // parsed events (recurring placeholders + concrete)
  const [dateFrom, setDateFrom] = useState(()=> dayKey(new Date()));
  const [dateTo,   setDateTo]   = useState(()=> dayKey(addDays(new Date(),30)));
  const [workStart, setWorkStart] = useState(9);
  const [workEnd,   setWorkEnd]   = useState(17);
  const [viewMode, setViewMode] = useState("single");
  const [currentMonth, setCurrentMonth] = useState(()=> monthStart(new Date()));
  const [hoverDay, setHoverDay] = useState(null);
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");

  // which preset calendars are currently shown
  const [selectedIds, setSelectedIds] = useState(new Set());
  const toggleSelected = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Load presets on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loadedSources = [];
        const loadedEvents  = [];
        for (const p of PRESET_CALENDARS) {
          const resp = await fetch(p.url);
          if (!resp.ok) throw new Error(`Fetch failed for ${p.name} (${resp.status})`);
          const text = await resp.text();
          loadedSources.push({ id: p.id, name: p.name });
          loadedEvents.push(...parseICSText(text, p.id, p.name));
        }
        if (cancelled) return;

        setSources(loadedSources);
        setRawEvents(loadedEvents);
        setSelectedIds(new Set(loadedSources.map(s => s.id)));
        setNotice(`Loaded ${loadedSources.length} preset calendar${loadedSources.length>1?'s':''}.`);

        // Fit initial range to concrete events once
        const bounds = loadedEvents
          .filter(e => !e.isRecurring && e.start && e.end)
          .flatMap(e => [e.start.getTime(), e.end.getTime()]);
        if (bounds.length) {
          const min = new Date(Math.min(...bounds));
          const max = new Date(Math.max(...bounds));
          setDateFrom(dayKey(startOfDay(min)));
          setDateTo(dayKey(endOfDay(max)));
          setCurrentMonth(monthStart(min));
        }
      } catch (e) {
        setErr(`Preset load error: ${e?.message || e}`);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const rangeStart = useMemo(()=> new Date(dateFrom+"T00:00:00"), [dateFrom]);
  const rangeEnd   = useMemo(()=> new Date(dateTo  +"T23:59:59"), [dateTo]);

  // Expand recurrences within range, THEN filter by selectedIds (stable counts)
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
                                  : new Date(s.getTime() + 30*60000);
          if (ee < rangeStart) { if (++i > 5000) break; continue; }
          if (s  > rangeEnd) break;
          out.push({ sourceId:e.sourceId, sourceName:e.sourceName, summary:evt.summary, start:s, end:ee, allDay:next.isDate });
          if (++i > 5000) break;
        }
      } else if (!(e.end < rangeStart || e.start > rangeEnd)) {
        out.push(e);
      }
    }
    return out;
  }, [rawEvents, selectedIds, rangeStart, rangeEnd]);

  // Day aggregates (union + per-person)
  const dayStats = useMemo(()=>{
    const perDayAll = new Map();   // date -> intervals across all
    const perDayBySrc = new Map(); // date -> Map(sourceId -> {name, intervals})

    for(const ev of events){
      const s = ev.start.getTime(), e = ev.end.getTime();
      for(const seg of splitIntervalByDays(s,e)){
        const k=seg.date;
        if(!perDayAll.has(k)) perDayAll.set(k, []);
        perDayAll.get(k).push([seg.start, seg.end]);

        if(!perDayBySrc.has(k)) perDayBySrc.set(k, new Map());
        const m = perDayBySrc.get(k);
        if(!m.has(ev.sourceId)) m.set(ev.sourceId, { name: ev.sourceName, intervals: [] });
        m.get(ev.sourceId).intervals.push([seg.start, seg.end]);
      }
    }

    const res={};
    for(let d=new Date(rangeStart); d<=rangeEnd; d=addDays(d,1)){
      const k=dayKey(d);
      const ws=new Date(d); ws.setHours(workStart,0,0,0);
      const we=new Date(d); we.setHours(workEnd,0,0,0);
      const WS=ws.getTime(), WE=we.getTime();
      const total = minutesBetween(WS,WE);

      const allIntervals = (perDayAll.get(k)||[])
        .map(([a,b])=>[Math.max(a,WS), Math.min(b,WE)])
        .filter(([a,b])=>b>a);
      const mergedAll = mergeIntervals(allIntervals);
      const busyUnion = mergedAll.reduce((acc,[a,b])=> acc + minutesBetween(a,b), 0);
      const freeUnion = Math.max(0, total - busyUnion);

      const bySrcMap = perDayBySrc.get(k) || new Map();
      const perPerson = [];
      for (const [sid, {name, intervals}] of bySrcMap.entries()){
        const clipped = intervals.map(([a,b])=>[Math.max(a,WS), Math.min(b,WE)]).filter(([a,b])=>b>a);
        const merged = mergeIntervals(clipped);
        const busy = merged.reduce((acc,[a,b])=> acc + minutesBetween(a,b), 0);
        const free = Math.max(0, total - busy);
        const freeBlocks = invertIntervals(merged, WS, WE);
        perPerson.push({ sourceId: sid, sourceName: name, busyMinutes: busy, freeMinutes: free, freeRatio: total ? free/total : 0, mergedBusy: merged, freeBlocks });
      }
      // include selected people with no events that day (fully free)
      for (const s of sources) {
        if (!selectedIds.has(s.id)) continue;
        if (!(bySrcMap.has(s.id))) {
          perPerson.push({ sourceId: s.id, sourceName: s.name, busyMinutes: 0, freeMinutes: total, freeRatio: total ? 1 : 0, mergedBusy: [], freeBlocks: total ? [[WS, WE]] : [] });
        }
      }
      perPerson.sort((a,b)=> a.sourceName.localeCompare(b.sourceName));

      res[k] = { date:new Date(d), totalMinutes: total, freeMinutes: freeUnion, busyMinutes: busyUnion, freeRatio: total? freeUnion/total : 0, mergedBusy: mergedAll, perPerson };
    }
    return res;
  }, [events, sources, selectedIds, rangeStart, rangeEnd, workStart, workEnd]);

  const colorForRatio = (r)=>{ const hue = r*120, sat=70, light=90 - r*40; return `hsl(${hue}, ${sat}%, ${light}%)`; };

  const hoverDayInfo = hoverDay ? dayStats[hoverDay] : null;
  const singleFrom = monthStart(currentMonth);
  const singleTo   = monthEnd(currentMonth);

  function renderMonthGrid(from, to){
    const blocks=[]; let cur=startOfDay(from);
    while(cur<=to){
      const mStart=monthStart(cur); const mEnd=monthEnd(cur);
      const secFrom = cur<mStart? mStart : cur;
      const secTo   = to<mEnd  ? to   : mEnd;
      blocks.push(
        <MonthGrid key={`${mStart.getFullYear()}-${mStart.getMonth()}`}
          year={mStart.getFullYear()} month={mStart.getMonth()}
          from={secFrom} to={secTo}
          dayStats={dayStats} setHoverDay={setHoverDay} colorForRatio={colorForRatio}
        />
      );
      cur = addDays(mEnd,1);
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
      `}</style>

      <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <h1 className="text-3xl font-bold mb-2">Free Time Heatmap from ICS</h1>
        <p className="text-gray-600 mb-3">Preset calendars are loaded automatically. Toggle any person below.</p>
        {notice && <div className="mb-4 text-xs" style={{padding:"6px 10px", background:"#ecfeff", border:"1px solid #a5f3fc", borderRadius:8}}>ℹ️ {notice}</div>}
        {err && <div className="mb-4 text-xs text-red-600">{err}</div>}

        <div className="grid md:grid-cols-3 gap-4 mb-6">
          {/* Upload card removed for this repo. Keep this commented block if you want it back later.
          <div className="bg-white rounded-2xl shadow p-4"> …upload UI… </div>
          */}

          <div className="bg-white rounded-2xl shadow p-4">
            <h2 className="font-semibold mb-2">1) Calendars</h2>
            <div className="text-sm">Show calendars</div>
            <div className="flex flex-wrap gap-3 text-sm mt-2">
              {sources.map(s => (
                <label key={s.id} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(s.id)}
                    onChange={() => toggleSelected(s.id)}
                  />
                  {s.name}
                </label>
              ))}
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow p-4">
            <h2 className="font-semibold mb-2">2) Date range</h2>
            <div className="flex items-center gap-2">
              <input type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)} className="border rounded-lg p-2 w-full" />
              <span className="text-gray-500">to</span>
              <input type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)} className="border rounded-lg p-2 w-full" />
            </div>
            <div className="text-xs text-gray-500 mt-2">{fmt(new Date(dateFrom))} – {fmt(new Date(dateTo))}</div>
          </div>

          <div className="bg-white rounded-2xl shadow p-4">
            <h2 className="font-semibold mb-2">3) Hours & View</h2>
            <div className="flex items-center gap-2 mb-3">
              <input type="number" min={0} max={23} value={workStart} onChange={e=>setWorkStart(clamp(parseInt(e.target.value||"0",10),0,23))} className="border rounded-lg p-2 w-20" />
              <span className="text-gray-500">to</span>
              <input type="number" min={1} max={24} value={workEnd} onChange={e=>setWorkEnd(clamp(parseInt(e.target.value||"24",10),1,24))} className="border rounded-lg p-2 w-20" />
              <span className="text-gray-500">o'clock</span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3 text-sm">
                <label className="flex items-center gap-1 cursor-pointer"><input type="radio" name="v" checked={viewMode==='single'} onChange={()=>setViewMode('single')} /> Single month</label>
                <label className="flex items-center gap-1 cursor-pointer"><input type="radio" name="v" checked={viewMode==='range'}  onChange={()=>setViewMode('range')} /> Range</label>
              </div>
              {viewMode==='single' && (
                <div className="flex items-center gap-2">
                  <button className="px-2 py-1 border rounded text-sm" onClick={()=>setCurrentMonth(monthStart(addDays(currentMonth,-1)))}>&lt;</button>
                  <div className="text-sm text-gray-600 w-28 text-center">{singleFrom.toLocaleDateString(undefined,{month:'long',year:'numeric'})}</div>
                  <button className="px-2 py-1 border rounded text-sm" onClick={()=>setCurrentMonth(monthStart(addDays(monthEnd(currentMonth),1)))}>&gt;</button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3 mb-4">
          <span className="text-sm font-medium">Legend:</span>
          <div className="flex items-center gap-1">
            {Array.from({length:10},(_,i)=>i/9).map(r=> (
              <div key={r} className="h-3 w-6 rounded" style={{ backgroundColor: colorForRatio(r) }} />
            ))}
          </div>
          <span className="text-xs text-gray-600">Less free → More free</span>
          <span className="text-sm text-gray-600 ml-4">Loaded events: <b>{events.length}</b></span>
        </div>

        <div className="grid md:grid-cols-[1fr_minmax(300px,360px)] gap-6 items-start">
          <div>
            {viewMode==='single'
              ? <MonthGrid year={singleFrom.getFullYear()} month={singleFrom.getMonth()} from={singleFrom} to={singleTo} dayStats={dayStats} setHoverDay={setHoverDay} colorForRatio={colorForRatio}/>
              : renderMonthGrid(new Date(dateFrom), new Date(dateTo))
            }
          </div>

          <aside className="md:sticky md:top-6">
            {hoverDayInfo
              ? <div className="bg-white rounded-2xl shadow p-4">
                  <h3 className="text-lg font-semibold">{fmt(hoverDayInfo.date)}</h3>
                  <p className="text-sm text-gray-600">
                    Group free: <span className="mono">{Math.round(hoverDayInfo.freeMinutes)}</span> / <span className="mono">{hoverDayInfo.totalMinutes}</span> min
                    <span className="chip">{Math.round(hoverDayInfo.freeRatio*100)}% free</span>
                  </p>

                  <div className="mt-3">
                    <h4 className="font-medium text-sm mb-1">Per person (in selected hours)</h4>
                    <ul style={{maxHeight: 260, overflow: "auto", paddingRight: 4}}>
                      {hoverDayInfo.perPerson.map(p => (
                        <li key={p.sourceId} className="text-sm mb-2">
                          <div>
                            <b>{p.sourceName}</b>
                            <span className="chip">{Math.round(p.freeRatio*100)}% free</span>
                          </div>
                          {p.mergedBusy.length
                            ? <div className="muted">Busy: {p.mergedBusy.map(([s,e],i)=>(
                                <span key={i} className="mono">{fmtTime(new Date(s))}–{fmtTime(new Date(e))}{i<p.mergedBusy.length-1?", ":""}</span>
                              ))}</div>
                            : <div className="muted">Busy: none</div>}
                          {p.freeBlocks.length
                            ? <div className="muted">Free: {p.freeBlocks.map(([s,e],i)=>(
                                <span key={i} className="mono">{fmtTime(new Date(s))}–{fmtTime(new Date(e))}{i<p.freeBlocks.length-1?", ":""}</span>
                              ))}</div>
                            : <div className="muted">Free: —</div>}
                        </li>
                      ))}
                    </ul>
                  </div>

                  {hoverDayInfo.mergedBusy.length
                    ? <div className="mt-3">
                        <h4 className="font-medium text-sm mb-1">Group busy (union)</h4>
                        <ul className="text-sm list-disc list-inside text-gray-700">
                          {hoverDayInfo.mergedBusy.map(([s,e],i)=> <li key={i}>{fmtTime(new Date(s))} – {fmtTime(new Date(e))}</li>)}
                        </ul>
                      </div>
                    : <div className="mt-3 text-sm text-green-700">No conflicts in these hours 🎉</div>}
                </div>
              : <div className="text-sm text-gray-500 bg-white rounded-2xl shadow p-4">Hover a day to see details.</div>}
          </aside>
        </div>
      </div>
    </div>
  );
}

function MonthGrid({ year, month, from, to, dayStats, setHoverDay, colorForRatio }){
  const first = new Date(year, month, 1);
  const startWeekday = (first.getDay() + 6) % 7; // Mon=0
  const daysInMonth = new Date(year, month+1, 0).getDate();

  // measure grid width -> derive square size (roughly (width - gaps)/7)
  const wrapRef = useRef(null);
  const gridWidth = useResizeWidth(wrapRef);
  const gap = 8; // px gap between cells (Tailwind gap-2 ≈ 8px)
  const cellSize = Math.max(36, Math.floor((gridWidth - gap * 6) / 7)); // min 36px

  // scale labels with the cell
  const dayNumSize = Math.round(cellSize * 0.22);   // top-right day number
  const pctSize    = Math.round(cellSize * 0.24);   // bottom-left percentage

  const cells=[];
  for(let i=0;i<startWeekday;i++) cells.push(<div key={"pad-"+i}/>);
  for(let day=1; day<=daysInMonth; day++){
    const date = new Date(year, month, day);
    if(date < startOfDay(from) || date > endOfDay(to)){
      cells.push(<div key={day} className="aspect-square rounded-xl border border-dashed border-gray-200 text-gray-300 flex items-start justify-end p-1 text-xs">{day}</div>);
      continue;
    }
    const k = dayKey(date); const info=dayStats[k]; const r=info?info.freeRatio:0;
    cells.push(
      <div key={day} onMouseEnter={()=>setHoverDay(k)} onMouseLeave={()=>setHoverDay(null)}
           className="aspect-square rounded-xl shadow-sm border border-gray-200 relative overflow-hidden cursor-default"
           style={{ backgroundColor: colorForRatio(r) }} title={`${fmt(date)} — ${Math.round(r*100)}% free`}>
<div
  className="absolute top-1 right-2 font-semibold text-gray-700/80"
  style={{ fontSize: Math.max(10, dayNumSize) }}
>
  {day}
</div>
<div
  className="absolute bottom-1 left-2 font-medium text-gray-700/90"
  style={{ fontSize: Math.max(11, pctSize) }}
>
  {Math.round(r*100)}%
</div>
      </div>
    );
  }

return (
  <div ref={wrapRef} className="bg-white rounded-2xl shadow p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">{first.toLocaleDateString(undefined,{month:"long",year:"numeric"})}</h3>
        <div className="text-xs text-gray-500">Mon–Sun</div>
      </div>
      <div className="grid grid-cols-7 gap-2 sm:gap-2 text-[clamp(10px,1.5vw,12px)] text-gray-500 mb-2">
        {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(d=> <div key={d} className="text-center">{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-2 sm:gap-2">{cells}</div>
    </div>
  );
}
