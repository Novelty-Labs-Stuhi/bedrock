// The File System Access API bits TypeScript's DOM lib still omits.

interface FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemHandle>;
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}

interface Window {
  showDirectoryPicker(options?: { mode?: "read" | "readwrite"; id?: string }): Promise<FileSystemDirectoryHandle>;
  /** The desktop shell's bridge (electron/preload.cjs); absent in a plain browser. */
  bedrock?: {
    gitCommit(root: string): Promise<string>;
    /** Opens a chat in a watched window; resolves with the conversation's URL once
        Google mints one, or null if the window closes first. */
    geminiChat(url: string): Promise<string | null>;
    /** Proves an API key against Linear and keeps it in the OS keychain. Rejects
        with what Linear said if the key is no good. */
    linearConnect(key: string): Promise<{ user: string }>;
    linearStatus(): Promise<{ connected: boolean; user: string }>;
    linearForget(): Promise<boolean>;
    /** One GraphQL call, with the stored key added by the shell. */
    linearCall(query: string, variables?: unknown): Promise<unknown>;
  };
}
