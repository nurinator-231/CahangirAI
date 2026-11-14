// Run with:  TZ=Asia/Baku node --test shared/planner/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('./planner.js');

const MIN = 60000, HOUR = 3600000;
// Saturday 14 Nov 2026, 09:00 local
const NOW = new Date(2026, 10, 14, 9, 0).getTime();
const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime();

test('timezone is fixed for deterministic tests', () => {
  assert.equal(new Date(NOW).getDay(), 6);
});

test('brief example: assignment due Friday (2h) + English lessons tomorrow 10 AM', () => {
  const r = P.parse('I have a programming assignment due Friday. I need approximately two hours. I also have English lessons tomorrow at 10 AM.', NOW);
  assert.equal(r.tasks.length, 1);
  const t = r.tasks[0];
  assert.equal(t.title, 'Programming assignment');
  assert.equal(t.deadline, at(20, 23, 59));
  assert.equal(t.estimated_minutes, 120);
  assert.equal(t.category, 'study');
  assert.equal(t.priority, 'medium');
  assert.equal(r.events.length, 1);
  const e = r.events[0];
  assert.equal(e.title, 'English lessons');
  assert.equal(e.start_at, at(15, 10));
  assert.equal(e.end_at, null);
  // Missing event length -> focused question; nothing invented.
  assert.equal(r.questions.length, 1);
  assert.match(r.questions[0].text, /How long is "English lessons"/);
});

test('never invents a deadline or duration', () => {
  const r = P.parse('Clean the garage', NOW);
  assert.equal(r.tasks[0].deadline, null);
  assert.equal(r.tasks[0].estimated_minutes, null);
  assert.equal(r.events.length, 0);
  assert.equal(r.questions[0].kind, 'estimate');
});

test('vague timing asks a question instead of guessing', () => {
  const r = P.parse('Finish the report next week, takes 3 hours', NOW);
  assert.equal(r.tasks[0].deadline, null);
  assert.equal(r.tasks[0].estimated_minutes, 180);
  assert.ok(r.questions.some(q => q.kind === 'deadline'));
});

test('Azerbaijani: deadline with weekday + duration + priority', () => {
  const r = P.parse('Cümə gününə qədər proqramlaşdırma tapşırığını bitirməliyəm, təxminən 2 saat, vacib', NOW);
  const t = r.tasks[0];
  assert.equal(t.deadline, at(20, 23, 59));
  assert.equal(t.estimated_minutes, 120);
  assert.equal(t.priority, 'high');
  assert.equal(t.category, 'study');
  assert.match(t.title.toLowerCase(), /proqramlaşdırma tapşırığını/);
});

test('Azerbaijani: event "sabah saat 10-da ingilis dili dərsim var"', () => {
  const r = P.parse('Sabah saat 10-da ingilis dili dərsim var', NOW);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].start_at, at(15, 10));
});

test('Azerbaijani weekday names: cümə axşamı is Thursday, çərşənbə axşamı Tuesday', () => {
  assert.equal(P.findDate('cümə axşamı', NOW).weekday, 4);
  assert.equal(P.findDate('çərşənbə axşamı', NOW).weekday, 2);
  assert.equal(P.findDate('bazar ertəsi', NOW).weekday, 1);
  assert.equal(P.findDate('bazar günü', NOW).weekday, 0);
});

test('durations in many forms', () => {
  const d = s => (P.findDuration(s) || {}).minutes;
  assert.equal(d('about 90 minutes'), 90);
  assert.equal(d('1.5 hours'), 90);
  assert.equal(d('an hour and a half'), 90);
  assert.equal(d('half an hour'), 30);
  assert.equal(d('2h30m'), 150);
  assert.equal(d('45 min'), 45);
  assert.equal(d('3 saat'), 180);
  assert.equal(d('yarım saat'), 30);
  assert.equal(d('saat 10-da'), undefined); // clock time, not a duration
});

