// Generated from Rust by pnpm generate:ipc. Do not edit.
// Checked by pnpm check:ipc; this is not runtime payload validation.
interface RenderedDocument {
  id: string;
  path: string;
  name: string;
  html: string;
  bytes: number;
}

interface ViewerCommands {
  take_pending_document: { args: undefined; result: RenderedDocument | null };
  open_document: { args: { path: string }; result: RenderedDocument };
  choose_document: { args: undefined; result: RenderedDocument | null };
  activate_document_images: { args: { documentId: string }; result: null };
  resolve_document_image: { args: { documentId: string; imageId: number }; result: string };
  open_link: { args: { href: string }; result: null };
  content_painted: { args: { hasDocument: boolean }; result: number };
}

interface ViewerEvents {
  'file-pending': null;
  // Tauri 2 WebView events, not emitted by this project's Rust code.
  // https://docs.rs/tauri/latest/tauri/webview/enum.DragDropEvent.html
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
