import * as path from 'path';

export type ResponseFileTokenizationMode = 'gnu' | 'windows';
export type ResponseFileToken = string | undefined;

export interface ResponseFileTokenizeOptions {
    mode: ResponseFileTokenizationMode;
    markEol?: boolean;
}

function isWhitespace(char: string): boolean {
    return char === ' ' || char === '\t' || char === '\r' || char === '\n';
}

function isWhitespaceOrNull(char: string): boolean {
    return isWhitespace(char) || char === '\0';
}

function isQuote(char: string): boolean {
    return char === '"' || char === "'";
}

function markEol(tokens: ResponseFileToken[], enabled: boolean | undefined, char: string): void {
    if (enabled && char === '\n')
        tokens.push(undefined);
}

function tokenizeGnuResponseFile(content: string, markEolEnabled: boolean | undefined): ResponseFileToken[] {
    const tokens: ResponseFileToken[] = [];
    let token = '';
    let inToken = false;

    for (let index = 0; index < content.length; index++) {
        if (!inToken) {
            while (index < content.length && isWhitespace(content.charAt(index))) {
                markEol(tokens, markEolEnabled, content.charAt(index));
                index++;
            }
            if (index === content.length)
                break;
            inToken = true;
        }

        const char = content.charAt(index);

        if (index + 1 < content.length && char === '\\') {
            index++;
            token += content.charAt(index);
            continue;
        }

        if (isQuote(char)) {
            index++;
            while (index < content.length && content.charAt(index) !== char) {
                if (content.charAt(index) === '\\' && index + 1 < content.length)
                    index++;
                token += content.charAt(index);
                index++;
            }
            if (index === content.length)
                break;
            continue;
        }

        if (isWhitespace(char)) {
            tokens.push(token);
            markEol(tokens, markEolEnabled, char);
            token = '';
            inToken = false;
            continue;
        }

        token += char;
    }

    if (inToken)
        tokens.push(token);

    return tokens;
}

function isWindowsSpecialChar(char: string): boolean {
    return isWhitespaceOrNull(char) || char === '\\' || char === '"';
}

function parseWindowsBackslash(content: string, index: number, token: string[]): number {
    let backslashCount = 0;
    do {
        index++;
        backslashCount++;
    } while (index !== content.length && content.charAt(index) === '\\');

    const followedByDoubleQuote = index !== content.length && content.charAt(index) === '"';
    if (followedByDoubleQuote) {
        token.push('\\'.repeat(Math.floor(backslashCount / 2)));
        if (backslashCount % 2 === 0)
            return index - 1;
        token.push('"');
        return index;
    }

    token.push('\\'.repeat(backslashCount));
    return index - 1;
}

function tokenizeWindowsResponseFile(content: string, markEolEnabled: boolean | undefined): ResponseFileToken[] {
    const tokens: ResponseFileToken[] = [];
    const token: string[] = [];
    let state: 'init' | 'unquoted' | 'quoted' = 'init';

    for (let index = 0; index < content.length; index++) {
        switch (state) {
        case 'init': {
            while (index < content.length && isWhitespaceOrNull(content.charAt(index))) {
                markEol(tokens, markEolEnabled, content.charAt(index));
                index++;
            }
            if (index >= content.length)
                break;

            const start = index;
            while (index < content.length && !isWindowsSpecialChar(content.charAt(index)))
                index++;

            const normalChars = content.substring(start, index);
            if (index >= content.length || isWhitespaceOrNull(content.charAt(index))) {
                tokens.push(normalChars);
                if (index < content.length)
                    markEol(tokens, markEolEnabled, content.charAt(index));
            } else if (content.charAt(index) === '"') {
                token.push(normalChars);
                state = 'quoted';
            } else if (content.charAt(index) === '\\') {
                token.push(normalChars);
                index = parseWindowsBackslash(content, index, token);
                state = 'unquoted';
            }
            break;
        }

        case 'unquoted':
            if (isWhitespaceOrNull(content.charAt(index))) {
                tokens.push(token.join(''));
                token.length = 0;
                markEol(tokens, markEolEnabled, content.charAt(index));
                state = 'init';
            } else if (content.charAt(index) === '"') {
                state = 'quoted';
            } else if (content.charAt(index) === '\\') {
                index = parseWindowsBackslash(content, index, token);
            } else {
                token.push(content.charAt(index));
            }
            break;

        case 'quoted':
            if (content.charAt(index) === '"') {
                if (index < content.length - 1 && content.charAt(index + 1) === '"') {
                    token.push('"');
                    index++;
                } else {
                    state = 'unquoted';
                }
            } else if (content.charAt(index) === '\\') {
                index = parseWindowsBackslash(content, index, token);
            } else {
                token.push(content.charAt(index));
            }
            break;
        }
    }

    if (state !== 'init')
        tokens.push(token.join(''));

    return tokens;
}

function withoutEolMarkers(tokens: readonly ResponseFileToken[]): string[] {
    return tokens.filter((token): token is string => token !== undefined);
}

function rspQuotingMode(args: readonly string[]): ResponseFileTokenizationMode | undefined {
    let mode: ResponseFileTokenizationMode | undefined;
    for (const arg of args) {
        if (arg === '--rsp-quoting=posix')
            mode = 'gnu';
        else if (arg === '--rsp-quoting=windows')
            mode = 'windows';
    }
    return mode;
}

function driverMode(args: readonly string[]): string | undefined {
    const prefix = '--driver-mode=';
    let mode: string | undefined;
    for (const arg of args) {
        if (arg.startsWith(prefix))
            mode = arg.substring(prefix.length);
    }
    return mode;
}

function compilerImpliesClMode(compilerPath: string | undefined): boolean {
    if (!compilerPath)
        return false;
    const executableName = path.basename(compilerPath.replace(/^"|"$/g, ''));
    return /^(?:(.+)-)?clang-cl(?:\.exe)?$/i.test(executableName) || /^cl(?:\.exe)?$/i.test(executableName);
}

export function isClangClResponseFileMode(args: readonly string[], compilerPath = args[0]): boolean {
    const mode = driverMode(args);
    return mode !== undefined ? mode === 'cl' : compilerImpliesClMode(compilerPath);
}

export function responseFileTokenizationMode(args: readonly string[], compilerPath = args[0]): ResponseFileTokenizationMode {
    return rspQuotingMode(args) ?? (isClangClResponseFileMode(args, compilerPath) ? 'windows' : 'gnu');
}

export function tokenizeResponseFileWithEolMarkers(
    content: string,
    options: ResponseFileTokenizeOptions,
): ResponseFileToken[] {
    return options.mode === 'windows'
        ? tokenizeWindowsResponseFile(content, options.markEol)
        : tokenizeGnuResponseFile(content, options.markEol);
}

export function tokenizeResponseFile(content: string, mode: ResponseFileTokenizationMode): string[] {
    return withoutEolMarkers(tokenizeResponseFileWithEolMarkers(content, {mode}));
}

export function tokenizeResponseFileForCommand(content: string, args: readonly string[], compilerPath = args[0]): string[] {
    return tokenizeResponseFile(content, responseFileTokenizationMode(args, compilerPath));
}
