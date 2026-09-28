import { sessionBus, interface as dbusInterface, NameFlag, RequestNameReply } from 'dbus-next';
import type { Dispose, Logger, UnfoldSide } from '@featherlog/contracts';

type Session = Pick<ReturnType<typeof sessionBus>, 'requestName' | 'export' | 'unexport' |
  'disconnect'> & { on(event: 'error', listener: (cause: unknown) => void): unknown };

export class DockService extends dbusInterface.Interface {
  constructor(private setSide: (side: UnfoldSide) => UnfoldSide,
    private expanded: () => boolean) { super('org.featherlog.Dock'); }
  SetSide(side: string): UnfoldSide {
    if (side !== 'left' && side !== 'right') {
      throw Object.assign(new Error('Invalid unfold side'), { code: 'shell/invalid-input' });
    }
    return this.setSide(side);
  }
  GetExpanded(): boolean { return this.expanded(); }
}
DockService.configureMembers({ methods: {
  SetSide: { inSignature: 's', outSignature: 's' },
  GetExpanded: { inSignature: '', outSignature: 'b' },
} });

export async function registerDockService(setSide: (side: UnfoldSide) => UnfoldSide,
  expanded: () => boolean, log: Logger, connect: () => Session = sessionBus): Promise<Dispose | undefined> {
  let bus: Session | undefined;
  const service = new DockService(setSide, expanded);
  try {
    bus = connect();
    const failed = new Promise<never>((_resolve, reject) => {
      bus!.on('error', (cause: unknown) => {
        log.warn('Dock DBus connection failed', cause);
        reject(cause);
      });
    });
    const reply = await Promise.race([
      bus.requestName('org.featherlog.Shell', NameFlag.DO_NOT_QUEUE), failed,
    ]);
    if (reply !== RequestNameReply.PRIMARY_OWNER) throw new Error('Dock DBus name is already owned');
    bus.export('/Dock', service);
    const connection = bus;
    return () => {
      connection.unexport('/Dock', service);
      connection.disconnect();
    };
  } catch (cause) {
    bus?.disconnect();
    log.warn('Dock DBus registration failed; unfold side stays left', cause);
    return undefined;
  }
}
