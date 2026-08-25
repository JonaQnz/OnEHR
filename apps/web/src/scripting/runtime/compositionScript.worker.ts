type CompositionStatus = { currentPage: string; completedBlocks: string[]; pendingBlocks: string[]; state: 'draft' | 'in_progress' | 'completed' | 'submitted' };
type InitMessage = { type: 'init'; compiled: string; pageIds: string[]; blockIds: string[]; dataBlockIds: string[]; status: CompositionStatus };
type HostMessage = InitMessage | { type: 'status'; status: CompositionStatus } | { type: 'destroy' };
const scope = self as unknown as { postMessage(message: unknown): void; close(): void; onmessage: ((event: MessageEvent<HostMessage>) => void) | null };
let pages = new Set<string>(); let blocks = new Set<string>(); let dataBlocks = new Set<string>(); let visiblePages = new Set<string>(); let visibleBlocks = new Set<string>(); let status: CompositionStatus;
const post = (type: string, data: Record<string, unknown> = {}) => scope.postMessage({ type, ...data });
const assertKnown = (ids: Set<string>, id: string, kind: string) => { if (!ids.has(id)) throw new Error(`Unbekannte ${kind}-ID "${id}".`); };
const logger = (level: string, message: unknown, details?: unknown) => post('log', { level, message: String(message), details });

function sdk() {
  return {
    pages: { show: (id: string) => { assertKnown(pages, id, 'Seiten'); visiblePages.add(id); post('page:visibility', { id, visible: true }); }, hide: (id: string) => { assertKnown(pages, id, 'Seiten'); visiblePages.delete(id); post('page:visibility', { id, visible: false }); }, isVisible: (id: string) => { assertKnown(pages, id, 'Seiten'); return visiblePages.has(id); } },
    blocks: { show: (id: string) => { assertKnown(blocks, id, 'Blöcke'); visibleBlocks.add(id); post('block:visibility', { id, visible: true }); }, hide: (id: string) => { assertKnown(blocks, id, 'Blöcke'); visibleBlocks.delete(id); post('block:visibility', { id, visible: false }); }, isVisible: (id: string) => { assertKnown(blocks, id, 'Blöcke'); return visibleBlocks.has(id); } },
    data: { refresh: async (id?: string) => { if (id !== undefined) assertKnown(dataBlocks, id, 'Datenblöcke'); post('data:refresh', id === undefined ? {} : { id }); }, setLoading: (id: string, loading: boolean) => { assertKnown(dataBlocks, id, 'Datenblöcke'); post('data:loading', { id, loading: Boolean(loading) }); } },
    navigation: { goTo: (id: string) => { assertKnown(pages, id, 'Seiten'); post('navigation:go-to', { id }); }, next: () => post('navigation:next'), previous: () => post('navigation:previous') },
    status: new Proxy({}, { get: (_target, property) => status[property as keyof CompositionStatus] }),
    logger: { debug: (message: unknown, details?: unknown) => logger('debug', message, details), info: (message: unknown, details?: unknown) => logger('info', message, details), warn: (message: unknown, details?: unknown) => logger('warn', message, details), error: (message: unknown, details?: unknown) => logger('error', message, details) },
  };
}

async function init(message: InitMessage) {
  pages = new Set(message.pageIds); blocks = new Set(message.blockIds); dataBlocks = new Set(message.dataBlockIds); visiblePages = new Set(message.pageIds); visibleBlocks = new Set(message.blockIds); status = message.status;
  const prelude = `const defineCompositionScript = (setup) => setup; for (const key of ["fetch","XMLHttpRequest","WebSocket","EventSource","Worker","SharedWorker","eval","Function","localStorage","sessionStorage","indexedDB","caches"]) { try { Object.defineProperty(globalThis, key, { value: undefined, configurable: false, writable: false }); } catch {} }`;
  const url = URL.createObjectURL(new Blob([prelude, '\n', message.compiled], { type: 'text/javascript' }));
  try { const module = await import(/* @vite-ignore */ url); if (typeof module.default !== 'function') throw new Error('Das Composition Script muss defineCompositionScript(...) als Default Export bereitstellen.'); await module.default(sdk()); post('ready'); }
  finally { URL.revokeObjectURL(url); }
}

scope.onmessage = (event) => { void (async () => { try { const message = event.data; if (message.type === 'init') await init(message); else if (message.type === 'status') status = message.status; else if (message.type === 'destroy') scope.close(); } catch (error) { post('error', { message: error instanceof Error ? error.message : 'Composition Script fehlgeschlagen.' }); } })(); };
