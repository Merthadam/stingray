import { z } from 'zod';
import { idSchema } from './common';
import { defineContract, event, returns } from './define';

export type ContainerInfo = {
  id: string; name: string; image: string; state: string; health: string;
  paths: string[];
  ports: { port: number; target: string; url: string; cdp?: true }[];
  /** Started by scripts/test-env.sh (label stingray.test-env): the only containers Stingray may stop or read logs from. */
  testEnv?: boolean;
};
export type WorkspacePort = { workspaceId: string; terminalId?: string; port: number; url: string; label: string; source: 'terminal' | 'docker'; containerId?: string; testEnv?: boolean; cdp?: true };
/** A Chrome DevTools Protocol endpoint to show in a live view tab. */
export type LiveViewTarget = { workspaceId: string; url: string; port: number; containerId?: string };
const unit = z.number().finite().min(0).max(1); // position normalized to the frame, so the renderer never needs page metadata
const modifiers = z.number().int().min(0).max(15); // CDP bit field: Alt 1, Ctrl 2, Meta 4, Shift 8
const delta = z.number().finite().min(-10_000).max(10_000);
export const liveViewInputSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('mouse'), action: z.enum(['mousePressed', 'mouseReleased', 'mouseMoved']), x: unit, y: unit,
    button: z.enum(['none', 'left', 'middle', 'right']), clickCount: z.number().int().min(0).max(3), modifiers }),
  z.strictObject({ type: z.literal('wheel'), x: unit, y: unit, deltaX: delta, deltaY: delta, modifiers }),
  z.strictObject({ type: z.literal('key'), action: z.enum(['keyDown', 'keyUp']), key: z.string().min(1).max(32), code: z.string().max(32),
    keyCode: z.number().int().min(0).max(255), text: z.string().max(4).optional(), modifiers }),
  z.strictObject({ type: z.literal('text'), text: z.string().min(1).max(10_000) }),
]);
export type LiveViewInput = z.infer<typeof liveViewInputSchema>;
export type LiveViewSession = { sessionId: string; targetUrl: string; title: string };
export type LiveViewEvent =
  | { sessionId: string; kind: 'frame'; data: string }
  | { sessionId: string; kind: 'closed'; reason: string };

const frameSize = z.number().int().min(16).max(8192);
const containerId = z.string().regex(/^[a-f0-9]{64}$/);
export const runtimeContract = defineContract('runtime', {
  invoke: {
    containers: [z.tuple([]), returns<ContainerInfo[]>()],
    /** docker stop; test-env containers only. */
    stopContainer: [z.tuple([containerId]), returns<void>()],
    /** Last ~300 log lines; test-env containers only. */
    containerLogs: [z.tuple([containerId]), returns<string>()],
    /** Copies 127.0.0.1:<port> and opens chrome://inspect in Google Chrome when possible. */
    inspectCdp: [z.tuple([z.number().int().min(1).max(65535)]), returns<{ address: string; opened: boolean }>()],
    ports: [z.tuple([]), returns<WorkspacePort[]>()],
    /** Screencast + input of a test instance's Stingray window over CDP on 127.0.0.1:port; max sizes are frame pixels. */
    liveViewStart: [z.tuple([z.strictObject({ port: z.number().int().min(1).max(65535), maxWidth: frameSize.optional(), maxHeight: frameSize.optional() })]), returns<LiveViewSession>()],
    liveViewInput: [z.tuple([idSchema, liveViewInputSchema]), returns<void>()],
    liveViewResize: [z.tuple([idSchema, frameSize, frameSize]), returns<void>()],
    liveViewStop: [z.tuple([idSchema]), returns<void>()],
    /** The latest frame was displayed; the next one may be sent. */
    liveViewAck: [z.tuple([idSchema]), returns<void>()],
  },
  events: { onLiveView: event<LiveViewEvent>() },
});
