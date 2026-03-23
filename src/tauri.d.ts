interface Window {
  __TAURI__: {
    event: {
      listen: (event: string, handler: (payload: any) => void) => Promise<() => void>;
      emit: (event: string, payload?: any) => Promise<void>;
    };
    core: {
      invoke: <T = any>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
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
