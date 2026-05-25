import * as vscode from 'vscode';
import {BaseLanguageClient} from 'vscode-languageclient';

import {ClangdExtension} from '../api/vscode-clangd';

import {ClangdExtensionImpl} from './api';
import {CMakeActiveProjectManager} from './cmake-active-project-manager';
import {get, update} from './config';
import * as install from './install';
import {setLoggerOutputChannel} from './logging';

let apiInstance: ClangdExtensionImpl|undefined;

/**
 *  This method is called when the extension is activated. The extension is
 *  activated the very first time a command is executed.
 */
export async function activate(context: vscode.ExtensionContext):
    Promise<ClangdExtension> {
  const outputChannel = vscode.window.createOutputChannel('clangd');
  setLoggerOutputChannel(outputChannel);
  context.subscriptions.push(outputChannel);
  await install.registerCommands(context.subscriptions, context.globalStoragePath);

  let cmakeProjectManager: CMakeActiveProjectManager|null = null;
  let clangdClient: BaseLanguageClient|undefined;
  const ensureCMakeProjectManager = async () => {
    if (cmakeProjectManager)
      return cmakeProjectManager;

    cmakeProjectManager = await CMakeActiveProjectManager.create(context.globalStoragePath, outputChannel);
    clangdClient = cmakeProjectManager.client;
    cmakeProjectManager.onDidChangeClient(client => {
      clangdClient = client;
      if (apiInstance)
        apiInstance.client = client;
    });
    context.subscriptions.push(cmakeProjectManager);
    return cmakeProjectManager;
  };

  context.subscriptions.push(
      vscode.commands.registerCommand('clangd.activate', async () => {
        if (cmakeProjectManager && (cmakeProjectManager.clientIsStarting() ||
                                    cmakeProjectManager.clientIsRunning())) {
          return;
        }
        vscode.commands.executeCommand('clangd.restart');
      }));
  context.subscriptions.push(
      vscode.commands.registerCommand('clangd.restart', async () => {
        if (!get<boolean>('enable')) {
          vscode.window
              .showInformationMessage(
                  'Language features from Clangd are currently disabled. Would you like to enable them?',
                  'Enable', 'Close')
              .then(async (choice) => {
                if (choice === 'Enable') {
                  await update<boolean>('enable', true);
                  vscode.commands.executeCommand('clangd.restart');
                }
              });
          return;
        }

        // clangd.restart can be called when the extension is not yet activated.
        // In such a case, vscode will activate the extension and then run this
        // handler. Detect this situation and bail out (doing an extra
        // stop/start cycle in this situation is pointless, and doesn't work
        // anyways because the client can't be stop()-ped when it's still in the
        // Starting state).
        if (cmakeProjectManager && cmakeProjectManager.clientIsStarting()) {
          return;
        }
        const manager = await ensureCMakeProjectManager();
        await manager.restartClangd();
        if (apiInstance) {
          apiInstance.client = clangdClient;
        }
      }));
  context.subscriptions.push(
      vscode.commands.registerCommand('clangd.shutdown', async () => {
        if (cmakeProjectManager && cmakeProjectManager.clientIsStarting()) {
          return;
        }
        cmakeProjectManager?.shutdownClangd();
      }));
  context.subscriptions.push(
      vscode.commands.registerCommand('clangd.refreshGeneratedCompileCommands', async () => {
        const manager = await ensureCMakeProjectManager();
        await manager.refreshGeneratedCompileCommands();
      }));

  let shouldCheck = false;

  if (vscode.workspace.getConfiguration('clangd').get<boolean>('enable')) {
    await ensureCMakeProjectManager();

    shouldCheck = vscode.workspace.getConfiguration('clangd').get<boolean>(
                      'detectExtensionConflicts') ??
                  false;
  }

  if (shouldCheck) {
    const interval = setInterval(function() {
      const cppTools = vscode.extensions.getExtension('ms-vscode.cpptools');
      if (cppTools && cppTools.isActive) {
        const cppToolsConfiguration =
            vscode.workspace.getConfiguration('C_Cpp');
        const cppToolsEnabled =
            cppToolsConfiguration.get<string>('intelliSenseEngine');
        if (cppToolsEnabled?.toLowerCase() !== 'disabled') {
          vscode.window
              .showWarningMessage(
                  'You have both the Microsoft C++ (cpptools) extension and ' +
                      'clangd extension enabled. The Microsoft IntelliSense features ' +
                      'conflict with clangd\'s code completion, diagnostics etc.',
                  'Disable IntelliSense', 'Never show this warning')
              .then(selection => {
                if (selection == 'Disable IntelliSense') {
                  cppToolsConfiguration.update(
                      'intelliSenseEngine', 'disabled',
                      vscode.ConfigurationTarget.Global);
                } else if (selection == 'Never show this warning') {
                  vscode.workspace.getConfiguration('clangd').update(
                      'detectExtensionConflicts', false,
                      vscode.ConfigurationTarget.Global);
                  clearInterval(interval);
                }
              });
        }
      }
    }, 5000);
  }

  apiInstance = new ClangdExtensionImpl(clangdClient);
  return apiInstance;
}
