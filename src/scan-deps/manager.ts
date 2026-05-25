import * as path from 'path';
import * as fs_ from 'fs';
import * as vscode from 'vscode';
import {BaseLanguageClient} from 'vscode-languageclient';

import {ClangdContext} from '../clangd-context';
import {CompilationDatabase, CompileCommand, compileCommandFilePath} from '../compilation-database';
import {Environment} from '../environment-variables';
import {createLogger} from '../logging';
import {fs} from '../pr';
import * as util from '../util';
import {varsForMsvcToolchain} from '../visual-studio';

import {buildGeneratedCompileCommands} from './build';
import type {FileModuleImportExportEntries} from './index';
import {scanEntry} from './entry';
import {isClangClToolchain, isMsvcToolchain} from './util';

const log = createLogger('scan-deps-cdb-manager');

export interface CompilationDatabaseScanDepsManagerOptions {
    globalStoragePath?: string;
    outputChannel?: vscode.OutputChannel;
    modulesEnabled?: boolean;
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
    try {
        return (await fs.readFile(filePath)).toString();
    } catch {
        return undefined;
    }
}

async function executableExists(filePath: string): Promise<boolean> {
    try {
        await fs_.promises.access(filePath, fs_.constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

function executableNameCandidates(name: string): string[] {
    if (process.platform !== 'win32' || path.extname(name))
        return [name];

    const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .filter(extension => extension.length > 0);
    return extensions.map(extension => `${name}${extension}`);
}

async function findProgramByName(name: string): Promise<string | undefined> {
    for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
        if (!directory)
            continue;

        for (const candidateName of executableNameCandidates(name)) {
            const candidate = path.join(directory, candidateName);
            if (await executableExists(candidate))
                return candidate;
        }
    }
    return undefined;
}

export class CompilationDatabaseScanDepsManager implements vscode.Disposable {
    private readonly onDidChangeClientEmitter = new vscode.EventEmitter<BaseLanguageClient | undefined>();
    private readonly subscriptions: vscode.Disposable[] = [];
    private database: CompilationDatabase = new CompilationDatabase([]);
    private clangdContext: ClangdContext | null = null;
    private cdbWatcher: vscode.FileSystemWatcher | undefined;
    private cdbRefreshTimer: ReturnType<typeof setTimeout> | undefined;
    private sourceRefreshTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly pendingSourceRefreshes = new Set<string>();
    private refreshChain: Promise<void> = Promise.resolve();
    private readonly moduleDepsByFile = new Map<string, FileModuleImportExportEntries>();

    readonly onDidChangeClient = this.onDidChangeClientEmitter.event;

    constructor(private readonly compilationDatabasePath: string,
                private options: CompilationDatabaseScanDepsManagerOptions = {}) {
        this.createCdbWatcher();
        this.subscriptions.push(vscode.workspace.onDidSaveTextDocument(
            document => { this.handleSavedDocument(document); }));
        void this.enqueueRefresh(async () => { await this.refreshCdb(true); });
    }

    get compilationDatabase(): CompilationDatabase { return this.database; }

    get client(): BaseLanguageClient | undefined { return this.clangdContext?.client; }

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

    private createCdbWatcher(): void {
        this.cdbWatcher?.dispose();
        this.cdbWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(path.dirname(this.compilationDatabasePath), path.basename(this.compilationDatabasePath)));
        this.subscriptions.push(this.cdbWatcher.onDidChange(uri => { void this.handleCdbChanged(uri); }));
        this.subscriptions.push(this.cdbWatcher.onDidCreate(uri => { void this.handleCdbChanged(uri); }));
        this.subscriptions.push(this.cdbWatcher);
    }

    private async handleCdbChanged(uri: vscode.Uri): Promise<void> {
        if (util.platformNormalizePath(uri.fsPath) !== util.platformNormalizePath(this.compilationDatabasePath))
            return;

        try {
            if ((await vscode.workspace.fs.stat(uri)).size <= 0)
                return;
        } catch {
            return;
        }

        this.scheduleCdbRefresh();
    }

    private handleSavedDocument(document: vscode.TextDocument): void {
        if (document.uri.scheme !== 'file' || !this.hasFile(document.uri.fsPath))
            return;

        this.scheduleSourceRefresh(document.uri.fsPath);
    }

    private scheduleCdbRefresh(): void {
        if (this.cdbRefreshTimer)
            clearTimeout(this.cdbRefreshTimer);

        this.cdbRefreshTimer = setTimeout(() => {
            this.cdbRefreshTimer = undefined;
            void this.enqueueRefresh(async () => { await this.refreshCdb(); });
        }, 2000);
    }

    private scheduleSourceRefresh(filePath: string): void {
        this.pendingSourceRefreshes.add(util.platformNormalizePath(filePath));
        if (this.sourceRefreshTimer)
            clearTimeout(this.sourceRefreshTimer);

        this.sourceRefreshTimer = setTimeout(() => {
            const filePaths = [...this.pendingSourceRefreshes];
            this.pendingSourceRefreshes.clear();
            this.sourceRefreshTimer = undefined;
            void this.enqueueRefresh(async () => { await this.refreshFiles(filePaths); });
        }, 2000);
    }

    private async enqueueRefresh(action: () => Promise<void>): Promise<void> {
        const run = async () => {
            try {
                await action();
            } catch (error) {
                log.warning(`Failed to refresh generated compile database: ${util.errorToString(error)}`);
                if (error instanceof Error && error.stack)
                    log.debug(error.stack);
            }
        };
        this.refreshChain = this.refreshChain.then(run, run);
        await this.refreshChain;
    }

    private async refreshFile(filePath: string): Promise<boolean> {
        return this.refreshFiles([filePath]);
    }

    private async refreshFiles(filePaths: string[]): Promise<boolean> {
        const entries: CompileCommand[] = [];
        const seenFiles = new Set<string>();
        for (const filePath of filePaths) {
            const entry = this.database.get(filePath);
            if (!entry)
                continue;

            const file = compileCommandFilePath(entry);
            if (seenFiles.has(file))
                continue;

            seenFiles.add(file);
            entries.push(entry);
        }

        if (entries.length === 0)
            return false;

        await Promise.all(entries.map(entry => this.scanAndUpdate(entry)));
        return this.writeGeneratedCompileCommands(false);
    }

    async refreshCdb(forceRewrite = false): Promise<boolean> {
        const nextDatabase = await CompilationDatabase.fromFilePaths([this.compilationDatabasePath]) ?? new CompilationDatabase([]);
        const update = this.database.replaceWith(nextDatabase);
        for (const file of update.removed)
            this.moduleDepsByFile.delete(file);

        if (this.options.modulesEnabled === false) {
            this.moduleDepsByFile.clear();
            return update.changed.length > 0 || update.removed.length > 0 || forceRewrite
                ? this.writeGeneratedCompileCommands(forceRewrite)
                : false;
        }

        await Promise.all(update.changed.map(entry => this.scanAndUpdate(entry)));
        return update.changed.length > 0 || update.removed.length > 0 || forceRewrite
            ? this.writeGeneratedCompileCommands(forceRewrite)
            : false;
    }

    private async scanAndUpdate(entry: CompileCommand): Promise<void> {
        const file = compileCommandFilePath(entry);
        if (this.options.modulesEnabled === false) {
            this.moduleDepsByFile.delete(file);
            return;
        }

        const result = await scanEntry(entry);
        if (result)
            this.moduleDepsByFile.set(file, result);
        else
            this.moduleDepsByFile.delete(file);
    }

    private async writeGeneratedCompileCommands(forceRewrite: boolean): Promise<boolean> {
        const generated = await buildGeneratedCompileCommands(this.database, this.moduleDeps());
        const content = JSON.stringify(generated.commands, undefined, 2);
        if (!forceRewrite && await readTextIfExists(this.generatedCompileCommandsPath) === content)
            return false;

        await fs.mkdir_p(path.dirname(this.generatedCompileCommandsPath));
        await fs.writeFile(this.generatedCompileCommandsPath, content);
        log.info(`Updated generated clangd compile database: ${this.generatedCompileCommandsPath}`);
        for (const diagnostic of generated.diagnostics)
            log.warning(diagnostic);
        await this.restartClangd();
        return true;
    }

    async restartClangd(): Promise<void> {
        if (this.clangdContext?.clientIsStarting())
            return;

        this.clangdContext?.dispose();
        if (!this.options.globalStoragePath || !this.options.outputChannel) {
            this.clangdContext = null;
            this.onDidChangeClientEmitter.fire(undefined);
            return;
        }

        const environment = await this.visualStudioEnvironmentFromCdb();
        const queryDriver = await this.queryDriverFromCompilers();
        this.logClangdEnvironment(environment);
        this.logClangdQueryDriver(queryDriver);
        this.clangdContext = await ClangdContext.create(
            this.options.globalStoragePath,
            this.options.outputChannel,
            {
                compileCommandsDir: this.generatedCompileCommandsDir,
                environment,
                queryDriver,
            });
        this.onDidChangeClientEmitter.fire(this.client);
    }

    shutdownClangd(): void {
        if (this.clangdContext?.clientIsStarting())
            return;

        this.clangdContext?.dispose();
        this.clangdContext = null;
        this.onDidChangeClientEmitter.fire(undefined);
    }

    clientIsStarting(): boolean { return this.clangdContext?.clientIsStarting() ?? false; }

    clientIsRunning(): boolean { return this.clangdContext?.clientIsRunning() ?? false; }

    private async resolveCompilerPathLikeClangd(compiler: string | undefined, directory?: string): Promise<string | undefined> {
        if (!compiler)
            return undefined;
        const unquoted = compiler.replace(/^\"|\"$/g, '');
        return /[\\/]/.test(unquoted)
            ? path.resolve(directory ?? '', unquoted)
            : await findProgramByName(unquoted);
    }

    private async visualStudioEnvironmentFromCdb(): Promise<Environment | undefined> {
        for (const entry of this.database.entries()) {
            const compiler = entry.arguments[0];
            if (!isMsvcToolchain(compiler) && !isClangClToolchain(compiler))
                continue;

            const driver = await this.resolveCompilerPathLikeClangd(compiler, entry.directory);
            if (!driver)
                return undefined;

            return varsForMsvcToolchain(driver);
        }
        return undefined;
    }

    private async addQueryDriverPath(drivers: Set<string>, compiler: string | undefined, directory?: string): Promise<void> {
        if (!compiler || isMsvcToolchain(compiler) || isClangClToolchain(compiler))
            return;

        const driver = await this.resolveCompilerPathLikeClangd(compiler, directory);
        if (!driver)
            return;

        drivers.add(driver);
        drivers.add(path.normalize(driver));
        try {
            drivers.add(await fs_.promises.realpath(driver));
        } catch {
        }
    }

    private async queryDriverFromCompilers(): Promise<string | undefined> {
        const drivers = new Set<string>();
        await Promise.all(this.database.entries().map(entry => this.addQueryDriverPath(
            drivers,
            entry.arguments[0],
            entry.directory,
        )));

        if (drivers.size === 0)
            return undefined;
        return [...drivers].join(',');
    }

    private logClangdEnvironment(environment: Environment | undefined): void {
        if (!environment) {
            log.debug('Starting clangd without Visual Studio environment: no MSVC or clang-cl compiler found in CDB.');
            return;
        }

        const include = environment.INCLUDE ?? '';
        const lib = environment.LIB ?? '';
        const pathValue = environment.PATH ?? '';
        log.info(`Starting clangd with Visual Studio environment from CDB: INCLUDE=${include ? 'set' : 'missing'}, LIB=${lib ? 'set' : 'missing'}, PATH=${pathValue ? 'set' : 'missing'}`);
        log.debug(`Visual Studio INCLUDE for clangd: ${include}`);
    }

    private logClangdQueryDriver(queryDriver: string | undefined): void {
        if (queryDriver)
            log.debug(`Starting clangd with query-driver: ${queryDriver}`);
    }

    dispose(): void {
        if (this.cdbRefreshTimer)
            clearTimeout(this.cdbRefreshTimer);
        if (this.sourceRefreshTimer)
            clearTimeout(this.sourceRefreshTimer);
        this.pendingSourceRefreshes.clear();
        this.subscriptions.forEach(subscription => { subscription.dispose(); });
        this.subscriptions.length = 0;
        this.shutdownClangd();
        this.onDidChangeClientEmitter.dispose();
    }

}
