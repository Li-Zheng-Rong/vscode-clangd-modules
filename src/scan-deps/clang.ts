import * as path from 'path';

import {CompilationDatabase, CompileCommand} from '../compilation-database';
import {fs} from '../pr';
import * as proc from '../proc';
import * as util from '../util';
import type {Environment} from '../environment-variables';

import type {FileModuleImportExportEntries, ModuleImportExportEntry} from './index';
import {collectScanResults, commandArguments, modulePcmPath, normalizePath, stableHash} from './util';

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

function compileCommandOutputs(entry: CompileCommand): string[] {
    const output = entry.output ?? outputFromArguments(commandArguments(entry));
    if (!output)
        return [];
    return [output];
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
    return commandArguments(entry).filter(argument => !isModmapResponseArgument(argument));
}

function toFilteredCompileCommandsJson(entry: CompileCommand): string {
    return JSON.stringify([{
        directory: entry.directory,
        file: entry.file,
        output: entry.output,
        arguments: filteredCommandArguments(entry),
    }], undefined, 2);
}

async function runClangScanDeps(
    compilationDatabasePath: string,
    clangScanDepsPath: string,
    entry: CompileCommand,
    temporaryDirectory: string,
    environment: Environment | undefined,
): Promise<ClangScanDepsP1689Output> {
    const id = stableHash(`${entry.directory}\0${entry.file}\0${compileCommandOutputs(entry).join('\0')}`);
    const filteredCompilationDatabasePath = path.join(temporaryDirectory, `${id}.compile_commands.json`);
    await fs.writeFile(filteredCompilationDatabasePath, toFilteredCompileCommandsJson(entry));
    const args = [
        '-compilation-database', filteredCompilationDatabasePath,
        '-format=p1689',
    ];
    const execution = await proc.execute(clangScanDepsPath, args, null, {
        cwd: path.dirname(compilationDatabasePath),
        encoding: 'utf8',
        silent: true,
        showOutputOnError: true,
        environment,
    }).result;
    if (execution.retc !== 0)
        throw new Error(`clang-scan-deps failed with code ${execution.retc}: ${execution.stderr}`);

    try {
        return JSON.parse(execution.stdout) as ClangScanDepsP1689Output;
    } catch (error) {
        throw new Error(`Failed to parse clang-scan-deps output: ${util.errorToString(error)}`);
    }
}

export async function scan(
    compilationDatabasePath: string,
    clangScanDepsPath: string,
    environment?: Environment,
): Promise<FileModuleImportExportEntries[]> {
    const database = await CompilationDatabase.fromFilePaths([compilationDatabasePath]);
    if (!database)
        return [];
    const buildDirectory = path.dirname(compilationDatabasePath);
    const temporaryDirectory = path.join(buildDirectory, '.clangd', 'scan-deps', 'clang');
    await fs.mkdir_p(temporaryDirectory);
    const scanDepsOutputs = await Promise.all(database.entries().map(entry => runClangScanDeps(
        compilationDatabasePath,
        clangScanDepsPath,
        entry,
        temporaryDirectory,
        environment,
    )));
    return collectScanResults(scanDepsOutputs, database, buildDirectory, compileCommandOutputs, toModuleEntry);
}