test('times and dates', () => {
  const t = s => { const x = P.findTime(s); return x && [x.h, x.m]; };
  assert.deepEqual(t('at 10 AM'), [10, 0]);
  assert.deepEqual(t('at 3pm'), [15, 0]);
  assert.deepEqual(t('meeting 14:30'), [14, 30]);
  assert.deepEqual(t('axşam 7-də'), [19, 0]);
  assert.deepEqual(t('at noon'), [12, 0]);
  assert.equal(P.findDate('on 20 November', NOW).day, at(20, 0));
  assert.equal(P.findDate('Nov 20th', NOW).day, at(20, 0));
  assert.equal(P.findDate('2026-12-01', NOW).day, new Date(2026, 11, 1).getTime());
  assert.equal(P.findDate('in 3 days', NOW).day, at(17, 0));
  assert.equal(P.findDate('next friday', NOW).day, at(27, 0));
  assert.equal(P.findDate('friday', NOW).day, at(20, 0));
  assert.equal(P.findDate('today', NOW).day, at(14, 0));
});

test('urgent and low priority detection; categories', () => {
  assert.equal(P.parse('Pay rent urgently, 15 minutes', NOW).tasks[0].priority, 'urgent');
  assert.equal(P.parse('Pay rent urgently, 15 minutes', NOW).tasks[0].category, 'finance');
  assert.equal(P.parse('Read a novel, low priority, 2 hours', NOW).tasks[0].priority, 'low');
  assert.equal(P.categorize('go to the gym'), 'health');
});

test('recurring weekly event', () => {
  const r = P.parse('I have English lessons every Monday at 18:00 for 90 minutes', NOW);
  const e = r.events[0];
  assert.deepEqual(e.recurrence, { type: 'weekly', wday: 1 });
  assert.equal(e.duration_minutes, 90);
  assert.equal(e.start_at, at(16, 18));
});

// ---------------- scheduling ----------------

const base = () => ({
  tasks: [{ id: 'T1', title: 'Programming assignment', priority: 'medium', deadline: at(20, 23, 59), estimated_minutes: 120, status: 'todo' }],
  events: [{ id: 'E1', title: 'English lessons', start_at: at(15, 10), end_at: null, confirmed: 1 }],
  blocks: [],
  now: NOW,
  lang: 'en'
});

test('schedules before the deadline, avoids commitments, splits and explains', () => {
  const plan = P.schedule(base());
  assert.equal(plan.conflicts.length, 0);
  const total = plan.add.reduce((s, b) => s + (b.end_at - b.start_at) / MIN, 0);
  assert.equal(total, 120);
  assert.equal(plan.add.length, 2); // 120 min > 90 min max session -> split
  plan.add.forEach(b => {
    assert.ok(b.end_at <= at(20, 23, 59));
    assert.ok(b.start_at >= NOW);
    assert.ok(b.reason.includes('deadline'));
  });
  // Break between sessions
  assert.ok(plan.add[1].start_at - plan.add[0].end_at >= 10 * MIN);
});

test('busy day pushes work around the event with buffer', () => {
  const inp = base();
  inp.now = at(15, 8);
  inp.tasks[0].estimated_minutes = 60;
  inp.prefs = { dayStart: '09:30', dayEnd: '12:00' };
  const plan = P.schedule(inp);
  const b = plan.add[0];
  // Event 10:00-11:00 (assumed 60 min) with 10 min buffer -> free 11:10-12:00 only 50 min on 15th;
  // 09:30-09:50 is too short. So on the 15th only 50 min fit; the scheduler splits to next day.
  const ev = { start: at(15, 9, 50), end: at(15, 11, 10) };
  plan.add.forEach(x => assert.ok(x.end_at <= ev.start || x.start_at >= ev.end));
  assert.ok(b.reason.length > 0);
});

test('never overlaps tasks and respects working hours', () => {
  const inp = base();
  inp.tasks.push({ id: 'T2', title: 'Essay', priority: 'high', deadline: at(17, 18), estimated_minutes: 200, status: 'todo' });
  inp.tasks.push({ id: 'T3', title: 'Groceries', priority: 'low', deadline: null, estimated_minutes: 45, status: 'todo' });
  const plan = P.schedule(inp);
  const all = plan.add.slice().sort((a, b) => a.start_at - b.start_at);
  for (let i = 1; i < all.length; i++) assert.ok(all[i].start_at >= all[i - 1].end_at + 10 * MIN, 'overlap or no break');
  all.forEach(b => {
    const d = new Date(b.start_at), e = new Date(b.end_at);
    assert.ok(d.getHours() >= 8 && (e.getHours() < 22 || (e.getHours() === 22 && e.getMinutes() === 0)));
  });
  // Earlier deadline / higher priority first.
  const firstEssay = all.find(b => b.task_id === 'T2');
  const firstGroc = all.find(b => b.task_id === 'T3');
  assert.ok(firstEssay.start_at < firstGroc.start_at);
});

