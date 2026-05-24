import * as path from 'path';
import * as vscode from 'vscode';

import { collectCxxModuleFileSetSources } from './cmake-file-api';
import { CompilationDatabase, CompileCommand } from './compilation-database';
import { CodeModel } from 'vscode-cmake-tools';
import { createLogger } from './logger';
import { fs } from './pr';
import * as util from './util';

import { buildGeneratedCompileCommandsFromCompilationDatabase } from './module-compile-commands';
import { stdlibModuleSourcePathsForToolchain } from './stdlib-modules';

const log = createLogger('clangd-cdb');

export function generatedCompileCommandsDir(buildDirectory: string): string {
    return path.join(buildDirectory, '.cmake-tools-clangd');
}

export function generatedCompileCommandsPath(buildDirectory: string): string {
    return path.join(generatedCompileCommandsDir(buildDirectory), 'compile_commands.json');
}

function resolveCommandPath(entry: CompileCommand, value: string): string {
    return util.platformNormalizePath(path.isAbsolute(value) ? value : path.resolve(entry.directory, value));
}

async function collectStdlibModuleSources(codeModel: CodeModel.Content | null | undefined): Promise<Set<string>> {
    const sources = new Set<string>();
    for (const toolchain of codeModel?.toolchains?.values() ?? []) {
        for (const source of await stdlibModuleSourcePathsForToolchain(toolchain as CodeModel.Toolchain))
            sources.add(source);
    }
    return sources;
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
    try {
        return (await fs.readFile(filePath)).toString();
    } catch {
        return undefined;
    }
}


export async function refreshGeneratedCompileCommandsAfterBuild(
    buildDirectory: string,
    database: CompilationDatabase | null,
    codeModel: CodeModel.Content | null | undefined,
): Promise<boolean> {
    if (!database)
        return false;

    let gccModuleProducerSources: Promise<Set<string>> | undefined;
    function getGccModuleProducerSources(): Promise<Set<string>> {
        gccModuleProducerSources ??= (async () => {
            const sources = new Set<string>();
            for (const source of await collectCxxModuleFileSetSources(buildDirectory))
                sources.add(source);
            for (const source of await collectStdlibModuleSources(codeModel))
                sources.add(source);
            return sources;
        })();
        return gccModuleProducerSources;
    }

    const generated = await buildGeneratedCompileCommandsFromCompilationDatabase(database, {
        isGccModuleProducer: async entry => {
            const source = resolveCommandPath(entry, entry.file);
            return (await getGccModuleProducerSources()).has(source);
        },
    });

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

