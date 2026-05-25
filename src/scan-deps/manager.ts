import * as path from 'path';

import {CompilationDatabase, CompileCommand, compileCommandFilePath} from '../compilation-database';
import {Environment} from '../environment-variables';
import {createLogger} from '../logging';
import {fs} from '../pr';
import {varsForMsvcToolchain} from '../visual-studio';

import {buildGeneratedCompileCommands} from './build';
import type {FileModuleImportExportEntries} from './index';
import {scanEntry} from './entry';
import {isClangClToolchain, isMsvcToolchain} from './util';

const log = createLogger('scan-deps-cdb-manager');

export interface CompilationDatabaseScanDepsManagerOptions {
    toolchain?: string;
    restart?: (cdbPath: string, environment?: Environment) => Promise<void> | void;
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
    try {
        return (await fs.readFile(filePath)).toString();
    } catch {
        return undefined;
    }
}

export class CompilationDatabaseScanDepsManager {
    private database: CompilationDatabase = new CompilationDatabase([]);
    private readonly moduleDepsByFile = new Map<string, FileModuleImportExportEntries>();

    constructor(private readonly compilationDatabasePath: string,
                private options: CompilationDatabaseScanDepsManagerOptions = {}) {}

    get compilationDatabase(): CompilationDatabase { return this.database; }

    get buildDirectory(): string { return path.dirname(this.compilationDatabasePath); }

    get generatedCompileCommandsDir(): string { return path.join(this.buildDirectory, '.clangd'); }

    get generatedCompileCommandsPath(): string { return path.join(this.generatedCompileCommandsDir, 'compile_commands.json'); }

    setOptions(options: CompilationDatabaseScanDepsManagerOptions): void {
        this.options = {...this.options, ...options};
    }

    moduleDeps(): FileModuleImportExportEntries[] {
        return [...this.moduleDepsByFile.values()];
    }

    hasFile(filePath: string): boolean {
        return this.database.has(filePath);
    }

    async refreshFile(filePath: string): Promise<boolean> {
        const entry = this.database.get(filePath);
        if (!entry)
            return false;

        await this.scanAndUpdate(entry);
        return this.writeGeneratedCompileCommands();
    }

    async refreshCdb(): Promise<boolean> {
        const nextDatabase = await CompilationDatabase.fromFilePaths([this.compilationDatabasePath]) ?? new CompilationDatabase([]);
        if (nextDatabase.entries().length === 0) {
            const hadState = this.database.entries().length > 0 || this.moduleDepsByFile.size > 0;
            this.clear();
            return hadState ? this.writeGeneratedCompileCommands() : false;
        }

        const update = this.database.replaceWith(nextDatabase);
        for (const file of update.removed)
            this.moduleDepsByFile.delete(file);

        await Promise.all(update.changed.map(entry => this.scanAndUpdate(entry)));
        return update.changed.length > 0 || update.removed.length > 0 ? this.writeGeneratedCompileCommands() : false;
    }

    private async scanAndUpdate(entry: CompileCommand): Promise<void> {
        const file = compileCommandFilePath(entry);
        const result = await scanEntry(entry);
        if (result)
            this.moduleDepsByFile.set(file, result);
        else
            this.moduleDepsByFile.delete(file);
    }

    private async writeGeneratedCompileCommands(): Promise<boolean> {
        const generated = await buildGeneratedCompileCommands(this.database, this.moduleDeps());
        const content = JSON.stringify(generated.commands, undefined, 2);
        if (await readTextIfExists(this.generatedCompileCommandsPath) === content)
            return false;

        await fs.mkdir_p(path.dirname(this.generatedCompileCommandsPath));
        await fs.writeFile(this.generatedCompileCommandsPath, content);
        log.info(`Updated generated clangd compile database: ${this.generatedCompileCommandsPath}`);
        for (const diagnostic of generated.diagnostics)
            log.warning(diagnostic);
        await this.options.restart?.(this.generatedCompileCommandsPath, await this.visualStudioEnvironmentForToolchain());
        return true;
    }

    private async visualStudioEnvironmentForToolchain(): Promise<Environment | undefined> {
        const toolchain = this.options.toolchain;
        if (!toolchain || (!isMsvcToolchain(toolchain) && !isClangClToolchain(toolchain)))
            return undefined;

        return varsForMsvcToolchain(toolchain);
    }

    private clear(): void {
        this.database = new CompilationDatabase([]);
        this.moduleDepsByFile.clear();
    }

}
