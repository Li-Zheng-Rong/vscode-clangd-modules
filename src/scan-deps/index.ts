import {scan as scanClang} from './clang';
import {scanEntry} from './entry';
import {scan as scanGcc} from './gcc';
import {CompilationDatabaseScanDepsManager} from './manager';
import {scan as scanMsvc} from './msvc';

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

export {CompilationDatabaseScanDepsManager};
export {buildGeneratedCompileCommands} from './build';
export {scanEntry};
export {scanClang};
export {scanGcc};
export {scanMsvc};
export {
    isClangClResponseFileMode,
    responseFileTokenizationMode,
    tokenizeResponseFile,
    tokenizeResponseFileForCommand,
    tokenizeResponseFileWithEolMarkers,
} from './tokenizer';
export type {ResponseFileToken, ResponseFileTokenizationMode, ResponseFileTokenizeOptions} from './tokenizer';
