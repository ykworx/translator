interface TauriEvent<P = unknown> {
  event: string;
  id: number;
  payload: P;
}

interface Window {
  __TAURI__: {
    event: {
      listen: <P = unknown>(event: string, handler: (event: TauriEvent<P>) => void) => Promise<() => void>;
      emit: (event: string, payload?: unknown) => Promise<void>;
    };
    core: {
      invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
    };
    window: {
      getCurrentWindow: () => {
        close: () => Promise<void>;
        hide: () => Promise<void>;
        show: () => Promise<void>;
      };
    };
  };
}
