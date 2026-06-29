import { uid } from '../utils/id';
import { todayKey, addDays } from '../utils/date';
import { WHEN, STATUS } from './constants';

// First-run seed data so the app looks alive instead of empty. Mirrors the kind
// of content Things ships in its onboarding.
export function buildSampleData() {
  const t = todayKey();

  const areaWork = { id: uid('area'), name: 'Work', color: '#2b6fff' };
  const areaPersonal = { id: uid('area'), name: 'Personal', color: '#1f9d55' };

  const projLaunch = {
    id: uid('proj'),
    name: 'Launch Website',
    notes: 'Ship the new marketing site before the conference.',
    areaId: areaWork.id,
    color: '#2b6fff',
    when: null,
    deadline: addDays(t, 5),
    status: STATUS.OPEN,
    createdAt: Date.now(),
    completedAt: null,
  };
  const projTrip = {
    id: uid('proj'),
    name: 'Weekend Trip',
    notes: '',
    areaId: areaPersonal.id,
    color: '#1f9d55',
    when: null,
    deadline: null,
    status: STATUS.OPEN,
    createdAt: Date.now(),
    completedAt: null,
  };

  const headingDesign = { id: uid('head'), projectId: projLaunch.id, title: 'Design' };
  const headingDev = { id: uid('head'), projectId: projLaunch.id, title: 'Development' };

  const mk = (over) => ({
    id: uid('task'),
    title: '',
    notes: '',
    checklist: [],
    tags: [],
    when: null,
    deadline: null,
    projectId: null,
    areaId: null,
    headingId: null,
    status: STATUS.OPEN,
    createdAt: Date.now(),
    completedAt: null,
    order: 0,
    ...over,
  });

  const tasks = [
    mk({ title: 'Welcome to Things 👋', notes: 'Tap a row to open it. Swipe right to complete, swipe left to schedule.', when: WHEN.TODAY }),
    mk({ title: 'Buy groceries', notes: 'Milk, eggs, coffee', when: WHEN.TODAY, areaId: areaPersonal.id, checklist: [
      { id: uid('chk'), title: 'Milk', done: false },
      { id: uid('chk'), title: 'Eggs', done: true },
      { id: uid('chk'), title: 'Coffee', done: false },
    ] }),
    mk({ title: 'Call the dentist', when: WHEN.TODAY, deadline: t, areaId: areaPersonal.id }),
    mk({ title: 'Draft homepage copy', projectId: projLaunch.id, headingId: headingDesign.id, when: WHEN.TODAY }),
    mk({ title: 'Pick hero illustration', projectId: projLaunch.id, headingId: headingDesign.id }),
    mk({ title: 'Set up CI pipeline', projectId: projLaunch.id, headingId: headingDev.id }),
    mk({ title: 'Build the landing page', projectId: projLaunch.id, headingId: headingDev.id, when: addDays(t, 2) }),
    mk({ title: 'Reply to investor email', when: WHEN.EVENING, areaId: areaWork.id }),
    mk({ title: 'Renew passport', when: addDays(t, 9), deadline: addDays(t, 20), areaId: areaPersonal.id }),
    mk({ title: 'Book hotel', projectId: projTrip.id, when: addDays(t, 1) }),
    mk({ title: 'Make a packing list', projectId: projTrip.id }),
    mk({ title: 'Read "Shape Up"', when: WHEN.SOMEDAY, areaId: areaWork.id }),
    mk({ title: 'Learn to make pasta', when: WHEN.SOMEDAY, areaId: areaPersonal.id }),
    mk({ title: 'Clear inbox of old notes' }),
    mk({ title: 'Set up new laptop', status: STATUS.COMPLETED, completedAt: Date.now() - 86400000, areaId: areaWork.id }),
  ];

  return {
    version: 1,
    areas: [areaWork, areaPersonal],
    projects: [projLaunch, projTrip],
    headings: [headingDesign, headingDev],
    tasks,
    tags: ['Errand', 'Home', 'Office', 'Important'],
  };
}
