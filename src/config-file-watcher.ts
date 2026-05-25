import * as path from 'path';
import * as vscode from 'vscode';
import * as vscodelc from 'vscode-languageclient/node';

import {ClangdContext} from './clangd-context';
import {CompilationDatabase} from './compilation-database';
import * as config from './config';
import {activeCMakeBuildDirectory} from './generate-cdb';
import * as util from './util';

export async function activate(context: ClangdContext) {
  if (await config.get<string>('onConfigChanged') !== 'ignore' ||
      await config.get<boolean>('modules.enabled')) {
    context.client.registerFeature(new ConfigFileWatcherFeature(context));
  }
}

// Clangd extension capabilities.
interface ClangdClientCapabilities {
  compilationDatabase?: {automaticReload?: boolean;},
}

class ConfigFileWatcherFeature implements vscodelc.StaticFeature {
  constructor(private context: ClangdContext) {}
  fillClientCapabilities(capabilities: vscodelc.ClientCapabilities) {}

  async initialize(capabilities: vscodelc.ServerCapabilities,
                   _documentSelector: vscodelc.DocumentSelector|undefined) {
    const skipConfigReload = !await config.get<boolean>('onConfigChangedForceEnable') &&
        (capabilities as ClangdClientCapabilities).compilationDatabase?.automaticReload === true;
    this.context.subscriptions.push(new ConfigFileWatcher(this.context, skipConfigReload));
  }
  getState(): vscodelc.FeatureState { return {kind: 'static'}; }
  clear() {}
}

class ConfigFileWatcher implements vscode.Disposable {
  private databaseWatcher?: vscode.FileSystemWatcher;
  private debounceTimer?: NodeJS.Timeout;
  private saveDebounceTimer?: NodeJS.Timeout;

  dispose() {
    if (this.databaseWatcher)
      this.databaseWatcher.dispose();
    if (this.saveDebounceTimer)
      clearTimeout(this.saveDebounceTimer);
  }

  constructor(private context: ClangdContext, private skipConfigReload: boolean) {
    this.createFileSystemWatcher();
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(
        () => { this.createFileSystemWatcher(); }));
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(
        document => { this.debouncedHandleSavedDocument(document); }));
  }

  createFileSystemWatcher() {
    if (this.databaseWatcher)
      this.databaseWatcher.dispose();
    if (vscode.workspace.workspaceFolders) {
      this.databaseWatcher = vscode.workspace.createFileSystemWatcher(
          '{' +
          vscode.workspace.workspaceFolders.map(f => f.uri.fsPath).join(',') +
          '}/{build/compile_commands.json,compile_commands.json,compile_flags.txt}');
      this.context.subscriptions.push(this.databaseWatcher.onDidChange(
          this.debouncedHandleConfigFilesChanged.bind(this)));
      this.context.subscriptions.push(this.databaseWatcher.onDidCreate(
          this.debouncedHandleConfigFilesChanged.bind(this)));
      this.context.subscriptions.push(this.databaseWatcher);
    }
  }

  async debouncedHandleConfigFilesChanged(uri: vscode.Uri) {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(async () => {
      await this.handleConfigFilesChanged(uri);
      this.debounceTimer = undefined;
    }, 2000);
  }

  debouncedHandleSavedDocument(document: vscode.TextDocument) {
    if (document.uri.scheme !== 'file')
      return;

    if (this.saveDebounceTimer)
      clearTimeout(this.saveDebounceTimer);

    this.saveDebounceTimer = setTimeout(async () => {
      await this.refreshGeneratedCompileCommandsForSavedFile(document.uri);
      this.saveDebounceTimer = undefined;
    }, 2000);
  }

  async handleConfigFilesChanged(uri: vscode.Uri) {
    // Sometimes the tools that generate the compilation database, before
    // writing to it, they create a new empty file or they clear the existing
    // one, and after the compilation they write the new content. In this cases
    // the server is not supposed to restart
    if ((await vscode.workspace.fs.stat(uri)).size <= 0)
      return;

    if (await this.refreshGeneratedCompileCommandsIfNeeded(uri))
      return;

    if (this.skipConfigReload)
      return;

    switch (await config.get<string>('onConfigChanged')) {
    case 'restart':
      vscode.commands.executeCommand('clangd.restart');
      break;
    case 'ignore':
      break;
    case 'prompt':
    default:
      switch (await vscode.window.showInformationMessage(
          `Clangd configuration file at '${
              uri.fsPath}' has been changed. Do you want to restart it?`,
          'Yes', 'Yes, always', 'No, never')) {
      case 'Yes':
        vscode.commands.executeCommand('clangd.restart');
        break;
      case 'Yes, always':
        vscode.commands.executeCommand('clangd.restart');
        config.update<string>('onConfigChanged', 'restart',
                              vscode.ConfigurationTarget.Global);
        break;
      case 'No, never':
        config.update<string>('onConfigChanged', 'ignore',
                              vscode.ConfigurationTarget.Global);
        break;
      default:
        break;
      }
      break;
    }
  }

  async refreshGeneratedCompileCommandsIfNeeded(uri: vscode.Uri): Promise<boolean> {
    if (!isCMakeCompilationDatabase(uri) || !await config.get<boolean>('modules.enabled'))
      return false;

    await vscode.commands.executeCommand('clangd.refreshGeneratedCompileCommands');
    return true;
  }

  async refreshGeneratedCompileCommandsForSavedFile(uri: vscode.Uri): Promise<void> {
    if (!await config.get<boolean>('modules.enabled') || !await isFileInActiveCompilationDatabase(uri))
      return;

    await vscode.commands.executeCommand('clangd.refreshGeneratedCompileCommands');
  }
}

function isCMakeCompilationDatabase(uri: vscode.Uri): boolean {
  if (uri.scheme !== 'file' || path.basename(uri.fsPath) !== 'compile_commands.json')
    return false;

  return !uri.fsPath.split(/[\\/]+/).includes('.clangd');
}

function compileCommandFilePath(entry: {directory: string; file: string}): string {
  return util.platformNormalizePath(path.isAbsolute(entry.file) ? entry.file : path.resolve(entry.directory, entry.file));
}

async function isFileInActiveCompilationDatabase(uri: vscode.Uri): Promise<boolean> {
  const buildDirectory = await activeCMakeBuildDirectory();
  if (!buildDirectory)
    return false;

  const database = await CompilationDatabase.fromFilePaths([path.join(buildDirectory, 'compile_commands.json')]);
  if (!database)
    return false;

  const filePath = util.platformNormalizePath(uri.fsPath);
  return database.entries().some(entry => compileCommandFilePath(entry) === filePath);
}
