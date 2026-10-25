import '@zana-ai/zcc-plugin-sdk/app';

// The installed host exports useRpc; SDK 0.1's bundled declarations omit it.
declare module '@zana-ai/zcc-plugin-sdk/app' {
  export function useRpc(): {
    call(method: string, args?: unknown): Promise<unknown>;
  };
}
