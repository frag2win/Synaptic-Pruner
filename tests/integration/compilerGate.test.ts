import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as readline from 'readline/promises';
import { compileFlow } from '../../src/compiler/compilerFlow';

vi.mock('fs');
vi.mock('readline/promises');
vi.mock('ora', () => ({
    default: () => ({
        start: () => ({
            text: '',
            stop: vi.fn(),
            succeed: vi.fn(),
            fail: vi.fn()
        })
    })
}));

describe('Compiler Authoring Gate', () => {
    let originalIsTTY: boolean | undefined;
    let rlClose: any;

    beforeEach(() => {
        originalIsTTY = process.stdin.isTTY;
        vi.clearAllMocks();
        
        vi.mocked(fs.readFileSync).mockReturnValue('[12:00:00] $ echo "test"\\ntest\\n');
        
        rlClose = vi.fn();
        vi.mocked(readline.createInterface).mockReturnValue({
            question: vi.fn(),
            close: rlClose
        } as any);
        
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        if (originalIsTTY !== undefined) {
            process.stdin.isTTY = originalIsTTY;
        } else {
            delete (process.stdin as any).isTTY;
        }
        vi.restoreAllMocks();
    });

    it('should throw an error and abort when invoked headlessly (!isTTY)', async () => {
        Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
        
        await expect(compileFlow('dummy.log', 'out.ts', { live: false })).rejects.toThrow("Fatal: Interactive TTY required");
        expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('should write to file when interactive and user explicitly approves ("y")', async () => {
        Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
        vi.mocked(readline.createInterface).mockReturnValue({
            question: vi.fn().mockResolvedValue('y'),
            close: rlClose
        } as any);

        await compileFlow('dummy.log', 'out.ts', { live: false });
        
        expect(fs.writeFileSync).toHaveBeenCalled();
        expect(rlClose).toHaveBeenCalled();
    });

    it('should reject and NOT write to file when user answers "n"', async () => {
        Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
        vi.mocked(readline.createInterface).mockReturnValue({
            question: vi.fn().mockResolvedValue('n'),
            close: rlClose
        } as any);

        await compileFlow('dummy.log', 'out.ts', { live: false });
        
        expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('should reject and NOT write to file when user presses Enter (empty)', async () => {
        Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
        vi.mocked(readline.createInterface).mockReturnValue({
            question: vi.fn().mockResolvedValue(''),
            close: rlClose
        } as any);

        await compileFlow('dummy.log', 'out.ts', { live: false });
        
        expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('should reject and NOT write to file when user inputs garbage ("asdf")', async () => {
        Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
        vi.mocked(readline.createInterface).mockReturnValue({
            question: vi.fn().mockResolvedValue('asdf'),
            close: rlClose
        } as any);

        await compileFlow('dummy.log', 'out.ts', { live: false });
        
        expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
});
