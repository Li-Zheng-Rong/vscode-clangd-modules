import {CompilationDatabase, CompileCommand} from '../compilation-database';

import {scan as scanClang} from './clang';
import {scan as scanGcc} from './gcc';
import {scan as scanMsvc} from './msvc';
import {clangScanDepsPathForToolchain, compilerPath, isGccToolchain, isMsvcToolchain, resolveCommandPath} from './util';

export interface ModuleExportEntry {
    logicalName: string;
    sourcePath: string;
    pcmPath: string;
}

export interface ModuleImportEntry {
    logicalName: string;
    sourcePath?: string;
}

export interface FileModuleImportExportEntries {
    file: string;
    exports: ModuleExportEntry[];
    imports: ModuleImportEntry[];
}

export interface ModuleScanResult {
    exports: ModuleExportEntry[];
    imports: ModuleImportEntry[];
}

async function scanEntry(
    entry: CompileCommand,
): Promise<FileModuleImportExportEntries | undefined> {
    const compiler = compilerPath(entry);
    if (!compiler)
        return undefined;

    let scanResult: ModuleScanResult | undefined;
    const clangScanDepsPath = clangScanDepsPathForToolchain(compiler);
    if (clangScanDepsPath)
        scanResult = await scanClang(entry);
    else if (isGccToolchain(compiler))
        scanResult = await scanGcc(entry);
    else if (isMsvcToolchain(compiler))
        scanResult = await scanMsvc(entry);

    return scanResult ? {file: resolveCommandPath(entry, entry.file), ...scanResult} : undefined;
}

export async function scan(compilationDatabasePath: string): Promise<FileModuleImportExportEntries[]> {
    const database = await CompilationDatabase.fromFilePaths([compilationDatabasePath]);
    if (!database)
        return [];

    return (await Promise.all(database.entries().map(entry => scanEntry(entry))))
        .filter((result): result is FileModuleImportExportEntries => !!result);
}

export {scanClang};
export {scanGcc};
export {scanMsvc};
