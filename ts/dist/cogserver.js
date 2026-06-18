"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.CogServerClient = void 0;
exports.pushToCogServer = pushToCogServer;
exports.executeOnCogServer = executeOnCogServer;
const net = __importStar(require("node:net"));
const atomspace_1 = require("./atomspace");
const atomese_1 = require("./atomese");
class CogServerClient {
    socket = null;
    host;
    port;
    enterShell;
    timeoutMs;
    // The guile shell prompt that signals end-of-response.
    static PROMPT = /guile>\s*$/;
    constructor(opts = {}) {
        this.host = opts.host ?? process.env.COGSERVER_HOST ?? '127.0.0.1';
        this.port = opts.port ?? Number(process.env.COGSERVER_PORT ?? 17001);
        this.enterShell = opts.enterShell ?? 'scm hush';
        this.timeoutMs = opts.timeoutMs ?? 15_000;
    }
    connect() {
        return new Promise((resolve, reject) => {
            const socket = net.createConnection({ host: this.host, port: this.port }, () => {
                this.socket = socket;
                // Enter the Scheme shell; swallow the banner.
                socket.write(`${this.enterShell}\n`);
                setTimeout(resolve, 250);
            });
            socket.setEncoding('utf-8');
            socket.once('error', reject);
            socket.setTimeout(this.timeoutMs, () => socket.destroy(new Error('CogServer connection timed out')));
        });
    }
    /** Send a Scheme/Atomese command and resolve with the textual response. */
    send(command) {
        return new Promise((resolve, reject) => {
            const socket = this.socket;
            if (!socket)
                return reject(new Error('CogServer client not connected'));
            let buffer = '';
            const onData = (chunk) => {
                buffer += chunk;
                if (CogServerClient.PROMPT.test(buffer)) {
                    socket.off('data', onData);
                    clearTimeout(timer);
                    resolve(buffer.replace(CogServerClient.PROMPT, '').trim());
                }
            };
            const timer = setTimeout(() => {
                socket.off('data', onData);
                // Return whatever we have — some commands produce no prompt-terminated output.
                resolve(buffer.trim());
            }, this.timeoutMs);
            socket.on('data', onData);
            socket.write(`${command}\n`);
        });
    }
    async close() {
        if (!this.socket)
            return;
        try {
            this.socket.write('.\n');
        }
        catch { /* ignore */ }
        this.socket.end();
        this.socket = null;
    }
}
exports.CogServerClient = CogServerClient;
/** Push the local HellGraph metagraph into a remote CogServer's AtomSpace. */
async function pushToCogServer(opts = {}) {
    const atomese = (0, atomese_1.dumpAtomese)((0, atomspace_1.getAtomSpace)());
    const client = new CogServerClient(opts);
    await client.connect();
    try {
        // Evaluate the whole dump as one begin-form so all atoms are defined.
        await client.send(`(begin ${atomese} )`);
        return { ok: true, bytes: atomese.length };
    }
    finally {
        await client.close();
    }
}
/** Run a BindLink/GetLink on the remote CogServer's Pattern Matcher. */
async function executeOnCogServer(bindlink, opts = {}) {
    const client = new CogServerClient(opts);
    await client.connect();
    try {
        return await client.send(`(cog-execute! ${bindlink})`);
    }
    finally {
        await client.close();
    }
}
//# sourceMappingURL=cogserver.js.map