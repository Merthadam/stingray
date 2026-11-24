// The single IPC entry of the main process: trusted-sender check, zod argument parse (both throw: trust boundary),
// then the action inside an error envelope so a failing handler never leaves an unhandled rejection (rule 1).
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import type { z } from 'zod';
import { channel, rendererName, type Contract, type Handlers, type IpcResult } from '../../shared/contracts/define';

export interface IpcContext {
  ipcMain: Pick<IpcMain, 'handle'>;
  window(): BrowserWindow | undefined;
  rendererUrl: string;
  log?: (message: string, error: unknown) => void;
}

export function handle(ctx: IpcContext, name: string, schema: z.ZodType, action: (...args: any[]) => unknown): void {
  ctx.ipcMain.handle(name, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<IpcResult<unknown>> => {
    const win = ctx.window();
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame ||
        event.senderFrame.url.split('#')[0] !== ctx.rendererUrl) throw new Error('Untrusted IPC sender.');
    const parsed = schema.parse(args) as unknown[];
    try { return { ok: true, value: await action(...parsed) }; } catch (error) {
      (ctx.log ?? console.error)(`IPC ${name} failed:`, error);
      return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } };
    }
  });
}

/** Registers every route of a contract; `handlers` must have exactly the contract's flat names (tsc). */
export function registerContract<C extends Contract>(ctx: IpcContext, contract: C, handlers: NoInfer<Handlers<C>>): void {
  for (const [member, entry] of Object.entries(contract.invoke)) {
    const action = (handlers as Record<string, (...args: any[]) => unknown>)[rendererName(member, entry)];
    handle(ctx, channel(contract.feature, member), entry[0], action);
  }
}
