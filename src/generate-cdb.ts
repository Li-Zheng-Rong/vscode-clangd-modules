import * as path from 'path';
import * as vscode from 'vscode';

import {CodeModel, getCMakeToolsApi, Version} from 'vscode-cmake-tools';

import {CompilationDatabase} from './compilation-database';
import {createLogger} from './logging';
import {buildGeneratedCompileCommandsFromCompilationDatabase} from './module-compile-commands';
import {fs} from './pr';
import {scan as scanCompilationDatabase} from './scan-deps';

const log = createLogger('generated-compile-commands');

export function generatedCompileCommandsDir(buildDirectory: string): string {
    return path.join(buildDirectory, '.clangd');
}

export function generatedCompileCommandsPath(buildDirectory: string): string {
    return path.join(generatedCompileCommandsDir(buildDirectory), 'compile_commands.json');
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
    try {
        return (await fs.readFile(filePath)).toString();
    } catch {
        return undefined;
    }
}

function activeWorkspaceFolderUri(): vscode.Uri | undefined {
    const activeDocumentUri = vscode.window.activeTextEditor?.document.uri;
    const activeWorkspaceFolder = activeDocumentUri ? vscode.workspace.getWorkspaceFolder(activeDocumentUri) : undefined;
    return activeWorkspaceFolder?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
}

export async function activeCMakeBuildDirectory(): Promise<string | undefined> {
    const api = await getCMakeToolsApi(Version.latest);
    const uri = activeWorkspaceFolderUri();
    if (!api || !uri)
        return undefined;

    const project = await api.getProject(uri);
    return project?.getBuildDirectory();
}

export async function activeCMakeCodeModel(): Promise<CodeModel.Content | undefined> {
    const api = await getCMakeToolsApi(Version.latest);
    const uri = activeWorkspaceFolderUri();
    if (!api || !uri)
        return undefined;

    const project = await api.getProject(uri);
    return project?.codeModel;
}

export async function refreshGeneratedCompileCommandsAfterBuild(
    buildDirectory: string,
    database: CompilationDatabase,
    codeModel: CodeModel.Content | undefined,
): Promise<boolean> {
    const databasePath = path.join(buildDirectory, 'compile_commands.json');
    const moduleScanDeps = await scanCompilationDatabase(databasePath, codeModel);
    const generated = await buildGeneratedCompileCommandsFromCompilationDatabase(database, moduleScanDeps);

    const outPath = generatedCompileCommandsPath(buildDirectory);
    const content = JSON.stringify(generated.commands, undefined, 2);
    if (await readTextIfExists(outPath) === content)
        return false;

    await fs.mkdir_p(path.dirname(outPath));
    await fs.writeFile(outPath, content);
    log.info(`Updated generated clangd compile database: ${outPath}`);
    if (generated.diagnostics.length) {
        for (const diagnostic of generated.diagnostics)
            log.warning(diagnostic);
    }
    await vscode.commands.executeCommand('clangd.restart');
    return true;
}

async function refreshGeneratedCompileCommands(): Promise<void> {
    const api = await getCMakeToolsApi(Version.latest);
    if (!api) {
        vscode.window.showWarningMessage('CMake Tools API is not available.');
        return;
    }

    const uri = activeWorkspaceFolderUri();
    if (!uri) {
        vscode.window.showWarningMessage('No active workspace or editor for CMake Tools project lookup.');
        return;
    }

    const project = await api.getProject(uri);
    if (!project) {
        vscode.window.showWarningMessage('No CMake Tools project found for the active workspace.');
        return;
    }

    const buildDirectory = await project.getBuildDirectory();
    if (!buildDirectory) {
        vscode.window.showWarningMessage('CMake Tools build directory is not available.');
        return;
    }

    const databasePath = path.join(buildDirectory, 'compile_commands.json');
    const database = await CompilationDatabase.fromFilePaths([databasePath]);
    if (!database) {
        vscode.window.showWarningMessage(`Compilation database not found: ${databasePath}`);
        return;
    }

    const changed = await refreshGeneratedCompileCommandsAfterBuild(buildDirectory, database, project.codeModel);
    vscode.window.showInformationMessage(changed ? 'Generated compile commands refreshed.' : 'Generated compile commands are already up to date.');
}

export function registerGeneratedCompileCommandsCommand(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.commands.registerCommand(
        'clangd.refreshGeneratedCompileCommands',
        refreshGeneratedCompileCommands,
    ));
}
