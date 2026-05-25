import * as path from 'path';

import type {CodeModel} from 'vscode-cmake-tools';

import {scan as scanClang} from './clang';
import {scan as scanGcc} from './gcc';

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

export async function scan(
    compilationDatabasePath: string,
    codeModel: CodeModel.Content | null | undefined,
): Promise<FileModuleImportExportEntries[]> {
    for (const toolchain of codeModel?.toolchains?.values() ?? []) {
        const clangScanDepsPath = clangScanDepsPathForToolchain(toolchain.path);
        if (clangScanDepsPath)
            return scanClang(compilationDatabasePath, clangScanDepsPath);
        if (isGccToolchain(toolchain.path))
            return scanGcc(compilationDatabasePath);
    }
    return [];
}

export {scanClang};
export {scanGcc};
