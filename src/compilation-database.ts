import * as path from 'path';
import * as shlex from './shlex';
import { fs } from './pr';
import * as util from './util';
import {createLogger} from './logging';
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

export function compileCommandFilePath(entry: {directory: string; file: string}): string {
    return util.platformNormalizePath(path.isAbsolute(entry.file) ? entry.file : path.resolve(entry.directory, entry.file));
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

function optionValue(
    args: readonly string[],
    index: number,
    ...options: string[]
): { nextIndex: number } | undefined {
    const arg = args[index];
    for (const option of options) {
        if (arg === option)
            return { nextIndex: index + 1 };

        const prefix = `${option}=`;
        if (arg.startsWith(prefix))
            return { nextIndex: index };
    }
    return undefined;
}

function isModmapResponseArgument(argument: string): boolean {
    return argument.startsWith('@') && util.platformNormalizePath(argument.substring(1)).endsWith('.modmap');
}

function preprocessArguments(args: readonly string[]): string[] {
    const filtered: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (isModmapResponseArgument(arg))
            continue;

        const moduleMapper = optionValue(args, i, '-fmodule-mapper');
        if (moduleMapper) {
            i = moduleMapper.nextIndex;
            continue;
        }

        filtered.push(arg);
    }
    return filtered;
}

function compileCommandFromRaw(raw: RawCompileCommand): CompileCommand {
    const args = raw.arguments ? raw.arguments : raw.command ? [...shlex.splitCommandLine(raw.command)] : [];
    const directory = util.platformNormalizePath(raw.directory);
    return {
        directory,
        file: compileCommandFilePath({directory, file: raw.file}),
        output: raw.output ? compileCommandFilePath({directory, file: raw.output}) : undefined,
        arguments: preprocessArguments(args)
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
                database.push(...content.map(compileCommandFromRaw));
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
