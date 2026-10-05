import type { QuestAttribute } from '@featherlog/contracts';

/** The four attributes of design §16.2, in their fixed order. */
export const ATTRIBUTES: { attribute: QuestAttribute; name: string; seal: string }[] = [
  { attribute: 'learning', name: '学识', seal: '学' },
  { attribute: 'body', name: '体魄', seal: '体' },
  { attribute: 'mind', name: '心性', seal: '心' },
  { attribute: 'craft', name: '技艺', seal: '技' },
];

export const attributeName = (attribute: QuestAttribute) => ATTRIBUTES.find((a) => a.attribute === attribute)?.name ?? attribute;
