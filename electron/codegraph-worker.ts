// Child-process entry for CodeGraph (forked by codegraph-process.ts with --liftoff-only): runs the in-process host and
// mirrors it over IPC (see serveCodeGraph in codegraph.ts).
import { serveCodeGraph } from './codegraph';
import type { WorkerEvent } from './codegraph-process';

const send = (event: WorkerEvent) => { try { process.send?.(event, undefined, undefined, () => { /* parent gone */ }); } catch { /* parent gone */ } };
const worker = serveCodeGraph(send, () => process.exit(0));
process.on('message', worker.handle);
process.on('disconnect', worker.disconnect);
