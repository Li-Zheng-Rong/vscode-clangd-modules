import * as path from 'path';

import type {CodeModel} from 'vscode-cmake-tools';

import {scan as scanClang} from './clang';

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

export async function scan(
    compilationDatabasePath: string,
    codeModel: CodeModel.Content | null | undefined,
): Promise<FileModuleImportExportEntries[]> {
    for (const toolchain of codeModel?.toolchains?.values() ?? []) {
        const clangScanDepsPath = clangScanDepsPathForToolchain(toolchain.path);
        if (clangScanDepsPath)
            return scanClang(compilationDatabasePath, clangScanDepsPath);
    }
    return [];
}

export {scanClang};
