import type { Dispose, Json, SlotHosts, SlotKind } from '@featherlog/contracts';
import { useEffect, useRef, useSyncExternalStore, type CSSProperties } from 'react';
import type { SlotRegistry } from './registry';

type Extras = {
  'collapsed.preview': { onSetHeight?(height: number): void };
  'panel.tab': { params?: Json };
  popup: { popupId: string; props?: Json; onClose(result?: Json): void };
};

type Props<K extends SlotKind> = {
  registry: SlotRegistry;
  kind: K;
  id: string;
  visible: boolean;
  className?: string;
  style?: CSSProperties;
} & Extras[K];

/** Mounts whatever a plugin provided for `kind`/`id` into a div, and keeps its host in sync. */
export function SlotMount<K extends SlotKind>(props: Props<K>) {
  const { registry, kind, id, visible, className, style } = props;
  const el = useRef<HTMLDivElement>(null);
  const mount = useSyncExternalStore(registry.subscribe, () => registry.get(kind, id));

  // Listener sets live across renders; the host object reads them.
  const state = useRef({
    visible,
    show: new Set<() => void>(),
    hide: new Set<() => void>(),
    params: new Set<(params: Json | undefined) => void>(),
    props,
  });
  state.current.props = props;

  useEffect(() => {
    if (!mount || !el.current) return;
    const s = state.current;
    const on = <T,>(set: Set<T>, listener: T): Dispose => {
      set.add(listener);
      return () => set.delete(listener);
    };
    const base = {
      slotId: id,
      get visible() {
        return s.visible;
      },
      onShow: (listener: () => void) => on(s.show, listener),
      onHide: (listener: () => void) => on(s.hide, listener),
    };
    const extras = s.props as Props<SlotKind> & Partial<Extras[keyof Extras]>;
    const hosts: SlotHosts = {
      'collapsed.preview': {
        ...base,
        setHeight: (height) => (extras as Extras['collapsed.preview']).onSetHeight?.(height),
      },
      'panel.tab': {
        ...base,
        get params() {
          return (s.props as Extras['panel.tab']).params;
        },
        onParamsChange: (listener) => on(s.params, listener),
      },
      popup: {
        ...base,
        popupId: (extras as Extras['popup']).popupId ?? '',
        props: (extras as Extras['popup']).props,
        close: (result) => (s.props as Extras['popup']).onClose(result),
      },
    };
    const unmount = mount(el.current, hosts[kind]);
    return () => {
      // Plugins often unmount a React root of their own; doing that while the
      // shell's root is committing makes React warn, so let the commit finish.
      if (typeof unmount === 'function') queueMicrotask(unmount);
      s.show.clear();
      s.hide.clear();
      s.params.clear();
    };
  }, [mount, kind, id]);

  useEffect(() => {
    const s = state.current;
    if (s.visible === visible) return;
    s.visible = visible;
    (visible ? s.show : s.hide).forEach((listener) => listener());
  }, [visible]);

  const params = kind === 'panel.tab' ? (props as Extras['panel.tab']).params : undefined;
  useEffect(() => {
    if (kind === 'panel.tab') state.current.params.forEach((listener) => listener(params));
  }, [kind, params]);

  return <div ref={el} className={className} style={style} data-slot={`${kind}:${id}`} />;
}