test('deadline conflict produces alternatives instead of silently failing', () => {
  const inp = base();
  inp.now = at(20, 20);
  inp.tasks[0].estimated_minutes = 240;
  const plan = P.schedule(inp);
  const c = plan.conflicts.find(x => x.type === 'deadline_at_risk');
  assert.ok(c);
  assert.ok(c.short_minutes > 0);
  const types = c.alternatives.map(a => a.type);
  assert.ok(types.includes('allow_late'));
  assert.ok(types.includes('extend_day'));
  // With allowLate the remaining minutes are scheduled after the deadline.
  const late = P.schedule(Object.assign(inp, { allowLate: ['T1'] }));
  assert.equal(late.add.reduce((s, b) => s + (b.end_at - b.start_at) / MIN, 0), 240);
});

test('confirmed commitments are never changed; locked blocks are not moved', () => {
  const inp = base();
  inp.blocks = [{ id: 'B_locked', task_id: 'T1', start_at: at(15, 10, 15), end_at: at(15, 11), status: 'confirmed', locked: 1 }];
  const plan = P.schedule(inp);
  assert.ok(!plan.remove.includes('B_locked'));
  assert.ok(plan.conflicts.some(c => c.type === 'block_overlaps_event' && c.block_id === 'B_locked'));
  // Unlocked clashing block is proposed for move (removed + re-added elsewhere).
  inp.blocks[0].locked = 0;
  const plan2 = P.schedule(inp);
  assert.ok(plan2.remove.includes('B_locked'));
  assert.ok(plan2.conflicts.some(c => c.type === 'block_moved'));
  assert.equal(plan2.add.reduce((s, b) => s + (b.end_at - b.start_at) / MIN, 0), 120);
});

test('rescheduling is incremental: kept blocks count toward the estimate', () => {
  const inp = base();
  inp.blocks = [{ id: 'B1', task_id: 'T1', start_at: at(16, 9), end_at: at(16, 10, 30), status: 'confirmed', locked: 0 }];
  const plan = P.schedule(inp);
  assert.deepEqual(plan.remove, []);
  assert.equal(plan.add.reduce((s, b) => s + (b.end_at - b.start_at) / MIN, 0), 30);
});

test('task without estimate is reported, not guessed', () => {
  const inp = base();
  inp.tasks[0].estimated_minutes = null;
  const plan = P.schedule(inp);
  assert.equal(plan.add.length, 0);
  assert.equal(plan.unscheduled[0].reason, 'needs_estimate');
});

test('done task future blocks are removed; overdue tasks flagged and scheduled ASAP', () => {
  const inp = base();
  inp.tasks[0].status = 'done';
  inp.blocks = [{ id: 'Bx', task_id: 'T1', start_at: at(16, 9), end_at: at(16, 10), status: 'confirmed', locked: 0 }];
  assert.deepEqual(P.schedule(inp).remove, ['Bx']);
  const od = base();
  od.tasks[0].deadline = at(13, 12);
  const p = P.schedule(od);
  assert.ok(p.conflicts.some(c => c.type === 'overdue'));
  assert.equal(p.add[0].start_at, NOW);
});

test('move lower-priority work: released blocks are re-planned after the boosted task', () => {
  const inp = base();
  inp.now = at(19, 18);
  inp.prefs = { dayEnd: '20:00' };
  inp.tasks[0].estimated_minutes = 180; // due Fri 23:59; Thu 18-20 and Fri 18-20 are the only free windows
  inp.events.push({ id: 'WORK', title: 'Work', start_at: at(20, 8), end_at: at(20, 17, 50) });
  inp.tasks.push({ id: 'LOW', title: 'Read novel', priority: 'low', deadline: null, estimated_minutes: 60, status: 'todo' });
  inp.blocks = [{ id: 'BL', task_id: 'LOW', start_at: at(20, 18), end_at: at(20, 19), status: 'confirmed', locked: 0 }];
  const p1 = P.schedule(inp);
  const risk = p1.conflicts.find(c => c.type === 'deadline_at_risk');
  assert.ok(risk);
  const mv = risk.alternatives.find(a => a.type === 'move_lower_priority');
  assert.ok(mv && mv.block_ids.includes('BL'));
  const p2 = P.schedule(Object.assign({}, inp, { release: mv.block_ids, boost: ['T1'] }));
  assert.ok(p2.remove.includes('BL'));
  assert.ok(!p2.conflicts.some(c => c.type === 'deadline_at_risk' && c.task_id === 'T1'));
  assert.equal(p2.add.filter(b => b.task_id === 'T1').reduce((s, b) => s + (b.end_at - b.start_at) / MIN, 0), 180);
});

