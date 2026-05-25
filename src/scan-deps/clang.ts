import * as crypto from 'crypto';
import * as path from 'path';

import {CompilationDatabase, CompileCommand} from '../compilation-database';
import {fs} from '../pr';
import * as proc from '../proc';
import * as shlex from '../shlex';
import * as util from '../util';

import type {FileModuleImportExportEntries, ModuleImportExportEntry} from './index';

interface ClangScanDepsModuleEntry {
    'logical-name': string;
    'source-path'?: string;
    'is-interface'?: boolean;
}

interface ClangScanDepsRule {
    'primary-output': string;
    provides?: ClangScanDepsModuleEntry[];
    requires?: ClangScanDepsModuleEntry[];
}

interface ClangScanDepsP1689Output {
    rules?: ClangScanDepsRule[];
}

function normalizePath(filePath: string): string {
    return util.platformNormalizePath(filePath);
}

function resolveCommandPath(entry: CompileCommand, value: string): string {
    const unquoted = value.replace(/^"|"$/g, '');
    return normalizePath(path.isAbsolute(unquoted) ? unquoted : path.resolve(entry.directory, unquoted));
}

function commandArguments(entry: CompileCommand): string[] {
    return entry.arguments ?? [...shlex.splitCommandLine(entry.command)];
}

function outputFromArguments(args: readonly string[]): string | undefined {
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '-o')
            return args[index + 1];
        if (arg.startsWith('-o') && arg.length > 2)
            return arg.substring(2);
        if (arg === '/Fo')
            return args[index + 1];
        if (arg.startsWith('/Fo') && arg.length > 3)
            return arg.substring(3);
    }
    return undefined;
}

function compileCommandOutputKeys(entry: CompileCommand): string[] {
    const output = entry.output ?? outputFromArguments(commandArguments(entry));
    if (!output)
        return [];
    return [normalizePath(output), resolveCommandPath(entry, output)];
}

function buildOutputLookup(database: CompilationDatabase): Map<string, CompileCommand> {
    const result = new Map<string, CompileCommand>();
    for (const entry of database.entries())
        for (const output of compileCommandOutputKeys(entry))
            result.set(output, entry);
    return result;
}

function stableHash(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex').substring(0, 16);
}

function modulePcmPath(buildDirectory: string, logicalName: string, sourcePath: string | undefined): string {
    const sourceKey = sourcePath ? normalizePath(sourcePath) : logicalName;
    return normalizePath(path.join(buildDirectory, '.clangd', 'modules', `${encodeURIComponent(logicalName)}-${stableHash(sourceKey)}.pcm`));
}

function toModuleEntry(
    entry: ClangScanDepsModuleEntry,
    buildDirectory: string,
    fallbackSourcePath: string | undefined,
): ModuleImportExportEntry {
    const sourcePath = entry['source-path'] ? normalizePath(entry['source-path']) : fallbackSourcePath;
    return {
        logicalName: entry['logical-name'],
        sourcePath,
        ...(fallbackSourcePath ? {pcmPath: modulePcmPath(buildDirectory, entry['logical-name'], sourcePath)} : {}),
    };
}

function isModmapResponseArgument(argument: string): boolean {
    return argument.startsWith('@') && normalizePath(argument.substring(1)).endsWith('.modmap');
}

function filteredCommandArguments(entry: CompileCommand): string[] {
    return (entry.arguments ?? []).filter(argument => !isModmapResponseArgument(argument));
}

function toFilteredCompileCommandsJson(database: CompilationDatabase): string {
    return JSON.stringify(database.entries().map(entry => ({
        directory: entry.directory,
        file: entry.file,
        output: entry.output,
        arguments: filteredCommandArguments(entry),
    })), undefined, 2);
}

async function runClangScanDeps(
    compilationDatabasePath: string,
    clangScanDepsPath: string,
    database: CompilationDatabase,
): Promise<ClangScanDepsP1689Output> {
    const temporaryDirectory = path.join(path.dirname(compilationDatabasePath), '.clangd', 'scan-deps');
    await fs.mkdir_p(temporaryDirectory);
    const filteredCompilationDatabasePath = path.join(temporaryDirectory, 'compile_commands.json');
    await fs.writeFile(filteredCompilationDatabasePath, toFilteredCompileCommandsJson(database));
    const args = [
        '-compilation-database', filteredCompilationDatabasePath,
        '-format=p1689',
    ];
    const execution = await proc.execute(clangScanDepsPath, args, null, {
        cwd: path.dirname(compilationDatabasePath),
        encoding: 'utf8',
        silent: true,
        showOutputOnError: true,
    }).result;
    if (execution.retc !== 0)
        throw new Error(`clang-scan-deps failed with code ${execution.retc}: ${execution.stderr}`);

    try {
        return JSON.parse(execution.stdout) as ClangScanDepsP1689Output;
    } catch (error) {
        throw new Error(`Failed to parse clang-scan-deps output: ${util.errorToString(error)}`);
    }
}

function collectScanResults(
    scanDepsOutput: ClangScanDepsP1689Output,
    database: CompilationDatabase,
    buildDirectory: string,
): FileModuleImportExportEntries[] {
    const commandsByOutput = buildOutputLookup(database);
    return (scanDepsOutput.rules ?? []).flatMap(rule => {
        const primaryOutput = normalizePath(rule['primary-output']);
        const command = commandsByOutput.get(primaryOutput);
        if (!command)
            return [];
        const file = resolveCommandPath(command, command.file);
        return [{
            file,
            exports: (rule.provides ?? []).map(entry => toModuleEntry(entry, buildDirectory, file)),
            imports: (rule.requires ?? []).map(entry => toModuleEntry(entry, buildDirectory, undefined)),
        }];
    });
}

export async function scan(
    compilationDatabasePath: string,
    clangScanDepsPath: string,
): Promise<FileModuleImportExportEntries[]> {
    const database = await CompilationDatabase.fromFilePaths([compilationDatabasePath]);
    if (!database)
        return [];
    const buildDirectory = path.dirname(compilationDatabasePath);
    return collectScanResults(await runClangScanDeps(compilationDatabasePath, clangScanDepsPath, database), database, buildDirectory);
}
