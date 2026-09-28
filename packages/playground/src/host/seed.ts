import type { Bus, Quest, QuestInput } from '@featherlog/contracts';

/**
 * On first run, fill the journal through the real quest API, the way a player
 * would: create quests, finish some objectives, count, track.
 */
export async function seedJournal(bus: Bus, today: (plusDays?: number) => string): Promise<void> {
  const { quests } = await bus.request('quest/list', {});
  if (quests.length) return;

  const create = async (input: QuestInput) => (await bus.request('quest/create', { input })).quest;
  const advance = async (quest: Quest, steps: number) => {
    let q = quest;
    for (let i = 0; i < steps; i++) {
      const objective = q.chapters[q.derived.chapterIndex]?.objectives[q.derived.objectiveIndex];
      if (!objective) break;
      q = (await bus.request('quest/complete-objective', { id: q.id, objectiveId: objective.id })).quest;
    }
    return q;
  };

  const memory = await create({
    kind: 'main',
    title: '背完 Redis 八股',
    name: '内存之王',
    story: 'Redis 把一切记在内存里，快得惊人——可一旦断电，记忆便烟消云散。弄清它如何把记忆刻进磁盘，方能踏上通往下一章的道路。',
    priority: 'high',
    deadline: today(33),
    chapters: [
      { title: '数据结构', objectives: [{ text: '五种基本类型与底层编码' }, { text: '跳表为何适合有序集合' }, { text: '渐进式 rehash' }] },
      {
        title: '持久化',
        objectives: [
          { text: '理解 RDB 快照' },
          { text: '理解 AOF 日志与重写' },
          { text: '对比 RDB 与 AOF 的取舍', detail: '写一段两百字的对比笔记' },
          { text: '动手开启 AOF，观察一次重写', detail: '记下重写前后的文件大小' },
          { text: '背诵持久化八股', count: { target: 10, unit: '题' } },
        ],
      },
      { title: '高可用', objectives: [{ text: '主从复制的全量与增量同步' }, { text: '哨兵如何选出新主' }, { text: '背诵高可用八股', count: { target: 12, unit: '题' } }] },
      { title: '集群', objectives: [{ text: '哈希槽与 MOVED 重定向' }, { text: '集群扩容时的数据迁移' }, { text: '一场模拟面试' }] },
    ],
  });
  await advance(memory, 5);
  await bus.request('quest/track', { id: memory.id });

  const iron = await create({
    kind: 'main',
    title: '跑完一次半程马拉松',
    name: '铁人之路',
    story: '从门口的那条街开始。先让双腿记住节奏，再让心肺学会忍耐，终点在二十一公里之外。',
    chapters: [
      { title: '从五公里开始', objectives: [{ text: '每周跑三次', detail: '连续两周', count: { target: 6, unit: '次' } }, { text: '不停歇跑完五公里' }] },
      { title: '十公里', objectives: [{ text: '配速稳定在六分半以内' }, { text: '完成一次十公里' }] },
      { title: '半程', objectives: [{ text: '报名一场半程马拉松' }, { text: '冲过终点' }] },
    ],
  });
  const firstRun = iron.chapters[0]!.objectives[0]!;
  await bus.request('quest/count', { id: iron.id, objectiveId: firstRun.id, set: 4 });

  const login = await create({
    kind: 'side',
    title: '修掉登录页 bug',
    name: '登录门外的怪物',
    story: '有人在登录门外徘徊，偶尔把人挡在门外。找出它，赶走它。',
    priority: 'high',
    deadline: today(),
    chapters: [{ title: '', objectives: [{ text: '稳定复现问题' }, { text: '定位原因', detail: '怀疑是 token 刷新的竞态' }, { text: '修复并补上测试' }] }],
  });
  await advance(login, 1);

  await create({ kind: 'side', title: '交房租', name: '一封来自房东的信', deadline: today(2) });
  await create({
    kind: 'side',
    title: '读《DDIA》第五章',
    name: '复制之谜',
    chapters: [{ title: '', objectives: [{ text: '领导者与追随者' }, { text: '复制延迟的问题' }, { text: '多主与无主复制' }] }],
  });
  const ledger = await create({
    kind: 'side',
    title: '整理九月的账单',
    name: '旧日的账簿',
    chapters: [{ title: '', objectives: [{ text: '收齐票据' }, { text: '记入账本' }] }],
  });
  await bus.request('quest/complete', { id: ledger.id });

  const daily = (title: string, quota?: number) =>
    create({ kind: 'daily', title, recurrence: { freq: 'daily' }, ...(quota ? { quota: { target: quota } } : {}) });
  const run = await daily('晨跑三公里');
  const meditate = await daily('冥想十分钟');
  const cards = await daily('背十张卡片', 10);
  await daily('读书三十分钟');
  await bus.request('quest/complete', { id: run.id });
  await bus.request('quest/complete', { id: meditate.id });
  await bus.request('quest/count', { id: cards.id, set: 7 });
}
