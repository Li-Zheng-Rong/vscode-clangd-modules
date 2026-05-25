import * as crypto from 'crypto';
import * as path from 'path';

import {CompilationDatabase, CompileCommand} from '../compilation-database';
import * as shlex from '../shlex';
import * as baseUtil from '../util';

import type {FileModuleImportExportEntries, ModuleImportExportEntry} from './index';

export interface ScanDepsModuleEntry {
    'logical-name': string;
}

export interface ScanDepsRule<Entry extends ScanDepsModuleEntry> {
    'primary-output': string;
    provides?: Entry[];
    requires?: Entry[];
}

export interface ScanDepsOutput<Entry extends ScanDepsModuleEntry> {
    rules?: ScanDepsRule<Entry>[];
}

export type ModuleEntryMapper<Entry extends ScanDepsModuleEntry> = (
    entry: Entry,
    buildDirectory: string,
    fallbackSourcePath: string | undefined,
) => ModuleImportExportEntry;

export function normalizePath(filePath: string): string {
    return baseUtil.platformNormalizePath(filePath);
}

export function resolveCommandPath(entry: CompileCommand, value: string): string {
    const unquoted = value.replace(/^\"|\"$/g, '');
    return normalizePath(path.isAbsolute(unquoted) ? unquoted : path.resolve(entry.directory, unquoted));
}

export function commandArguments(entry: CompileCommand): string[] {
    return entry.arguments ?? [...shlex.splitCommandLine(entry.command)];
}

export function stableHash(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex').substring(0, 16);
}

export function modulePcmPath(buildDirectory: string, logicalName: string, sourcePath: string | undefined): string {
    const sourceKey = sourcePath ? normalizePath(sourcePath) : logicalName;
    return normalizePath(path.join(buildDirectory, '.clangd', 'modules', `${encodeURIComponent(logicalName)}-${stableHash(sourceKey)}.pcm`));
}

export function buildOutputLookup(
    database: CompilationDatabase,
    outputsForEntry: (entry: CompileCommand) => readonly string[],
): Map<string, CompileCommand> {
    const result = new Map<string, CompileCommand>();
    for (const entry of database.entries())
        for (const output of outputsForEntry(entry))
            result.set(resolveCommandPath(entry, output), entry);
    return result;
}

export function commandForPrimaryOutput(
    database: CompilationDatabase,
    commandsByOutput: Map<string, CompileCommand>,
    primaryOutput: string,
): CompileCommand | undefined {
    if (path.isAbsolute(primaryOutput))
        return commandsByOutput.get(normalizePath(primaryOutput));
    for (const entry of database.entries()) {
        const command = commandsByOutput.get(resolveCommandPath(entry, primaryOutput));
        if (command)
            return command;
    }
    return undefined;
}

export function collectScanResults<Entry extends ScanDepsModuleEntry>(
    scanDepsOutputs: readonly ScanDepsOutput<Entry>[],
    database: CompilationDatabase,
    buildDirectory: string,
    outputsForEntry: (entry: CompileCommand) => readonly string[],
    toModuleEntry: ModuleEntryMapper<Entry>,
): FileModuleImportExportEntries[] {
    const commandsByOutput = buildOutputLookup(database, outputsForEntry);
    return scanDepsOutputs.flatMap(scanDepsOutput => (scanDepsOutput.rules ?? []).flatMap(rule => {
        const command = commandForPrimaryOutput(database, commandsByOutput, rule['primary-output']);
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
