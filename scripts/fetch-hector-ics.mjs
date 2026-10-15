#!/usr/bin/env node
// Fetches the Artist Growth ICS for Las Cafeteras, keeps only Hector-relevant
// events, tags hotel/lodging entries as LOCATION (not busy), and writes the
// filtered ICS to public/calendars/Hector.ics.
//
// For single-day all-day events it also extracts the real time window from the
// SCHEDULE section in DESCRIPTION, replacing the all-day VALUE=DATE fields with
// UTC DTSTART/DTEND so the heat-map shows the actual busy window.
//
// Run manually:  node scripts/fetch-hector-ics.mjs
// Runs automatically via .github/workflows/update-hector.yml every 6 hours.

import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Configuration ─────────────────────────────────────────────────────────────

const LIVE_URL =
  "https://web.artistgrowth.com/artist/7e34ce41-f3f2-4f2d-af93-43e3a3eddf71/events/ics/?key=eba67398e868dbdc2cc371ef46162658c7a2e455&cb=847fb0136e0a";

// Events matching this in ANY text field are kept as Hector-specific events.
// "HF" = Hector Flores's initials as they appear in Artist Growth.
const HECTOR_RE = /hector|\bhf\b/i;

// Band-wide show/performance events are included regardless — Hector performs
// at every Las Cafeteras show.
const SHOW_RE =
  /las\s*cafeteras|\bshow\b|\bconcert\b|\bperformance\b|\bmatinee\b|\bgig\b|\bfestival\b|show\s*time|musicians\s*arrive/i;

// Band-wide travel days. Artist Growth often files tour travel ("FLY TO NEVADA",
// "TRAVEL HOME", "Fly to Indiana", "Fly home") with no personnel listed, so
// neither HECTOR_RE nor SHOW_RE matches and the day silently disappears.
// Hector performs at every show, so a travel entry that sits within
// TRAVEL_ADJ_DAYS of a kept show/Hector event is treated as his travel too.
const TRAVEL_RE = /\b(travel|fly|flight|flights|drive|driving|road\s*trip|airport)\b/i;
// ...unless the SUMMARY names other people ("Dancers FLY HOME",
// "John & Mijangos Flight", "Jasmine Flight Home", "Flight BUR>LGA - JM,JJ,AD,AG").
// Names are case-insensitive; the initials list is case-sensitive so ordinary
// words like "TO" in "FLY TO NEVADA" don't trip it. HF-tagged events never
// reach this check (HECTOR_RE keeps them first).
const OTHER_PEOPLE_RE =
  /\b(dancers?|crew|lina|dante|jen|john|mijangos|jasmine?|jaz|denise|moi|xoco|chuy|alih|aunya|diego)\b/i;
const OTHER_INITIALS_RE = /\b(DC|JM|JJ|JL|MB|AD|AG|LD)\b/;
const TRAVEL_ADJ_DAYS = 2;

// Hotel detection checked against SUMMARY only.
// Artist Growth adds an "ACCOMMODATIONS:" header to nearly every event's
// DESCRIPTION template, so checking DESCRIPTION produces false positives.
// Real hotel entries always surface "Hotel"/"Inn"/etc. in SUMMARY.
const HOTEL_RE =
  /\b(hotel|inn|suite|motel|lodge|airbnb|accommodation|lodging)\b/i;

// UTC offsets for timezone abbreviations that appear in Artist Growth schedules.
const TZ_OFFSET = {
  PDT: -7, PST: -8,
  CDT: -5, CST: -6,
  EDT: -4, EST: -5,
  MDT: -6, MST: -7,
};

// ── ICS line helpers ──────────────────────────────────────────────────────────

// RFC 5545 line unfolding: a continuation line starts with a space or tab.
function unfold(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n[ \t]/g, '');
}

// Value after the first colon on a property line.
function propVal(line) {
  const i = line.indexOf(':');
  return i >= 0 ? line.slice(i + 1) : '';
}

