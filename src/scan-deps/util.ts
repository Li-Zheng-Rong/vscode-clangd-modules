import * as crypto from 'crypto';
import * as path from 'path';

import {CompileCommand} from '../compilation-database';
import * as shlex from '../shlex';
import * as baseUtil from '../util';

import type {ModuleExportEntry, ModuleImportEntry, ModuleScanResult} from './index';

export interface ScanDepsModuleEntry {
    'logical-name': string;
    'source-path'?: string;
    'is-interface'?: boolean;
}

export interface ScanDepsRule<Entry extends ScanDepsModuleEntry> {
    'primary-output': string;
    provides?: Entry[];
    requires?: Entry[];
}

export interface ScanDepsOutput<Entry extends ScanDepsModuleEntry> {
    rules?: ScanDepsRule<Entry>[];
}

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

export function compilerPath(entry: CompileCommand): string | undefined {
    return commandArguments(entry)[0];
}

export function clangScanDepsNameForToolchain(name: string): string | undefined {
    const match = /^(?:(.+)-)?clang(?:\+\+|-cl)?(\.exe)?$/i.exec(name);
    if (!match)
        return undefined;
    return `${match[1] ? `${match[1]}-` : ''}clang-scan-deps${match[2] ?? ''}`;
}

export function clangScanDepsPathForToolchain(toolchainPath: string): string | undefined {
    const scanDepsName = clangScanDepsNameForToolchain(path.basename(toolchainPath));
    if (!scanDepsName)
        return undefined;

    return path.join(path.dirname(toolchainPath), scanDepsName);
}

export function isGccToolchain(toolchainPath: string): boolean {
    return /^(?:(.+)-)?(?:gcc|g\+\+|cc|c\+\+)(?:\.exe)?$/i.test(path.basename(toolchainPath));
}

export function isClangClToolchain(toolchainPath: string): boolean {
    return /^(?:(.+)-)?clang-cl(?:\.exe)?$/i.test(path.basename(toolchainPath));
}

export function isMsvcToolchain(toolchainPath: string): boolean {
    return /^cl(?:\.exe)?$/i.test(path.basename(toolchainPath));
}

export function stableHash(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex').substring(0, 16);
}

export function modulePcmPath(buildDirectory: string, logicalName: string, sourcePath: string | undefined): string {
    const sourceKey = sourcePath ? normalizePath(sourcePath) : logicalName;
    return normalizePath(path.join(buildDirectory, '.clangd', 'modules', `${encodeURIComponent(logicalName)}-${stableHash(sourceKey)}.pcm`));
}

function moduleSourcePath(entry: ScanDepsModuleEntry, fallbackSourcePath: string): string {
    return entry['source-path'] ? normalizePath(entry['source-path']) : fallbackSourcePath;
}

function moduleExportEntry(entry: ScanDepsModuleEntry, buildDirectory: string, fallbackSourcePath: string): ModuleExportEntry {
    const sourcePath = moduleSourcePath(entry, fallbackSourcePath);
    return {
        logicalName: entry['logical-name'],
        sourcePath,
        pcmPath: modulePcmPath(buildDirectory, entry['logical-name'], sourcePath),
    };
}

function moduleImportEntry(entry: ScanDepsModuleEntry): ModuleImportEntry {
    return {
        logicalName: entry['logical-name'],
        ...(entry['source-path'] ? {sourcePath: normalizePath(entry['source-path'])} : {}),
    };
}

export function collectModuleScanResult<Entry extends ScanDepsModuleEntry>(
    scanDepsOutput: ScanDepsOutput<Entry>,
    buildDirectory: string,
    exportSourcePath: string,
): ModuleScanResult | undefined {
    const rules = scanDepsOutput.rules ?? [];
    if (!rules.length)
        return undefined;

    return {
        exports: rules.flatMap(rule => (rule.provides ?? []).map(entry => moduleExportEntry(entry, buildDirectory, exportSourcePath))),
        imports: rules.flatMap(rule => (rule.requires ?? []).map(moduleImportEntry)),
    };
}
