// Keep these contracts aligned with commands in src-tauri/src/main.rs and
// the serialized Document in src-tauri/src/document.rs. They do not validate IPC.
interface RenderedDocument {
  html: string;
  name: string;
  path: string;
  bytes: number;
}

interface ViewerCommands {
  open_document: { args: { path: string }; result: RenderedDocument };
  choose_document: { args: undefined; result: RenderedDocument | null };
  take_pending_document: { args: undefined; result: RenderedDocument | null };
  open_link: { args: { href: string }; result: null };
  content_painted: { args: { hasDocument: boolean }; result: number };
}

interface ViewerEvents {
  'file-pending': null;
  'tauri://drag-enter': { paths: string[]; position: { x: number; y: number } };
  'tauri://drag-leave': null;
  'tauri://drag-drop': { paths: string[]; position: { x: number; y: number } };
}

interface Window {
  __TAURI__: {
    core: {
      invoke<K extends keyof ViewerCommands>(
        command: K,
        ...args: ViewerCommands[K]['args'] extends undefined ? [] : [ViewerCommands[K]['args']]
      ): Promise<ViewerCommands[K]['result']>;
    };
    event: {
      listen<K extends keyof ViewerEvents>(
        event: K,
        handler: (event: { event: K; id: number; payload: ViewerEvents[K] }) => void,
      ): Promise<() => void>;
    };
  };
}
