import * as crypto from 'crypto';
import * as path from 'path';

import {CompilationDatabase, CompileCommand} from '../compilation-database';
import {fs} from '../pr';
import * as proc from '../proc';
import * as shlex from '../shlex';
import * as util from '../util';

import type {FileModuleImportExportEntries, ModuleImportExportEntry} from './index';

interface GccScanDepsModuleEntry {
    'logical-name': string;
    'is-interface'?: boolean;
}

interface GccScanDepsRule {
    'primary-output': string;
    provides?: GccScanDepsModuleEntry[];
    requires?: GccScanDepsModuleEntry[];
}

interface GccScanDepsP1689Output {
    rules?: GccScanDepsRule[];
}

function normalizePath(filePath: string): string {
    return util.platformNormalizePath(filePath);
}

function stableHash(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex').substring(0, 16);
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
    }
    return undefined;
}

function compileCommandOutput(entry: CompileCommand): string | undefined {
    return entry.output ?? outputFromArguments(commandArguments(entry));
}

function compileCommandOutputKeys(entry: CompileCommand): string[] {
    const output = compileCommandOutput(entry);
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

function modulePcmPath(buildDirectory: string, logicalName: string, sourcePath: string): string {
    return normalizePath(path.join(buildDirectory, '.clangd', 'modules', `${encodeURIComponent(logicalName)}-${stableHash(normalizePath(sourcePath))}.pcm`));
}

function optionValue(args: readonly string[], index: number, ...options: string[]): {nextIndex: number} | undefined {
    const arg = args[index];
    for (const option of options) {
        if (arg === option)
            return {nextIndex: index + 1};
        if (arg.startsWith(`${option}=`))
            return {nextIndex: index};
    }
    return undefined;
}

function isResponseModuleMap(argument: string): boolean {
    return argument.startsWith('@') && normalizePath(argument.substring(1)).endsWith('.modmap');
}

function filteredScanArguments(entry: CompileCommand): string[] {
    const args = commandArguments(entry);
    const sourcePath = normalizePath(resolveCommandPath(entry, entry.file));
    const filtered: string[] = [];
    for (let index = 1; index < args.length; index++) {
        const arg = args[index];
        if (arg === '-c' || arg === '-E' || isResponseModuleMap(arg))
            continue;

        const option = optionValue(args, index,
            '-o', '-x', '-MF', '-MT', '-MQ', '-fdeps-file', '-fdeps-target', '-fdeps-format', '-fmodule-mapper');
        if (option) {
            index = option.nextIndex;
            continue;
        }

        if (arg === '-MD' || arg === '-MMD' || arg === '-M' || arg === '-MM')
            continue;

        if (normalizePath(resolveCommandPath(entry, arg)) === sourcePath)
            continue;

        filtered.push(arg);
    }
    return filtered;
}

async function runGccScanDeps(
    entry: CompileCommand,
    temporaryDirectory: string,
): Promise<GccScanDepsP1689Output | undefined> {
    const args = commandArguments(entry);
    const compiler = args[0];
    const output = compileCommandOutput(entry);
    if (!compiler || !output)
        return undefined;

    const id = stableHash(`${entry.directory}\0${entry.file}\0${output}`);
    const ddiPath = path.join(temporaryDirectory, `${id}.ddi`);
    const depPath = path.join(temporaryDirectory, `${id}.d`);
    const preprocessedPath = path.join(temporaryDirectory, `${id}.ii`);
    const sourcePath = resolveCommandPath(entry, entry.file);
    const scanArgs = [
        ...filteredScanArguments(entry),
        '-E',
        '-x', 'c++',
        sourcePath,
        '-MT', ddiPath,
        '-MD',
        '-MF', depPath,
        `-fdeps-file=${ddiPath}`,
        `-fdeps-target=${output}`,
        '-fdeps-format=p1689r5',
        '-o', preprocessedPath,
    ];
    const execution = await proc.execute(compiler, scanArgs, null, {
        cwd: entry.directory,
        encoding: 'utf8',
        silent: true,
        showOutputOnError: true,
    }).result;
    if (execution.retc !== 0)
        throw new Error(`g++ dependency scan failed with code ${execution.retc}: ${execution.stderr}`);

    try {
        return JSON.parse((await fs.readFile(ddiPath)).toString()) as GccScanDepsP1689Output;
    } catch (error) {
        throw new Error(`Failed to parse g++ dependency scan output: ${util.errorToString(error)}`);
    }
}

function toModuleEntry(
    entry: GccScanDepsModuleEntry,
    buildDirectory: string,
    sourcePath: string | undefined,
): ModuleImportExportEntry {
    return {
        logicalName: entry['logical-name'],
        ...(sourcePath ? {sourcePath, pcmPath: modulePcmPath(buildDirectory, entry['logical-name'], sourcePath)} : {}),
    };
}

function collectScanResults(
    scanDepsOutputs: readonly GccScanDepsP1689Output[],
    database: CompilationDatabase,
    buildDirectory: string,
): FileModuleImportExportEntries[] {
    const commandsByOutput = buildOutputLookup(database);
    return scanDepsOutputs.flatMap(scanDepsOutput => (scanDepsOutput.rules ?? []).flatMap(rule => {
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
    }));
}

export async function scan(compilationDatabasePath: string): Promise<FileModuleImportExportEntries[]> {
    const database = await CompilationDatabase.fromFilePaths([compilationDatabasePath]);
    if (!database)
        return [];

    const temporaryDirectory = path.join(path.dirname(compilationDatabasePath), '.clangd', 'scan-deps', 'gcc');
    await fs.mkdir_p(temporaryDirectory);
    const scanDepsOutputs = (await Promise.all(database.entries().map(entry => runGccScanDeps(entry, temporaryDirectory))))
        .filter((output): output is GccScanDepsP1689Output => !!output);
    return collectScanResults(scanDepsOutputs, database, path.dirname(compilationDatabasePath));
}
