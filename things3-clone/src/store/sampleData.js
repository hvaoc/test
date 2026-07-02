import { uid } from '../utils/id';
import { todayKey, addDays } from '../utils/date';
import { WHEN, STATUS } from './constants';

// First-run seed data. Deliberately broad so every view has something to show:
// nested subtasks, priorities, labels, deadlines, time-blocked to-dos (for the
// day planner), checklists, completed/canceled items, and dates spread across
// the month (for Upcoming / Calendar / Gantt).
export function buildSampleData() {
  const t = todayKey();
  const now = Date.now();
  const day = 86400000;

  const areaWork = { id: uid('area'), name: 'Work', color: '#2b6fff' };
  const areaPersonal = { id: uid('area'), name: 'Personal', color: '#1f9d55' };

  const projLaunch = {
    id: uid('proj'),
    name: 'Launch Website',
    notes: 'Ship the new marketing site before the conference.',
    areaId: areaWork.id,
    color: '#2b6fff',
    when: null,
    deadline: addDays(t, 12),
    status: STATUS.OPEN,
    createdAt: now,
    completedAt: null,
  };
  const projTrip = {
    id: uid('proj'),
    name: 'Weekend Trip',
    notes: 'Long weekend in the mountains.',
    areaId: areaPersonal.id,
    color: '#1f9d55',
    when: null,
    deadline: addDays(t, 6),
    status: STATUS.OPEN,
    createdAt: now,
    completedAt: null,
  };

  const hDesign = { id: uid('head'), projectId: projLaunch.id, title: 'Design', order: 0 };
  const hDev = { id: uid('head'), projectId: projLaunch.id, title: 'Development', order: 1 };
  const hQA = { id: uid('head'), projectId: projLaunch.id, title: 'QA', order: 2 };
  const hMkt = { id: uid('head'), projectId: projLaunch.id, title: 'Marketing', order: 3 };
  const hPlan = { id: uid('head'), projectId: projTrip.id, title: 'Planning', order: 0 };
  const hPack = { id: uid('head'), projectId: projTrip.id, title: 'Packing', order: 1 };

  const tasks = [];
  let ord = 0;
  // Creates a task, pushes it, and returns its id (so subtasks can reference it).
  const mk = (over) => {
    const task = {
      id: uid('task'),
      title: '',
      notes: '',
      checklist: [],
      tags: [],
      when: null,
      deadline: null,
      priority: null,
      location: '',
      projectId: null,
      areaId: null,
      headingId: null,
      parentId: null,
      startMinutes: null,
      durationMinutes: null,
      status: STATUS.OPEN,
      createdAt: now,
      completedAt: null,
      order: ord++,
      ...over,
    };
    tasks.push(task);
    return task.id;
  };
  const chk = (title, done = false) => ({ id: uid('chk'), title, done });
  const done = (agoDays) => ({ status: STATUS.COMPLETED, completedAt: now - agoDays * day });

  // ---- Launch Website ---------------------------------------------------
  const L = { projectId: projLaunch.id, areaId: areaWork.id };

  // Design — a task with two levels of subtasks + a time block today.
  const designMockups = mk({
    ...L, headingId: hDesign.id, title: 'Design mockups',
    priority: 'high', tags: ['Design'], when: t, deadline: addDays(t, 3),
    startMinutes: 9 * 60, durationMinutes: 60, notes: 'Figma file in the shared drive.',
  });
  mk({ ...L, parentId: designMockups, title: 'Wireframes', ...done(2) });
  const hifi = mk({ ...L, parentId: designMockups, title: 'Hi-fi mockups' });
  mk({ ...L, parentId: hifi, title: 'Export assets @2x' });
  // Left untimed on today so the day planner's All-day / Unscheduled panel has
  // something to schedule.
  mk({ ...L, headingId: hDesign.id, title: 'Pick hero illustration', tags: ['Design'], when: t });

  // Development — subtasks + a time block today + a multi-day bar.
  const buildLanding = mk({
    ...L, headingId: hDev.id, title: 'Build the landing page',
    priority: 'high', tags: ['Frontend'], when: t, deadline: addDays(t, 4),
    startMinutes: 14 * 60, durationMinutes: 90,
  });
  mk({ ...L, parentId: buildLanding, title: 'Header component', ...done(1) });
  mk({ ...L, parentId: buildLanding, title: 'Hero section' });
  mk({ ...L, parentId: buildLanding, title: 'Footer', ...done(1) });
  mk({ ...L, headingId: hDev.id, title: 'Set up CI pipeline', tags: ['DevOps'], when: addDays(t, 2), deadline: addDays(t, 5) });
  mk({ ...L, headingId: hDev.id, title: 'API integration', priority: 'medium', tags: ['Backend'], when: addDays(t, 6), deadline: addDays(t, 9) });

  // QA
  mk({ ...L, headingId: hQA.id, title: 'Write test plan', priority: 'low', tags: ['QA'], when: addDays(t, 7) });
  mk({ ...L, headingId: hQA.id, title: 'Cross-browser testing', tags: ['QA'], when: addDays(t, 10), deadline: addDays(t, 12) });
  mk({ ...L, headingId: hQA.id, title: 'Fix reported bugs', ...done(3) });

  // Marketing — more today time blocks + a copy checklist.
  mk({
    ...L, headingId: hMkt.id, title: 'Draft homepage copy',
    tags: ['Content'], when: t, startMinutes: 11 * 60, durationMinutes: 45,
    checklist: [chk('Headline'), chk('Feature bullets', true), chk('CTA')],
  });
  mk({ ...L, headingId: hMkt.id, title: 'Email newsletter', priority: 'medium', tags: ['Content'], deadline: addDays(t, 8) });
  mk({ ...L, headingId: hMkt.id, title: 'Schedule launch tweets', tags: ['Social'], when: addDays(t, 14) });
  mk({ ...L, headingId: hMkt.id, title: 'Draft press release', ...done(4), tags: ['Content'] });

  // ---- Weekend Trip -----------------------------------------------------
  const T = { projectId: projTrip.id, areaId: areaPersonal.id };
  mk({ ...T, headingId: hPlan.id, title: 'Book hotel', tags: ['Travel'], when: addDays(t, 1), deadline: addDays(t, 3) });
  mk({ ...T, headingId: hPlan.id, title: 'Rent a car', priority: 'medium', tags: ['Travel'], when: addDays(t, 2) });
  const itinerary = mk({ ...T, headingId: hPlan.id, title: 'Plan itinerary', when: addDays(t, 4) });
  mk({ ...T, parentId: itinerary, title: 'Day 1 · hiking trail' });
  mk({ ...T, parentId: itinerary, title: 'Day 2 · city tour' });
  mk({
    ...T, headingId: hPack.id, title: 'Make a packing list',
    checklist: [chk('Passport'), chk('Charger', true), chk('Sunscreen'), chk('Hiking boots')],
  });
  mk({ ...T, headingId: hPack.id, title: 'Buy travel insurance', priority: 'low', deadline: addDays(t, 4) });

  // ---- Loose to-dos: Today / Evening / Someday / Inbox / Logbook --------
  mk({ title: 'Welcome to Things 👋', notes: 'Tap a row to open it. Try the project layouts: List · Board · Calendar · Gantt · Date.', when: t });
  mk({
    title: 'Buy groceries', areaId: areaPersonal.id, when: t, tags: ['Errand'],
    checklist: [chk('Milk'), chk('Eggs', true), chk('Coffee')],
  });
  mk({ title: 'Call the dentist', areaId: areaPersonal.id, when: t, deadline: t, priority: 'high', tags: ['Errand'], location: 'Downtown Clinic' });
  mk({ title: 'Renew passport', areaId: areaPersonal.id, when: addDays(t, 9), deadline: addDays(t, 20), tags: ['Important'] });
  mk({ title: 'Reply to investor email', areaId: areaWork.id, when: WHEN.EVENING, priority: 'medium' });
  mk({ title: 'Evening run', areaId: areaPersonal.id, when: WHEN.EVENING, tags: ['Home'] });

  mk({ title: 'Read "Shape Up"', areaId: areaWork.id, when: WHEN.SOMEDAY });
  mk({ title: 'Learn to make fresh pasta', areaId: areaPersonal.id, when: WHEN.SOMEDAY });

  mk({ title: 'Clear inbox of old notes' });
  mk({ title: 'Idea: automate the weekly report' });

  mk({ title: 'Set up new laptop', areaId: areaWork.id, ...done(1) });
  mk({ title: 'Submit expense report', areaId: areaWork.id, ...done(2) });
  mk({ title: 'Cancel unused subscription', areaId: areaPersonal.id, status: STATUS.CANCELED, completedAt: now - 5 * day });

  return {
    version: 2,
    areas: [areaWork, areaPersonal],
    projects: [projLaunch, projTrip],
    headings: [hDesign, hDev, hQA, hMkt, hPlan, hPack],
    tasks,
    tags: ['Design', 'Frontend', 'Backend', 'DevOps', 'QA', 'Content', 'Social', 'Travel', 'Errand', 'Home', 'Important'],
  };
}
