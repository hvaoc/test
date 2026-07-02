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
    emoji: '🚀',
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
    emoji: '🏔️',
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

  // ---- DevConf 2026: one busy day, multiple rooms, parallel tracks -------
  const projConf = {
    id: uid('proj'), name: 'DevConf 2026', emoji: '🎤',
    notes: 'One-day developer conference — multiple rooms, parallel tracks.',
    areaId: areaWork.id, color: '#e84393', when: null, deadline: t,
    status: STATUS.OPEN, createdAt: now, completedAt: null,
  };
  const cKey = { id: uid('head'), projectId: projConf.id, title: 'Keynotes & Main Stage', order: 0 };
  const cFE = { id: uid('head'), projectId: projConf.id, title: 'Frontend Track', order: 1 };
  const cBE = { id: uid('head'), projectId: projConf.id, title: 'Backend Track', order: 2 };
  const cWS = { id: uid('head'), projectId: projConf.id, title: 'Workshops', order: 3 };
  const cCom = { id: uid('head'), projectId: projConf.id, title: 'Community', order: 4 };
  const sess = (h, title, start, dur, room) =>
    mk({ projectId: projConf.id, areaId: areaWork.id, headingId: h.id, title, when: t, startMinutes: start, durationMinutes: dur, tags: [room] });
  // Main stage (single track)
  sess(cKey, 'Registration & Coffee', 510, 30, 'Main Hall'); // 08:30
  sess(cKey, 'Opening Keynote — Ada Lovelace', 540, 60, 'Main Hall'); // 09:00
  sess(cKey, 'Lunch & Networking', 750, 60, 'Main Hall'); // 12:30
  sess(cKey, 'Closing Keynote — Grace Hopper', 1020, 45, 'Main Hall'); // 17:00
  sess(cKey, 'Happy Hour', 1065, 60, 'Rooftop'); // 17:45
  // Parallel tracks (overlapping time slots across rooms)
  sess(cFE, 'React Server Components — Dan A.', 615, 45, 'Room A'); // 10:15
  sess(cBE, 'Scaling Postgres to 1M writes — Kelsey H.', 615, 45, 'Room B');
  sess(cWS, 'Design Systems Workshop', 615, 90, 'Room C');
  sess(cFE, 'CSS Container Queries — Miriam S.', 675, 45, 'Room A'); // 11:15
  sess(cBE, 'Event-driven Microservices — Sam N.', 675, 45, 'Room B');
  sess(cCom, 'Open Source Panel', 675, 45, 'Lounge');
  sess(cWS, 'Testing Workshop', 720, 60, 'Room C'); // 12:00
  sess(cFE, 'Signals & Fine-grained Reactivity — Ryan C.', 825, 45, 'Room A'); // 13:45
  sess(cBE, 'Rust for Services — Carol N.', 825, 45, 'Room B');
  sess(cCom, 'Diversity in Tech', 825, 45, 'Lounge');
  sess(cWS, 'Kubernetes Hands-on', 840, 90, 'Room C'); // 14:00
  sess(cFE, 'Accessibility Patterns — Marcy S.', 900, 45, 'Room A'); // 15:00
  sess(cBE, 'Observability 101 — Charity M.', 900, 45, 'Room B');
  sess(cCom, 'Lightning Talks', 900, 60, 'Lounge');
  sess(cFE, 'Edge Rendering — Sunil P.', 960, 45, 'Room A'); // 16:00
  sess(cBE, 'Zero-downtime Migrations — Gergely O.', 960, 45, 'Room B');
  sess(cWS, 'AI Pair Programming', 960, 60, 'Room C');

  // ---- Generated projects ------------------------------------------------
  // Five more projects, each with 5-7 sections and many tasks whose dates are
  // spread across ~4 months, so the list/board/calendar/gantt/upcoming views
  // have real volume to work with. Deterministic (index-derived, no randomness).
  const genProjects = [];
  const genHeadings = [];
  const areaFor = (i) => (i % 2 === 0 ? areaWork : areaPersonal);
  const PROJECT_DEFS = [
    { name: 'Mobile App v2', color: '#9b59b6', sections: ['Discovery', 'Design', 'iOS', 'Android', 'Backend', 'QA', 'Release'] },
    { name: 'Marketing Q3', color: '#e8554e', sections: ['Strategy', 'Content', 'Social', 'Email', 'Paid Ads', 'Analytics'] },
    { name: 'Office Move', color: '#f5a623', sections: ['Planning', 'Vendors', 'Packing', 'IT Setup', 'Furniture'] },
    { name: 'Annual Conference', color: '#16a4a4', sections: ['Venue', 'Speakers', 'Sponsors', 'Logistics', 'Marketing', 'Catering', 'Run of Show'] },
    { name: 'Home Renovation', color: '#5b6b7b', sections: ['Budget', 'Kitchen', 'Bathroom', 'Painting', 'Landscaping'] },
  ];
  const VERBS = ['Draft', 'Review', 'Finalize', 'Ship', 'Test', 'Plan', 'Schedule', 'Update', 'Research', 'Design', 'Build', 'Fix', 'Coordinate', 'Order', 'Confirm', 'Prepare', 'Write', 'Approve', 'Send', 'Book', 'Audit', 'Refine', 'Estimate', 'Migrate'];
  const NOUNS = ['the spec', 'the mockups', 'vendor quotes', 'the deck', 'the API', 'user flows', 'the budget', 'the timeline', 'the invite list', 'the layout', 'the copy', 'the tests', 'the report', 'the assets', 'the contract', 'the schedule', 'the demo', 'feedback', 'the checklist', 'the rollout', 'the roadmap', 'the metrics', 'the backlog', 'the release notes'];
  const GTAGS = ['Design', 'Frontend', 'Backend', 'QA', 'Content', 'Social', 'Ops', 'Finance', 'Important', 'Errand'];
  const GPRI = ['high', 'medium', 'low'];

  let g = 0;
  PROJECT_DEFS.forEach((def, pi) => {
    const proj = {
      id: uid('proj'), name: def.name, notes: '', areaId: areaFor(pi).id, color: def.color,
      when: null, deadline: addDays(t, 20 + pi * 15), status: STATUS.OPEN, createdAt: now, completedAt: null,
    };
    genProjects.push(proj);
    def.sections.forEach((sTitle, si) => {
      const h = { id: uid('head'), projectId: proj.id, title: sTitle, order: si };
      genHeadings.push(h);
      const count = 7 + ((g + si) % 6); // 7-12 per section
      for (let k = 0; k < count; k++) {
        g += 1;
        const over = {
          projectId: proj.id,
          areaId: proj.areaId,
          headingId: h.id,
          title: `${VERBS[g % VERBS.length]} ${NOUNS[(g * 7) % NOUNS.length]}`,
        };
        if (g % 10 < 7) {
          over.when = addDays(t, ((g * 13) % 110) - 25); // ~ -25 .. +85 days
          if (g % 5 < 2) over.deadline = addDays(over.when, 3 + (g % 8));
        } else if (g % 10 === 7) {
          over.when = WHEN.SOMEDAY;
        }
        if (g % 3 === 0) over.priority = GPRI[g % 3];
        if (g % 2 === 0) {
          const two = g % 4 === 0;
          over.tags = [...new Set([GTAGS[g % GTAGS.length], ...(two ? [GTAGS[(g * 3) % GTAGS.length]] : [])])];
        }
        if (g % 9 === 0) { over.status = STATUS.COMPLETED; over.completedAt = now - (g % 20) * day; }
        const parentId = mk(over);
        if (g % 11 === 0 && over.status !== STATUS.COMPLETED) {
          mk({ projectId: proj.id, areaId: proj.areaId, parentId, title: 'Sub-task A' });
          mk({ projectId: proj.id, areaId: proj.areaId, parentId, title: 'Sub-task B', ...(g % 22 === 0 ? { status: STATUS.COMPLETED, completedAt: now - day } : {}) });
        }
      }
    });
  });

  return {
    version: 4,
    areas: [areaWork, areaPersonal],
    projects: [projLaunch, projTrip, projConf, ...genProjects],
    headings: [hDesign, hDev, hQA, hMkt, hPlan, hPack, cKey, cFE, cBE, cWS, cCom, ...genHeadings],
    tasks,
    tags: ['Design', 'Frontend', 'Backend', 'DevOps', 'QA', 'Content', 'Social', 'Ops', 'Finance', 'Travel', 'Errand', 'Home', 'Important', 'Main Hall', 'Room A', 'Room B', 'Room C', 'Lounge'],
  };
}
