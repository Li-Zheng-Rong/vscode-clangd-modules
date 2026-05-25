import {CompileCommand} from '../compilation-database';

import type {FileModuleImportExportEntries, ModuleScanResult} from './index';
import {scan as scanClang} from './clang';
import {scan as scanGcc} from './gcc';
import {scan as scanMsvc} from './msvc';
import {clangScanDepsPathForToolchain, compilerPath, isGccToolchain, isMsvcToolchain, resolveCommandPath} from './util';

export async function scanEntry(
    entry: CompileCommand,
): Promise<FileModuleImportExportEntries | undefined> {
    const compiler = compilerPath(entry);
    if (!compiler)
        return undefined;

    let scanResult: ModuleScanResult | undefined;
    if (isMsvcToolchain(compiler))
        scanResult = await scanMsvc(entry);
    else if (isGccToolchain(compiler))
        scanResult = await scanGcc(entry);
    else if (clangScanDepsPathForToolchain(compiler))
        scanResult = await scanClang(entry);

    return scanResult ? {file: resolveCommandPath(entry, entry.file), ...scanResult} : undefined;
}
