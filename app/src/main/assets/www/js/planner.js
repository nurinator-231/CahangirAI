/* Cahangir Planner — shared, dependency-free planning engine.
 *
 * Used unchanged by the Android WebView UI and the Windows (Tauri/React) UI, so task
 * understanding and scheduling behave identically on every device and work offline.
 * The canonical copy lives in shared/planner/planner.js; scripts/sync-shared.sh copies
 * it into the Android assets and a test fails if the copies ever differ.
 *
 * Entity shapes match the synchronized database columns:
 *   task  {id,title,description,category,priority,deadline,estimated_minutes,status,completed_at}
 *   event {id,title,start_at,end_at,all_day,recurrence,confirmed}
 *   block {id,task_id,start_at,end_at,status,locked,reason}
 * All times are epoch milliseconds; calendar arithmetic uses the device's local zone.
 */
(function (root) {
  'use strict';

  var MIN = 60000, HOUR = 3600000, DAY = 86400000;

  var DEFAULT_PREFS = {
    dayStart: '08:00',        // earliest time work may be scheduled
    dayEnd: '22:00',          // latest end of scheduled work
    workDays: [0, 1, 2, 3, 4, 5, 6],
    breakMinutes: 10,         // gap kept after every work session
    maxSessionMinutes: 90,    // long tasks are split into sessions of at most this
    minSessionMinutes: 25,    // never create a fragment shorter than this (unless it finishes the task)
    maxTaskMinutesPerDay: 180,
    horizonDays: 14,
    eventBufferMinutes: 10,   // travel/transition buffer around fixed commitments
    defaultEventMinutes: 60,  // used for availability when an event's length is unknown
    granularityMinutes: 15,
    deadlineReminderHours: [24, 2],
    blockReminderMinutes: 10,
    eventReminderMinutes: 15
  };

  var PRIORITY_WEIGHT = { urgent: 3, high: 2, medium: 1, low: 0 };
  var PRIORITY_SHIFT_MS = { urgent: 3 * DAY, high: DAY, medium: 0, low: -DAY };

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */
  // 'I' maps to 'i' (not Azerbaijani dotless 'ı') so English input like "I have" matches.
  function lower(s) { return String(s || '').replace(/İ/g, 'i').toLowerCase(); }
  function lowerEn(s) { return String(s || '').toLowerCase(); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function sod(ms) { var d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function addDays(ms, n) { var d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); }
  function atTime(dayMs, h, m) { var d = new Date(dayMs); d.setHours(h, m || 0, 0, 0); return d.getTime(); }
  function hm(str) { var p = String(str).split(':'); return [parseInt(p[0], 10) || 0, parseInt(p[1], 10) || 0]; }
  function ceilTo(ms, minutes) { var g = minutes * MIN; return Math.ceil(ms / g) * g; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function cap(s) { s = String(s || '').trim(); return s ? s.charAt(0).toLocaleUpperCase() + s.slice(1) : s; }
  function uniq(arr) { var seen = {}; return arr.filter(function (x) { if (seen[x]) return false; seen[x] = 1; return true; }); }
  function fmtClock(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  var WD_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var WD_AZ = ['Bazar', 'B.e.', 'Ç.a.', 'Çərş.', 'C.a.', 'Cümə', 'Şənbə'];
  function fmtWhen(ms, lang) {
    var d = new Date(ms);
    return (lang === 'en' ? WD_EN : WD_AZ)[d.getDay()] + ' ' + d.getDate() + '.' + pad(d.getMonth() + 1) + ' ' + fmtClock(ms);
  }
  function fmtMinutes(m, lang) {
    var h = Math.floor(m / 60), r = m % 60;
    if (lang === 'en') return (h ? h + ' h' : '') + (h && r ? ' ' : '') + (r ? r + ' min' : '') || '0 min';
    return (h ? h + ' saat' : '') + (h && r ? ' ' : '') + (r ? r + ' dəq' : '') || '0 dəq';
  }

  function parseRepeat(rep) {
    if (!rep) return null;
    if (typeof rep === 'object') return rep;
    try { return JSON.parse(rep); } catch (e) { return null; }
  }

  /** Next occurrence of a repeating reminder strictly after nowMs (same semantics as
   *  nlp.js / Kotlin / Rust implementations). */
  function nextDue(due, repeat, nowMs) {
    repeat = parseRepeat(repeat);
    if (!repeat || due == null) return null;
    var d = new Date(due), guard = 0;
    do {
      if (repeat.type === 'daily') d.setDate(d.getDate() + 1);
      else if (repeat.type === 'weekly') d.setDate(d.getDate() + 7);
      else if (repeat.type === 'interval') d = new Date(d.getTime() + Math.max(60000, repeat.ms || 60000));
      else return null;
      guard++;
    } while (d.getTime() <= nowMs && guard < 100000);
    return d.getTime();
  }

  /* ------------------------------------------------------------------ *
   * Natural-language understanding (English + Azerbaijani), rule based
   * ------------------------------------------------------------------ */
  var NUM_WORDS = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty-five': 45, fortyfive: 45, sixty: 60, ninety: 90,
    a: 1, an: 1, bir: 1, iki: 2, 'üç': 3, 'dörd': 4, 'beş': 5, 'altı': 6, yeddi: 7, 'səkkiz': 8, doqquz: 9, on: 10,
    'on beş': 15, iyirmi: 20, otuz: 30, qırx: 40, 'qırx beş': 45, 'altmış': 60
  };
  var NUM_ALT = 'forty-five|fortyfive|eleven|twelve|fifteen|twenty|thirty|forty|sixty|ninety|one|two|three|four|five|six|seven|eight|nine|ten|an|a|qırx beş|on beş|iyirmi|otuz|qırx|altmış|bir|iki|üç|dörd|beş|altı|yeddi|səkkiz|doqquz|on';
  function toNum(s) {
    s = lower(s).replace(',', '.').trim();
    if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
    return NUM_WORDS[s] != null ? NUM_WORDS[s] : null;
  }

  var MONTHS = [
    ['january', 'jan', 'yanvar'], ['february', 'feb', 'fevral'], ['march', 'mar', 'mart'], ['april', 'apr', 'aprel'],
    ['may', 'may'], ['june', 'jun', 'iyun'], ['july', 'jul', 'iyul'], ['august', 'aug', 'avqust'],
    ['september', 'sep', 'sept', 'sentyabr'], ['october', 'oct', 'oktyabr'], ['november', 'nov', 'noyabr'], ['december', 'dec', 'dekabr']
  ];
  var MONTH_RE = MONTHS.map(function (m) { return m.join('|'); }).join('|');
  function monthIndex(word) {
    word = lower(word);
    for (var i = 0; i < MONTHS.length; i++) for (var j = 0; j < MONTHS[i].length; j++) if (word.indexOf(MONTHS[i][j]) === 0) return i;
    return -1;
  }

  // Order matters: multi-word Azerbaijani names first ("cümə axşamı" is Thursday).
  // JS \b does not treat ə/ş/ç... as word characters, so use explicit boundaries.
  var LB = '(?<![a-z0-9əıöüşçğ])', SUF = '[a-zəıöüşçğ]*';
  function wre(word) { return new RegExp(LB + word + SUF + '(?:\\s+gün' + SUF + ')?'); }
  var WEEKDAY_PATTERNS = [
    [wre('bazar ertəsi'), 1], [wre('çərşənbə axşamı'), 2], [wre('cümə axşamı'), 4],
    [wre('çərşənbə'), 3], [wre('cümə'), 5], [wre('şənbə'), 6], [wre('bazar'), 0],
    [/\bmondays?\b|\bmon\b/, 1], [/\btuesdays?\b|\btue\b|\btues\b/, 2], [/\bwednesdays?\b|\bwed\b/, 3],
    [/\bthursdays?\b|\bthu\b|\bthurs\b/, 4], [/\bfridays?\b|\bfri\b/, 5], [/\bsaturdays?\b|\bsat\b/, 6], [/\bsundays?\b|\bsun\b/, 0]
  ];

  var DEADLINE_MARKERS = /\b(due|by|before|deadline|until|till|no later than|submit|hand in|turn in)\b|qədər|-dək|\bdək\b|son tarix|son gün|təhvil|vaxtı bitir/;
  var EVENT_WORDS = /\b(lesson|lessons|class|classes|lecture|meeting|appointment|call|interview|exam|training|practice|session|dinner|lunch|party|flight|game|match|tutoring|shift|seminar|webinar)\b|dərs|görüş|iclas|toplant|həkim|qəbul|imtahan|məşq|zəng|nahar|şam yeməyi|ad günü|uçuş|növbə/;
  var TASK_LEADS = /^(?:(?:and|also|plus|then|and also|həmçinin|həm də|bir də)\s+)*(?:(?:i|we)\s+(?:also\s+)?(?:have|has|need|needs|must|should|want|gotta|got)(?:\s+to)?\s+|(?:i'?ve got|i'?ll|i will|please|remind me to|don'?t forget to|need to|have to|must|should|todo:?|task:?)\s+|there(?:'s| is| are)\s+|mənim\s+|məndə\s+|lazımdır\s+|gərək\s+)+/;
  var ARTICLES = /^(?:a|an|the|my|our|some|bir)\s+/;
  var TRAILING_FILLER = /\s+(?:var|lazımdır|olmalıdır|edilməlidir|etməliyəm|bitirməliyəm|yazmalıyam|that is|which is|which|that|and|also|too|həmçinin|də|da)$/;

  var CATEGORY_RULES = [
    ['study', /\b(assignment|homework|essay|exam|study|lecture|lesson|lessons|class|course|thesis|project report|quiz|revision|reading|programming|coursework|lab)\b|dərs|tapşırıq|imtahan|ev işi|kurs|oxu|referat|mühazirə|proqramlaşdırma/],
    ['work', /\b(meeting|report|client|deploy|presentation|email|emails|invoice|review|deadline|sprint|code|ticket|interview|office|work)\b|iş\b|iclas|hesabat|müştəri|təqdimat|ofis|toplant/],
    ['health', /\b(gym|doctor|dentist|workout|run|running|exercise|medicine|pill|pills|therapy|yoga|training)\b|həkim|idman|dərman|məşq|stomatoloq|qaçış/],
    ['finance', /\b(bill|bills|pay|payment|rent|tax|taxes|bank|budget|insurance)\b|ödəniş|kirayə|vergi|bank|büdcə|kommunal/],
    ['home', /\b(clean|cleaning|laundry|cook|cooking|groceries|grocery|shopping|repair|dishes|garden)\b|təmizlik|yemək|alış-veriş|bazarlıq|təmir|paltar/],
    ['social', /\b(party|birthday|friend|friends|family|dinner|wedding|visit)\b|qonaq|toy|dost|ailə|ad günü/],
    ['personal', /\b(call|book|appointment|passport|haircut|renew)\b|zəng|pasport|bərbər/]
  ];
  function categorize(text) {
    var t = lower(text);
    for (var i = 0; i < CATEGORY_RULES.length; i++) if (CATEGORY_RULES[i][1].test(t)) return CATEGORY_RULES[i][0];
    return 'general';
  }
  function priorityOf(text) {
    var t = lower(text);
    if (/\b(urgent|urgently|asap|as soon as possible|critical|immediately)\b|təcili|dərhal|çox vacib/.test(t)) return 'urgent';
    if (/\b(low priority|not urgent|whenever|someday|no rush|optional)\b|vacib deyil|tələsmə|vaxt olanda/.test(t)) return 'low';
    if (/\b(important|high priority|high-priority|must not forget)\b|vacib|mühüm|önəmli/.test(t)) return 'high';
    return null;
  }

  function splitClauses(text) {
    var t = String(text || '').replace(/\r/g, '');
    // Protect decimals and clock times ("1.5 hours", "10.30") from sentence splitting.
    t = t.replace(/(\d)\.(\d)/g, '$1\u0000$2');
    var parts = t.split(/[.!?;\n]+(?=\s|$)|\n+/);
    var out = [];
    parts.forEach(function (p) {
      p = p.replace(/\u0000/g, '.').trim();
      if (!p) return;
      // Split on "also"/"and also"/"həmçinin" when they introduce a new item mid-sentence.
      p.split(/,?\s+(?:and also|and then|plus|həmçinin|bundan əlavə)\s+|,\s+(?:and\s+)?(?=i (?:also )?(?:have|need|must)\b)/i).forEach(function (q) {
        q = q.trim(); if (q) out.push(q);
      });
    });
    return out;
  }

  /** Finds a duration ("approximately two hours", "90 min", "1.5h", "2 saat", "yarım saat"). */
  function findDuration(clause) {
    var t = lower(clause);
    var m;
    var approx = '(?:(?:approximately|approx\\.?|about|around|roughly|maybe|~|təxminən|təqribən|azı|ən azı)\\s+)?';
    m = t.match(new RegExp(approx + '(?:an?\\s+)?hour and a half|' + approx + 'bir yarım saat|' + approx + '1,5 saat'));
    if (m) return { minutes: 90, text: m[0] };
    m = t.match(new RegExp(approx + '(?:half an hour|yarım saat)'));
    if (m) return { minutes: 30, text: m[0] };
    m = t.match(/(\d+)\s*h(?:ours?)?\s*(\d+)\s*m(?:in(?:utes?)?)?\b/);
    if (m) return { minutes: parseInt(m[1], 10) * 60 + parseInt(m[2], 10), text: m[0] };
    var UNIT = '(hours?|hrs?|h|minutes?|mins?|m|saat|saatlıq|dəqiqə|dəqiqəlik|dəq)(?![a-z0-9əıöüşçğ])';
    var WUNIT = '(hours?|hrs?|minutes?|mins?|saat|saatlıq|dəqiqə|dəqiqəlik|dəq)(?![a-z0-9əıöüşçğ])';
    var re = new RegExp(approx + '(?<![a-z0-9əıöüşçğ.,])(\\d+(?:[.,]\\d+)?)\\s*-?\\s*' + UNIT);
    m = t.match(re);
    if (!m) {
      var reW = new RegExp(approx + '(?<![a-z0-9əıöüşçğ])(' + NUM_ALT + ')\\s+' + WUNIT);
      m = t.match(reW);
    }
    if (m) {
      // "saat 10" means "at 10 o'clock" in Azerbaijani; a duration needs the number first,
      // and "10 saat" right after "saat" ("saat 10 saat") is not plausible, so this is safe.
      var n = toNum(m[1]);
      if (n == null || n <= 0) return null;
      var unit = m[2];
      var minutes = /^(h|hours?|hrs?|saat|saatlıq)$/.test(unit) ? Math.round(n * 60) : Math.round(n);
      if (/^m$/.test(unit) && n > 600) return null;
      if (minutes <= 0 || minutes > 14 * 24 * 60) return null;
      return { minutes: minutes, text: m[0] };
    }
    return null;
  }

  /** Time of day: "at 10 AM", "10:30", "3pm", "saat 10-da", "axşam 7", "noon". */
  function findTime(clause) {
    var t = lower(clause), m;
    if ((m = t.match(/\b(?:at\s+)?noon\b|\bgünorta\b/))) return { h: 12, m: 0, text: m[0] };
    if ((m = t.match(/\b(?:at\s+)?midnight\b|gecəyarısı/))) return { h: 23, m: 59, text: m[0] };
    m = t.match(/\b(?:at\s+|@\s*)?(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/);
    if (m) {
      var h = parseInt(m[1], 10) % 12, mm = parseInt(m[2] || '0', 10);
      if (/p/.test(m[3])) h += 12;
      if (h < 24 && mm < 60) return { h: h, m: mm, text: m[0] };
    }
    m = t.match(/(?:\bsaat\s+)(\d{1,2})(?:[:.](\d{2}))?(?:\s*-?\s*(?:da|də|ta|tə|dan|dən|a|ə|ya|yə|radək|dək))?/);
    if (m) {
      var hh = parseInt(m[1], 10), mi = parseInt(m[2] || '0', 10);
      var ctx = t.slice(Math.max(0, m.index - 12), m.index);
      if (/(axşam|gecə)\s*$/.test(ctx) && hh < 12) hh += 12;
      if (/günorta\s*$/.test(ctx) && hh < 7) hh += 12;
      if (hh < 24 && mi < 60) return { h: hh, m: mi, text: (/(axşam|səhər|gecə|günorta)\s*$/.test(ctx) ? ctx.match(/(axşam|səhər|gecə|günorta)\s*$/)[0] : '') + m[0] };
    }
    m = t.match(/\b(?:at\s+|@\s*)(\d{1,2})(?:[:.](\d{2}))?\b(?!\s*(?:hours?|h\b|min|saat|dəq|days?|gün|%))/);
    if (m) {
      var h2 = parseInt(m[1], 10), m2 = parseInt(m[2] || '0', 10);
      var after = t.slice(m.index + m[0].length, m.index + m[0].length + 20);
      if (/^\s*(in the evening|tonight|in the afternoon)/.test(after) && h2 < 12) h2 += 12;
      else if (h2 >= 1 && h2 <= 6 && !m[2]) h2 += 12; // "at 3" almost always means 15:00
      if (h2 < 24 && m2 < 60) return { h: h2, m: m2, text: m[0] };
    }
    m = t.match(/(?:^|\s)(\d{1,2}):(\d{2})(?!\d)(?:\s*-?\s*(?:da|də|ta|tə))?/);
    if (m) {
      var h3 = parseInt(m[1], 10), m3 = parseInt(m[2], 10);
      if (h3 < 24 && m3 < 60) return { h: h3, m: m3, text: m[0].trim() };
    }
    m = t.match(/\b(axşam|səhər)\s+(\d{1,2})(?:[:.](\d{2}))?(?:\s*-?\s*(?:da|də|ta|tə))?/);
    if (m) {
      var h4 = parseInt(m[2], 10), m4 = parseInt(m[3] || '0', 10);
      if (m[1] === 'axşam' && h4 < 12) h4 += 12;
      if (h4 < 24 && m4 < 60) return { h: h4, m: m4, text: m[0] };
    }
    return null;
  }

  /** Date: today/tomorrow/weekday/"15 May"/"2026-11-20"/"20.11"/"in 3 days". */
  function findDate(clause, nowMs) {
    var t = lower(clause), m, today = sod(nowMs);
    if ((m = t.match(/\bday after tomorrow\b|birisi\s?gün\w*|biri\s?gün\w*/))) return { day: addDays(today, 2), text: m[0] };
    if ((m = t.match(/\btomorrow\b|\btmrw\b|\bsabah(?!\s+saat\s+\d+\s*(?:-?da|-?də)?\s*$)\w*/))) {
      // Azerbaijani "sabah" also means "morning"; "sabah" is overwhelmingly "tomorrow" in this context.
      return { day: addDays(today, 1), text: m[0] };
    }
    if ((m = t.match(/\btoday\b|\btonight\b|\bthis (?:morning|afternoon|evening)\b|\bbu\s?gün\w*|\bbu axşam\b|\bbu səhər\b/))) return { day: today, text: m[0], tonight: /tonight|evening|axşam/.test(m[0]) };
    if ((m = t.match(/\bin (\d+|a|one|two|three|four|five|six|seven) (day|days|week|weeks)\b|(\d+|bir|iki|üç|dörd|beş) (gün|həftə) sonra/))) {
      var n = toNum(m[1] || m[3]) || 1, unit = m[2] || m[4];
      return { day: addDays(today, /week|həftə/.test(unit) ? n * 7 : n), text: m[0] };
    }
    if ((m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/))) {
      return { day: new Date(+m[1], +m[2] - 1, +m[3]).getTime(), text: m[0] };
    }
    var dm = t.match(new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(' + MONTH_RE + ')[a-zəıöüşçğ]*', 'i')) ||
      t.match(new RegExp('\\b(' + MONTH_RE + ')[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b', 'i'));
    if (dm) {
      var dayN, mon;
      if (/^\d/.test(dm[1])) { dayN = +dm[1]; mon = monthIndex(dm[2]); } else { mon = monthIndex(dm[1]); dayN = +dm[2]; }
      if (mon >= 0 && dayN >= 1 && dayN <= 31) {
        var y = new Date(nowMs).getFullYear(), cand = new Date(y, mon, dayN).getTime();
        if (cand < today) cand = new Date(y + 1, mon, dayN).getTime();
        return { day: cand, text: dm[0] };
      }
    }
    if ((m = t.match(/\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b/)) && !/\d[.:]\d{2}\s*(am|pm|da|də)/.test(m[0])) {
      var d1 = +m[1], mo = +m[2] - 1, yy = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : new Date(nowMs).getFullYear();
      if (d1 >= 1 && d1 <= 31 && mo >= 0 && mo < 12 && +m[2] > 0) {
        var cd = new Date(yy, mo, d1).getTime();
        if (!m[3] && cd < today) cd = new Date(yy + 1, mo, d1).getTime();
        // Only accept "20.11" style if it is not a clock time ("10.30").
        if (!(+m[1] < 24 && +m[2] >= 13)) return { day: cd, text: m[0] };
      }
    }
    for (var i = 0; i < WEEKDAY_PATTERNS.length; i++) {
      var wm = t.match(WEEKDAY_PATTERNS[i][0]);
      if (!wm) continue;
      var wd = WEEKDAY_PATTERNS[i][1];
      var before = t.slice(Math.max(0, wm.index - 12), wm.index);
      var nowWd = new Date(nowMs).getDay();
      var diff = (wd - nowWd + 7) % 7;
      var text = wm[0];
      if (/\bnext\s+$|gələn\s+$|növbəti\s+$/.test(before)) { if (diff === 0) diff = 7; else diff += 7; text = before.match(/(next|gələn|növbəti)\s+$/)[0] + wm[0]; }
      else if (/\bthis\s+$|bu\s+$/.test(before)) { text = before.match(/(this|bu)\s+$/)[0] + wm[0]; }
      else if (/\bon\s+$/.test(before)) { text = 'on ' + wm[0]; }
      // A weekday name with an Azerbaijani "evening" suffix must not be confused: handled by ordering.
      return { day: addDays(today, diff), text: text, weekday: wd };
    }
    if ((m = t.match(/\b(?:end of (?:the |this )?week|this weekend)\b|həftə(?:nin)? sonu\w*/))) {
      var diffSun = (7 - new Date(nowMs).getDay()) % 7;
      return { day: addDays(today, diffSun), text: m[0], assumed: true };
    }
    return null;
  }

  function findVague(clause) {
    var m = lower(clause).match(/\bnext week\b|\bnext month\b|\bsoon\b|\blater\b|\bsometime\b|gələn həftə|gələn ay|tezliklə|sonra(?!\s)/);
    return m ? m[0] : null;
  }

  function findRecurrence(clause, weekday) {
    var t = lower(clause);
    if (/\bevery ?day\b|\bdaily\b|hər gün/.test(t)) return { type: 'daily' };
    if (/\bevery (?:mon|tue|wed|thu|fri|sat|sun)|\bon (?:mon|tue|wed|thu|fri|sat|sun)[a-z]*days\b|hər (?:bazar|çərşənbə|cümə|şənbə)/.test(t) && weekday != null) return { type: 'weekly', wday: weekday };
    if (/\bevery week\b|\bweekly\b|hər həftə/.test(t) && weekday != null) return { type: 'weekly', wday: weekday };
    return null;
  }

  function cleanTitle(clause, spans) {
    var t = ' ' + clause + ' ';
    spans.filter(Boolean).sort(function (a, b) { return b.length - a.length; }).forEach(function (s) {
      var idx = lower(t).indexOf(lower(s));
      if (idx >= 0) t = t.slice(0, idx) + ' ' + t.slice(idx + s.length);
    });
    t = t.replace(/\b(due|by|before|until|till|deadline|on|at|for|in|approximately|approx|about|around|roughly|which takes|that takes|it takes|it will take|will take|takes|take|i need|need|it'?ll take)\s*$/i, ' ');
    t = t.replace(/\s+(due|by|before|until|till|on|at|for|in)\s+(?=$|[,.])/gi, ' ');
    // Azerbaijani postpositions/verbs that only carried the deadline or duration.
    t = t.replace(/(^|[\s,])(?:qədər|-?dək|kimi|ərzində|çəkəcək|çəkər|çəkir|vaxt aparacaq|lazımdır)(?=[\s,.]|$)/gi, '$1');
    t = t.replace(/\s+/g, ' ').trim();
    var low = lower(t);
    var lead = low.match(TASK_LEADS);
    if (lead) { t = t.slice(lead[0].length); low = lower(t); }
    var art = low.match(ARTICLES);
    if (art) { t = t.slice(art[0].length); }
    for (var i = 0; i < 3; i++) {
      var tf = lower(t).match(TRAILING_FILLER);
      if (tf) t = t.slice(0, t.length - tf[0].length);
      t = t.replace(/\s+(due|by|before|until|on|at|for|and|also|too|which|that|which takes|it takes)$/i, '');
    }
    t = t.replace(/^[\s,:;-]+|[\s,:;-]+$/g, '').replace(/\s*-\s*(?:da|də|ta|tə)\b/g, '');
    return cap(t);
  }

  function isDurationOnly(clause, dur) {
    if (!dur) return false;
    var rest = lower(clause).replace(lower(dur.text), ' ');
    rest = rest.replace(/\b(i|we|it|this|that|will|would|should|need|needs|take|takes|probably|approximately|about|around|roughly|maybe|for|to|finish|complete|do|it'?ll|i'?ll|and|also|the|whole|thing|task|bunun|bu|üçün|lazımdır|lazım|çəkəcək|çəkir|vaxt|təxminən|olar)\b/g, ' ');
    return rest.replace(/[\s,.;:!?'"-]+/g, '').length === 0;
  }

  /**
   * parse(text, now) -> { tasks, events, questions, notes }
   * Never invents a deadline, time or duration: anything not stated is left null and
   * either asked about (questions) or reported (notes).
   */
  function parse(text, now, opts) {
    opts = opts || {};
    var nowMs = now instanceof Date ? now.getTime() : (now || Date.now());
    var lang = opts.lang || (/[əıöüşçğ]/i.test(text) ? 'az' : 'en');
    var clauses = splitClauses(text);
    var tasks = [], events = [], questions = [], notes = [];
    var globalPriority = priorityOf(text);
    var last = null;

    clauses.forEach(function (clause) {
      var dur = findDuration(clause);
      if (isDurationOnly(clause, dur) && last) {
        if (last.kind === 'task' && last.item.estimated_minutes == null) last.item.estimated_minutes = dur.minutes;
        else if (last.kind === 'event' && last.item.duration_minutes == null) { last.item.duration_minutes = dur.minutes; last.item.end_at = last.item.start_at + dur.minutes * MIN; }
        return;
      }
      var date = findDate(clause, nowMs);
      var time = findTime(clause);
      var vague = findVague(clause);
      var low = lower(clause);
      var hasDeadlineMarker = DEADLINE_MARKERS.test(low);
      var looksEvent = EVENT_WORDS.test(low) || /^(?:i|we)\s+(?:also\s+)?have\b.*\b(at|@)\s*\d/.test(lowerEn(clause)) || /\bvar\b/.test(low) && !!time;
      var prio = priorityOf(clause) || null;
      var spans = [dur && dur.text, date && date.text, time && time.text];
      var recurrence = findRecurrence(clause, date ? date.weekday : null);
      if (recurrence) spans.push((low.match(/\bevery ?day\b|\bdaily\b|\bevery week\b|\bweekly\b|hər gün|hər həftə|\bevery\b/) || [])[0]);
      var prioWords = low.match(/\b(urgent|urgently|asap|as soon as possible|important|high priority|low priority|not urgent)\b|təcili|vacib deyil|vacib|mühüm/);
      if (prioWords) spans.push(prioWords[0]);
      var title = cleanTitle(clause, spans);
      if (!title || title.length < 2) return;

      if (time && !hasDeadlineMarker && (looksEvent || date)) {
        var day = date ? date.day : sod(nowMs);
        var start = atTime(day, time.h, time.m);
        if (!date && start < nowMs) start = addDays(start, 1);
        var ev = {
          title: title, start_at: start, end_at: dur ? start + dur.minutes * MIN : null,
          duration_minutes: dur ? dur.minutes : null, recurrence: recurrence, all_day: 0, confirmed: 1,
          category: categorize(clause), source_text: clause
        };
        events.push(ev); last = { kind: 'event', item: ev };
        return;
      }

      var deadline = null, deadlineText = null;
      if (date) {
        deadlineText = date.text;
        if (time) deadline = atTime(date.day, time.h, time.m);
        else deadline = atTime(date.day, 23, 59);
        if (date.assumed) notes.push((lang === 'en' ? 'Interpreted "' : '"') + date.text + (lang === 'en' ? '" as ' : '" bu kimi başa düşüldü: ') + fmtWhen(deadline, lang));
      } else if (time && hasDeadlineMarker) {
        deadline = atTime(sod(nowMs), time.h, time.m);
        if (deadline < nowMs) deadline = addDays(deadline, 1);
        deadlineText = time.text;
      }
      var task = {
        title: title, description: '', category: categorize(clause),
        priority: prio || globalPriority || 'medium',
        deadline: deadline, deadline_text: deadlineText,
        estimated_minutes: dur ? dur.minutes : null,
        status: 'todo', source_text: clause
      };
      if (vague && !date) {
        questions.push({ kind: 'deadline', item: 'task', index: tasks.length,
          text: lang === 'en' ? 'When exactly is "' + title + '" due? You said "' + vague + '".' : '"' + title + '" dəqiq nə vaxta qədər olmalıdır? ("' + vague + '" dediniz)' });
      }
      tasks.push(task); last = { kind: 'task', item: task };
    });

    tasks.forEach(function (t, i) {
      if (t.estimated_minutes == null) questions.push({ kind: 'estimate', item: 'task', index: i,
        text: lang === 'en' ? 'About how long will "' + t.title + '" take?' : '"' + t.title + '" təxminən nə qədər vaxt aparacaq?' });
      if (t.deadline != null && t.deadline < nowMs) notes.push(lang === 'en' ? '"' + t.title + '" deadline is already in the past.' : '"' + t.title + '" üçün son tarix artıq keçib.');
    });
    events.forEach(function (e, i) {
      if (e.duration_minutes == null) questions.push({ kind: 'duration', item: 'event', index: i,
        text: lang === 'en' ? 'How long is "' + e.title + '"? (I will assume ' + DEFAULT_PREFS.defaultEventMinutes + ' min when finding free time.)'
          : '"' + e.title + '" nə qədər davam edir? (Boş vaxt hesablanarkən ' + DEFAULT_PREFS.defaultEventMinutes + ' dəq. götürüləcək.)' });
    });
    return { tasks: tasks, events: events, questions: questions, notes: notes, lang: lang };
  }

  /* ------------------------------------------------------------------ *
   * Calendar helpers
   * ------------------------------------------------------------------ */
  function eventEnd(ev, prefs) {
    if (ev.end_at && ev.end_at > ev.start_at) return ev.end_at;
    return ev.start_at + (prefs || DEFAULT_PREFS).defaultEventMinutes * MIN;
  }

  /** Expands recurring events into concrete occurrences overlapping [from, to). */
  function expandEvents(events, from, to, prefs) {
    var out = [];
    (events || []).forEach(function (ev) {
      if (!ev || ev.deleted) return;
      var rec = parseRepeat(ev.recurrence);
      var len = eventEnd(ev, prefs) - ev.start_at;
      if (!rec) {
        if (ev.start_at < to && ev.start_at + len > from) out.push({ event: ev, start: ev.start_at, end: ev.start_at + len });
        return;
      }
      var s = ev.start_at, guard = 0;
      if (s < from - len) { var n = nextDue(s, rec, from - len); if (n != null) s = n; }
      while (s < to && guard++ < 1000) {
        if (s + len > from) out.push({ event: ev, start: s, end: s + len, recurring: true });
        var nx = nextDue(s, rec, s);
        if (nx == null || nx <= s) break;
        s = nx;
      }
    });
    return out.sort(function (a, b) { return a.start - b.start; });
  }

  function mergeIntervals(list) {
    var s = list.filter(function (x) { return x.end > x.start; }).sort(function (a, b) { return a.start - b.start; });
    var out = [];
    s.forEach(function (x) {
      var l = out[out.length - 1];
      if (l && x.start <= l.end) l.end = Math.max(l.end, x.end); else out.push({ start: x.start, end: x.end });
    });
    return out;
  }

  /** Free intervals inside working hours between from and to, excluding busy intervals. */
  function freeIntervals(busy, from, to, prefs) {
    prefs = Object.assign({}, DEFAULT_PREFS, prefs || {});
    var ds = hm(prefs.dayStart), de = hm(prefs.dayEnd);
    var windows = [];
    for (var day = sod(from); day < to; day = addDays(day, 1)) {
      if (prefs.workDays.indexOf(new Date(day).getDay()) < 0) continue;
      var ws = Math.max(atTime(day, ds[0], ds[1]), from), we = Math.min(atTime(day, de[0], de[1]), to);
      if (we > ws) windows.push({ start: ws, end: we });
    }
    var b = mergeIntervals(busy);
    var free = [];
    windows.forEach(function (w) {
      var cur = w.start;
      b.forEach(function (x) {
        if (x.end <= cur || x.start >= w.end) return;
        if (x.start > cur) free.push({ start: cur, end: Math.min(x.start, w.end) });
        cur = Math.max(cur, x.end);
      });
      if (cur < w.end) free.push({ start: cur, end: w.end });
    });
    return free.filter(function (f) { return f.end - f.start >= MIN; });
  }

  /* ------------------------------------------------------------------ *
   * Scheduling engine
   * ------------------------------------------------------------------ */
  function isOpenTask(t) { return t && !t.deleted && t.status !== 'done' && t.status !== 'cancelled'; }
  function blockId(taskId, start) { return 'blk_' + String(taskId).replace(/[^A-Za-z0-9_-]/g, '') + '_' + Math.round(start / MIN); }
  function overlaps(a, b) { return a.start < b.end && b.start < a.end; }

  /**
   * schedule(input) -> plan
   * input: { tasks, events, blocks, now, prefs, lang, allowLate: [taskId], extendMinutes,
   *          release: [blockId] (unlocked blocks the user agreed to move), boost: [taskId] (schedule first) }
   * plan: {
   *   add:    new blocks to create (status 'confirmed' once the user accepts),
   *   remove: ids of existing unlocked blocks to delete (moved / obsolete),
   *   keep:   existing blocks left untouched,
   *   conflicts: [{type, task_id|event_id|block_id, message, alternatives:[...]}],
   *   unscheduled: [{task_id, reason, message}],
   *   explanations: {blockId: text}
   * }
   * Existing blocks that are locked (manually edited/pinned) are never moved.
   * Confirmed commitments (events) are never changed by the scheduler.
   */
  function schedule(input) {
    var prefs = Object.assign({}, DEFAULT_PREFS, input.prefs || {});
    var lang = input.lang || 'az';
    var nowMs = input.now instanceof Date ? input.now.getTime() : (input.now || Date.now());
    var start = ceilTo(nowMs, prefs.granularityMinutes);
    var horizonEnd = addDays(sod(nowMs), prefs.horizonDays + 1);
    var tasks = (input.tasks || []).filter(isOpenTask);
    var taskById = {}; (input.tasks || []).forEach(function (t) { taskById[t.id] = t; });
    var allowLate = {}; (input.allowLate || []).forEach(function (id) { allowLate[id] = true; });
    var release = {}; (input.release || []).forEach(function (id) { release[id] = true; });
    var boost = {}; (input.boost || []).forEach(function (id) { boost[id] = true; });
    tasks = tasks.map(function (t) { return boost[t.id] ? Object.assign({}, t, { priority: 'urgent', _boosted: true }) : t; });
    if (input.extendMinutes) {
      var de = hm(prefs.dayEnd), total = Math.min(23 * 60 + 59, de[0] * 60 + de[1] + input.extendMinutes);
      prefs.dayEnd = pad(Math.floor(total / 60)) + ':' + pad(total % 60);
    }
    var occ = expandEvents(input.events, sod(nowMs) - DAY, horizonEnd, prefs).filter(function (o) { return !o.event.all_day; });
    var buf = prefs.eventBufferMinutes * MIN;
    var busy = occ.map(function (o) { return { start: o.start - buf, end: o.end + buf, label: o.event.title, kind: 'event' }; });
    var conflicts = [], remove = [], keep = [], add = [], explanations = {}, unscheduled = [];

    // Overlapping fixed commitments.
    for (var i = 0; i < occ.length; i++) for (var j = i + 1; j < occ.length; j++) {
      if (occ[j].start >= occ[i].end) break;
      if (occ[i].event.id !== occ[j].event.id && overlaps(occ[i], occ[j]) && occ[i].end > nowMs) {
        conflicts.push({ type: 'event_overlap', event_id: occ[i].event.id, other_event_id: occ[j].event.id,
          message: lang === 'en' ? '"' + occ[i].event.title + '" overlaps "' + occ[j].event.title + '" (' + fmtWhen(occ[j].start, lang) + ').'
            : '"' + occ[i].event.title + '" ilə "' + occ[j].event.title + '" üst-üstə düşür (' + fmtWhen(occ[j].start, lang) + ').', alternatives: [] });
      }
    }

    // Existing blocks: keep done/locked/confirmed ones; displaced or obsolete unlocked ones are removed.
    var planned = {}; // task_id -> minutes already covered by kept blocks
    (input.blocks || []).forEach(function (b) {
      if (!b || b.deleted) return;
      var t = taskById[b.task_id];
      var iv = { start: b.start_at, end: b.end_at };
      var mins = Math.max(0, Math.round((b.end_at - b.start_at) / MIN));
      if (b.status === 'done') { planned[b.task_id] = (planned[b.task_id] || 0) + mins; keep.push(b); return; }
      if (b.status === 'skipped') { keep.push(b); return; }
      var future = b.end_at > nowMs;
      if (release[b.id] && !b.locked && future) { remove.push(b.id); return; } // user chose to move it
      if (!t || !isOpenTask(t)) {
        if (future && !b.locked) remove.push(b.id); else keep.push(b);
        return;
      }
      if (!future) {
        // A past confirmed session that was not marked done: assume it happened only if user marks it.
        keep.push(b); return;
      }
      var clash = occ.filter(function (o) { return overlaps(iv, o); });
      if (clash.length) {
        if (b.locked) {
          keep.push(b); busy.push({ start: b.start_at, end: b.end_at + prefs.breakMinutes * MIN, kind: 'block' });
          planned[b.task_id] = (planned[b.task_id] || 0) + mins;
          conflicts.push({ type: 'block_overlaps_event', block_id: b.id, task_id: b.task_id, event_id: clash[0].event.id,
            message: lang === 'en' ? 'Pinned session for "' + t.title + '" overlaps "' + clash[0].event.title + '". It was not moved because you pinned it.'
              : '"' + t.title + '" üçün sabitlənmiş vaxt "' + clash[0].event.title + '" ilə üst-üstə düşür. Siz sabitlədiyiniz üçün dəyişdirilmədi.',
            alternatives: [] });
        } else {
          remove.push(b.id); // will be re-planned below
          conflicts.push({ type: 'block_moved', block_id: b.id, task_id: b.task_id, event_id: clash[0].event.id,
            message: lang === 'en' ? 'Session for "' + t.title + '" at ' + fmtWhen(b.start_at, lang) + ' clashes with "' + clash[0].event.title + '"; a new time is proposed.'
              : '"' + t.title + '" üçün ' + fmtWhen(b.start_at, lang) + ' vaxtı "' + clash[0].event.title + '" ilə toqquşur; yeni vaxt təklif olunur.', alternatives: [] });
        }
        return;
      }
      keep.push(b); busy.push({ start: b.start_at, end: b.end_at + prefs.breakMinutes * MIN, kind: 'block' });
      planned[b.task_id] = (planned[b.task_id] || 0) + mins;
    });

    function sortKey(t) {
      var d = t.deadline != null ? t.deadline : nowMs + (prefs.horizonDays + 30) * DAY;
      return d - (PRIORITY_SHIFT_MS[t.priority] || 0);
    }
    var queue = tasks.slice().sort(function (a, b) {
      return sortKey(a) - sortKey(b) || (PRIORITY_WEIGHT[b.priority] || 1) - (PRIORITY_WEIGHT[a.priority] || 1) || (a.created_at || 0) - (b.created_at || 0);
    });

    var dayUse = {}; // task_id|day -> minutes
    function dayKey(id, ms) { return id + '|' + sod(ms); }
    queue.forEach(function (t) {
      if (t.estimated_minutes == null || t.estimated_minutes <= 0) {
        unscheduled.push({ task_id: t.id, reason: 'needs_estimate',
          message: lang === 'en' ? 'Add an estimated duration to schedule "' + t.title + '".' : '"' + t.title + '" planlaşdırmaq üçün təxmini müddət əlavə edin.' });
        return;
      }
      var remaining = t.estimated_minutes - (planned[t.id] || 0);
      if (remaining <= 0) return;
      var overdue = t.deadline != null && t.deadline <= nowMs;
      var limit = (t.deadline != null && !allowLate[t.id] && !overdue) ? Math.min(t.deadline, horizonEnd) : horizonEnd;
      var sessions = 0, placedBlocks = [];
      var guard = 0;
      while (remaining > 0 && guard++ < 500) {
        var free = freeIntervals(busy, start, limit, prefs);
        var placed = false;
        for (var k = 0; k < free.length; k++) {
          var f = free[k];
          var used = dayUse[dayKey(t.id, f.start)] || 0;
          var dayCap = prefs.maxTaskMinutesPerDay - used;
          if (dayCap < Math.min(prefs.minSessionMinutes, remaining)) continue;
          var avail = Math.floor((f.end - f.start) / MIN);
          var len = Math.min(prefs.maxSessionMinutes, remaining, avail, dayCap);
          if (len < Math.min(prefs.minSessionMinutes, remaining)) continue;
          // Avoid leaving a useless tiny remainder.
          if (remaining - len > 0 && remaining - len < prefs.minSessionMinutes && len - (prefs.minSessionMinutes - (remaining - len)) >= prefs.minSessionMinutes) {
            len -= prefs.minSessionMinutes - (remaining - len);
          }
          var bs = f.start, be = f.start + len * MIN;
          var blk = { id: blockId(t.id, bs), task_id: t.id, start_at: bs, end_at: be, status: 'confirmed', locked: 0, reason: '' };
          placedBlocks.push(blk);
          busy.push({ start: bs, end: be + prefs.breakMinutes * MIN, kind: 'block' });
          dayUse[dayKey(t.id, bs)] = used + len;
          remaining -= len; sessions++; placed = true;
          break;
        }
        if (!placed) break;
      }
      placedBlocks.forEach(function (b, idx) {
        b.reason = explain(t, b, idx, placedBlocks.length, occ, nowMs, prefs, lang, overdue);
        explanations[b.id] = b.reason;
        add.push(b);
      });
      if (remaining > 0) {
        var alts = input._noAlternatives ? [] : alternativesFor(t, remaining, input, prefs, nowMs, lang, add, keep, taskById);
        if (t.deadline != null && !allowLate[t.id] && !overdue) {
          conflicts.push({ type: 'deadline_at_risk', task_id: t.id,
            message: lang === 'en' ? 'Only ' + fmtMinutes(t.estimated_minutes - remaining, lang) + ' of ' + fmtMinutes(t.estimated_minutes, lang) + ' for "' + t.title + '" fit before its deadline (' + fmtWhen(t.deadline, lang) + ').'
              : '"' + t.title + '" üçün ' + fmtMinutes(t.estimated_minutes, lang) + ' vaxtın yalnız ' + fmtMinutes(t.estimated_minutes - remaining, lang) + ' son tarixə (' + fmtWhen(t.deadline, lang) + ') qədər yerləşir.',
            short_minutes: remaining, alternatives: alts });
        } else {
          unscheduled.push({ task_id: t.id, reason: 'no_free_time', short_minutes: remaining,
            message: lang === 'en' ? 'No free time left in the next ' + prefs.horizonDays + ' days for ' + fmtMinutes(remaining, lang) + ' of "' + t.title + '".'
              : 'Növbəti ' + prefs.horizonDays + ' gündə "' + t.title + '" üçün ' + fmtMinutes(remaining, lang) + ' boş vaxt qalmayıb.', alternatives: alts });
        }
      }
      if (overdue) {
        conflicts.push({ type: 'overdue', task_id: t.id,
          message: lang === 'en' ? '"' + t.title + '" is overdue (was due ' + fmtWhen(t.deadline, lang) + '); scheduled as soon as possible.'
            : '"' + t.title + '" gecikib (son tarix ' + fmtWhen(t.deadline, lang) + '); ən tez vaxta planlaşdırıldı.', alternatives: [] });
      }
    });

    add.sort(function (a, b) { return a.start_at - b.start_at; });
    return { add: add, remove: uniq(remove), keep: keep, conflicts: conflicts, unscheduled: unscheduled, explanations: explanations, prefs: prefs };
  }

  function explain(t, b, idx, n, occ, nowMs, prefs, lang, overdue) {
    var parts = [];
    var en = lang === 'en';
    if (overdue) parts.push(en ? 'Overdue — earliest free time' : 'Gecikib — ən yaxın boş vaxt');
    else if (t.deadline != null) parts.push(en ? 'Earliest free time before the deadline (' + fmtWhen(t.deadline, lang) + ')' : 'Son tarixdən (' + fmtWhen(t.deadline, lang) + ') əvvəlki ən yaxın boş vaxt');
    else parts.push(en ? 'Earliest free time (no deadline)' : 'Ən yaxın boş vaxt (son tarix yoxdur)');
    if (t.priority === 'urgent' || t.priority === 'high') parts.push(en ? t.priority + ' priority' : (t.priority === 'urgent' ? 'təcili' : 'yüksək prioritet'));
    if (n > 1) parts.push(en ? 'session ' + (idx + 1) + ' of ' + n + ' (split into ≤' + prefs.maxSessionMinutes + ' min with ' + prefs.breakMinutes + ' min breaks)'
      : (idx + 1) + '/' + n + ' sessiya (≤' + prefs.maxSessionMinutes + ' dəq hissələrə bölündü, ' + prefs.breakMinutes + ' dəq fasilə)');
    var prev = null, next = null;
    occ.forEach(function (o) {
      if (o.end <= b.start_at && (!prev || o.end > prev.end)) prev = o;
      if (o.start >= b.end_at && (!next || o.start < next.start)) next = o;
    });
    if (prev && b.start_at - prev.end <= (prefs.eventBufferMinutes + prefs.granularityMinutes) * MIN && sod(prev.end) === sod(b.start_at))
      parts.push(en ? 'after "' + prev.event.title + '"' : '"' + prev.event.title + '" bitəndən sonra');
    else if (next && next.start - b.end_at <= (prefs.eventBufferMinutes + prefs.granularityMinutes) * MIN && sod(next.start) === sod(b.end_at))
      parts.push(en ? 'before "' + next.event.title + '"' : '"' + next.event.title + '" başlamazdan əvvəl');
    return parts.join('; ');
  }

  function alternativesFor(t, shortMin, input, prefs, nowMs, lang, add, keep, taskById) {
    var en = lang === 'en', alts = [];
    if (t.deadline != null && t.deadline > nowMs && !input._noAlternatives) {
      // 1. Longer working days before the deadline (evaluated with the same commitments).
      var extended = schedule(Object.assign({}, input, { tasks: [t], extendMinutes: 120, allowLate: [], _noAlternatives: true }));
      var stillShort = extended.conflicts.filter(function (c) { return c.type === 'deadline_at_risk' && c.task_id === t.id; });
      if (!stillShort.length || stillShort[0].short_minutes < shortMin)
        alts.push({ type: 'extend_day', extend_minutes: 120, message: en ? 'Work up to 2 hours later in the evenings before the deadline.' : 'Son tarixə qədər axşamlar 2 saat artıq işləmək.' });
      // 2. Move lower-priority work scheduled before the deadline.
      var movable = add.concat(keep).filter(function (b) {
        var o = taskById[b.task_id];
        return o && o.id !== t.id && !b.locked && b.status !== 'done' && b.start_at < t.deadline && b.end_at > nowMs &&
          ((PRIORITY_WEIGHT[o.priority] || 1) < (PRIORITY_WEIGHT[t.priority] || 1) || o.deadline == null || o.deadline > t.deadline);
      });
      var mins = movable.reduce(function (s, b) { return s + Math.round((b.end_at - b.start_at) / MIN); }, 0);
      if (mins > 0) {
        var names = uniq(movable.map(function (b) { return taskById[b.task_id].title; })).slice(0, 3);
        alts.push({ type: 'move_lower_priority', block_ids: movable.map(function (b) { return b.id; }), minutes: mins,
          message: en ? 'Move later-due/lower-priority work (' + names.join(', ') + ', ' + fmtMinutes(mins, lang) + ') after the deadline.'
            : 'Daha az vacib işləri (' + names.join(', ') + ', ' + fmtMinutes(mins, lang) + ') son tarixdən sonraya keçirmək.' });
      }
    }
    alts.push({ type: 'allow_late', message: en ? 'Schedule the remaining ' + fmtMinutes(shortMin, lang) + ' after the deadline / beyond the planning window.' : 'Qalan ' + fmtMinutes(shortMin, lang) + ' son tarixdən sonraya planlaşdırmaq.' });
    alts.push({ type: 'reduce_estimate', message: en ? 'Reduce the estimate or split the task.' : 'Təxmini müddəti azaltmaq və ya tapşırığı bölmək.' });
    return alts;
  }

  /* ------------------------------------------------------------------ *
   * Views
   * ------------------------------------------------------------------ */
  function dayAgenda(data, dayMs, prefs) {
    prefs = Object.assign({}, DEFAULT_PREFS, prefs || {});
    var d0 = sod(dayMs), d1 = addDays(d0, 1);
    var tasksById = {}; (data.tasks || []).forEach(function (t) { tasksById[t.id] = t; });
    var items = [];
    expandEvents(data.events, d0, d1, prefs).forEach(function (o) {
      items.push({ type: 'event', start: o.start, end: o.end, title: o.event.title, id: o.event.id, all_day: !!o.event.all_day, recurring: !!o.recurring, unknown_length: !o.event.end_at });
    });
    (data.blocks || []).forEach(function (b) {
      if (b.deleted || b.start_at >= d1 || b.end_at <= d0) return;
      var t = tasksById[b.task_id];
      items.push({ type: 'block', start: b.start_at, end: b.end_at, title: t ? t.title : '?', id: b.id, task_id: b.task_id, status: b.status, locked: !!b.locked, reason: b.reason });
    });
    (data.tasks || []).forEach(function (t) {
      if (!t.deleted && t.deadline != null && t.deadline >= d0 && t.deadline < d1)
        items.push({ type: 'deadline', start: t.deadline, end: t.deadline, title: t.title, id: t.id, done: t.status === 'done', priority: t.priority });
    });
    (data.reminders || []).forEach(function (r) {
      var at = r.snooze || r.due;
      if (!r.deleted && !r.done && at && at >= d0 && at < d1 && !r.task_id)
        items.push({ type: 'reminder', start: at, end: at, title: r.text, id: r.id });
    });
    items.sort(function (a, b) { return a.start - b.start || (a.type === 'event' ? -1 : 1); });
    var busy = items.filter(function (i) { return (i.type === 'event' && !i.all_day) || i.type === 'block'; }).map(function (i) { return { start: i.start, end: i.end }; });
    var free = freeIntervals(busy, d0, d1, Object.assign({}, prefs, { workDays: [0, 1, 2, 3, 4, 5, 6] }));
    var freeMin = free.reduce(function (s, f) { return s + Math.round((f.end - f.start) / MIN); }, 0);
    return { day: d0, items: items, free: free, free_minutes: freeMin };
  }

  function weekOverview(data, weekStartMs, prefs) {
    var days = [];
    for (var i = 0; i < 7; i++) {
      var a = dayAgenda(data, addDays(sod(weekStartMs), i), prefs);
      days.push({
        day: a.day,
        events: a.items.filter(function (x) { return x.type === 'event'; }).length,
        planned_minutes: a.items.filter(function (x) { return x.type === 'block'; }).reduce(function (s, x) { return s + Math.round((x.end - x.start) / MIN); }, 0),
        deadlines: a.items.filter(function (x) { return x.type === 'deadline' && !x.done; }).map(function (x) { return x.title; }),
        free_minutes: a.free_minutes,
        items: a.items
      });
    }
    return days;
  }

  function startOfWeek(ms) { var d = sod(ms), wd = new Date(d).getDay(); return addDays(d, -((wd + 6) % 7)); } // Monday

  function upcomingDeadlines(tasks, nowMs, days) {
    var lim = nowMs + (days || 7) * DAY;
    return (tasks || []).filter(function (t) { return isOpenTask(t) && t.deadline != null && t.deadline >= nowMs && t.deadline <= lim; })
      .sort(function (a, b) { return a.deadline - b.deadline; });
  }
  function overdueTasks(tasks, nowMs) {
    return (tasks || []).filter(function (t) { return isOpenTask(t) && t.deadline != null && t.deadline < nowMs; }).sort(function (a, b) { return a.deadline - b.deadline; });
  }
  function completedTasks(tasks) {
    return (tasks || []).filter(function (t) { return !t.deleted && t.status === 'done'; }).sort(function (a, b) { return (b.completed_at || 0) - (a.completed_at || 0); });
  }
  function byPriority(tasks) {
    var groups = { urgent: [], high: [], medium: [], low: [] };
    (tasks || []).filter(isOpenTask).forEach(function (t) { (groups[t.priority] || groups.medium).push(t); });
    Object.keys(groups).forEach(function (k) { groups[k].sort(function (a, b) { return (a.deadline || 9e15) - (b.deadline || 9e15); }); });
    return groups;
  }

  /* ------------------------------------------------------------------ *
   * Reminder generation (deterministic ids => no duplicates across devices)
   * ------------------------------------------------------------------ */
  function safeId(s) { return String(s).replace(/[^A-Za-z0-9_-]/g, ''); }
  function deadlineReminders(task, nowMs, prefs, lang) {
    prefs = Object.assign({}, DEFAULT_PREFS, prefs || {});
    if (!task || task.deadline == null || !isOpenTask(task)) return [];
    var en = (lang || 'az') === 'en';
    return prefs.deadlineReminderHours.map(function (h) {
      return { id: 'rem_dl_' + safeId(task.id) + '_' + h + 'h', kind: 'deadline', task_id: task.id, due: task.deadline - h * HOUR, done: 0, timer: 0, repeat: null,
        text: (en ? 'Deadline in ' + h + ' h: ' : 'Son tarixə ' + h + ' saat qalıb: ') + task.title };
    }).filter(function (r) { return r.due > nowMs; });
  }
  function blockReminder(block, task, prefs, lang) {
    prefs = Object.assign({}, DEFAULT_PREFS, prefs || {});
    var en = (lang || 'az') === 'en';
    return { id: 'rem_blk_' + safeId(block.id), kind: 'task', task_id: block.task_id, due: block.start_at - prefs.blockReminderMinutes * MIN, done: 0, timer: 0, repeat: null,
      text: (en ? 'In ' + prefs.blockReminderMinutes + ' min: ' : prefs.blockReminderMinutes + ' dəq sonra: ') + (task ? task.title : '') + ' (' + fmtClock(block.start_at) + '–' + fmtClock(block.end_at) + ')' };
  }
  function eventReminder(ev, prefs, lang) {
    prefs = Object.assign({}, DEFAULT_PREFS, prefs || {});
    var en = (lang || 'az') === 'en';
    var rec = parseRepeat(ev.recurrence);
    return { id: 'rem_evt_' + safeId(ev.id), kind: 'event', event_id: ev.id, due: ev.start_at - prefs.eventReminderMinutes * MIN, done: 0, timer: 0,
      repeat: rec ? JSON.stringify(rec) : null,
      text: (en ? 'In ' + prefs.eventReminderMinutes + ' min: ' : prefs.eventReminderMinutes + ' dəq sonra: ') + ev.title + ' (' + fmtClock(ev.start_at) + ')' };
  }

  var api = {
    DEFAULT_PREFS: DEFAULT_PREFS, parse: parse, schedule: schedule, expandEvents: expandEvents, freeIntervals: freeIntervals,
    dayAgenda: dayAgenda, weekOverview: weekOverview, startOfWeek: startOfWeek, upcomingDeadlines: upcomingDeadlines,
    overdueTasks: overdueTasks, completedTasks: completedTasks, byPriority: byPriority, deadlineReminders: deadlineReminders,
    blockReminder: blockReminder, eventReminder: eventReminder, nextDue: nextDue, categorize: categorize, priorityOf: priorityOf,
    findDuration: findDuration, findTime: findTime, findDate: findDate, splitClauses: splitClauses, fmtWhen: fmtWhen,
    fmtMinutes: fmtMinutes, fmtClock: fmtClock, sod: sod, addDays: addDays, blockId: blockId, eventEnd: eventEnd, MIN: MIN, HOUR: HOUR, DAY: DAY
  };
  // Always register the global (WebView / bundled builds) and export for CommonJS (tests).
  root.CahangirPlanner = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
