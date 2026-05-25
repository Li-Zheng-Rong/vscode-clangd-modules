import * as path from 'path';

import type {CodeModel} from 'vscode-cmake-tools';

import {varsForMsvcToolchain} from '../visual-studio';

import {scan as scanClang} from './clang';
import {scan as scanGcc} from './gcc';
import {scan as scanMsvc} from './msvc';

export interface ModuleImportExportEntry {
    logicalName: string;
    sourcePath?: string;
    pcmPath?: string;
}

export interface FileModuleImportExportEntries {
    file: string;
    exports: ModuleImportExportEntry[];
    imports: ModuleImportExportEntry[];
}

function clangScanDepsNameForToolchain(name: string): string | undefined {
    const match = /^(?:(.+)-)?clang(?:\+\+|-cl)?(\.exe)?$/i.exec(name);
    if (!match)
        return undefined;
    return `${match[1] ? `${match[1]}-` : ''}clang-scan-deps${match[2] ?? ''}`;
}

function clangScanDepsPathForToolchain(toolchainPath: string): string | undefined {
    const scanDepsName = clangScanDepsNameForToolchain(path.basename(toolchainPath));
    if (!scanDepsName)
        return undefined;

    return path.join(path.dirname(toolchainPath), scanDepsName);
}

function isGccToolchain(toolchainPath: string): boolean {
    return /^(?:(.+)-)?(?:gcc|g\+\+|cc|c\+\+)(?:\.exe)?$/i.test(path.basename(toolchainPath));
}

function isClangClToolchain(toolchainPath: string): boolean {
    return /^(?:(.+)-)?clang-cl(?:\.exe)?$/i.test(path.basename(toolchainPath));
}

function isMsvcToolchain(toolchainPath: string): boolean {
    return /^cl(?:\.exe)?$/i.test(path.basename(toolchainPath));
}

export async function scan(
    compilationDatabasePath: string,
    codeModel: CodeModel.Content | null | undefined,
): Promise<FileModuleImportExportEntries[]> {
    for (const toolchain of codeModel?.toolchains?.values() ?? []) {
        const clangScanDepsPath = clangScanDepsPathForToolchain(toolchain.path);
        if (clangScanDepsPath) {
            const environment = isClangClToolchain(toolchain.path) ? await varsForMsvcToolchain(toolchain.path) : undefined;
            return scanClang(compilationDatabasePath, clangScanDepsPath, environment);
        }
        if (isGccToolchain(toolchain.path))
            return scanGcc(compilationDatabasePath);
        if (isMsvcToolchain(toolchain.path))
            return scanMsvc(compilationDatabasePath, toolchain.path);
    }
    return [];
}

export {scanClang};
export {scanGcc};
export {scanMsvc};
