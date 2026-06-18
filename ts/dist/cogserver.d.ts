/**
 * CogServer client — direct TCP federation with a running OpenCog CogServer.
 *
 * The CogServer exposes the AtomSpace on the network (default port 17001) behind
 * a Scheme (guile) shell. This client enters that shell and issues Atomese/Scheme
 * commands, so HellGraph can push its metagraph into a remote AtomSpace, pull
 * results back, and trigger native Pattern Matcher / PLN execution — the same
 * channel a `CogStorageNode` uses to federate AtomSpaces.
 *
 * This is the no-sidecar path: useful when an OpenCog CogServer is already
 * running. For embedded reasoning, prefer the HTTP sidecar (sidecar.ts).
 */
export interface CogServerOptions {
    host?: string;
    port?: number;
    /** Command that enters the Scheme shell. Default 'scm hush' to suppress echo. */
    enterShell?: string;
    timeoutMs?: number;
}
export declare class CogServerClient {
    private socket;
    private readonly host;
    private readonly port;
    private readonly enterShell;
    private readonly timeoutMs;
    private static readonly PROMPT;
    constructor(opts?: CogServerOptions);
    connect(): Promise<void>;
    /** Send a Scheme/Atomese command and resolve with the textual response. */
    send(command: string): Promise<string>;
    close(): Promise<void>;
}
/** Push the local HellGraph metagraph into a remote CogServer's AtomSpace. */
export declare function pushToCogServer(opts?: CogServerOptions): Promise<{
    ok: boolean;
    bytes: number;
}>;
/** Run a BindLink/GetLink on the remote CogServer's Pattern Matcher. */
export declare function executeOnCogServer(bindlink: string, opts?: CogServerOptions): Promise<string>;
//# sourceMappingURL=cogserver.d.ts.map