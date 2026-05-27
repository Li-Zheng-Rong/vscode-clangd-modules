import * as path from 'path';
import * as shlex from './shlex';
import { fs } from './pr';
import * as util from './util';
import {createLogger} from './logging';
import {responseFileTokenizationMode, tokenizeResponseFile} from './scan-deps/tokenizer';
import * as nls from 'vscode-nls';

nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

const log = createLogger('compdb');

export interface CompileCommand {
    directory: string;
    file: string;
    output?: string;
    arguments: string[];
}

interface RawCompileCommand {
    directory: string;
    file: string;
    output?: string;
    command?: string;
    arguments?: string[];
}

export interface CompilationDatabaseUpdate {
    changed: CompileCommand[];
    removed: string[];
}

function normalizeCompileCommandPath(directory: string, file: string): string {
    const resolved = path.isAbsolute(file) ? file : path.resolve(directory, file);
    return util.normalizePath(resolved, { normCase: 'never', normUnicode: 'platform' });
}

export function compileCommandFilePath(entry: {directory: string; file: string}): string {
    return util.platformNormalizePath(normalizeCompileCommandPath(entry.directory, entry.file));
}

function arrayEquals<T>(left: readonly T[] | undefined, right: readonly T[] | undefined): boolean {
    if (left === right)
        return true;
    if (!left || !right || left.length !== right.length)
        return false;
    return left.every((value, index) => value === right[index]);
}

function compileCommandEquals(left: CompileCommand, right: CompileCommand): boolean {
    return left.directory === right.directory &&
        left.file === right.file &&
        left.output === right.output &&
        arrayEquals(left.arguments, right.arguments);
}

function optionValue(args: readonly string[], index: number, ...options: string[]): {nextIndex: number} | undefined {
    const arg = args[index];
    for (const option of options) {
        if (arg === option)
            return {nextIndex: index + 1};
        if (arg.startsWith(`${option}=`) || arg.startsWith(`${option}:`))
            return {nextIndex: index};
    }
    return undefined;
}

function responseFilePath(directory: string, argument: string): string {
    const filePath = argument.substring(1);
    return path.isAbsolute(filePath) ? filePath : path.resolve(directory, filePath);
}

async function expandResponseFileArgument(
    directory: string,
    argument: string,
    modeArgs: readonly string[],
    expansionStack: Set<string>,
): Promise<string[]> {
    if (!argument.startsWith('@') || argument === '@')
        return [argument];

    const filePath = responseFilePath(directory, argument);
    const normalizedPath = util.platformNormalizePath(filePath);
    if (expansionStack.has(normalizedPath)) {
        log.warning(localize('recursive.response.file', 'Skipping recursive response file {0}', `"${filePath}"`));
        return [];
    }

    try {
        const content = await fs.readFile(filePath);
        const mode = responseFileTokenizationMode(modeArgs);
        const tokens = tokenizeResponseFile(content.toString(), mode);
        expansionStack.add(normalizedPath);
        try {
            return await expandResponseFileArguments(directory, tokens, modeArgs, expansionStack);
        } finally {
            expansionStack.delete(normalizedPath);
        }
    } catch (error) {
        log.warning(localize('error.reading.response.file', 'Error reading response file {0}: {1}', `"${filePath}"`, util.errorToString(error)));
        return [argument];
    }
}

async function expandResponseFileArguments(
    directory: string,
    args: readonly string[],
    modeArgs: readonly string[] = args,
    expansionStack: Set<string> = new Set(),
): Promise<string[]> {
    const expanded: string[] = [];
    for (const arg of args) {
        expanded.push(...await expandResponseFileArgument(directory, arg, modeArgs, expansionStack));
    }
    return expanded;
}

function filterModuleArguments(args: readonly string[]): string[] {
    const filtered: string[] = [];
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '-interface' || arg === '/interface' ||
            arg === '-internalPartition' || arg === '/internalPartition')
            continue;

        const moduleOption = optionValue(args, index,
            '-ifcOutput', '/ifcOutput',
            '-reference', '/reference',
            '-x',
            '-fmodule-output',
            '-fmodule-file',
            '-fmodule-mapper');
        if (moduleOption) {
            index = moduleOption.nextIndex;
            continue;
        }

        filtered.push(arg);
    }
    return filtered;
}

async function preprocessArguments(directory: string, args: readonly string[]): Promise<string[]> {
    return filterModuleArguments(await expandResponseFileArguments(directory, args));
}

async function compileCommandFromRaw(raw: RawCompileCommand): Promise<CompileCommand> {
    const args = raw.arguments ? raw.arguments : raw.command ? [...shlex.splitCommandLine(raw.command)] : [];
    const directory = util.normalizePath(raw.directory, { normCase: 'never', normUnicode: 'platform' });
    return {
        directory,
        file: normalizeCompileCommandPath(directory, raw.file),
        output: raw.output ? normalizeCompileCommandPath(directory, raw.output) : undefined,
        arguments: await preprocessArguments(directory, args),
    };
}

export class CompilationDatabase {
    private infoByFilePath: Map<string, CompileCommand>;

    constructor(infos: CompileCommand[]) {
        this.infoByFilePath = new Map<string, CompileCommand>();
        for (const cur of infos) {
            this.set(cur);
        }
    }

    get(fsPath: string) {
        return this.infoByFilePath.get(util.platformNormalizePath(fsPath));
    }

    has(fsPath: string): boolean {
        return this.infoByFilePath.has(util.platformNormalizePath(fsPath));
    }

    entries(): CompileCommand[] {
        return [...this.infoByFilePath.values()];
    }

    set(entry: CompileCommand): void {
        const file = compileCommandFilePath(entry);
        this.infoByFilePath.set(file, entry);
    }

    replaceWith(next: CompilationDatabase): CompilationDatabaseUpdate {
        const changed: CompileCommand[] = [];
        const removed: string[] = [];

        for (const file of this.infoByFilePath.keys()) {
            if (!next.infoByFilePath.has(file))
                removed.push(file);
        }

        for (const [file, entry] of next.infoByFilePath) {
            const current = this.infoByFilePath.get(file);
            if (!current || !compileCommandEquals(current, entry))
                changed.push(entry);
        }

        this.infoByFilePath = new Map(next.infoByFilePath);
        return { changed, removed };
    }

    public static async fromFilePaths(databasePaths: string[]): Promise<CompilationDatabase> {
        const database: CompileCommand[] = [];

        for (const path of databasePaths) {
            if (!await fs.exists(path)) {
                continue;
            }

            const fileContent = await fs.readFile(path);
            try {
                const content = JSON.parse(fileContent.toString()) as RawCompileCommand[];
                database.push(...await Promise.all(content.map(compileCommandFromRaw)));
            } catch (e) {
                log.warning(localize('error.parsing.compilation.database', 'Error parsing compilation database {0}: {1}', `"${path}"`, util.errorToString(e)));
                if (e instanceof Error && e.stack) {
                    log.debug(e.stack);
                }
            }
        }

        return new CompilationDatabase(database);
    }

    public static toJson(database: CompilationDatabase): string {
        return JSON.stringify([...database.infoByFilePath.values()].map(({ file, arguments: args, directory }) => ({ file, arguments: args, directory })));
    }
}
