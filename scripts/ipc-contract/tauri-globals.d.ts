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