// ICS text-value unescaping. We keep \n as a real newline so that
// DESCRIPTION fields can be parsed line-by-line for schedule entries.
function unescape(val) {
  return val
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

// ── Schedule time parsing ─────────────────────────────────────────────────────

// Parse "H:MM AM/PM" → minutes since midnight (null on failure).
function parse12h(str) {
  const m = str.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = m[3].toUpperCase();
  if (ap === 'AM' && h === 12) h = 0;       // 12:00 AM → midnight
  else if (ap === 'PM' && h !== 12) h += 12; // 12:30 PM → 12:30, 1:00 PM → 13:00
  return h * 60 + min;
}

// Convert (YYYYMMDD date string, minutes-since-midnight, TZ abbreviation) → UTC
// datetime string in ICS format: "YYYYMMDDTHHmmssZ".
function toUtcString(yyyymmdd, minutes, tzAbbr) {
  const offset = TZ_OFFSET[tzAbbr?.toUpperCase()] ?? -7; // default PDT
  const y  = parseInt(yyyymmdd.slice(0, 4), 10);
  const mo = parseInt(yyyymmdd.slice(4, 6), 10) - 1;
  const d  = parseInt(yyyymmdd.slice(6, 8), 10);
  const h  = Math.floor(minutes / 60);
  const mn = minutes % 60;
  // Subtract the local offset to get UTC (offset is negative west of UTC)
  const utc = new Date(Date.UTC(y, mo, d, h - offset, mn, 0));
  const p2 = n => String(n).padStart(2, '0');
  return `${utc.getUTCFullYear()}${p2(utc.getUTCMonth()+1)}${p2(utc.getUTCDate())}` +
         `T${p2(utc.getUTCHours())}${p2(utc.getUTCMinutes())}00Z`;
}

// Extract the real start/end window from an Artist Growth SCHEDULE section.
//
// The SCHEDULE section looks like:
//   SCHEDULE:
//    3:00 PM - 5:30 PM PDT: Load/in & Sound
//   ----------------------------------------
//    8:00 PM - 9:30 PM PDT: Showtime 90min
//   ----------------------------------------
//    9:30 PM - 10:00 PM PDT: Lobby meet & greet
//
// Entries with no time after the dash (e.g. "12:00 AM -  PDT: Rental Car")
// are logistics placeholders — they are intentionally skipped.
// Entries at exactly midnight (12:00 AM) are also skipped.
//
// Returns { startMin, endMin, tz } or null if no usable entries found.
function extractScheduleTimes(description) {
  // Find the SCHEDULE: section — runs until the next ***** block or end of string.
  const m = description.match(/SCHEDULE:\s*([\s\S]*?)(?:\*{5,}|$)/i);
  if (!m) return null;
  const text = m[1];

  // Pattern: "H:MM AM/PM [- [M/D/YYYY ]H:MM AM/PM] TZ:"
  // The timezone abbreviation must appear immediately before the colon separator.
  // This means "12:00 AM -  PDT:" won't match because there is no time between
  // the dash and the timezone.
  const TIME_RE =
    /(\d{1,2}:\d{2}\s*[AP]M)\s*(?:-\s*(?:\d{1,2}\/\d{1,2}\/\d{4}\s+)?(\d{1,2}:\d{2}\s*[AP]M)\s*)?\s*(PDT|CDT|EDT|MDT|PST|CST|EST|MST)\s*:/gi;

  const entries = [];
  let hit;
  while ((hit = TIME_RE.exec(text)) !== null) {
    const startMin = parse12h(hit[1]);
    if (startMin === null) continue;
    if (startMin === 0) continue; // midnight = all-day placeholder, skip

    const endMin = hit[2] ? parse12h(hit[2]) : null;
    entries.push({ startMin, endMin, tz: hit[3] });
  }

  if (!entries.length) return null;

  const tz     = entries[0].tz;
  const starts = entries.map(e => e.startMin);
  const ends   = entries.filter(e => e.endMin !== null).map(e => e.endMin);

  // Require at least one entry with a real duration (end > start + 30 min) OR
  // multiple distinct start times. Cross-day logistics entries (rental cars,
  // etc.) produce endMin == startMin and we skip those to avoid fabricating
  // times for all-day travel events.
  const hasRealDuration   = entries.some(e => e.endMin !== null && e.endMin > e.startMin + 30);
  const hasMultipleStarts = new Set(starts).size > 1;
  if (!hasRealDuration && !hasMultipleStarts) return null;

  const minStart = Math.min(...starts);
  // Use the latest explicit end time; fall back to +2h after the last start.
  let maxEnd = ends.length ? Math.max(...ends) : Math.max(...starts) + 120;
  // Guard against a zero/negative window (e.g. a cross-day end that resolved
  // to the same minute as the start).
  if (maxEnd <= minStart) maxEnd = minStart + 120;

  return { startMin: minStart, endMin: maxEnd, tz };
}

// Days between two YYYYMMDD strings (b − a).
function dateDiffDays(a, b) {
  const parse = s => new Date(+s.slice(0,4), +s.slice(4,6)-1, +s.slice(6,8));
  return Math.round((parse(b) - parse(a)) / 86400000);
}

// ── Parse all VEVENTs from raw ICS text ───────────────────────────────────────
// Returns an array of { rawLines, fields }.
// rawLines: original (possibly folded) lines for faithful re-output.
// fields:   property name → unescaped string value for filtering / time parsing.

function parseVEvents(rawText) {
  const origLines = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const flatLines = unfold(rawText).split('\n');

  const events = [];
  let cur = null;
  for (const line of origLines) {
    const t = line.trim();
    if (t === 'BEGIN:VEVENT') { cur = []; }
    if (cur !== null) cur.push(line);
    if (t === 'END:VEVENT' && cur) { events.push({ rawLines: cur, fields: {} }); cur = null; }
  }

  let idx = -1;
  for (const line of flatLines) {
    const t = line.trim();
    if (t === 'BEGIN:VEVENT') { idx++; continue; }
    if (t === 'END:VEVENT')   continue;
    if (idx < 0 || idx >= events.length) continue;

    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const prop = line.slice(0, colon).toUpperCase().split(';')[0]; // strip params
    const val  = unescape(propVal(line));

    const f = events[idx].fields;
    // Append for multi-line properties (DESCRIPTION can be long)
    f[prop] = f[prop] ? f[prop] + '\n' + val : val;
  }

  return events;
}

// ── Filtering helpers ─────────────────────────────────────────────────────────

function textFields(fields) {
  return [fields.SUMMARY, fields.DESCRIPTION, fields.LOCATION, fields.COMMENT]
    .map(v => v || '');
}

const isHectorEvent = fields => textFields(fields).some(v => HECTOR_RE.test(v));
const isShowEvent   = fields => textFields(fields).some(v => SHOW_RE.test(v));
// A show whose venue is a hotel ("Hotel Congress DDM show") is a show, not lodging.
const isHotelEvent  = fields => HOTEL_RE.test(fields.SUMMARY || '') && !SHOW_RE.test(fields.SUMMARY || '');
const isTravelEvent = fields => {
  const sum = fields.SUMMARY || '';
  return TRAVEL_RE.test(sum) && !OTHER_PEOPLE_RE.test(sum) && !OTHER_INITIALS_RE.test(sum);
};

// Calendar-date span of an event as YYYYMMDD strings (DTEND is exclusive for
// all-day events; for timed events the UTC date is close enough for adjacency).
function eventDateRange(fields) {
  const sm = (fields.DTSTART || '').match(/(\d{8})/);
  if (!sm) return null;
  const em = (fields.DTEND || '').match(/(\d{8})/);
  return { s: sm[1], e: em ? em[1] : sm[1] };
}

// ── Build output lines for a single kept event ────────────────────────────────

function buildEventLines(ev, isHotel, isTravel = false) {
  const { rawLines, fields } = ev;

  // For single-day all-day events, try to replace VALUE=DATE with real UTC times.
  let inject = null;
  if (!isHotel) {
    const startRaw = rawLines.find(l => /^DTSTART/i.test(l.trim()));
    const endRaw   = rawLines.find(l => /^DTEND/i.test(l.trim()));

    if (startRaw && endRaw) {
      const sm = startRaw.match(/VALUE=DATE:(\d{8})/);
      const em = endRaw.match(/VALUE=DATE:(\d{8})/);

      if (sm && em && dateDiffDays(sm[1], em[1]) === 1) {
        const times = extractScheduleTimes(fields.DESCRIPTION || '');
        if (times) {
          inject = {
            start: `DTSTART:${toUtcString(sm[1], times.startMin, times.tz)}`,
            end:   `DTEND:${toUtcString(sm[1], times.endMin, times.tz)}`,
            label: `${sm[1]} → ${times.startMin}–${times.endMin} min (${times.tz})`,
          };
        }
      }
    }
  }

  const out = [];
  for (const ln of rawLines) {
    const t = ln.trim();
    if (inject) {
      if (/^DTSTART/i.test(t)) { out.push(inject.start); continue; }
      if (/^DTEND/i.test(t))   { out.push(inject.end);   continue; }
    }
    if (t === 'END:VEVENT') {
      if (isHotel)  out.push('X-HECTOR-TYPE:LOCATION');
      if (isTravel) out.push('X-HECTOR-REASON:TRAVEL-ADJACENT');
      if (inject)   out.push(`X-HECTOR-SCHED:${inject.label}`);
      out.push('END:VEVENT');
    } else {
      out.push(ln.trimEnd());
    }
  }
  return out;
}

// ── Extract calendar preamble (everything before first VEVENT) ────────────────

function extractPreamble(rawText) {
  const lines = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const preamble = [];
  for (const line of lines) {
    const t = line.trim();
    if (t === 'BEGIN:VEVENT' || t === 'END:VCALENDAR') break;
    if (t) preamble.push(t);
  }
  return preamble;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Fetching live ICS from Artist Growth…');
  const resp = await fetch(LIVE_URL);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${LIVE_URL}`);
  const raw = await resp.text();
  console.log(`Fetched ${raw.length} bytes`);

  const allEvents = parseVEvents(raw);
  console.log(`Total events in calendar: ${allEvents.length}`);

  const kept = [];
  const dropped = [];
  let hotelCt = 0, showCt = 0, hectorCt = 0, travelCt = 0;

  for (const ev of allEvents) {
    const { fields } = ev;
    const hector = isHectorEvent(fields);
    const show   = isShowEvent(fields);
    const hotel  = isHotelEvent(fields);

    if (!hector && !show) { dropped.push(ev); continue; } // no Hector/show mention
    if (hotel && !hector) continue;   // band-wide hotel entry, not Hector's room

    if (hector) hectorCt++;
    if (show && !hector) showCt++;
    if (hotel) hotelCt++;

    kept.push({ ev, isHotel: hotel });
  }

  // Second pass: band-wide travel that brackets a kept show/Hector event.
  const anchors = kept
    .filter(k => !k.isHotel)
    .map(k => eventDateRange(k.ev.fields))
    .filter(Boolean);

  for (const ev of dropped) {
    const { fields } = ev;
    if (!isTravelEvent(fields) || isHotelEvent(fields)) continue;
    const r = eventDateRange(fields);
    if (!r) continue;
    const near = anchors.some(a =>
      dateDiffDays(a.e, r.s) <= TRAVEL_ADJ_DAYS && dateDiffDays(r.e, a.s) <= TRAVEL_ADJ_DAYS);
    if (!near) {
      console.log(`  ✈ skipped travel (no show within ${TRAVEL_ADJ_DAYS}d): ${r.s} ${(fields.SUMMARY || '').slice(0, 50)}`);
      continue;
    }
    kept.push({ ev, isHotel: false, isTravel: true });
    travelCt++;
  }

  // Keep the output in date order now that the travel pass appends out of sequence.
  kept.sort((a, b) => {
    const da = eventDateRange(a.ev.fields)?.s || '';
    const db = eventDateRange(b.ev.fields)?.s || '';
    return da < db ? -1 : da > db ? 1 : 0;
  });

  console.log(`Kept: ${kept.length}  (${hectorCt} Hector-specific, ${showCt} band shows, ${hotelCt} hotels, ${travelCt} travel-adjacent)`);

  // ── Build output ICS ──────────────────────────────────────────────────────
  const preamble = extractPreamble(raw);
  const outLines = [...preamble];
  let timedCt = 0;

  for (const { ev, isHotel, isTravel } of kept) {
    const lines = buildEventLines(ev, isHotel, isTravel);
    outLines.push(...lines);

    // Count time-injected events for the log
    if (lines.some(l => l.startsWith('X-HECTOR-SCHED:'))) {
      const label = lines.find(l => l.startsWith('X-HECTOR-SCHED:'));
      const sum   = ev.fields.SUMMARY || '';
      console.log(`  ⏰ ${sum.slice(0, 50)} — ${label?.slice('X-HECTOR-SCHED:'.length)}`);
      timedCt++;
    }
  }

  outLines.push('END:VCALENDAR');
  console.log(`Time-injected: ${timedCt} events upgraded from all-day to timed`);

  const output = outLines.join('\r\n') + '\r\n';

  const outDir = resolve(__dirname, '../public/calendars');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'Hector.ics'), output, 'utf8');
  console.log(`Written: ${resolve(outDir, 'Hector.ics')}`);

  try {
    const distDir = resolve(__dirname, '../dist/calendars');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(resolve(distDir, 'Hector.ics'), output, 'utf8');
    console.log('Mirrored to dist/');
  } catch { /* dist/ may not exist */ }
}

main().catch(e => { console.error(e); process.exit(1); });
