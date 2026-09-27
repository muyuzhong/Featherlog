import type { Chapter, Quest } from '@featherlog/contracts';

type Stored = Omit<Quest, 'derived'>;
type ObjectiveSeed = string | { text: string; detail?: string; count?: [number, number, string?]; done?: boolean };

let serial = 0;
const id = (prefix: string) => `${prefix}-${(++serial).toString(36)}`;

function chapter(title: string, objectives: ObjectiveSeed[], doneAt?: string): Chapter {
  return {
    id: id('ch'),
    title,
    objectives: objectives.map((seed) => {
      const o = typeof seed === 'string' ? { text: seed } : seed;
      return {
        id: id('ob'),
        text: o.text,
        ...(o.detail ? { detail: o.detail } : {}),
        ...(o.count ? { count: { current: o.count[0], target: o.count[1], ...(o.count[2] ? { unit: o.count[2] } : {}) } } : {}),
        ...(o.done || doneAt ? { doneAt: doneAt ?? '2026-09-20T21:00:00+08:00' } : {}),
      };
    }),
    ...(doneAt ? { doneAt } : {}),
  };
}

const done = (text: string): ObjectiveSeed => ({ text, done: true });

/** A lived-in journal: one quest line mid-way, a second one just begun, a few side quests and dailies. */
export function seedQuests(today: string, daysAgo: (n: number) => string): Stored[] {
  const base = {
    status: 'active' as const,
    priority: 'none' as const,
    tracked: false,
    revealed: false,
    createdAt: `${daysAgo(27)}T09:00:00+08:00`,
    updatedAt: `${today}T08:00:00+08:00`,
  };
  const daily = (title: string, order: number, quota?: number, current = 0, doneToday = false): Stored => ({
    ...base,
    id: id('dy'),
    kind: 'daily',
    title,
    chapters: [],
    recurrence: { freq: 'daily' },
    ...(quota ? { quota: { target: quota } } : {}),
    cycle: { periodKey: today, current: doneToday ? (quota ?? 1) : current, done: doneToday },
    order,
  });

  return [
    {
      ...base,
      id: 'q-memory',
      kind: 'main',
      title: '背完 Redis 八股',
      name: '内存之王',
      story:
        'Redis 把一切记在内存里，快得惊人——可一旦断电，记忆便烟消云散。弄清它如何把记忆刻进磁盘，方能踏上通往下一章的道路。',
      tracked: true,
      priority: 'high',
      chapters: [
        chapter('数据结构', ['五种基本类型与底层编码', '跳表为何适合有序集合', '渐进式 rehash'], `${daysAgo(9)}T22:10:00+08:00`),
        chapter('持久化', [
          done('理解 RDB 快照'),
          done('理解 AOF 日志与重写'),
          { text: '对比 RDB 与 AOF 的取舍', detail: '写一段两百字的对比笔记' },
          { text: '动手开启 AOF，观察一次重写', detail: '记下重写前后的文件大小' },
          { text: '背诵持久化八股', count: [0, 10, '题'] },
        ]),
        chapter('高可用', ['主从复制的全量与增量同步', '哨兵如何选出新主', { text: '背诵高可用八股', count: [0, 12, '题'] }]),
        chapter('集群', ['哈希槽与 MOVED 重定向', '集群扩容时的数据迁移', '一场模拟面试']),
      ],
      deadline: '2026-10-31',
      order: 0,
      createdAt: `${daysAgo(27)}T09:00:00+08:00`,
    },
    {
      ...base,
      id: 'q-iron',
      kind: 'main',
      title: '跑完一次半程马拉松',
      name: '铁人之路',
      story: '从门口的那条街开始。先让双腿记住节奏，再让心肺学会忍耐，终点在二十一公里之外。',
      chapters: [
        chapter('从五公里开始', [{ text: '每周跑三次', detail: '连续两周', count: [4, 6, '次'] }, '不停歇跑完五公里']),
        chapter('十公里', ['配速稳定在六分半以内', '完成一次十公里']),
        chapter('半程', ['报名一场半程马拉松', '冲过终点']),
      ],
      order: 1,
      createdAt: `${daysAgo(12)}T07:00:00+08:00`,
    },
    {
      ...base,
      id: 'q-login',
      kind: 'side',
      title: '修掉登录页 bug',
      name: '登录门外的怪物',
      story: '有人在登录门外徘徊，偶尔把人挡在门外。找出它，赶走它。',
      priority: 'high',
      chapters: [chapter('', [done('稳定复现问题'), { text: '定位原因', detail: '怀疑是 token 刷新的竞态' }, '修复并补上测试'])],
      deadline: today,
      order: 0,
    },
    {
      ...base,
      id: 'q-rent',
      kind: 'side',
      title: '交房租',
      name: '一封来自房东的信',
      chapters: [chapter('', [])],
      deadline: '2026-09-30',
      order: 1,
    },
    {
      ...base,
      id: 'q-ddia',
      kind: 'side',
      title: '读《DDIA》第五章',
      name: '复制之谜',
      chapters: [chapter('', ['领导者与追随者', '复制延迟的问题', '多主与无主复制'])],
      order: 2,
    },
    {
      ...base,
      id: 'q-ledger',
      kind: 'side',
      title: '整理九月的账单',
      name: '旧日的账簿',
      status: 'completed',
      chapters: [chapter('', ['收齐票据', '记入账本'], `${daysAgo(6)}T20:00:00+08:00`)],
      completedAt: `${daysAgo(6)}T20:00:00+08:00`,
      order: 3,
    },
    daily('晨跑三公里', 0, undefined, 0, true),
    daily('冥想十分钟', 1, undefined, 0, true),
    daily('背十张卡片', 2, 10, 7),
    daily('读书三十分钟', 3),
  ];
}
