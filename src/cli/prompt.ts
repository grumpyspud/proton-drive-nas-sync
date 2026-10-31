import { createInterface } from 'node:readline';

export function prompt(question: string): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

/**
 * Prompts for a secret without echoing input to the terminal.
 * Falls back to a normal prompt if stdin is not a TTY.
 */
export function promptHidden(question: string): Promise<string> {
    if (!process.stdin.isTTY) {
        return prompt(`${question} (input will be visible: not a TTY): `);
    }

    return new Promise((resolve) => {
        const onData = (raw: Buffer) => {
            const text = raw.toString('utf8');
            for (const char of text) {
                if (char === '\r' || char === '\n') {
                    process.stdout.write('\n');
                    cleanup();
                    resolve(buffer);
                    return;
                }
                if (char === '\u0003') {
                    cleanup();
                    process.exit(130);
                }
                if (char === '\u007f' || char === '\b') {
                    buffer = buffer.slice(0, -1);
                } else {
                    buffer += char;
                }
            }
        };

        const cleanup = () => {
            process.stdin.removeListener('data', onData);
            process.stdin.setRawMode?.(false);
            process.stdin.pause();
        };

        let buffer = '';
        process.stdout.write(question);
        process.stdin.setRawMode?.(true);
        process.stdin.resume();
        process.stdin.on('data', onData);
    });
}
