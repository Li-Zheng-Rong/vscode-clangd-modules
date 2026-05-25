import * as path from 'path';
import * as vscode from 'vscode';
import {BaseLanguageClient} from 'vscode-languageclient';
import {CMakeToolsApi, getCMakeToolsApi, Project, Version} from 'vscode-cmake-tools';

import {createLogger} from './logging';
import {CompilationDatabaseScanDepsManager} from './scan-deps';

const log = createLogger('cmake-active-project');

export interface ActiveCMakeProjectState {
  projectUri: vscode.Uri;
  project: Project;
  buildDirectory: string;
  compilationDatabasePath: string;
  generatedCompileCommandsDir: string;
}

export class CMakeActiveProjectManager implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly onDidChangeClientEmitter = new vscode.EventEmitter<BaseLanguageClient|undefined>();
  private activeState: ActiveCMakeProjectState|undefined;
  private cdbManager: CompilationDatabaseScanDepsManager|undefined;
  private cdbManagerClientSubscription: vscode.Disposable|undefined;
  private activeProjectGeneration = 0;

  readonly onDidChangeClient = this.onDidChangeClientEmitter.event;

  static async create(globalStoragePath: string,
                      outputChannel: vscode.OutputChannel): Promise<CMakeActiveProjectManager> {
    const api = await getCMakeToolsApi(Version.latest);
    if (!api)
      log.warning('CMake Tools API is not available.');

    const manager = new CMakeActiveProjectManager(api, globalStoragePath, outputChannel);
    await manager.activate();
    return manager;
  }

  private constructor(private readonly api: CMakeToolsApi|undefined,
                      private readonly globalStoragePath: string,
                      private readonly outputChannel: vscode.OutputChannel) {}

  get state(): ActiveCMakeProjectState|undefined { return this.activeState; }

  get client(): BaseLanguageClient|undefined { return this.cdbManager?.client; }

  get compileCommandsDir(): string|undefined {
    return this.activeState?.generatedCompileCommandsDir;
  }

  private async activate(): Promise<void> {
    if (this.api) {
      this.subscriptions.push(this.api.onActiveProjectChanged(
          uri => { void this.handleActiveProjectChanged(uri); }));
    }

    await this.handleActiveProjectChanged(this.initialProjectUri());
  }

  private initialProjectUri(): vscode.Uri|undefined {
    const activeDocumentUri = vscode.window.activeTextEditor?.document.uri;
    const activeWorkspaceFolder = activeDocumentUri ? vscode.workspace.getWorkspaceFolder(activeDocumentUri) : undefined;
    if (activeWorkspaceFolder)
      return activeWorkspaceFolder.uri;

    const activeFolderPath = this.api?.getActiveFolderPath();
    if (activeFolderPath)
      return vscode.Uri.file(activeFolderPath);

    return vscode.workspace.workspaceFolders?.[0]?.uri;
  }

  private async handleActiveProjectChanged(uri: vscode.Uri|undefined): Promise<void> {
    const generation = ++this.activeProjectGeneration;
    if (!uri || !this.api) {
      this.setActiveState(undefined);
      return;
    }

    const project = await this.api.getProject(uri);
    const buildDirectory = await project?.getBuildDirectory();
    if (generation !== this.activeProjectGeneration)
      return;

    if (!project || !buildDirectory) {
      this.setActiveState(undefined);
      return;
    }

    this.setActiveState({
      projectUri: uri,
      project,
      buildDirectory,
      compilationDatabasePath: path.join(buildDirectory, 'compile_commands.json'),
      generatedCompileCommandsDir: path.join(buildDirectory, '.clangd'),
    });
  }

  async restartClangd(): Promise<void> {
    await this.cdbManager?.restartClangd();
  }

  shutdownClangd(): void {
    this.cdbManager?.shutdownClangd();
  }

  clientIsStarting(): boolean { return this.cdbManager?.clientIsStarting() ?? false; }

  clientIsRunning(): boolean { return this.cdbManager?.clientIsRunning() ?? false; }

  private setActiveState(state: ActiveCMakeProjectState|undefined): void {
    this.activeState = state;
    this.resetCdbManager();
  }

  private resetCdbManager(): void {
    this.cdbManagerClientSubscription?.dispose();
    this.cdbManagerClientSubscription = undefined;
    this.cdbManager?.dispose();
    this.cdbManager = undefined;

    if (!this.activeState) {
      this.onDidChangeClientEmitter.fire(undefined);
      return;
    }

    log.info(`Using CMake project compile database: ${this.activeState.compilationDatabasePath}`);
    this.cdbManager = new CompilationDatabaseScanDepsManager(
        this.activeState.compilationDatabasePath,
        {
          globalStoragePath: this.globalStoragePath,
          outputChannel: this.outputChannel,
          toolchain: this.toolchainForProject(this.activeState.project),
        });
    this.cdbManagerClientSubscription = this.cdbManager.onDidChangeClient(
        client => { this.onDidChangeClientEmitter.fire(client); });
    this.onDidChangeClientEmitter.fire(this.cdbManager.client);
  }

  private toolchainForProject(project: Project): string|undefined {
    for (const toolchain of project.codeModel?.toolchains?.values() ?? [])
      return toolchain.path;
    return undefined;
  }

  dispose(): void {
    this.subscriptions.forEach(subscription => { subscription.dispose(); });
    this.subscriptions.length = 0;
    this.cdbManagerClientSubscription?.dispose();
    this.cdbManager?.dispose();
    this.cdbManagerClientSubscription = undefined;
    this.cdbManager = undefined;
    this.onDidChangeClientEmitter.dispose();
  }
}
