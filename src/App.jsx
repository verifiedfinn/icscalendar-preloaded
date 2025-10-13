import React, { useEffect, useMemo, useRef, useState } from "react";
import ICAL from "ical.js";

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
// complement of merged intervals within [ws,we)
const invertIntervals = (merged, ws, we) => {
  const out = [];
  let cur = ws;
  for (const [s, e] of merged) {
    if (s > cur) out.push([cur, s]);
    cur = Math.max(cur, e);
    if (cur >= we) break;
  }
  if (cur < we) out.push([cur, we]);
  return out;
};

// ---------- simple local persistence ----------
const STORAGE_KEY = "ics_saved_v1"; // stores [{id,name,text}]
function getSaved() {
  try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : []; } catch { return []; }
}
function setSaved(arr) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(arr)); return true; } catch (e) { return e; }
}
function clearSaved() { try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

// ---------- ICS parsing (v2 safe) ----------
function parseICSText(text, sourceId, sourceName){
  const jcal = ICAL.parse(text);
  const comp = new ICAL.Component(jcal);
  const vevents = comp.getAllSubcomponents("vevent");
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
    } catch (err) { console.warn("Failed vevent", err); }
  }
  return events;
}

// ---------- UI ----------
export default function App(){
  const [sources, setSources] = useState([]); // {id,name}
  const [files, setFiles] = useState([]);     // names for display
  const [rawEvents, setRawEvents] = useState([]);
  const [dateFrom, setDateFrom] = useState(()=> dayKey(new Date()));
  const [dateTo,   setDateTo]   = useState(()=> dayKey(addDays(new Date(),30)));
  const [workStart, setWorkStart] = useState(9);
  const [workEnd,   setWorkEnd]   = useState(17);
  const [viewMode, setViewMode] = useState("single");
  const [currentMonth, setCurrentMonth] = useState(()=> monthStart(new Date()));
  const [hoverDay, setHoverDay] = useState(null);
  const [err, setErr] = useState("");
  const [remember, setRemember] = useState(true);
  const [notice, setNotice] = useState("");

  const inputRef = useRef(null);

  // Stop browser default file-open on drop
  useEffect(()=>{
    const pd=(e)=>e.preventDefault();
    window.addEventListener("dragover", pd);
    window.addEventListener("drop", pd);
    return ()=>{ window.removeEventListener("dragover", pd); window.removeEventListener("drop", pd); };
  },[]);

  // On load: auto-load saved calendars (if any)
  useEffect(()=>{
    const saved = getSaved();
    if (saved && saved.length) {
      const newSources = []; const newNames = []; const newEvents = [];
      for (const s of saved) {
        const id = s.id || `saved_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const name = s.name || "saved.ics";
        try {
          newSources.push({ id, name });
          newNames.push(name);
          newEvents.push(...parseICSText(s.text, id, name));
        } catch(e) {
          setErr(prev => (prev? prev+" • ":"") + `Failed saved ${name}: ${e?.message||e}`);
        }
      }
      if (newSources.length) {
        setSources(prev=>[...prev, ...newSources]);
        setFiles(prev=>[...prev, ...newNames]);
        setRawEvents(prev=>[...prev, ...newEvents]);
        setNotice(`Loaded ${newSources.length} saved calendar${newSources.length>1?"s":""}.`);
        // fit range
        const bounds = newEvents.filter(e=>!e.isRecurring && e.start && e.end).flatMap(e=>[e.start.getTime(), e.end.getTime()]);
        if(bounds.length){
          const min = new Date(Math.min(...bounds));
          const max = new Date(Math.max(...bounds));
          setDateFrom(dayKey(startOfDay(min))); setDateTo(dayKey(endOfDay(max))); setCurrentMonth(monthStart(min));
        }
      }
    }
  },[]);

  async function handleFiles(fileList){
    setErr("");
    if(!fileList || !fileList.length) return;
    const fs = Array.from(fileList);

    const newNames = []; const newSources = []; const newEvents = []; const toSave = [];
    let idx = 0;
    for (const f of fs){
      const id = `${Date.now()}_${idx++}`;
      const name = f.name || `calendar-${idx}.ics`;
      newSources.push({ id, name }); newNames.push(name);
      try {
        const text = await f.text();
        newEvents.push(...parseICSText(text, id, name));
        if (remember) toSave.push({ id, name, text });
      } catch(e){ setErr(prev => (prev? prev+" • ":"") + `Failed ${name}: ${e?.message||e}`); }
    }

    setSources(prev => [...prev, ...newSources]);
    setFiles(prev => [...prev, ...newNames]);
    setRawEvents(prev => [...prev, ...newEvents]);

    // persist if asked
    if (remember && toSave.length){
      const cur = getSaved();
      const merged = [...cur, ...toSave];
      const result = setSaved(merged);
      if (result !== true) {
        setErr(prev => (prev? prev+" • ":"") + "Could not save calendars locally (storage full or blocked). They still load for this session.");
      } else {
        setNotice(`Saved ${toSave.length} calendar${toSave.length>1?"s":""} on this device.`);
      }
    }

    // auto fit range to concrete (non-recurring) events
    const bounds = newEvents.filter(e=>!e.isRecurring && e.start && e.end)
                            .flatMap(e=>[e.start.getTime(), e.end.getTime()]);
    if(bounds.length){
      const min = new Date(Math.min(...bounds));
      const max = new Date(Math.max(...bounds));
      setDateFrom(dayKey(startOfDay(min)));
      setDateTo(dayKey(endOfDay(max)));
      setCurrentMonth(monthStart(min));
    }
  }

  // Sample with TWO calendars so per-person view is obvious
  function loadSample(){
    const A = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Sample A//EN
BEGIN:VEVENT
UID:a1
DTSTART:20251015T150000Z
DTEND:20251015T160000Z
SUMMARY:A Overlap 1
END:VEVENT
BEGIN:VEVENT
UID:a2
DTSTART:20251020T090000Z
DTEND:20251020T110000Z
SUMMARY:A Morning
END:VEVENT
END:VCALENDAR`;
    const B = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Sample B//EN
BEGIN:VEVENT
UID:b1
DTSTART:20251015T153000Z
DTEND:20251015T170000Z
SUMMARY:B Overlap 2
END:VEVENT
BEGIN:VEVENT
UID:b2
DTSTART:20251022T130000Z
DTEND:20251022T150000Z
SUMMARY:B Afternoon
END:VEVENT
END:VCALENDAR`;
    const id1 = `sample_${Date.now()}_1`, id2 = `sample_${Date.now()}_2`;
    setSources(prev=>[...prev, {id:id1, name:"sample-a.ics"}, {id:id2, name:"sample-b.ics"}]);
    setFiles(prev=>[...prev, "sample-a.ics", "sample-b.ics"]);
    setRawEvents(prev=>[...prev, ...parseICSText(A,id1,"sample-a.ics"), ...parseICSText(B,id2,"sample-b.ics")]);
    setDateFrom("2025-10-01"); setDateTo("2025-10-31"); setCurrentMonth(new Date(2025,9,1));
  }

  const rangeStart = useMemo(()=> new Date(dateFrom+"T00:00:00"), [dateFrom]);
  const rangeEnd   = useMemo(()=> new Date(dateTo  +"T23:59:59"), [dateTo]);

  // expand recurrences within range
  const events = useMemo(()=>{
    const out=[];
    for(const e of rawEvents){
      if(e.isRecurring){
        const evt = new ICAL.Event(e.component);
        const it = evt.iterator();
        let next; let i=0;
        while((next=it.next())){
          const s = next.toJSDate();
          const ee = evt.duration ? next.clone().addDuration(evt.duration).toJSDate() : new Date(s.getTime()+30*60000);
          if(ee < rangeStart){ if(++i>5000) break; continue; }
          if(s > rangeEnd) break;
          out.push({ sourceId:e.sourceId, sourceName:e.sourceName, summary: evt.summary, start: s, end: ee, allDay: next.isDate });
          if(++i>5000) break;
        }
      } else if (!(e.end < rangeStart || e.start > rangeEnd)){
        out.push(e);
      }
    }
    return out;
  }, [rawEvents, rangeStart, rangeEnd]);

  // day aggregates (union + per-person)
  const dayStats = useMemo(()=>{
    const perDayAll = new Map();          // date -> intervals across all
    const perDayBySrc = new Map();        // date -> Map(sourceId -> {name, intervals})

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
        .map(([a,b])=>[clamp(a,WS,WE), clamp(b,WS,WE)])
        .filter(([a,b])=>b>a);
      const mergedAll = mergeIntervals(allIntervals);
      const busyUnion = mergedAll.reduce((acc,[a,b])=> acc + minutesBetween(a,b), 0);
      const freeUnion = Math.max(0, total - busyUnion);

      // per-person summary
      const bySrcMap = perDayBySrc.get(k) || new Map();
      const perPerson = [];
      for (const [sid, {name, intervals}] of bySrcMap.entries()){
        const clipped = intervals.map(([a,b])=>[clamp(a,WS,WE), clamp(b,WS,WE)]).filter(([a,b])=>b>a);
        const merged = mergeIntervals(clipped);
        const busy = merged.reduce((acc,[a,b])=> acc + minutesBetween(a,b), 0);
        const free = Math.max(0, total - busy);
        const freeBlocks = invertIntervals(merged, WS, WE);
        perPerson.push({ sourceId: sid, sourceName: name, busyMinutes: busy, freeMinutes: free, freeRatio: total ? free/total : 0, mergedBusy: merged, freeBlocks });
      }
      // include people with no events that day (fully free)
      for (const s of sources) {
        if (!(bySrcMap.has(s.id))) {
          perPerson.push({ sourceId: s.id, sourceName: s.name, busyMinutes: 0, freeMinutes: total, freeRatio: total ? 1 : 0, mergedBusy: [], freeBlocks: total ? [[WS, WE]] : [] });
        }
      }
      perPerson.sort((a,b)=> a.sourceName.localeCompare(b.sourceName));

      res[k] = { date:new Date(d), totalMinutes: total, freeMinutes: freeUnion, busyMinutes: busyUnion, freeRatio: total? freeUnion/total : 0, mergedBusy: mergedAll, perPerson };
    }
    return res;
  }, [events, sources, rangeStart, rangeEnd, workStart, workEnd]);

  const colorForRatio = (r)=>{ const hue = r*120, sat=70, light=90 - r*40; return `hsl(${hue}, ${sat}%, ${light}%)`; };

  const hoverInfo = hoverDay ? dayStats[hoverDay] : null;
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
      {/* FORCE LIGHT CONTROLS */}
      <style>{`
        :root { color-scheme: light !important; }
        input, select, textarea, button { background:#fff !important; color:#111 !important; }
        input[type="date"], input[type="number"] { background:#fff !important; color:#111 !important; }
        .chip{display:inline-block;padding:2px 8px;border:1px solid #ddd;border-radius:9999px;font-size:12px;line-height:18px;margin-left:6px;}
        .muted{color:#6b7280;}
        .mono{font-variant-numeric: tabular-nums;}
      `}</style>

      <div className="max-w-6xl mx-auto p-6">
        <h1 className="text-3xl font-bold mb-2">Free Time Heatmap from ICS</h1>
        <p className="text-gray-600 mb-3">Drop .ics files or use the button. Color shows how free the group is within selected hours.</p>
        {notice && <div className="mb-4 text-xs" style={{padding:"6px 10px", background:"#ecfeff", border:"1px solid #a5f3fc", borderRadius:8}}>ℹ️ {notice}</div>}

        <div className="grid md:grid-cols-3 gap-4 mb-6">
          <div className="bg-white rounded-2xl shadow p-4"
               onDrop={(e)=>{e.preventDefault(); handleFiles(e.dataTransfer?.files);}}
               onDragOver={(e)=>e.preventDefault()}>
            <h2 className="font-semibold mb-2">1) Calendars</h2>
            <label htmlFor="file" className="block w-full border-2 border-dashed border-gray-300 rounded-xl p-6 text-center cursor-pointer hover:border-gray-400">
              <input ref={inputRef} id="file" type="file" accept=".ics,text/calendar" multiple className="hidden"
                     onChange={(e)=>{handleFiles(e.target.files); e.target.value="";}} />
              <div className="text-sm">Click to pick files <span className="text-gray-400">or drag & drop here</span></div>
              <div className="text-xs text-gray-500 mt-1">Parsing happens in your browser.</div>
            </label>
            <div className="flex flex-wrap items-center gap-2 mt-3">
              <button onClick={()=>inputRef.current?.click()} className="px-3 py-1.5 rounded-lg border text-sm">Load .ics</button>
              <button onClick={()=>{setFiles([]); setRawEvents([]); setSources([]);}} className="px-3 py-1.5 rounded-lg border text-sm">Clear</button>
              <button onClick={loadSample} className="px-3 py-1.5 rounded-lg border text-sm ">Load sample</button>
            </div>
            <div className="flex items-center gap-2 mt-3 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" checked={remember} onChange={(e)=>setRemember(e.target.checked)} /> Remember on this device</label>
              <button className="px-2 py-1 border rounded text-xs" onClick={()=>{clearSaved(); setNotice("Cleared saved calendars.");}}>Forget saved</button>
            </div>
            {files.length>0 && <div className="mt-3 text-xs text-gray-600">Loaded: {files.join(", ")}</div>}
            {err && <div className="mt-2 text-xs text-red-600">{err}</div>}
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

        <div className="flex items-center gap-3 mb-4">
          <span className="text-sm font-medium">Legend:</span>
          <div className="flex items-center gap-1">
            {Array.from({length:10},(_,i)=>i/9).map(r=> (
              <div key={r} className="h-3 w-6 rounded" style={{ backgroundColor: colorForRatio(r) }} />
            ))}
          </div>
          <span className="text-xs text-gray-600">Less free → More free</span>
          <span className="text-sm text-gray-600 ml-4">Loaded events: <b>{events.length}</b></span>
        </div>

        <div className="grid md:grid-cols-[1fr_360px] gap-6 items-start">
          <div>
            {viewMode==='single'
              ? <MonthGrid year={singleFrom.getFullYear()} month={singleFrom.getMonth()} from={singleFrom} to={singleTo} dayStats={dayStats} setHoverDay={setHoverDay} colorForRatio={colorForRatio}/>
              : renderMonthGrid(new Date(dateFrom), new Date(dateTo))
            }
          </div>

          <aside className="md:sticky md:top-6">
            {hoverInfo
              ? <div className="bg-white rounded-2xl shadow p-4">
                  <h3 className="text-lg font-semibold">{fmt(hoverInfo.date)}</h3>
                  <p className="text-sm text-gray-600">
                    Group free: <span className="mono">{Math.round(hoverInfo.freeMinutes)}</span> / <span className="mono">{hoverInfo.totalMinutes}</span> min
                    <span className="chip">{Math.round(hoverInfo.freeRatio*100)}% free</span>
                  </p>

                  <div className="mt-3">
                    <h4 className="font-medium text-sm mb-1">Per person (in selected hours)</h4>
                    <ul style={{maxHeight: 260, overflow: "auto", paddingRight: 4}}>
                      {hoverInfo.perPerson.map(p => (
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

                  {hoverInfo.mergedBusy.length
                    ? <div className="mt-3">
                        <h4 className="font-medium text-sm mb-1">Group busy (union)</h4>
                        <ul className="text-sm list-disc list-inside text-gray-700">
                          {hoverInfo.mergedBusy.map(([s,e],i)=> <li key={i}>{fmtTime(new Date(s))} – {fmtTime(new Date(e))}</li>)}
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
        <div className="absolute top-1 right-2 text-[10px] font-semibold text-gray-700/80">{day}</div>
        <div className="absolute bottom-1 left-2 text-[11px] font-medium text-gray-700/90">{Math.round(r*100)}%</div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl shadow p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">{first.toLocaleDateString(undefined,{month:"long",year:"numeric"})}</h3>
        <div className="text-xs text-gray-500">Mon–Sun</div>
      </div>
      <div className="grid grid-cols-7 gap-2 text-xs text-gray-500 mb-2">
        {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(d=> <div key={d} className="text-center">{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-2">{cells}</div>
    </div>
  );
}
