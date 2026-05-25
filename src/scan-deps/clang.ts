import * as path from 'path';

import {CompileCommand} from '../compilation-database';
import type {Environment} from '../environment-variables';
import {fs} from '../pr';
import * as proc from '../proc';
import * as util from '../util';
import {varsForMsvcToolchain} from '../visual-studio';

import type {ModuleScanResult} from './index';
import {clangScanDepsPathForToolchain, collectModuleScanResult, commandArguments, compilerPath, isClangClToolchain, normalizePath, resolveCommandPath, ScanDepsModuleEntry, ScanDepsOutput, stableHash} from './util';

function outputFromArguments(args: readonly string[]): string | undefined {
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '-o')
            return args[index + 1];
        if (arg.startsWith('-o') && arg.length > 2)
            return arg.substring(2);
        if (arg === '/Fo')
            return args[index + 1];
        if (arg.startsWith('/Fo') && arg.length > 3)
            return arg.substring(3);
    }
    return undefined;
}

function compileCommandOutputs(entry: CompileCommand): string[] {
    const output = entry.output ?? outputFromArguments(commandArguments(entry));
    if (!output)
        return [];
    return [output];
}

function isModmapResponseArgument(argument: string): boolean {
    return argument.startsWith('@') && normalizePath(argument.substring(1)).endsWith('.modmap');
}

function filteredCommandArguments(entry: CompileCommand): string[] {
    return commandArguments(entry).filter(argument => !isModmapResponseArgument(argument));
}

function toFilteredCompileCommandsJson(entry: CompileCommand): string {
    return JSON.stringify([{
        directory: entry.directory,
        file: entry.file,
        output: entry.output,
        arguments: filteredCommandArguments(entry),
    }], undefined, 2);
}

async function runClangScanDeps(
    workingDirectory: string,
    clangScanDepsPath: string,
    entry: CompileCommand,
    temporaryDirectory: string,
    environment: Environment | undefined,
): Promise<ScanDepsOutput<ScanDepsModuleEntry>> {
    const id = stableHash(`${entry.directory}\0${entry.file}\0${compileCommandOutputs(entry).join('\0')}`);
    const filteredCompilationDatabasePath = path.join(temporaryDirectory, `${id}.compile_commands.json`);
    await fs.writeFile(filteredCompilationDatabasePath, toFilteredCompileCommandsJson(entry));
    const args = [
        '-compilation-database', filteredCompilationDatabasePath,
        '-format=p1689',
    ];
    const execution = await proc.execute(clangScanDepsPath, args, null, {
        cwd: workingDirectory,
        encoding: 'utf8',
        silent: true,
        showOutputOnError: true,
        environment,
    }).result;
    if (execution.retc !== 0)
        throw new Error(`clang-scan-deps failed with code ${execution.retc}: ${execution.stderr}`);

    try {
        return JSON.parse(execution.stdout) as ScanDepsOutput<ScanDepsModuleEntry>;
    } catch (error) {
        throw new Error(`Failed to parse clang-scan-deps output: ${util.errorToString(error)}`);
    }
}

export async function scan(
    entry: CompileCommand,
): Promise<ModuleScanResult | undefined> {
    const compiler = compilerPath(entry);
    const clangScanDepsPath = compiler ? clangScanDepsPathForToolchain(compiler) : undefined;
    if (!compiler || !clangScanDepsPath)
        return undefined;

    const buildDirectory = entry.directory;
    const temporaryDirectory = path.join(buildDirectory, '.clangd', 'scan-deps', 'clang');
    await fs.mkdir_p(temporaryDirectory);
    const environment: Environment | undefined = isClangClToolchain(compiler) ? await varsForMsvcToolchain(compiler) : undefined;
    const scanDepsOutput = await runClangScanDeps(
        buildDirectory,
        clangScanDepsPath,
        entry,
        temporaryDirectory,
        environment,
    );
    return collectModuleScanResult(scanDepsOutput, buildDirectory, resolveCommandPath(entry, entry.file));
}
