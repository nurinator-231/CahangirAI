/* brain.js — niyyət (intent) marşrutlaşdırıcısı. LLM olmadan, ani və oflayn işləyir.
   Anlaşılmayan suallar (qoşulubsa) dil modelinə (Gemma və s.) ötürülür. */
(function (root) {
  'use strict';
  const N = (typeof module !== 'undefined' && module.exports) ? require('./nlp.js') : root.CahangirNLP;

  const JOKES = [
    'Proqramçı marketə gedir. Həyat yoldaşı deyir: “Bir çörək al, yumurta varsa altısını al.” O, altı çörək alıb gəlir: “Yumurta var idi.”',
    'Kompüter niyə soyuqdan qorxmur? Çünki onun həmişə Windows-u açıqdır.',
    'Mənim planım sadədir: bu gün nə edəcəyəmsə, sabaha xatırlatma qurum.'
  ];
  const HELP = 'Bunları bacarıram:\n' +
    '• Xatırlatma: “sabah saat 9-da toplantı xatırlat”, “30 dəqiqə sonra çay dəmləməyi xatırlat”, “hər gün saat 8-də vitamin xatırlat”\n' +
    '• Taymer: “10 dəqiqəlik taymer”; fokus: “fokus” (25 dəq.), “fasilə” (5 dəq.)\n' +
    '• Gün xülasəsi: “bu gün nə etdim”\n' +
    '• Siyahı və ləğv: “xatırlatmalarım”, “idman xatırlatmasını sil”\n' +
    '• Yaddaş: “mənim adım …”, “yadda saxla: …”, “məni tanıyırsan?”, “unut: …”\n' +
    '• Layihə/tapşırıq: “layihə …”, “layihələrim”, “… bitirdim”\n' +
    '• Saat, tarix və hesablama: “saat neçədir”, “25*4+3”, “150-nin 20 faizi”\n' +
    'Səsli xatırlatma zamanı “oldu” və ya “10 dəqiqə sonra” deyə bilərsən.';

  function greeting(now) {
    const h = now.getHours();
    return h >= 5 && h < 12 ? 'Sabahın xeyir' : h >= 18 && h < 23 ? 'Axşamın xeyir' : 'Salam';
  }

  /* açar sözlə maddə axtarışı (şəkilçilərə dözümlü) */
  const STOPKW = /^(sil|silin|legv|poz|pozun|cixar|ortur|et|edin|xatirla\w*|alarm|taymer\w*|layihe\w*|tapsiriq\w*|yaddas\w*|mene|butun|hamisi\w*|son|bu|o|unut|ve|ile|ucun|haqqinda|eden|olan|var|de|yox|etdim|bitirdim|tamamladim|hazirladim|artiq|indi|artıq)$/;
  function keywords(text) {
    return N.tokenize(text).map(t => t.f).filter(w => w.length > 2 && !STOPKW.test(w) && !/^\d/.test(w));
  }
  function stem(w) { return w.slice(0, Math.max(3, w.length - 2)); }
  function matchItems(items, text) {
    const kws = keywords(text);
    if (!kws.length) return [];
    return items.filter(it => { const f = N.fold(it.text); return kws.some(k => f.includes(stem(k))); });
  }

  function extractName(raw, strict) {
    const toks = N.tokenize(raw);
    let i = toks.findIndex(t => /^(adim|ismim|adimdir)$/.test(t.f));
    let cand = [];
    if (i >= 0) cand = toks.slice(i + 1);
    else {
      const j = toks.findIndex(t => /^(mene|meni)$/.test(t.f));
      const e = toks.findIndex(t => /^(de|cagir|cagirin|deyin|deye)$/.test(t.f));
      if (j >= 0 && e > j) cand = toks.slice(j + 1, e);
      else if (!strict) cand = toks.filter(t => !/^(menim|men|adim|bu|budur|ve|salam)$/.test(t.f));
    }
    cand = cand.filter(t => !/^(dir|di|budur|olsun|kimi)$/.test(t.f)).map(t => t.raw.replace(/[.,!?:;"']+/g, '')).filter(Boolean);
    if (!cand.length || cand.length > 3) return null;
    if (!cand.every(w => /^[\p{L}'-]{2,24}$/u.test(w))) return null;
    return cand.map(w => N.capAz(w)).join(' ');
  }

  function afterTrigger(raw, re) {
    const toks = N.tokenize(raw);
    for (let i = 0; i < toks.length; i++) {
      const two = toks[i].f + ' ' + (toks[i + 1] ? toks[i + 1].f : '');
      const m = re.exec(two) || re.exec(toks[i].f);
      if (m) {
        const len = re.exec(two) ? 2 : 1;
        let rest = toks.slice(i + len).map(t => t.raw);
        if (rest[0] && /^ki$/i.test(rest[0].replace(/[:,]/g, ''))) rest.shift();
        return rest.join(' ').replace(/^[\s:,.\-–]+/, '').trim();
      }
    }
    return '';
  }

  const YES = /^(beli|he|hə|hee|aha|yes|tamam|ok|okay|olar|et|edin|bəli|elədir|eleidir|elebelidir|dogrudur|duzdur|buyur)\b/;
  const NO = /^(yox|xeyr|yoxdur|lazim deyil|legv|bos ver|lazimdir yox|etme|no)\b/;

  async function route(text, env) {
    const st = env.store; const now = env.now(); const ses = env.session;
    const raw = String(text || '').trim();
    if (!raw) return { reply: '' };
    const f = N.fold(raw);
    const name = st.profile.name;
    const addr = name ? name + ', ' : '';

    const createReminder = (o) => {
      const it = st.add('reminders', { text: o.text, due: o.ts, repeat: o.repeat || null, timer: !!o.timer });
      env.changed && env.changed();
      return it;
    };
    const confirmText = (o) => {
      const rep = o.repeat ? ' (' + N.fmtRepeat(o.repeat) + ')' : '';
      return `Yaxşı, ${addr}${N.fmtWhen(o.ts, now)}${rep} “${o.text}” üçün xatırladacağam.`;
    };

    /* 1. Zəng çalarkən: dayandır / təxirə sal */
    if (env.firing().length) {
      if (/\b(texire sal|ertele|snooze|bir az sonra|sonra xatirlat|dəqiqə sonra|deqiqe sonra|saat sonra)\b/.test(f) || (/\bsonra\b/.test(f) && /\d/.test(f))) {
        const w = N.parseWhen(raw, now); const ms = w.relative && w.ts ? w.ts - now.getTime() : 600000;
        env.snooze(ms);
        return { reply: `Yaxşı, ${N.fmtDuration(ms)} sonra yenidən xatırladacağam.` };
      }
      if (f.split(/\s+/).length <= 6 && /\b(dayan|sus|bes|bes edir|kifayet|oldu|tamam|bitdi|etdim|gordum|esitdim|eshitdim|ok|okay|yaxsi|aydindir|basa dusdum|sagol|saq ol|sondur)\b/.test(f)) {
        env.ack();
        return { reply: 'Yaxşı, dayandırdım.' };
      }
    }

    /* 2. Gözlənilən cavab (sual-cavab davamı) */
    const p = ses.pending;
    if (p) {
      ses.pending = null;
      if (p.type === 'confirm') {
        if (YES.test(f)) return { reply: await p.run() };
        if (NO.test(f)) return { reply: 'Yaxşı, ləğv etdim.' };
      } else if (NO.test(f)) {
        return { reply: 'Yaxşı, ləğv etdim.' };
      } else if (p.type === 'name') {
        const n = extractName(raw, false);
        if (n) { st.setName(n); env.changed && env.changed(); return { reply: `Tanış olduğumuza şadam, ${n}! Artıq səni tanıyıram. Nə vaxt istəsən xatırlatma qura, qeyd saxlaya və suallarına cavab verə bilərəm. Nə edə biləcəyimi görmək üçün “kömək” yaz.` }; }
      } else if (p.type === 'when') {
        const w = N.parseWhen(raw, now, p.dateOnly ? { baseDay: p.dateOnly } : {});
        if (w.ts != null && !w.past) {
          const o = { text: p.text, ts: w.ts, repeat: p.repeat || w.repeat };
          createReminder(o); return { reply: confirmText(o) };
        }
        if (w.past) return { reply: 'Bu vaxt artıq keçib. Başqa vaxt de, məsələn “sabah saat 9-da”.' };
      } else if (p.type === 'what') {
        const t = N.extractTask(raw, null);
        if (t) { const o = { text: t, ts: p.ts, repeat: p.repeat }; createReminder(o); return { reply: confirmText(o) }; }
      } else if (p.type === 'mem') {
        st.add('memory', { text: raw }); env.changed && env.changed();
        return { reply: 'Yadda saxladım.' };
      }
      /* əlaqəsiz mesajdır → normal marşrutlaşdırma */
    }

    /* 3. Silmə / ləğv */
    const isDel = /\b(sil|silin|silsene|legv|poz|pozun|cixar|ortur|yigisdir)\b/.test(f) || (/\bsondur\b/.test(f) && /alarm|xatirlat|taymer/.test(f));
    if (isDel && !/\bunut\b/.test(f)) {
      const kind = /layihe|tapsiriq/.test(f) ? 'projects' : /yaddas/.test(f) ? 'memory' : 'reminders';
      const label = { reminders: 'xatırlatma', projects: 'layihə', memory: 'yaddaş qeydi' }[kind];
      const list = st.items(kind).filter(i => kind !== 'reminders' || true);
      if (/\b(hamisi\w*|butun|hec ne)\b/.test(f) || (kind === 'memory' && /yaddas/.test(f) && !keywords(raw).length)) {
        if (!list.length) return { reply: `Silinəcək ${label} yoxdur.` };
        ses.pending = { type: 'confirm', run: async () => { st.removeMany(list.map(i => i.id)); env.changed && env.changed(); return `Bütün ${label}lar silindi (${list.length}).`; } };
        return { reply: `${list.length} ${label} silinsin? (bəli / yox)` };
      }
      let hit = matchItems(list, raw);
      if (!hit.length && /\bson\b/.test(f) && list.length) hit = [list[list.length - 1]];
      if (!hit.length && !keywords(raw).length) {
        const act = list.filter(i => !i.done);
        if (act.length === 1) hit = act;
        else if (!act.length) return { reply: `Silinəcək ${label} yoxdur.` };
        else return { reply: `Hansı ${label}ni silim? Məsələn: “${act[0].text} xatırlatmasını sil”.` };
      }
      if (!hit.length) return { reply: `Bu adda ${label} tapa bilmədim.` };
      st.removeMany(hit.map(i => i.id)); env.changed && env.changed();
      return { reply: hit.length === 1 ? `“${hit[0].text}” silindi.` : `${hit.length} ${label} silindi.` };
    }
    if (/\bunut\b/.test(f)) {
      const hit = matchItems(st.items('memory'), raw);
      if (!hit.length) return { reply: 'Bu barədə yaddaşımda heç nə tapmadım.' };
      st.removeMany(hit.map(i => i.id)); env.changed && env.changed();
      return { reply: 'Unutdum.' };
    }
    if (/yaddas\w*\s+(temizle|sifirla|sil)/.test(f)) {
      const list = st.items('memory');
      if (!list.length) return { reply: 'Yaddaşım onsuz da boşdur.' };
      ses.pending = { type: 'confirm', run: async () => { st.removeMany(list.map(i => i.id)); env.changed && env.changed(); return 'Yaddaşı təmizlədim.'; } };
      return { reply: `${list.length} qeyd silinsin? (bəli / yox)` };
    }

    /* 4. Siyahı */
    if (/xatirlatmalar|xatirlatma(lari)?\s+(goster|siyahi|bax)|\b(bu gun|sabah)\s+ne var|gozleyen|planlarim|taymerlerim|ne xatirlatmalarim/.test(f) && !/^xatirlat\b/.test(f)) {
      const eff = i => (i.snooze && i.snooze > 0) ? i.snooze : i.due;
      let list = st.items('reminders').filter(i => !i.done && eff(i));
      const tom = /\bsabah\b/.test(f), tod = /\bbu gun\b/.test(f);
      if (tom) list = list.filter(i => N.dayDiff(new Date(eff(i)), now) === 1);
      else if (tod) list = list.filter(i => N.dayDiff(new Date(eff(i)), now) <= 0);
      list.sort((a, b) => eff(a) - eff(b));
      const none = st.items('reminders').filter(i => !i.done && !i.due);
      if (!list.length && !none.length) return { reply: tom ? 'Sabah üçün xatırlatma yoxdur.' : tod ? 'Bu gün üçün xatırlatma yoxdur.' : 'Gözləyən xatırlatma yoxdur.' };
      const lines = list.slice(0, 12).map(i => '• ' + N.fmtWhen(eff(i), now) + ' — ' + i.text + (i.repeat ? ' (' + N.fmtRepeat(i.repeat) + ')' : ''));
      none.slice(0, 4).forEach(i => lines.push('• vaxtsız — ' + i.text));
      return { reply: `${list.length + none.length} gözləyən xatırlatma var:\n` + lines.join('\n') };
    }

    /* 4b. Fokus / fasilə */
    if (/\b(fokus|pomodoro|konsentrasiya)\b|\bfasile\b/.test(f) && !/xatirla/.test(f)) {
      const br = /\bfasile\b/.test(f);
      const m = f.match(/(\d{1,3})\s*(deq|d\b|min)/); const mins = m ? Math.min(180, Math.max(1, +m[1])) : (br ? 5 : 25);
      createReminder({ text: br ? 'Fasilə' : 'Fokus', ts: now.getTime() + mins * 60000, timer: true });
      return { reply: br ? `${mins} dəqiqəlik fasilə başladı. Bitəndə səslə deyəcəyəm.` : `Fokus başladı: ${mins} dəqiqə. Bitəndə səslə deyəcəyəm — indi diqqətini işə ver.` };
    }

    /* 4c. Gün xülasəsi */
    if (/gun xulase|xulase|ne etdim|nece kecdi|neler etdim|ne bitirdim/.test(f)) {
      const done = st.logToday(now);
      const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const left = st.items('reminders').filter(i => !i.done && (i.snooze > 0 ? i.snooze : i.due) && (i.snooze > 0 ? i.snooze : i.due) >= now.getTime() && (i.snooze > 0 ? i.snooze : i.due) < t0 + 864e5);
      const nm = st.profile.name ? st.profile.name + ', ' : '';
      let r = done.length ? `${nm}bu gün ${done.length} iş tamamlamısan:\n` + done.slice(-6).map(x => '• ' + x.text).join('\n') : `${nm}bu gün hələ tamamlanmış xatırlatma yoxdur.`;
      r += left.length ? `\nQalan: ${left.length} xatırlatma.` : '\nBu günə qalan xatırlatma yoxdur.';
      return { reply: r };
    }

    /* 5. Taymer */
    if (/\btaymer|geri sayim|(deqiqelik|saniyelik|saatliq)/.test(f)) {
      const w = N.parseWhen(raw, now);
      if (w.relative && w.ts) {
        const ms = w.ts - now.getTime();
        createReminder({ text: 'Taymer', ts: w.ts, timer: true });
        return { reply: `${N.fmtDuration(ms)} taymer qurdum.` };
      }
      return { reply: 'Neçə dəqiqəlik? Məsələn: “10 dəqiqəlik taymer”.' };
    }

    /* 6. Xatırlatma yaratma */
    if (/xatirla|yadima sal|\balarm\b|\boyat\b|\boyad\b/.test(f)) {
      const w = N.parseWhen(raw, now);
      const toks = N.tokenize(raw);
      toks.forEach((t, i) => { if (t.f === 'elave' && toks[i + 1] && /^et/.test(toks[i + 1].f)) { w.used.add(i); w.used.add(i + 1); } });
      let task = N.extractTask(raw, w.used);
      const isAlarm = /\balarm\b/.test(f) && !task;
      const isWake = /\boyat\b|\boyad\b/.test(f);
      if (!task && isAlarm) task = 'Alarm';
      if (!task && isWake) task = 'Oyanmaq vaxtıdır';
      if (isWake && /^(mene|meni)$/.test(N.fold(task))) task = 'Oyanmaq vaxtıdır';
      if (w.past) {
        const t2 = w.ts + 86400000;
        ses.pending = { type: 'confirm', run: async () => { const o = { text: task || 'Xatırlatma', ts: t2, repeat: w.repeat }; createReminder(o); return confirmText(o); } };
        return { reply: 'Bu vaxt artıq keçib. Sabaha qurum? (bəli / yox)' };
      }
      if (w.ts != null) {
        if (!task) { ses.pending = { type: 'what', ts: w.ts, repeat: w.repeat }; return { reply: `${N.fmtWhen(w.ts, now)} nəyi xatırladım?` }; }
        const o = { text: task, ts: w.ts, repeat: w.repeat }; createReminder(o); return { reply: confirmText(o) };
      }
      if (!task) { ses.pending = { type: 'what', ts: null, repeat: null }; return { reply: 'Nəyi xatırladım?' }; }
      if (w.dateOnly) {
        ses.pending = { type: 'when', text: task, repeat: w.repeat, dateOnly: w.dateOnly.getTime() };
        return { reply: `${N.fmtWhen(w.dateOnly.getTime(), now).replace(/ 00:00$/, '')} saat neçədə xatırladım?` };
      }
      ses.pending = { type: 'when', text: task, repeat: null, dateOnly: null };
      return { reply: 'Nə vaxt xatırladım? Məsələn: “saat 19:00”, “30 dəqiqə sonra”, “sabah saat 9-da”.' };
    }

    /* 7. Yaddaş və tanışlıq */
    if (/\b(adim|ismim)\b/.test(f) && !/(nedir|nə|ne\b|neydi|neci|hansi|bilirsen|yadindadir|\?)/.test(f.replace(/ne /, ' ne '))) {
      const n = extractName(raw, true);
      if (n) { st.setName(n); env.changed && env.changed(); return { reply: `Tanış olduğumuza şadam, ${n}! Adını yadda saxladım.` }; }
    }
    if (/^(mene|meni)\b.*\b(cagir|de)\b/.test(f) && !/\?/.test(raw) && /\b(cagir|cagirin)\b/.test(f)) {
      const n = extractName(raw, true);
      if (n) { st.setName(n); env.changed && env.changed(); return { reply: `Yaxşı, bundan sonra sənə ${n} deyəcəyəm.` }; }
    }
    if (/yadda saxla|yadinda saxla|\bunutma\b|qeyd et\b|yaddasa yaz/.test(f)) {
      const fact = afterTrigger(raw, /^(yadda saxla\w*|yadinda saxla\w*|unutma\w*|qeyd et\w*|yaddasa yaz\w*)/);
      if (!fact) { ses.pending = { type: 'mem' }; return { reply: 'Nəyi yadda saxlayım?' }; }
      st.add('memory', { text: fact }); env.changed && env.changed();
      return { reply: `Yadda saxladım: ${fact}` };
    }
    if (/menim adim (ne|nedir)|adim nedir|adimi (de|deye|soyle|bilirsen|xatirla|yadindadir|unutmusan)|menim adimi|adimi ne|adim ne idi|kimdir men|adimla muraciet|men kimem|meni taniyirsan|meni taniyirsiniz|menim haqqimda|menden ne bilirsen|yaddasinda ne var|yaddasi goster|yaddasim|ne yadda saxlamisan|haqqimda ne/.test(f)) {
      const facts = st.items('memory');
      if (!name && !facts.length) { ses.pending = { type: 'name' }; return { reply: 'Hələ səni tanımıram. Adın nədir?' }; }
      let r = name ? `Əlbəttə, sən ${name}sən.` : 'Adını hələ bilmirəm.';
      if (facts.length) r += ' Haqqında bunları bilirəm:\n' + facts.slice(-10).map(i => '• ' + i.text).join('\n');
      else r += ' Əlavə qeydim yoxdur — “yadda saxla: …” deyə öyrədə bilərsən.';
      return { reply: r };
    }

    /* 8. Layihə / tapşırıq */
    if (/layihelerim|tapsiriqlarim|layihelere bax|tapsiriqlara bax|layihe siyahisi/.test(f)) {
      const l = st.items('projects').filter(i => !i.done);
      if (!l.length) return { reply: 'Açıq layihə və ya tapşırıq yoxdur.' };
      return { reply: `${l.length} açıq iş var:\n` + l.slice(0, 12).map(i => '• ' + i.text).join('\n') };
    }
    if (/^(layihe|tapsiriq)\b|\b(layihe|tapsiriq)\s+(elave|yarat|ac)/.test(f)) {
      let t = raw.replace(/^(layih[əe]|tapşırıq)\s*[:\-]?\s*/i, '');
      t = t.replace(/\b(layih[əe]|tapşırıq)\s+(əlavə|elave|yarat|aç)\s*(et)?\s*[:\-]?\s*/i, '').trim();
      if (!t) return { reply: 'Layihənin adını de. Məsələn: “layihə sayt hazırla”.' };
      st.add('projects', { text: t }); env.changed && env.changed();
      return { reply: `Layihə/tapşırıq əlavə olundu: ${t}` };
    }
    if (/\b(bitirdim|tamamladim|hazirladim|etdim|yerine yetirdim)\b/.test(f)) {
      const cand = st.items().filter(i => !i.done && (i.kind === 'projects' || i.kind === 'reminders'));
      const hit = matchItems(cand, raw);
      if (hit.length) {
        hit.forEach(i => st.update(i.id, { done: true })); env.changed && env.changed();
        return { reply: `Afərin${name ? ', ' + name : ''}! “${hit[0].text}” tamamlandı kimi işarələndi.` };
      }
    }

    /* 9. Saat və tarix */
    if (/saat nece|vaxt nece|saat ne qeder|hazirda saat|saat nedir/.test(f)) return { reply: `Saat ${N.clock(now)}.` };
    if (/bu gun (ne gunudur|hansi gundur|neci|ayin)|bugun (ne gunudur|hansi gundur)|tarix|ayin neci|hansi gundur|ne gunudur/.test(f)) return { reply: `Bu gün ${N.fmtDate(now)}.` };

    /* 10. Hesablama */
    if (/\d/.test(f)) {
      const c = N.calc(raw);
      if (c) return { reply: `${c.expr} = ${c.text}` };
    }

    /* 11. Səs idarəsi */
    if (/(sesi|danismagi) (sondur|bagla|kes)|danisma\b|sessiz rejim/.test(f)) { env.setVoice(false); return { reply: 'Səsi söndürdüm. Yalnız yazı ilə cavab verəcəyəm.' }; }
    if (/(sesi|danismagi) (ac|yandir)|danis\b/.test(f)) { env.setVoice(true); return { reply: 'Səs yandı. Artıq danışıram.' }; }

    /* 12. Söhbət */
    if (/^(salam|salamlar|merheba|hey|hello|hi|sabahin xeyir|axsamin xeyir|gunaydin)\b/.test(f) && f.split(/\s+/).length <= 4) {
      return { reply: `${greeting(now)}${name ? ', ' + name : ''}! Necə kömək edə bilərəm?` };
    }
    if (/necesen|nece gedir|ne var ne yox|halin nece/.test(f)) return { reply: `Əla, sağ ol${name ? ', ' + name : ''}! Sən necəsən?` };
    if (/sen kimsen|adin ne|kimsen/.test(f)) return { reply: 'Mən Cahangirəm — sənin şəxsi köməkçin. Xatırlatma qururam, qeydlərini yadda saxlayıram və suallarına cavab verirəm.' };
    if (/\b(komek|help|ne ede bilirsen|nelere qadirsen|komandalar|imkanlar)\b/.test(f)) return { reply: HELP };
    if (/\b(sag ol|tesekkur|minnetdaram|raziyam)\b/.test(f)) return { reply: 'Buyur! Həmişə hazıram.' };
    if (/\b(helelik|sag ol qal|gorusenedek|xudahafiz|sagliqla)\b/.test(f)) return { reply: `Hələlik${name ? ', ' + name : ''}! Xatırlatmaların işləməyə davam edir.` };
    if (/letife|zarafat|gulduru/.test(f)) return { reply: JOKES[Math.floor((now.getTime() / 1000) % JOKES.length)] };

    /* 13. Dil modeli (qoşulubsa) */
    if (env.llm) {
      try { const r = await env.llm(raw); if (r) return { reply: r, llm: true }; }
      catch (e) { return { reply: 'Dil modelinə qoşula bilmədim: ' + (e && e.message ? e.message : e) + '. Ayarlar → Dil modeli bölməsini yoxla (istəmirsənsə “Qoşulmayıb” seç).', error: true }; }
    }
    return { reply: 'Bunu tam başa düşmədim. Xatırlatma qura, qeyd saxlaya, taymer qura və hesablaya bilirəm — məsələn: “sabah saat 9-da toplantı xatırlat”. Ümumi suallara cavab üçün Ayarlar → Dil modeli bölməsindən Gemma və ya başqa model qoş. Bütün imkanlar üçün “kömək” yaz.' };
  }

  function welcome(env) {
    const st = env.store; const now = env.now();
    if (!st.profile.name) { env.session.pending = { type: 'name' }; return 'Salam! Mən Cahangirəm — sənin şəxsi köməkçin. Səni tanımaq istəyirəm: adın nədir?'; }
    const act = st.items('reminders').filter(i => !i.done && i.due && i.due > now.getTime()).sort((a, b) => a.due - b.due);
    const nxt = act[0] ? ` Növbəti xatırlatma: ${N.fmtWhen(act[0].due, now)} — ${act[0].text}.` : '';
    return `${greeting(now)}, ${st.profile.name}!${nxt}`;
  }

  const api = { route, welcome, HELP, extractName, matchItems };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CahangirBrain = api;
})(typeof window !== 'undefined' ? window : globalThis);
