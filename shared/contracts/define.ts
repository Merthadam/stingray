// Contracts: one per feature, imported by main (handler registration), preload (window.stingray) and the renderer
// (DesktopAPI, demos). Channels are `${feature}.${member}`; the renderer API stays flat (member name, or `renderer`).
import type { z } from 'zod';

declare const typeTag: unique symbol;
/** Return type carrier of a route (no runtime value). */
export type Returns<T> = { readonly [typeTag]?: T };
/** Payload type carrier of an event (no runtime value). */
export type EventOf<T> = { readonly [typeTag]?: T };
export const returns = <T>(): Returns<T> => ({});
export const event = <T>(): EventOf<T> => ({});

type AnyTuple = z.ZodTuple<any, any>;
export type InvokeEntry = readonly [AnyTuple, Returns<any>] | readonly [AnyTuple, Returns<any>, { readonly renderer: string }];
export interface Contract {
  readonly feature: string;
  readonly invoke: Readonly<Record<string, InvokeEntry>>;
  readonly events: Readonly<Record<string, EventOf<any>>>;
}

export function defineContract<const F extends string, const I extends Record<string, InvokeEntry>, const E extends Record<string, EventOf<any>>>(
  feature: F, spec: { invoke: I; events: E }): { feature: F; invoke: I; events: E } {
  return { feature, invoke: spec.invoke, events: spec.events };
}

export const channel = (feature: string, member: string) => `${feature}.${member}`;
export const rendererName = (member: string, entry: InvokeEntry) => (entry.length === 3 ? entry[2].renderer : member);

type Args<E> = E extends readonly [infer S extends AnyTuple, ...unknown[]] ? z.input<S> : never;
type Parsed<E> = E extends readonly [infer S extends AnyTuple, ...unknown[]] ? z.output<S> : never;
type Ret<E> = E extends readonly [AnyTuple, Returns<infer R>, ...unknown[]] ? R : never;
type Flat<K, E> = E extends readonly [AnyTuple, Returns<any>, { readonly renderer: infer N extends string }] ? N : K;
type Payload<E> = E extends EventOf<infer T> ? T : never;

/** Renderer side (window.stingray, demos): Promise-returning, keyed by flat renderer name. */
export type Invoke<C extends Contract> = { [K in keyof C['invoke'] as Flat<K, C['invoke'][K]>]: (...args: Args<C['invoke'][K]>) => Promise<Ret<C['invoke'][K]>> };
/** Main side (registerContract): parsed arguments, sync or async result, same keys as Invoke. */
export type Handlers<C extends Contract> = { [K in keyof C['invoke'] as Flat<K, C['invoke'][K]>]: (...args: Parsed<C['invoke'][K]>) => Ret<C['invoke'][K]> | Promise<Ret<C['invoke'][K]>> };
/** Renderer side: subscribe, returns unsubscribe. */
export type Events<C extends Contract> = { [K in keyof C['events']]: (listener: (payload: Payload<C['events'][K]>) => void) => () => void };
/** Main side: emit one event. */
export type Publishers<C extends Contract> = { [K in keyof C['events']]: (payload: Payload<C['events'][K]>) => void };
/** Envelope every handler returns (failure-isolation rule 1). Sender and argument checks still throw. */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: { message: string } };