test('overlapping commitments detected', () => {
  const inp = base();
  inp.events.push({ id: 'E2', title: 'Dentist', start_at: at(15, 10, 30), end_at: at(15, 11) });
  assert.ok(P.schedule(inp).conflicts.some(c => c.type === 'event_overlap'));
});

test('recurring events block time on every occurrence', () => {
  const occ = P.expandEvents([{ id: 'R', title: 'Gym', start_at: at(9, 18), end_at: at(9, 19), recurrence: '{"type":"daily"}' }], at(14, 0), at(17, 0));
  assert.deepEqual(occ.map(o => new Date(o.start).getDate()), [14, 15, 16]);
});

test('deterministic block ids prevent duplicates across devices', () => {
  const a = P.schedule(base()), b = P.schedule(base());
  assert.deepEqual(a.add.map(x => x.id), b.add.map(x => x.id));
});

test('agenda, week overview, views', () => {
  const data = { tasks: base().tasks, events: base().events, blocks: P.schedule(base()).add, reminders: [] };
  const day = P.dayAgenda(data, at(15, 0));
  assert.ok(day.items.some(i => i.type === 'event' && i.title === 'English lessons'));
  assert.ok(day.free_minutes > 0);
  const week = P.weekOverview(data, P.startOfWeek(at(20, 9)));
  assert.equal(week.length, 7);
  assert.equal(new Date(week[0].day).getDay(), 1);
  assert.ok(week.some(d => d.deadlines.includes('Programming assignment')));
  assert.equal(P.upcomingDeadlines(data.tasks, NOW).length, 1);
  assert.equal(P.overdueTasks(data.tasks, at(21, 9)).length, 1);
  assert.equal(P.byPriority(data.tasks).medium.length, 1);
});

test('reminders: multiple deadline reminders, block and event reminders with stable ids', () => {
  const t = base().tasks[0];
  const rs = P.deadlineReminders(t, NOW);
  assert.deepEqual(rs.map(r => r.due), [t.deadline - 24 * HOUR, t.deadline - 2 * HOUR]);
  assert.equal(rs[0].id, 'rem_dl_T1_24h');
  assert.equal(P.deadlineReminders(t, t.deadline - HOUR).length, 0);
  const er = P.eventReminder({ id: 'E1', title: 'English', start_at: at(15, 10), recurrence: { type: 'weekly', wday: 0 } });
  assert.equal(er.due, at(15, 9, 45));
  assert.equal(er.repeat, '{"type":"weekly","wday":0}');
});

test('nextDue matches reminder semantics and is DST-safe (calendar days)', () => {
  assert.equal(P.nextDue(at(14, 8), '{"type":"daily"}', at(14, 9)), at(15, 8));
  assert.equal(P.nextDue(at(1, 8), { type: 'weekly' }, at(14, 9)), at(15, 8));
  assert.equal(P.nextDue(at(14, 8), { type: 'interval', ms: 30 * MIN }, at(14, 9)), at(14, 9, 30));
  assert.equal(P.nextDue(at(14, 8), null, NOW), null);
});

test('Android asset copy is identical to the canonical planner', () => {
  const canon = fs.readFileSync(path.join(__dirname, 'planner.js'), 'utf8');
  const android = path.join(__dirname, '../../app/src/main/assets/www/js/planner.js');
  assert.ok(fs.existsSync(android), 'run scripts/sync-shared.sh');
  assert.equal(fs.readFileSync(android, 'utf8'), canon, 'Android copy is stale: run scripts/sync-shared.sh');
});
