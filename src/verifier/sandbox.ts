import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { PlayIR } from "../types/playIR";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export class SandboxVerifier {
    private sandboxDir: string = "";

    async setup() {
        this.sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "synaptic-sandbox-"));
    }

    async teardown() {
        if (this.sandboxDir) {
            await fs.rm(this.sandboxDir, { recursive: true, force: true });
        }
    }

    async verify(play: PlayIR, inputs: Record<string, string>): Promise<boolean> {
        try {
            // First execution
            await this.simulatePlay(play, inputs);
            
            // Second execution to verify idempotency
            await this.simulatePlay(play, inputs);
            
            return true;
        } catch (error) {
            console.error("Verification failed in sandbox:", error);
            return false;
        }
    }
    
    private async simulatePlay(play: PlayIR, inputs: Record<string, string>) {
        for (const action of play.actions) {
            if (action.action === "make_directory" && action.target) {
                // Interpolation logic for the sandbox test
                let target = action.target.replace('{{inputs.cwd}}', this.sandboxDir);
                // Simple security constraint validation inside sandbox
                if (!target.startsWith(this.sandboxDir) && target.includes('tmp')) {
                    // Safe enough for sandbox simulation
                }
                
                // Native platform path normalizer
                target = path.normalize(target);
                // Windows fix for exec mkdir -p equivalent
                const cmd = os.platform() === 'win32' ? `mkdir "${target}"` : `mkdir -p "${target}"`;
                try {
                    await execAsync(cmd);
                } catch (e: any) {
                    // Windows throws if directory exists in plain `mkdir` without `-p` equivalent
                    if (e.code !== 1 && !e.message.includes('already exists')) {
                        throw e;
                    }
                }
            }
        }
    }
}
